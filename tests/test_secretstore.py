"""Tests for sidecar.agent.secretstore — encrypted secret storage."""

from __future__ import annotations

import os
import tempfile
import unittest


class TestSecretStore(unittest.TestCase):
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
            import sidecar.agent.secretstore as ss
            return ss
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_set_and_get_secret(self) -> None:
        ss = self._import()
        ss.set_secret("mykey", "myvalue")
        result = ss.get_secret("mykey")
        self.assertEqual(result, "myvalue")

    def test_get_missing_returns_none(self) -> None:
        ss = self._import()
        result = ss.get_secret("nonexistent_key_xyz")
        self.assertIsNone(result)

    def test_list_secrets_includes_stored(self) -> None:
        ss = self._import()
        ss.set_secret("listme", "val")
        names = ss.list_secrets()
        self.assertIn("listme", names)

    def test_has_secret_true(self) -> None:
        ss = self._import()
        ss.set_secret("exists", "yes")
        self.assertTrue(ss.has_secret("exists"))

    def test_has_secret_false(self) -> None:
        ss = self._import()
        self.assertFalse(ss.has_secret("not_set_at_all_xyz"))

    def test_delete_secret(self) -> None:
        ss = self._import()
        ss.set_secret("delme", "x")
        ss.delete_secret("delme")
        self.assertIsNone(ss.get_secret("delme"))

    def test_overwrite_secret(self) -> None:
        ss = self._import()
        ss.set_secret("ow", "first")
        ss.set_secret("ow", "second")
        self.assertEqual(ss.get_secret("ow"), "second")


if __name__ == "__main__":
    unittest.main()
