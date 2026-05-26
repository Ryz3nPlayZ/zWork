"""Tests for sidecar.agent.projects — project CRUD operations."""

from __future__ import annotations

import os
import tempfile
import unittest


class TestProjects(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp()
        self._old_home = os.environ.get("ZWORK_HOME")
        os.environ["ZWORK_HOME"] = self._tmp

    def tearDown(self) -> None:
        if self._old_home is None:
            os.environ.pop("ZWORK_HOME", None)
        else:
            os.environ["ZWORK_HOME"] = self._old_home

    def _import(self):
        try:
            import sidecar.agent.projects as p
            return p
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_create_returns_project(self) -> None:
        mod = self._import()
        project = mod.create("Test Project")
        self.assertIsNotNone(project)
        self.assertTrue(project.id)

    def test_create_has_name(self) -> None:
        mod = self._import()
        project = mod.create("Named Project")
        self.assertEqual(project.name, "Named Project")

    def test_get_after_create(self) -> None:
        mod = self._import()
        project = mod.create("My Project")
        fetched = mod.get(project.id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.id, project.id)

    def test_get_missing_returns_none(self) -> None:
        mod = self._import()
        result = mod.get("nonexistent_project_id_xyz")
        self.assertIsNone(result)

    def test_list_all_includes_created(self) -> None:
        mod = self._import()
        project = mod.create("Listed Project")
        projects = mod.list_all()
        ids = [p.get("id") if isinstance(p, dict) else p.id for p in projects]
        self.assertIn(project.id, ids)

    def test_delete_removes_project(self) -> None:
        mod = self._import()
        project = mod.create("Temp Project")
        mod.delete(project.id)
        self.assertIsNone(mod.get(project.id))

    def test_update_project_name(self) -> None:
        mod = self._import()
        project = mod.create("Before")
        mod.update(project.id, name="After")
        fetched = mod.get(project.id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.name, "After")

    def test_set_and_get_context(self) -> None:
        mod = self._import()
        project = mod.create("Ctx Project")
        mod.set_context(project.id, "some context")
        ctx = mod.get_context(project.id)
        self.assertEqual(ctx, "some context")


if __name__ == "__main__":
    unittest.main()
