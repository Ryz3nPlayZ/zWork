"""Tests for sidecar.agent.runtime — constants, RunContext, and helpers."""

from __future__ import annotations

import time
import unittest


class TestRuntimeConstants(unittest.TestCase):
    def test_run_timeout_is_positive(self) -> None:
        try:
            from sidecar.agent.runtime import RUN_TIMEOUT_SECONDS
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertGreater(RUN_TIMEOUT_SECONDS, 0)

    def test_turn_timeout_less_than_run_timeout(self) -> None:
        try:
            from sidecar.agent.runtime import RUN_TIMEOUT_SECONDS, TURN_TIMEOUT_SECONDS
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertLess(TURN_TIMEOUT_SECONDS, RUN_TIMEOUT_SECONDS)

    def test_max_tool_calls_positive(self) -> None:
        try:
            from sidecar.agent.runtime import MAX_TOOL_CALLS
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertGreater(MAX_TOOL_CALLS, 0)

    def test_command_timeout_positive(self) -> None:
        try:
            from sidecar.agent.runtime import COMMAND_TIMEOUT_SECONDS
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertGreater(COMMAND_TIMEOUT_SECONDS, 0)

    def test_command_output_cap_positive(self) -> None:
        try:
            from sidecar.agent.runtime import COMMAND_OUTPUT_CAP
        except ImportError:
            self.skipTest("sidecar not installed")
        self.assertGreater(COMMAND_OUTPUT_CAP, 0)


class TestRunContext(unittest.TestCase):
    def _make_ctx(self):
        try:
            from sidecar.agent.runtime import RunContext
        except ImportError:
            self.skipTest("sidecar not installed")
            return None
        return RunContext(
            run_id="run_abc",
            chat_id="chat_xyz",
            requested_model_id="claude-3-5-sonnet",
        )

    def test_initial_tool_calls_zero(self) -> None:
        ctx = self._make_ctx()
        self.assertEqual(ctx.tool_calls, 0)

    def test_initial_turn_index_zero(self) -> None:
        ctx = self._make_ctx()
        self.assertEqual(ctx.turn_index, 0)

    def test_next_tool_call_increments(self) -> None:
        ctx = self._make_ctx()
        ctx.next_tool_call()
        self.assertEqual(ctx.tool_calls, 1)

    def test_next_tool_call_raises_at_limit(self) -> None:
        try:
            from sidecar.agent.runtime import RunContext
        except ImportError:
            self.skipTest("sidecar not installed")
        ctx = RunContext(
            run_id="r",
            chat_id="c",
            requested_model_id="m",
            max_tool_calls=2,
        )
        ctx.next_tool_call()
        ctx.next_tool_call()
        with self.assertRaises(RuntimeError):
            ctx.next_tool_call()

    def test_remaining_seconds_decreases(self) -> None:
        ctx = self._make_ctx()
        first = ctx.remaining_run_seconds()
        time.sleep(0.05)
        second = ctx.remaining_run_seconds()
        self.assertLess(second, first)

    def test_remaining_seconds_non_negative(self) -> None:
        try:
            from sidecar.agent.runtime import RunContext
        except ImportError:
            self.skipTest("sidecar not installed")
        ctx = RunContext(
            run_id="r",
            chat_id="c",
            requested_model_id="m",
            run_timeout_seconds=0.0,
        )
        self.assertEqual(ctx.remaining_run_seconds(), 0.0)

    def test_register_and_unregister_process(self) -> None:
        ctx = self._make_ctx()
        ctx.register_process(12345)
        self.assertIn(12345, ctx._active_processes)
        ctx.unregister_process(12345)
        self.assertNotIn(12345, ctx._active_processes)


class TestCurrentRun(unittest.TestCase):
    def test_current_run_none_outside_scope(self) -> None:
        try:
            from sidecar.agent.runtime import current_run
        except ImportError:
            self.skipTest("sidecar not installed")
        # Outside any run_scope the contextvar should be None
        self.assertIsNone(current_run())


if __name__ == "__main__":
    unittest.main()
