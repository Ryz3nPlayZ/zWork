"""Tests for sidecar.agent.taskstore — task CRUD and status helpers."""

from __future__ import annotations

import os
import tempfile
import unittest


class TestTaskStore(unittest.TestCase):
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
            import sidecar.agent.taskstore as ts
            return ts
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_create_returns_id(self) -> None:
        ts = self._import()
        task_id = ts.create_task(title="My Task")
        self.assertIsInstance(task_id, str)
        self.assertTrue(task_id)

    def test_get_after_create(self) -> None:
        ts = self._import()
        task_id = ts.create_task(title="Test Task")
        task = ts.get_task(task_id)
        self.assertIsNotNone(task)

    def test_get_missing_returns_none(self) -> None:
        ts = self._import()
        result = ts.get_task("task_does_not_exist")
        self.assertIsNone(result)

    def test_list_tasks_includes_created(self) -> None:
        ts = self._import()
        task_id = ts.create_task(title="Listed Task")
        tasks = ts.list_tasks()
        ids = [t.id if hasattr(t, "id") else t.get("id") for t in tasks]
        self.assertIn(task_id, ids)

    def test_delete_removes_task(self) -> None:
        ts = self._import()
        task_id = ts.create_task(title="Deletable")
        ts.delete_task(task_id)
        self.assertIsNone(ts.get_task(task_id))

    def test_update_task_title(self) -> None:
        ts = self._import()
        task_id = ts.create_task(title="Old Title")
        ts.update_task(task_id, title="New Title")
        task = ts.get_task(task_id)
        title = task.title if hasattr(task, "title") else task.get("title")
        self.assertEqual(title, "New Title")

    def test_complete_task(self) -> None:
        ts = self._import()
        task_id = ts.create_task(title="Complete Me")
        ts.complete_task(task_id)
        task = ts.get_task(task_id)
        completed = task.completed if hasattr(task, "completed") else task.get("completed")
        self.assertTrue(completed)

    def test_reopen_task(self) -> None:
        ts = self._import()
        task_id = ts.create_task(title="Reopen Me")
        ts.complete_task(task_id)
        ts.reopen_task(task_id)
        task = ts.get_task(task_id)
        completed = task.completed if hasattr(task, "completed") else task.get("completed")
        self.assertFalse(completed)


if __name__ == "__main__":
    unittest.main()
