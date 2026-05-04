"""Tests for Anthropic prompt-caching helpers."""
import unittest

from sidecar.agent.providers import _apply_anthropic_cache, _max_tokens_for


class TestApplyAnthropicCache(unittest.TestCase):
    def test_system_becomes_block_with_cache_control(self) -> None:
        system_blocks, _ = _apply_anthropic_cache("you are a helpful assistant", [])
        self.assertEqual(len(system_blocks), 1)
        self.assertEqual(system_blocks[0]["type"], "text")
        self.assertEqual(system_blocks[0]["text"], "you are a helpful assistant")
        self.assertEqual(
            system_blocks[0]["cache_control"], {"type": "ephemeral"}
        )

    def test_empty_system_returns_empty_list(self) -> None:
        # An empty system prompt shouldn't take a cache slot — Anthropic only
        # supports 4 per request and we want to leave headroom.
        system_blocks, _ = _apply_anthropic_cache("", [])
        self.assertEqual(system_blocks, [])

    def test_tools_get_cache_control_on_last(self) -> None:
        tools = [
            {"name": "a", "description": "first", "input_schema": {}},
            {"name": "b", "description": "second", "input_schema": {}},
            {"name": "c", "description": "third", "input_schema": {}},
        ]
        _, tools_out = _apply_anthropic_cache("sys", tools)
        self.assertEqual(len(tools_out), 3)
        self.assertNotIn("cache_control", tools_out[0])
        self.assertNotIn("cache_control", tools_out[1])
        self.assertEqual(tools_out[2]["cache_control"], {"type": "ephemeral"})

    def test_empty_tools_returns_empty(self) -> None:
        _, tools_out = _apply_anthropic_cache("sys", [])
        self.assertEqual(tools_out, [])

    def test_does_not_mutate_input_tools(self) -> None:
        tools = [{"name": "a", "description": "x", "input_schema": {}}]
        _apply_anthropic_cache("sys", tools)
        # The original list of tools should be untouched — callers reuse them
        # and a hidden cache_control would surprise them.
        self.assertNotIn("cache_control", tools[0])


class TestMaxTokensFor(unittest.TestCase):
    def test_sonnet_4_64k(self) -> None:
        self.assertEqual(_max_tokens_for("claude-sonnet-4-5"), 64000)
        self.assertEqual(_max_tokens_for("claude-sonnet-4-20250514"), 64000)

    def test_opus_4_64k(self) -> None:
        self.assertEqual(_max_tokens_for("claude-opus-4-20250514"), 64000)

    def test_claude_3_5_8k(self) -> None:
        self.assertEqual(_max_tokens_for("claude-3-5-sonnet-20241022"), 8192)

    def test_other_claude_8k(self) -> None:
        self.assertEqual(_max_tokens_for("claude-3-haiku-20240307"), 8192)

    def test_openai_default(self) -> None:
        self.assertEqual(_max_tokens_for("gpt-4o-mini"), 16384)

    def test_empty_default(self) -> None:
        self.assertEqual(_max_tokens_for(""), 16384)


if __name__ == "__main__":
    unittest.main()
