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

    def test_create_returns_id(self) -> None:
        cs = self._import()
        chat_id = cs.create()
        self.assertIsInstance(chat_id, str)
        self.assertTrue(chat_id)

    def test_get_after_create(self) -> None:
        cs = self._import()
        chat_id = cs.create()
        chat = cs.get(chat_id)
        self.assertIsNotNone(chat)

    def test_get_missing_returns_none(self) -> None:
        cs = self._import()
        result = cs.get("does_not_exist_xyz")
        self.assertIsNone(result)

    def test_list_all_includes_created(self) -> None:
        cs = self._import()
        chat_id = cs.create()
        chats = cs.list_all()
        ids = [c.id if hasattr(c, "id") else c.get("id") for c in chats]
        self.assertIn(chat_id, ids)

    def test_delete_removes_chat(self) -> None:
        cs = self._import()
        chat_id = cs.create()
        cs.delete(chat_id)
        self.assertIsNone(cs.get(chat_id))

    def test_append_and_get_messages(self) -> None:
        cs = self._import()
        chat_id = cs.create()
        cs.append_message(chat_id, {"role": "user", "content": "hello"})
        msgs = cs.get_messages(chat_id)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["content"], "hello")

    def test_multiple_messages_ordered(self) -> None:
        cs = self._import()
        chat_id = cs.create()
        for i in range(5):
            cs.append_message(chat_id, {"role": "user", "content": f"msg {i}"})
        msgs = cs.get_messages(chat_id)
        self.assertEqual(len(msgs), 5)
        for i, msg in enumerate(msgs):
            self.assertEqual(msg["content"], f"msg {i}")

    def test_truncate_messages(self) -> None:
        cs = self._import()
        chat_id = cs.create()
        for i in range(5):
            cs.append_message(chat_id, {"role": "user", "content": f"msg {i}"})
        cs.truncate_messages(chat_id, 2)
        msgs = cs.get_messages(chat_id)
        self.assertEqual(len(msgs), 2)


if __name__ == "__main__":
    unittest.main()
