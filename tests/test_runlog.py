"""Tests for sidecar.agent.runlog — JSONL event logging."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path


class TestRunlog(unittest.TestCase):
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
            import sidecar.agent.runlog as rl
            return rl
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_append_creates_file(self) -> None:
        rl = self._import()
        rl.append("run_001", "test_event", key="value")
        path = rl._path("run_001")
        self.assertTrue(path.exists())

    def test_append_valid_json(self) -> None:
        rl = self._import()
        rl.append("run_002", "msg", content="hello")
        path = rl._path("run_002")
        lines = path.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 1)
        record = json.loads(lines[0])
        self.assertEqual(record["event"], "msg")
        self.assertEqual(record["content"], "hello")

    def test_append_multiple_lines(self) -> None:
        rl = self._import()
        rl.append("run_003", "ev1")
        rl.append("run_003", "ev2")
        rl.append("run_003", "ev3")
        path = rl._path("run_003")
        lines = path.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 3)

    def test_timestamp_present(self) -> None:
        rl = self._import()
        rl.append("run_004", "ts_test")
        path = rl._path("run_004")
        record = json.loads(path.read_text(encoding="utf-8").strip())
        self.assertIn("ts", record)
        self.assertIsInstance(record["ts"], int)

    def test_sanitize_truncates_long_string(self) -> None:
        rl = self._import()
        long_val = "x" * 5000
        sanitized = rl._sanitize(long_val)
        self.assertLessEqual(len(sanitized), 4020)
        self.assertIn("truncated", sanitized)

    def test_sanitize_strips_null_bytes(self) -> None:
        rl = self._import()
        val = "hello\x00world"
        result = rl._sanitize(val)
        self.assertNotIn("\x00", result)

    def test_sanitize_nested_dict(self) -> None:
        rl = self._import()
        val = {"a": {"b": "c"}}
        result = rl._sanitize(val)
        self.assertEqual(result, {"a": {"b": "c"}})

    def test_sanitize_list(self) -> None:
        rl = self._import()
        val = ["a", "b", "c"]
        result = rl._sanitize(val)
        self.assertEqual(result, ["a", "b", "c"])

    def test_path_returns_path_instance(self) -> None:
        rl = self._import()
        p = rl._path("run_xyz")
        self.assertIsInstance(p, Path)
        self.assertEqual(p.suffix, ".jsonl")


if __name__ == "__main__":
    unittest.main()
