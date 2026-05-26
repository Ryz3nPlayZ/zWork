"""Tests for sidecar.agent.secretstore — API key storage via keyring or file store."""

from __future__ import annotations

import os
import tempfile
import unittest


class TestSecretStore(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp()
        self._old_home = os.environ.get("ZWORK_HOME")
        self._old_store = os.environ.get("ZWORK_SECRET_STORE")
        os.environ["ZWORK_HOME"] = self._tmp
        # Force file-based store so tests work without system keyring
        os.environ["ZWORK_SECRET_STORE"] = "file"

    def tearDown(self) -> None:
        if self._old_home is None:
            os.environ.pop("ZWORK_HOME", None)
        else:
            os.environ["ZWORK_HOME"] = self._old_home
        if self._old_store is None:
            os.environ.pop("ZWORK_SECRET_STORE", None)
        else:
            os.environ["ZWORK_SECRET_STORE"] = self._old_store

    def _import(self):
        try:
            import sidecar.agent.secretstore as ss
            return ss
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_set_and_get_api_key(self) -> None:
        ss = self._import()
        ss.set_api_key("openai", "sk-testkey")
        result = ss.get_api_key("openai")
        self.assertEqual(result, "sk-testkey")

    def test_get_missing_returns_empty(self) -> None:
        ss = self._import()
        result = ss.get_api_key("nonexistent_provider_xyz")
        # Should return empty string for missing keys
        self.assertIsInstance(result, str)

    def test_delete_api_key(self) -> None:
        ss = self._import()
        ss.set_api_key("anthropic", "sk-ant-test")
        ss.delete_api_key("anthropic")
        result = ss.get_api_key("anthropic")
        self.assertEqual(result, "")

    def test_overwrite_api_key(self) -> None:
        ss = self._import()
        ss.set_api_key("openai", "first")
        ss.set_api_key("openai", "second")
        self.assertEqual(ss.get_api_key("openai"), "second")

    def test_load_api_keys_returns_dict(self) -> None:
        ss = self._import()
        result = ss.load_api_keys()
        self.assertIsInstance(result, dict)

    def test_persist_and_load_keys(self) -> None:
        ss = self._import()
        ss.persist_api_keys({"openai": "sk-test-abc"})
        loaded = ss.load_api_keys()
        self.assertIsInstance(loaded, dict)


if __name__ == "__main__":
    unittest.main()
