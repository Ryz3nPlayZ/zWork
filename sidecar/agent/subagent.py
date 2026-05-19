"""Subagent spawning system for parallel agent execution.

Supports two modes:
1. Explicit: LLM calls spawn_agent tool with a task description
2. Implicit: Orchestration detects parallelizable ops (e.g., batch file reads)

Each subagent runs in its own async task with its own message context.
Results are streamed back to the main agent loop.
"""
from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Literal

from .runtime import current_run, RunContext


@dataclass
class SubagentTask:
    """A task assigned to a subagent."""
    id: str
    description: str
    parent_run_id: str
    status: Literal["pending", "running", "completed", "failed"] = "pending"
    result: str | None = None
    error: str | None = None
    started_at: float | None = None
    completed_at: float | None = None


@dataclass
class SubagentContext:
    """Context for a running subagent."""
    task_id: str
    run_context: RunContext
    result_queue: asyncio.Queue[dict]
    parent_messages: list[dict[str, Any]]


class SubagentSpawner:
    """Manages spawning and coordination of subagents."""

    def __init__(self, parent_run_id: str, parent_context: RunContext) -> None:
        self.parent_run_id = parent_run_id
        self.parent_context = parent_context
        self.active_tasks: dict[str, SubagentTask] = {}
        self._task_lock = asyncio.Lock()

    def generate_task_id(self) -> str:
        """Generate a unique subagent task ID."""
        return f"subagent_{uuid.uuid4().hex[:12]}"

    async def spawn(
        self,
        description: str,
        messages: list[dict[str, Any]],
        model_id: str,
        plan_mode: bool = False,
    ) -> AsyncIterator[dict]:
        """Spawn a subagent for the given task.

        Yields events:
        - subagent_started: {task_id, description}
        - subagent_progress: {task_id, status}
        - subagent_done: {task_id, result, error?}
        """
        task_id = self.generate_task_id()
        task = SubagentTask(
            id=task_id,
            description=description,
            parent_run_id=self.parent_run_id,
        )

        async with self._task_lock:
            self.active_tasks[task_id] = task

        yield {
            "type": "subagent_started",
            "task_id": task_id,
            "description": description,
        }

        # Create result queue for this subagent
        result_queue: asyncio.Queue[dict] = asyncio.Queue()

        # Create subagent run context
        subagent_run = RunContext(
            run_id=f"{self.parent_run_id}_{task_id}",
            chat_id=self.parent_context.chat_id,
            requested_model_id=model_id,
            resolved_model_id=model_id,
            run_timeout_seconds=self.parent_context.run_timeout_seconds,
            turn_timeout_seconds=self.parent_context.turn_timeout_seconds,
        )

        # Run the subagent in background
        async def run_subagent():
            try:
                task.status = "running"
                task.started_at = asyncio.get_running_loop().time()
                yield {
                    "type": "subagent_progress",
                    "task_id": task_id,
                    "status": "running",
                }

                # Import here to avoid circular dependency
                from .providers import stream_chat
                from . import settings as settings_mod

                # Get settings for model resolution
                s = settings_mod.load()
                model_entry = None
                for m in s.custom_models:
                    if m.get("id") == model_id:
                        model_entry = m
                        break
                if not model_entry:
                    # Try default model
                    model_entry = {
                        "id": model_id,
                        "credential": s.default_provider or "claude_code",
                        "model_id": model_id,
                        "shape": "anthropic",
                    }

                # Stream the subagent's work
                full_result = []
                async for evt in stream_chat(
                    messages=messages,
                    zwork_model_id=model_id,
                    s=s,
                    run_ctx=subagent_run,
                    plan_mode=plan_mode,
                    auto_approve_destructive=False,  # Subagents are conservative
                ):
                    # Forward progress events
                    if evt.get("type") == "delta":
                        full_result.append(evt.get("text", ""))
                        await result_queue.put({
                            "type": "subagent_delta",
                            "task_id": task_id,
                            "text": evt.get("text", ""),
                        })
                    elif evt.get("type") in ("activity", "status"):
                        await result_queue.put({
                            "type": "subagent_activity",
                            "task_id": task_id,
                            "event": evt,
                        })

                result = "".join(full_result)
                task.status = "completed"
                task.result = result
                task.completed_at = asyncio.get_running_loop().time()

                await result_queue.put({
                    "type": "subagent_done",
                    "task_id": task_id,
                    "result": result,
                })

            except Exception as e:
                task.status = "failed"
                task.error = str(e)
                task.completed_at = asyncio.get_running_loop().time()
                await result_queue.put({
                    "type": "subagent_done",
                    "task_id": task_id,
                    "error": str(e),
                })

        # Start the subagent task
        asyncio.create_task(run_subagent())

        # Return an async iterator that yields from the result queue
        while True:
            evt = await result_queue.get()
            yield evt
            if evt.get("type") == "subagent_done":
                break

    async def spawn_batch(
        self,
        tasks: list[tuple[str, list[dict[str, Any]]]],
        model_id: str,
        plan_mode: bool = False,
    ) -> AsyncIterator[dict]:
        """Spawn multiple subagents in parallel.

        Yields events from all subagents as they complete.
        """
        # Create all tasks first
        async def run_single(desc: str, msgs: list[dict[str, Any]]):
            async for evt in self.spawn(desc, msgs, model_id, plan_mode):
                yield evt

        # Run all subagents concurrently using TaskGroup
        async with asyncio.TaskGroup() as tg:
            async def collect_task(desc: str, msgs: list[dict[str, Any]]):
                async for evt in run_single(desc, msgs):
                    yield evt

            # We'll collect events from all tasks
            event_queues: list[asyncio.Queue] = []

            for desc, msgs in tasks:
                q: asyncio.Queue[dict] = asyncio.Queue()
                event_queues.append(q)

                async def pipe_events():
                    async for evt in run_single(desc, msgs):
                        await q.put(evt)
                    await q.put({"type": "_task_done"})

                tg.create_task(pipe_events())

        # Yield events as they arrive (round-robin from queues)
        pending = set(range(len(event_queues)))
        while pending:
            for i, q in enumerate(event_queues):
                if i not in pending:
                    continue
                try:
                    evt = q.get_nowait()
                    if evt.get("type") == "_task_done":
                        pending.discard(i)
                    else:
                        yield evt
                except asyncio.QueueEmpty:
                    pass
            await asyncio.sleep(0.01)  # Small backoff

    def get_active_tasks(self) -> list[SubagentTask]:
        """Get list of currently active subagent tasks."""
        return list(self.active_tasks.values())


def current_spawner() -> SubagentSpawner | None:
    """Get the current subagent spawner from the run context."""
    run = current_run()
    if run is None:
        return None
    # Spawner is stored as an attribute on the run context
    return getattr(run, "_subagent_spawner", None)


async def spawn_agent(
    description: str,
    messages: list[dict[str, Any]],
    model_id: str,
    plan_mode: bool = False,
) -> AsyncIterator[dict]:
    """Convenience function to spawn a subagent from the current context."""
    spawner = current_spawner()
    if spawner is None:
        # No spawner available - yield error and return
        yield {
            "type": "error",
            "text": "Subagent spawning not available in this context",
        }
        yield {
            "type": "subagent_done",
            "task_id": "none",
            "error": "No spawner available",
        }
        return

    async for evt in spawner.spawn(description, messages, model_id, plan_mode):
        yield evt
