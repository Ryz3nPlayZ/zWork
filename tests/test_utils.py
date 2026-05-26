"""Tests for sidecar.agent.utils — now_ms, uid, new_id."""

from __future__ import annotations

import time
import unittest


class TestNowMs(unittest.TestCase):
    def test_returns_int(self) -> None:
        result = None
        try:
            from sidecar.agent.utils import now_ms
            result = now_ms()
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertIsInstance(result, int)

    def test_approximate_current_time(self) -> None:
        try:
            from sidecar.agent.utils import now_ms
        except ImportError:
            self.skipTest("sidecar not installed")
        before = int(time.time() * 1000)
        result = now_ms()
        after = int(time.time() * 1000)
        self.assertGreaterEqual(result, before)
        self.assertLessEqual(result, after + 5)

    def test_monotonically_non_decreasing(self) -> None:
        try:
            from sidecar.agent.utils import now_ms
        except ImportError:
            self.skipTest("sidecar not installed")
        a = now_ms()
        b = now_ms()
        self.assertGreaterEqual(b, a)


class TestUid(unittest.TestCase):
    def test_returns_string(self) -> None:
        try:
            from sidecar.agent.utils import uid
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertIsInstance(uid(), str)

    def test_length_12(self) -> None:
        try:
            from sidecar.agent.utils import uid
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertEqual(len(uid()), 12)

    def test_hex_characters_only(self) -> None:
        try:
            from sidecar.agent.utils import uid
        except ImportError:
            self.skipTest("sidecar not installed")
        result = uid()
        self.assertTrue(all(c in "0123456789abcdef" for c in result), repr(result))

    def test_unique_values(self) -> None:
        try:
            from sidecar.agent.utils import uid
        except ImportError:
            self.skipTest("sidecar not installed")
        results = {uid() for _ in range(100)}
        self.assertEqual(len(results), 100)


class TestNewId(unittest.TestCase):
    def test_prefix_present(self) -> None:
        try:
            from sidecar.agent.utils import new_id
        except ImportError:
            self.skipTest("sidecar not installed")
        result = new_id("chat")
        self.assertTrue(result.startswith("chat_"), repr(result))

    def test_format(self) -> None:
        try:
            from sidecar.agent.utils import new_id
        except ImportError:
            self.skipTest("sidecar not installed")
        result = new_id("run")
        parts = result.split("_")
        self.assertEqual(parts[0], "run")
        self.assertEqual(len(parts[1]), 16)

    def test_unique_values(self) -> None:
        try:
            from sidecar.agent.utils import new_id
        except ImportError:
            self.skipTest("sidecar not installed")
        results = {new_id("x") for _ in range(50)}
        self.assertEqual(len(results), 50)


if __name__ == "__main__":
    unittest.main()
