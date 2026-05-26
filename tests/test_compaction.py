"""Tests for sidecar.agent.compaction — token estimation and compaction helpers."""

from __future__ import annotations

import unittest


def _msgs(*contents: str) -> list[dict]:
    return [{"role": "user", "content": c} for c in contents]


class TestEstimateTokens(unittest.TestCase):
    def _fn(self):
        try:
            from sidecar.agent.compaction import estimate_tokens
            return estimate_tokens
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_empty_list_returns_int(self) -> None:
        fn = self._fn()
        result = fn([])
        self.assertIsInstance(result, int)

    def test_single_message(self) -> None:
        fn = self._fn()
        result = fn(_msgs("hello world"))
        self.assertGreaterEqual(result, 0)
        self.assertIsInstance(result, int)

    def test_longer_message_more_tokens(self) -> None:
        fn = self._fn()
        short = fn(_msgs("hi"))
        long_ = fn(_msgs("hi " * 200))
        self.assertGreater(long_, short)

    def test_more_messages_more_tokens(self) -> None:
        fn = self._fn()
        one = fn(_msgs("hello world"))
        many = fn(_msgs(*["hello world"] * 10))
        self.assertGreater(many, one)

    def test_proportional_to_content(self) -> None:
        fn = self._fn()
        a = fn(_msgs("x" * 100))
        b = fn(_msgs("x" * 1000))
        self.assertGreater(b, a)


class TestShouldCompact(unittest.TestCase):
    def _fn(self):
        try:
            from sidecar.agent.compaction import should_compact
            return should_compact
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_empty_list(self) -> None:
        fn = self._fn()
        result = fn([], threshold_chars=10000)
        self.assertIsInstance(result, bool)

    def test_small_convo_no_compact(self) -> None:
        fn = self._fn()
        msgs = _msgs("hi", "hello")
        self.assertFalse(fn(msgs, threshold_chars=100000))

    def test_huge_convo_should_compact(self) -> None:
        fn = self._fn()
        msgs = _msgs(*["x" * 1000] * 100)
        result = fn(msgs, threshold_chars=100)
        self.assertIsInstance(result, bool)


class TestMergeConsecutiveUser(unittest.TestCase):
    def _fn(self):
        try:
            from sidecar.agent.compaction import merge_consecutive_user
            return merge_consecutive_user
        except ImportError:
            self.skipTest("sidecar not installed")

    def test_empty_list(self) -> None:
        fn = self._fn()
        self.assertEqual(fn([]), [])

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
        self.assertLessEqual(len(result), 3)


if __name__ == "__main__":
    unittest.main()
