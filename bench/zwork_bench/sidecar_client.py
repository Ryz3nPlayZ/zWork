"""HTTP/SSE client for the zWork sidecar running inside a container.

Posts the task to ``POST /api/chat/stream`` and drains the SSE stream until the
terminal ``end`` event, capturing a full trajectory (assistant text, tool calls,
tool results). Mirrors what the desktop frontend does, minus the rendering.

The sidecar serializes each agent event as a single SSE ``data:`` line whose
payload is a JSON object with a ``"type"`` discriminator (e.g. ``delta``,
``tool_use``, ``tool_result``, ``error``, ``done``, ``end``). See
``sidecar-rust/src/server.rs:chat_stream_route`` and
``sidecar-rust/src/agent/mod.rs:run_agent_turn``.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Iterator

import httpx


@dataclass
class Trajectory:
    """Everything captured from one agent run."""

    events: list[dict[str, Any]] = field(default_factory=list)
    assistant_text: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    n_turns: int = 0
    finished: bool = False
    finish_reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "assistant_text": self.assistant_text,
            "tool_calls": self.tool_calls,
            "tool_results": self.tool_results,
            "errors": self.errors,
            "n_turns": self.tool_calls
            and (max((c.get("turn", 0) for c in self.tool_calls), default=0)),
            "finished": self.finished,
            "finish_reason": self.finish_reason,
            "n_events": len(self.events),
        }


class SidecarError(RuntimeError):
    pass


def _sse_events(response: httpx.Response) -> Iterator[dict[str, Any]]:
    """Yield each SSE event payload as a parsed dict."""
    for line in response.iter_lines():
        if not line:
            continue
        # Axum's SSE writer emits `data: <json>`. Some keepalive lines may be
        # empty or comments (":") — skip them.
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            payload = line[len("data:"):].strip()
        elif line.startswith("event:"):
            continue  # our server doesn't name events; data-only
        else:
            # Tolerate a bare JSON object (no `data:` prefix) just in case.
            payload = line.strip()
            if not payload.startswith("{"):
                continue
        if not payload:
            continue
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            # Ignore malformed fragments — never fatal, the run terminates on
            # `end` or stream close regardless.
            continue


def run_agent_turn(
    base_url: str,
    token: str,
    message: str,
    model_id: str,
    *,
    timeout_s: float = 1200.0,
) -> Trajectory:
    """POST the task and drain the stream. Blocks until the turn ends."""
    url = f"{base_url.rstrip('/')}/api/chat/stream"
    headers = {"x-zwork-token": token, "Content-Type": "application/json"}
    body = {
        "run_id": f"bench-{int(time.time())}",
        "message": message,
        "model": model_id,
        "new_chat_title": "swe-bench",
        # Autonomous coding config — see RunConfig defaults.
        "plan_mode": False,
        "auto_approve_destructive": True,
        "artifact_mode": False,
        "web_search_enabled": False,
        "attachments": [],
    }

    traj = Trajectory()
    started = time.monotonic()

    with httpx.stream(
        "POST", url, json=body, headers=headers, timeout=timeout_s
    ) as resp:
        if resp.status_code != 200:
            body_text = resp.read().decode("utf-8", "replace")
            raise SidecarError(
                f"sidecar POST /api/chat/stream -> {resp.status_code}: {body_text[:500]}"
            )

        for ev in _sse_events(resp):
            traj.events.append(ev)
            t = ev.get("type")

            if t == "delta":
                traj.assistant_text += ev.get("text", "")
            elif t == "tool_use":
                traj.tool_calls.append(ev)
                traj.n_turns += 1
            elif t == "tool_result":
                traj.tool_results.append(ev)
            elif t == "error":
                txt = ev.get("text") or ev.get("message") or json.dumps(ev)
                traj.errors.append(str(txt))
            elif t == "done":
                traj.finished = True
                traj.finish_reason = ev.get("reason", "done")
            elif t == "end":
                traj.finished = True
                if not traj.finish_reason:
                    traj.finish_reason = "end"
                break

            if time.monotonic() - started > timeout_s:
                traj.finish_reason = "wall_timeout"
                break

    if not traj.finished:
        traj.finish_reason = traj.finish_reason or "stream_closed"
    return traj


def wait_until_ready(base_url: str, token: str, *, timeout_s: float = 60.0) -> bool:
    """Poll the sidecar until it answers (handles Axum bind race)."""
    url = f"{base_url.rstrip('/')}/api/health"
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            r = httpx.get(url, headers={"x-zwork-token": token}, timeout=3.0)
            if r.status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    return False
