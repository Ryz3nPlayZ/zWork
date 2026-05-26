"""Tests for sidecar.agent.home — path helpers and safe ID validation."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path


class TestZworkHome(unittest.TestCase):
    def test_creates_directory(self) -> None:
        try:
            from sidecar.agent.home import zwork_home
        except ImportError:
            self.skipTest("sidecar not installed")
        with tempfile.TemporaryDirectory() as tmp:
            custom = Path(tmp) / "zwork_test_home"
            old = os.environ.get("ZWORK_HOME")
            try:
                os.environ["ZWORK_HOME"] = str(custom)
                result = zwork_home()
                self.assertTrue(result.exists())
                self.assertEqual(result, custom)
            finally:
                if old is None:
                    os.environ.pop("ZWORK_HOME", None)
                else:
                    os.environ["ZWORK_HOME"] = old

    def test_returns_path_instance(self) -> None:
        try:
            from sidecar.agent.home import zwork_home
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertIsInstance(zwork_home(), Path)


class TestSubdirectoryHelpers(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp()
        self._old_home = os.environ.get("ZWORK_HOME")
        os.environ["ZWORK_HOME"] = self._tmp

    def tearDown(self) -> None:
        if self._old_home is None:
            os.environ.pop("ZWORK_HOME", None)
        else:
            os.environ["ZWORK_HOME"] = self._old_home

    def _import(self, name: str):
        try:
            import sidecar.agent.home as h
            return getattr(h, name)
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_chats_dir_created(self) -> None:
        fn = self._import("chats_dir")
        d = fn()
        self.assertTrue(d.exists())
        self.assertEqual(d.name, "chats")

    def test_runs_dir_created(self) -> None:
        fn = self._import("runs_dir")
        d = fn()
        self.assertTrue(d.exists())
        self.assertEqual(d.name, "runs")

    def test_projects_dir_created(self) -> None:
        fn = self._import("projects_dir")
        d = fn()
        self.assertTrue(d.exists())
        self.assertEqual(d.name, "projects")

    def test_workspace_root_created(self) -> None:
        fn = self._import("workspace_root")
        d = fn()
        self.assertTrue(d.exists())
        self.assertEqual(d.name, "workspace")

    def test_workspace_scratch_created(self) -> None:
        fn = self._import("workspace_scratch_dir")
        d = fn()
        self.assertTrue(d.exists())
        self.assertEqual(d.name, "scratch")

    def test_settings_path_suffix(self) -> None:
        fn = self._import("settings_path")
        p = fn()
        self.assertEqual(p.suffix, ".json")
        self.assertEqual(p.name, "settings.json")

    def test_memory_path_suffix(self) -> None:
        fn = self._import("memory_path")
        p = fn()
        self.assertEqual(p.suffix, ".md")

    def test_project_dir_uses_id(self) -> None:
        fn = self._import("project_dir")
        d = fn("proj_abc123")
        self.assertTrue(d.exists())
        self.assertEqual(d.name, "proj_abc123")


class TestIsSafeId(unittest.TestCase):
    def _fn(self):
        try:
            from sidecar.agent.home import is_safe_id
            return is_safe_id
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_none_is_safe(self) -> None:
        fn = self._fn()
        self.assertTrue(fn(None))

    def test_empty_string_unsafe(self) -> None:
        fn = self._fn()
        self.assertFalse(fn(""))

    def test_alphanumeric_safe(self) -> None:
        fn = self._fn()
        self.assertTrue(fn("chat123"))

    def test_underscore_and_hyphen_safe(self) -> None:
        fn = self._fn()
        self.assertTrue(fn("chat_abc-def"))

    def test_path_traversal_unsafe(self) -> None:
        fn = self._fn()
        self.assertFalse(fn("../etc/passwd"))

    def test_slash_unsafe(self) -> None:
        fn = self._fn()
        self.assertFalse(fn("a/b"))

    def test_dot_unsafe(self) -> None:
        fn = self._fn()
        self.assertFalse(fn("a.b"))

    def test_space_unsafe(self) -> None:
        fn = self._fn()
        self.assertFalse(fn("a b"))


if __name__ == "__main__":
    unittest.main()
