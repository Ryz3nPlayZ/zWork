"""Tests for the MCP config loader, name encoding, and manager status."""
import asyncio
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sidecar.agent.mcp import (
    MCPManager,
    MCPServerSpec,
    load_config,
    prefixed_tool_name,
    split_tool_name,
)


class TestPrefixedNames(unittest.TestCase):
    def test_round_trip_simple(self) -> None:
        self.assertEqual(prefixed_tool_name("linear", "create"), "mcp__linear__create")
        self.assertEqual(split_tool_name("mcp__linear__create"), ("linear", "create"))

    def test_tool_name_with_double_underscore(self) -> None:
        # The split is on the FIRST `__` after the prefix; tool names that
        # themselves contain `__` (rare but legal) are preserved on the right.
        encoded = prefixed_tool_name("svc", "list__items")
        self.assertEqual(encoded, "mcp__svc__list__items")
        self.assertEqual(split_tool_name(encoded), ("svc", "list__items"))

    def test_split_rejects_non_mcp_names(self) -> None:
        self.assertIsNone(split_tool_name("read_file"))
        self.assertIsNone(split_tool_name(""))
        self.assertIsNone(split_tool_name("mcp__"))
        self.assertIsNone(split_tool_name("mcp__servername_only"))


class TestLoadConfig(unittest.TestCase):
    def _write(self, payload: dict) -> Path:
        td = TemporaryDirectory()
        self.addCleanup(td.cleanup)
        path = Path(td.name) / "mcp.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_missing_file_returns_empty(self) -> None:
        # Pointing at a path that doesn't exist must not raise — config is
        # optional, the user might not have set one up yet.
        path = Path("/tmp/zwork-mcp-test-nonexistent-xyz123.json")
        self.assertFalse(path.exists())
        self.assertEqual(load_config(path), [])

    def test_basic_claude_desktop_shape(self) -> None:
        path = self._write({
            "mcpServers": {
                "linear": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-linear"],
                    "env": {"LINEAR_API_KEY": "lin_xxx"},
                }
            }
        })
        specs = load_config(path)
        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0].name, "linear")
        self.assertEqual(specs[0].command, "npx")
        self.assertEqual(specs[0].args, ["-y", "@modelcontextprotocol/server-linear"])
        self.assertEqual(specs[0].env, {"LINEAR_API_KEY": "lin_xxx"})
        self.assertTrue(specs[0].enabled)

    def test_enabled_false_is_kept_in_list(self) -> None:
        # Disabled rows still come back; the manager filters at start time.
        # Keeping them makes /api/mcp/servers list show them.
        path = self._write({
            "mcpServers": {
                "off": {"command": "echo", "args": ["hi"], "enabled": False}
            }
        })
        specs = load_config(path)
        self.assertEqual(len(specs), 1)
        self.assertFalse(specs[0].enabled)

    def test_skips_invalid_rows(self) -> None:
        path = self._write({
            "mcpServers": {
                "good": {"command": "npx", "args": []},
                "no_command": {"args": ["foo"]},
                "bad_command_type": {"command": 42},
                "": {"command": "x"},
            }
        })
        specs = load_config(path)
        names = sorted(s.name for s in specs)
        self.assertEqual(names, ["good"])

    def test_malformed_json_returns_empty(self) -> None:
        td = TemporaryDirectory()
        self.addCleanup(td.cleanup)
        path = Path(td.name) / "mcp.json"
        path.write_text("{not valid json", encoding="utf-8")
        self.assertEqual(load_config(path), [])

    def test_args_and_env_coerced_to_strings(self) -> None:
        # Common authoring footgun: pasting an integer port into args. Coerce.
        path = self._write({
            "mcpServers": {
                "x": {
                    "command": "node",
                    "args": ["server.js", 8080],
                    "env": {"PORT": 8080},
                }
            }
        })
        specs = load_config(path)
        self.assertEqual(specs[0].args, ["server.js", "8080"])
        self.assertEqual(specs[0].env, {"PORT": "8080"})


class TestManagerStatusEmpty(unittest.TestCase):
    def test_status_on_fresh_manager(self) -> None:
        # No specs started → empty status, no exceptions.
        m = MCPManager()
        self.assertEqual(m.status(), [])
        self.assertEqual(m.all_tool_schemas(), [])

    def test_call_unknown_server(self) -> None:
        m = MCPManager()
        result = asyncio.run(m.call_tool("mcp__nope__do", {}))
        self.assertTrue(result["isError"])
        self.assertIn("unknown MCP server", result["content"][0]["text"])

    def test_call_non_mcp_name(self) -> None:
        m = MCPManager()
        result = asyncio.run(m.call_tool("read_file", {}))
        self.assertTrue(result["isError"])
        self.assertIn("not an MCP tool name", result["content"][0]["text"])


class TestServerSpecDefaults(unittest.TestCase):
    def test_minimal_spec(self) -> None:
        spec = MCPServerSpec(name="x", command="echo")
        self.assertEqual(spec.args, [])
        self.assertEqual(spec.env, {})
        self.assertTrue(spec.enabled)


if __name__ == "__main__":
    unittest.main()
