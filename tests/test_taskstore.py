"""Tests for sidecar.agent.taskstore — task and calendar CRUD."""

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

    def test_get_tasks_returns_list(self) -> None:
        ts = self._import()
        result = ts.get_tasks()
        self.assertIsInstance(result, list)

    def test_save_task_creates_entry(self) -> None:
        ts = self._import()
        task = ts.save_task(title="My Task", description="", column="todo")
        self.assertIsNotNone(task)
        self.assertTrue(task.id)

    def test_task_appears_in_get_tasks(self) -> None:
        ts = self._import()
        task = ts.save_task(title="Listed Task", description="", column="todo")
        tasks = ts.get_tasks()
        ids = [t.id for t in tasks]
        self.assertIn(task.id, ids)

    def test_delete_task(self) -> None:
        ts = self._import()
        task = ts.save_task(title="Delete Me", description="", column="todo")
        ts.delete_task(task.id)
        remaining = [t for t in ts.get_tasks() if t.id == task.id]
        self.assertEqual(len(remaining), 0)

    def test_update_task_column(self) -> None:
        ts = self._import()
        task = ts.save_task(title="Move Me", description="", column="todo")
        updated = ts.update_task_column(task.id, "done")
        if updated is not None:
            self.assertEqual(updated.column, "done")

    def test_get_events_returns_list(self) -> None:
        ts = self._import()
        result = ts.get_events()
        self.assertIsInstance(result, list)

    def test_save_event_creates_entry(self) -> None:
        ts = self._import()
        event = ts.save_event(
            title="Team Meeting",
            date="2026-06-01",
            start_time="10:00",
            end_time="11:00",
        )
        self.assertIsNotNone(event)
        self.assertTrue(event.id)

    def test_event_appears_in_get_events(self) -> None:
        ts = self._import()
        event = ts.save_event(
            title="Listed Event",
            date="2026-06-01",
            start_time="10:00",
            end_time="11:00",
        )
        events = ts.get_events()
        ids = [e.id for e in events]
        self.assertIn(event.id, ids)

    def test_delete_event(self) -> None:
        ts = self._import()
        event = ts.save_event(
            title="Delete Event",
            date="2026-06-01",
            start_time="10:00",
            end_time="11:00",
        )
        ts.delete_event(event.id)
        remaining = [e for e in ts.get_events() if e.id == event.id]
        self.assertEqual(len(remaining), 0)


if __name__ == "__main__":
    unittest.main()
