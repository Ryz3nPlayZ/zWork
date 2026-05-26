"""Tests for sidecar.agent.chatstore — chat CRUD and message management."""

from __future__ import annotations

import os
import tempfile
import unittest


class TestChatStore(unittest.TestCase):
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
            import sidecar.agent.chatstore as cs
            return cs
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_create_returns_chat(self) -> None:
        cs = self._import()
        chat = cs.create()
        self.assertIsNotNone(chat)
        self.assertTrue(chat.id)

    def test_create_has_id_string(self) -> None:
        cs = self._import()
        chat = cs.create()
        self.assertIsInstance(chat.id, str)

    def test_get_after_create(self) -> None:
        cs = self._import()
        chat = cs.create()
        fetched = cs.get(chat.id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.id, chat.id)

    def test_get_missing_returns_none(self) -> None:
        cs = self._import()
        result = cs.get("does_not_exist_xyz")
        self.assertIsNone(result)

    def test_list_all_includes_created(self) -> None:
        cs = self._import()
        chat = cs.create()
        chats = cs.list_all()
        ids = [c.get("id") if isinstance(c, dict) else c.id for c in chats]
        self.assertIn(chat.id, ids)

    def test_delete_removes_chat(self) -> None:
        cs = self._import()
        chat = cs.create()
        cs.delete(chat.id)
        self.assertIsNone(cs.get(chat.id))

    def test_append_message_returns_message(self) -> None:
        cs = self._import()
        chat = cs.create()
        msg = cs.append_message(chat.id, "user", "hello")
        self.assertIsNotNone(msg)

    def test_append_message_stored(self) -> None:
        cs = self._import()
        chat = cs.create()
        cs.append_message(chat.id, "user", "hello world")
        refreshed = cs.get(chat.id)
        self.assertIsNotNone(refreshed)
        contents = [m.content if hasattr(m, "content") else m.get("content") for m in refreshed.messages]
        self.assertIn("hello world", contents)

    def test_multiple_messages_stored(self) -> None:
        cs = self._import()
        chat = cs.create()
        for i in range(3):
            cs.append_message(chat.id, "user", f"msg {i}")
        refreshed = cs.get(chat.id)
        self.assertEqual(len(refreshed.messages), 3)

    def test_rename_updates_title(self) -> None:
        cs = self._import()
        chat = cs.create(title="Old Title")
        updated = cs.rename(chat.id, "New Title")
        self.assertIsNotNone(updated)
        self.assertEqual(updated.title, "New Title")


if __name__ == "__main__":
    unittest.main()
