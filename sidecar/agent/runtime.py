from __future__ import annotations

import asyncio
import contextlib
import contextvars
import time
from dataclasses import dataclass, field
from typing import AsyncIterator

from . import runlog


RUN_TIMEOUT_SECONDS = 15 * 60
TURN_TIMEOUT_SECONDS = 5 * 60
MAX_TOOL_CALLS = 64
COMMAND_TIMEOUT_SECONDS = 180
COMMAND_OUTPUT_CAP = 20_000


@dataclass
class RunContext:
    run_id: str
    chat_id: str
    requested_model_id: str
    resolved_model_id: str = ""
    provider_base_url: str = ""
    provider_source: str = ""
    run_timeout_seconds: float = RUN_TIMEOUT_SECONDS
    turn_timeout_seconds: float = TURN_TIMEOUT_SECONDS
    command_timeout_seconds: float = COMMAND_TIMEOUT_SECONDS
    command_output_cap: int = COMMAND_OUTPUT_CAP
    max_tool_calls: int = MAX_TOOL_CALLS
    started_monotonic: float = field(default_factory=time.monotonic)
    turn_index: int = 0
    tool_calls: int = 0
    last_event_type: str = ""
    last_error: str = ""
    _active_processes: set[int] = field(default_factory=set)

    def log(self, event: str, **fields: object) -> None:
        runlog.append(
            self.run_id,
            event,
            chat_id=self.chat_id,
            requested_model_id=self.requested_model_id,
            resolved_model_id=self.resolved_model_id,
            provider_base_url=self.provider_base_url,
            provider_source=self.provider_source,
            turn_index=self.turn_index,
            tool_calls=self.tool_calls,
            last_event_type=self.last_event_type,
            **fields,
        )

    def remaining_run_seconds(self) -> float:
        elapsed = time.monotonic() - self.started_monotonic
        return max(0.0, self.run_timeout_seconds - elapsed)

    def next_tool_call(self) -> None:
        self.tool_calls += 1
        if self.tool_calls > self.max_tool_calls:
            raise RuntimeError(
                f"Tool budget exceeded ({self.max_tool_calls} calls). "
                "Stop and summarize the current progress instead."
            )

    def register_process(self, pid: int) -> None:
        self._active_processes.add(pid)

    def unregister_process(self, pid: int) -> None:
        self._active_processes.discard(pid)


_CURRENT_RUN: contextvars.ContextVar[RunContext | None] = contextvars.ContextVar(
    "zwork_current_run",
    default=None,
)


def current_run() -> RunContext | None:
    return _CURRENT_RUN.get()


@contextlib.asynccontextmanager
async def run_scope(ctx: RunContext) -> AsyncIterator[RunContext]:
    token = _CURRENT_RUN.set(ctx)
    try:
        yield ctx
    finally:
        _CURRENT_RUN.reset(token)
