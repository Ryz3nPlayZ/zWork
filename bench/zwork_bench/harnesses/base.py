"""The Harness trait: every competitor (zWork, Claude Code, OpenCode) implements it.

The driver orchestrates container lifecycle, patch extraction, and grading —
those are identical for every harness. A Harness only owns its own
container-internal setup and headless task execution. This separation is what
makes the head-to-head comparison fair: everything outside the harness is
literally the same code path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from ..config import RunConfig


@dataclass
class HarnessRun:
    """Result of one harness executing one task."""

    finish_reason: str = ""  # done | wall_timeout | error | max_turns | stream_closed
    n_turns: int = 0  # best-effort; some harnesses can't count (set 0)
    duration_s: float = 0.0
    errors: list[str] = field(default_factory=list)
    raw_log_path: str = ""  # path to saved stdout/stderr inside the run dir
    # Optional structured trajectory (zWork has rich SSE events; the CLIs don't).
    events: list[dict[str, Any]] = field(default_factory=list)
    assistant_text: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "finish_reason": self.finish_reason,
            "n_turns": self.n_turns,
            "duration_s": round(self.duration_s, 2),
            "errors": self.errors[:10],
            "raw_log_path": self.raw_log_path,
            "assistant_text": self.assistant_text,
            "n_events": len(self.events),
        }


@runtime_checkable
class Harness(Protocol):
    """A coding-agent harness drivable headlessly inside a SWE-bench container.

    Implementations must be picklable (instances live across a process pool),
    so keep them immutable-ish: configure via attributes set at __init__, not
    via methods that mutate state.
    """

    name: str
    """Stable identifier — ``zwork`` | ``claude-code`` | ``opencode``. Used in
    report grouping and run-dir layout."""

    label: str
    """Human-readable name for reports, e.g. ``"zWork"``."""

    def install(self, container_id: str, cfg: RunConfig, api_key: str) -> None:
        """Install + configure the harness inside a freshly-started container.

        Called once per (instance × harness) — the container is exclusive to
        this harness for this run, so install can be invasive. Must leave the
        harness ready to execute :meth:`run_task`. The repo under test is at
        ``/testbed`` (cwd already set); do not modify it.
        """
        ...

    def run_task(
        self,
        container_id: str,
        task_prompt: str,
        cfg: RunConfig,
        run_dir: str,
    ) -> HarnessRun:
        """Execute one task headlessly. Blocks until the harness finishes.

        ``task_prompt`` is the standard SWE-bench wrapper (identical for every
        harness). The harness must edit files under ``/testbed`` and leave
        them in the working tree — the driver collects ``git diff`` afterward.
        Must respect ``cfg.max_turns`` and ``cfg.wall_timeout_s``.
        """
        ...

    def model_selector(self, cfg: RunConfig) -> str:
        """The harness-specific selector string for the run's pinned model.

        Resolved from ``cfg.profile.model_selectors[self.name]`` — every
        harness gets a selector for the *same* upstream snapshot. That's the
        same-LLM guarantee.
        """
        ...
