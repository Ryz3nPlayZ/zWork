"""Harness registry. ``get_harness(name)`` returns a fresh instance.

Adding a competitor (Aider, SWE-agent, …) is: write a module in this package
implementing :class:`base.Harness`, register it here, and add a model-selector
entry to each profile in :mod:`config`. Nothing else changes — the driver,
grader, and report treat all harnesses uniformly.
"""

from __future__ import annotations

from typing import Callable

from .base import Harness, HarnessRun  # re-export
from .claude_code import ClaudeCodeHarness
from .opencode import OpenCodeHarness
from .zwork import ZWorkHarness

# Each factory takes no args; per-run config (e.g. host port for zWork) is set
# by the driver after construction via attributes.
FACTORIES: dict[str, Callable[[], Harness]] = {
    "zwork": ZWorkHarness,
    "claude-code": ClaudeCodeHarness,
    "opencode": OpenCodeHarness,
}

ALL = tuple(FACTORIES.keys())


def get_harness(name: str) -> Harness:
    if name not in FACTORIES:
        raise ValueError(
            f"Unknown harness {name!r}. Known: {sorted(FACTORIES)}"
        )
    return FACTORIES[name]()


__all__ = ["Harness", "HarnessRun", "get_harness", "ALL", "FACTORIES"]
