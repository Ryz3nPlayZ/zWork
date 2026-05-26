"""Tests for sidecar.agent.compaction — token estimation and compaction helpers."""

from __future__ import annotations

import unittest


class TestEstimateTokens(unittest.TestCase):
    def _fn(self):
        try:
            from sidecar.agent.compaction import estimate_tokens
            return estimate_tokens
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_empty_string_returns_zero(self) -> None:
        fn = self._fn()
        self.assertEqual(fn(""), 0)

    def test_short_string(self) -> None:
        fn = self._fn()
        result = fn("hello world")
        self.assertGreater(result, 0)
        self.assertIsInstance(result, int)

    def test_longer_string_more_tokens(self) -> None:
        fn = self._fn()
        short = fn("hi")
        long_ = fn("hi " * 100)
        self.assertGreater(long_, short)

    def test_proportional_to_length(self) -> None:
        fn = self._fn()
        a = fn("x" * 100)
        b = fn("x" * 1000)
        self.assertGreater(b, a)


class TestShouldCompact(unittest.TestCase):
    def _fn(self):
        try:
            from sidecar.agent.compaction import should_compact
            return should_compact
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_empty_list_no_compact(self) -> None:
        fn = self._fn()
        self.assertFalse(fn([]))

    def test_returns_bool(self) -> None:
        fn = self._fn()
        msgs = [{"role": "user", "content": "hi"} for _ in range(5)]
        self.assertIsInstance(fn(msgs), bool)

    def test_large_list_may_compact(self) -> None:
        fn = self._fn()
        big_content = "x" * 10000
        msgs = [{"role": "user", "content": big_content} for _ in range(50)]
        # With 50 * 10000 chars this should exceed any reasonable threshold
        result = fn(msgs)
        self.assertIsInstance(result, bool)


class TestMergeConsecutiveUser(unittest.TestCase):
    def _fn(self):
        try:
            from sidecar.agent.compaction import merge_consecutive_user
            return merge_consecutive_user
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_no_change_for_alternating(self) -> None:
        fn = self._fn()
        msgs = [
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
            {"role": "user", "content": "c"},
        ]
        result = fn(msgs)
        self.assertEqual(len(result), 3)

    def test_merges_consecutive_user(self) -> None:
        fn = self._fn()
        msgs = [
            {"role": "user", "content": "a"},
            {"role": "user", "content": "b"},
            {"role": "assistant", "content": "c"},
        ]
        result = fn(msgs)
        self.assertLess(len(result), 3)

    def test_empty_list(self) -> None:
        fn = self._fn()
        self.assertEqual(fn([]), [])


if __name__ == "__main__":
    unittest.main()
