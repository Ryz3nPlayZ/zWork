"""Tests for the OpenAI-compatible provider retry helpers."""
import unittest

from sidecar.agent.providers import (
    _OPENAI_RETRY_CAP_SECONDS,
    _openai_retry_delay,
    _parse_retry_after_seconds,
)


class TestParseRetryAfter(unittest.TestCase):
    def test_integer_seconds(self) -> None:
        self.assertEqual(_parse_retry_after_seconds("5"), 5.0)

    def test_decimal_seconds(self) -> None:
        self.assertEqual(_parse_retry_after_seconds("1.5"), 1.5)

    def test_whitespace_tolerated(self) -> None:
        self.assertEqual(_parse_retry_after_seconds("  3  "), 3.0)

    def test_empty(self) -> None:
        self.assertIsNone(_parse_retry_after_seconds(""))

    def test_unparseable_http_date(self) -> None:
        # HTTP-date form is rare for LLM providers and we treat it as missing.
        self.assertIsNone(_parse_retry_after_seconds("Wed, 21 Oct 2015 07:28:00 GMT"))

    def test_negative_clamped_to_zero(self) -> None:
        self.assertEqual(_parse_retry_after_seconds("-3"), 0.0)


class TestOpenAIRetryDelay(unittest.TestCase):
    def test_server_hint_within_cap_passes_through(self) -> None:
        self.assertEqual(_openai_retry_delay(0, server_hint=4.0), 4.0)

    def test_server_hint_above_cap_is_clamped(self) -> None:
        self.assertEqual(_openai_retry_delay(0, server_hint=999.0), _OPENAI_RETRY_CAP_SECONDS)

    def test_server_hint_below_floor_is_clamped(self) -> None:
        self.assertEqual(_openai_retry_delay(0, server_hint=0.0), 0.5)

    def test_no_hint_uses_backoff_within_bounds(self) -> None:
        for attempt in range(4):
            delay = _openai_retry_delay(attempt, server_hint=None)
            self.assertGreaterEqual(delay, 0.5)
            self.assertLessEqual(delay, _OPENAI_RETRY_CAP_SECONDS)

    def test_high_attempt_hits_cap(self) -> None:
        # 1.5 * 2^4 = 24, well above the 15s cap.
        self.assertEqual(_openai_retry_delay(4, server_hint=None), _OPENAI_RETRY_CAP_SECONDS)


if __name__ == "__main__":
    unittest.main()
