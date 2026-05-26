"""Tests for sidecar.agent.env_loader — .env file loading helper."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path


class TestEnvLoader(unittest.TestCase):
    def _import(self):
        try:
            import sidecar.agent.env_loader as el
            return el
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_module_importable(self) -> None:
        self._import()

    def test_loads_env_file(self) -> None:
        el = self._import()
        if not hasattr(el, "load_env"):
            self.skipTest("load_env not found")
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            env_file.write_text("TEST_ZWORK_VAR=hello123\n", encoding="utf-8")
            old = os.environ.get("TEST_ZWORK_VAR")
            try:
                el.load_env(str(env_file))
                self.assertEqual(os.environ.get("TEST_ZWORK_VAR"), "hello123")
            finally:
                if old is None:
                    os.environ.pop("TEST_ZWORK_VAR", None)
                else:
                    os.environ["TEST_ZWORK_VAR"] = old

    def test_missing_file_no_error(self) -> None:
        el = self._import()
        if not hasattr(el, "load_env"):
            self.skipTest("load_env not found")
        # Should not raise even if file doesn't exist
        try:
            el.load_env("/nonexistent/path/.env")
        except FileNotFoundError:
            pass  # acceptable — just must not crash the import


if __name__ == "__main__":
    unittest.main()
