"""Tests for sidecar.agent.projects — project CRUD helpers."""

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

    def test_create_returns_id(self) -> None:
        mod = self._import()
        project_id = mod.create_project(name="Test Project")
        self.assertIsInstance(project_id, str)
        self.assertTrue(project_id)

    def test_get_after_create(self) -> None:
        mod = self._import()
        project_id = mod.create_project(name="My Project")
        project = mod.get_project(project_id)
        self.assertIsNotNone(project)

    def test_get_missing_returns_none(self) -> None:
        mod = self._import()
        result = mod.get_project("nonexistent_project_id")
        self.assertIsNone(result)

    def test_list_projects_includes_created(self) -> None:
        mod = self._import()
        pid = mod.create_project(name="Listed Project")
        projects = mod.list_projects()
        ids = [p.id if hasattr(p, "id") else p.get("id") for p in projects]
        self.assertIn(pid, ids)

    def test_delete_removes_project(self) -> None:
        mod = self._import()
        pid = mod.create_project(name="Temp Project")
        mod.delete_project(pid)
        result = mod.get_project(pid)
        self.assertIsNone(result)

    def test_update_project(self) -> None:
        mod = self._import()
        pid = mod.create_project(name="Before")
        mod.update_project(pid, name="After")
        project = mod.get_project(pid)
        self.assertIsNotNone(project)
        name = project.name if hasattr(project, "name") else project.get("name")
        self.assertEqual(name, "After")


if __name__ == "__main__":
    unittest.main()
