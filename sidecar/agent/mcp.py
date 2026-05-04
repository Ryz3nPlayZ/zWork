"""Model Context Protocol (MCP) client integration.

zWork can use any MCP server — Linear, GitHub, Postgres, Filesystem, etc. —
by listing it in `~/.zwork/mcp.json` (Claude Desktop's config shape). At
startup the manager opens a stdio session per server, fetches its tool
catalog, and registers each tool under the name `mcp__<server>__<tool>`.

The agent's existing tool dispatcher routes anything matching that prefix
through `MCPManager.call_tool`, which proxies to the right session and
returns the structured result.

This module is intentionally narrow:
- stdio transport only (SSE / HTTP can come later)
- one persistent session per server, managed by an asyncio task that
  owns the stdio context manager and serves calls from a queue
- no resource / prompt support yet — only `tools/list` and `tools/call`
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .home import zwork_home

log = logging.getLogger(__name__)


MCP_CONFIG_FILENAME = "mcp.json"
TOOL_PREFIX = "mcp__"


@dataclass
class MCPServerSpec:
    """One MCP server entry from mcp.json."""

    name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True


def mcp_config_path() -> Path:
    return zwork_home() / MCP_CONFIG_FILENAME


def load_config(path: Optional[Path] = None) -> list[MCPServerSpec]:
    """Read mcp.json and return validated server specs.

    Schema (Claude Desktop compatible):

        {
          "mcpServers": {
            "name": {
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
              "env": {"FOO": "bar"},
              "enabled": true
            }
          }
        }

    `enabled` defaults to true. Entries with missing or non-string `command`
    are skipped (with a log line) so a single broken row doesn't break the
    whole file.
    """
    p = path or mcp_config_path()
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("mcp.json could not be parsed: %s", e)
        return []
    servers = raw.get("mcpServers") if isinstance(raw, dict) else None
    if not isinstance(servers, dict):
        return []
    out: list[MCPServerSpec] = []
    for name, entry in servers.items():
        if not isinstance(name, str) or not name:
            continue
        if not isinstance(entry, dict):
            continue
        command = entry.get("command")
        if not isinstance(command, str) or not command:
            log.warning("mcp.json: server %r has no command, skipping", name)
            continue
        args_raw = entry.get("args") or []
        env_raw = entry.get("env") or {}
        args = [str(a) for a in args_raw] if isinstance(args_raw, list) else []
        env = (
            {str(k): str(v) for k, v in env_raw.items()}
            if isinstance(env_raw, dict)
            else {}
        )
        enabled = bool(entry.get("enabled", True))
        out.append(MCPServerSpec(name=name, command=command, args=args, env=env, enabled=enabled))
    return out


def prefixed_tool_name(server: str, tool: str) -> str:
    return f"{TOOL_PREFIX}{server}__{tool}"


def split_tool_name(prefixed: str) -> Optional[tuple[str, str]]:
    """Reverse of `prefixed_tool_name`. Returns (server, tool) or None.

    Server names are themselves arbitrary strings, so we split on the FIRST
    `__` after the prefix and treat the rest as the tool name.
    """
    if not prefixed.startswith(TOOL_PREFIX):
        return None
    rest = prefixed[len(TOOL_PREFIX):]
    sep = rest.find("__")
    if sep <= 0 or sep >= len(rest) - 2:
        return None
    return rest[:sep], rest[sep + 2:]


# ---------------- Per-server session ----------------


class _Session:
    """Owns one MCP stdio session and serves tool calls from a queue.

    Why a queue: the `mcp.client.stdio.stdio_client` and `ClientSession`
    are async context managers. Trying to enter them once and exit them
    later from a different task triggers anyio cancel-scope errors. The
    cleanest cross-version approach is to keep them inside one long-lived
    task that pulls work items off an asyncio.Queue.
    """

    def __init__(self, spec: MCPServerSpec) -> None:
        self.spec = spec
        self.tools: list[dict] = []
        self.error: Optional[str] = None
        self.ready = asyncio.Event()
        self._queue: asyncio.Queue = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"mcp-{self.spec.name}")

    async def stop(self) -> None:
        if self._task and not self._task.done():
            await self._queue.put(("__stop__", None, None))
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except asyncio.TimeoutError:
                self._task.cancel()
            except Exception:
                pass

    async def call_tool(self, tool_name: str, args: dict) -> dict:
        if not self.ready.is_set():
            await asyncio.wait_for(self.ready.wait(), timeout=10.0)
        if self.error:
            return {"isError": True, "content": [{"type": "text", "text": self.error}]}
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        await self._queue.put(("__call__", tool_name, (args, future)))
        return await asyncio.wait_for(future, timeout=120.0)

    async def _run(self) -> None:
        # Late imports keep zWork bootable even if `mcp` isn't installed
        # (e.g. during unit tests that don't exercise the manager).
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        env = dict(os.environ)
        env.update(self.spec.env)
        params = StdioServerParameters(
            command=self.spec.command, args=self.spec.args, env=env
        )
        try:
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    self.tools = [
                        {
                            "name": t.name,
                            "description": t.description or "",
                            "input_schema": t.inputSchema or {"type": "object"},
                        }
                        for t in listed.tools
                    ]
                    self.ready.set()
                    while True:
                        kind, name, payload = await self._queue.get()
                        if kind == "__stop__":
                            return
                        if kind == "__call__":
                            args, future = payload
                            try:
                                result = await session.call_tool(name, arguments=args)
                                future.set_result(_serialize_call_result(result))
                            except Exception as e:  # noqa: BLE001
                                future.set_result(
                                    {
                                        "isError": True,
                                        "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}],
                                    }
                                )
        except Exception as e:  # noqa: BLE001
            self.error = f"failed to start MCP server {self.spec.name!r}: {e}"
            log.warning(self.error)
            self.ready.set()


def _serialize_call_result(result: Any) -> dict:
    """Convert an `mcp` CallToolResult into a plain dict."""
    content_objs = getattr(result, "content", None) or []
    content: list[dict] = []
    for c in content_objs:
        kind = getattr(c, "type", None)
        if kind == "text":
            content.append({"type": "text", "text": getattr(c, "text", "")})
        else:
            # Best-effort serialization for non-text content (image, resource).
            content.append({"type": kind or "unknown", "value": str(c)})
    return {"isError": bool(getattr(result, "isError", False)), "content": content}


# ---------------- Manager ----------------


class MCPManager:
    """Owns the set of running MCP sessions for the zWork sidecar."""

    def __init__(self) -> None:
        self._sessions: dict[str, _Session] = {}

    async def start(self, specs: Optional[list[MCPServerSpec]] = None) -> None:
        if specs is None:
            specs = load_config()
        for spec in specs:
            if not spec.enabled:
                continue
            if spec.name in self._sessions:
                continue
            sess = _Session(spec)
            self._sessions[spec.name] = sess
            await sess.start()

    async def stop(self) -> None:
        await asyncio.gather(
            *(s.stop() for s in self._sessions.values()), return_exceptions=True
        )
        self._sessions.clear()

    def status(self) -> list[dict]:
        rows: list[dict] = []
        for name, sess in self._sessions.items():
            rows.append(
                {
                    "name": name,
                    "command": sess.spec.command,
                    "args": list(sess.spec.args),
                    "ready": sess.ready.is_set() and not sess.error,
                    "error": sess.error,
                    "tool_count": len(sess.tools),
                }
            )
        return rows

    def all_tool_schemas(self) -> list[dict]:
        """Return MCP tools as zWork-shaped TOOL_SCHEMAS entries (with prefix)."""
        out: list[dict] = []
        for name, sess in self._sessions.items():
            if sess.error or not sess.ready.is_set():
                continue
            for t in sess.tools:
                out.append(
                    {
                        "name": prefixed_tool_name(name, t["name"]),
                        "description": t["description"] or f"MCP tool {t['name']} on {name}",
                        "parameters": t["input_schema"],
                    }
                )
        return out

    async def call_tool(self, prefixed_name: str, args: dict) -> dict:
        parts = split_tool_name(prefixed_name)
        if not parts:
            return {
                "isError": True,
                "content": [{"type": "text", "text": f"not an MCP tool name: {prefixed_name}"}],
            }
        server, tool = parts
        sess = self._sessions.get(server)
        if not sess:
            return {
                "isError": True,
                "content": [{"type": "text", "text": f"unknown MCP server: {server}"}],
            }
        return await sess.call_tool(tool, args)


_manager: Optional[MCPManager] = None


def get_manager() -> MCPManager:
    """Module-level singleton — same lifecycle as the FastAPI app."""
    global _manager
    if _manager is None:
        _manager = MCPManager()
    return _manager
