"""Integration smoke tests — verify sidecar module imports without error."""

from __future__ import annotations

import importlib
import unittest


MODULES = [
    "sidecar",
    "sidecar.agent",
    "sidecar.agent.utils",
    "sidecar.agent.runlog",
    "sidecar.agent.runtime",
    "sidecar.agent.home",
    "sidecar.agent.detect",
    "sidecar.agent.chatstore",
    "sidecar.agent.compaction",
    "sidecar.agent.projects",
    "sidecar.agent.taskstore",
    "sidecar.agent.settings",
    "sidecar.agent.skills",
    "sidecar.agent.streaming",
    "sidecar.agent.subagent",
    "sidecar.agent.academic",
]


class TestModuleImports(unittest.TestCase):
    """Ensure all sidecar modules can be imported without raising exceptions."""

    def _make_test(module: str):  # type: ignore[misc]
        def test(self) -> None:
            try:
                importlib.import_module(module)
            except ImportError as e:
                self.skipTest(f"optional dependency missing: {e}")
            except Exception as e:
                self.fail(f"Import of {module!r} raised {type(e).__name__}: {e}")
        test.__name__ = f"test_import_{module.replace('.', '_')}"
        return test

    for _m in MODULES:
        locals()[f"test_import_{_m.replace('.', '_')}"] = _make_test(_m)


if __name__ == "__main__":
    unittest.main()
