"""Composio integration: connect user apps (Gmail, Calendar, Slack, etc.)
and expose their actions as tools prefixed ``composio__``.

All Composio API calls are proxied through the zWork cloud server
(api.tryzwork.app) so the platform API key never touches the client.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

log = logging.getLogger(__name__)

TOOL_PREFIX = "composio__"

COMPOSIO_CLOUD_BASE = os.environ.get(
    "ZWORK_CLOUD_API_BASE", "https://api.tryzwork.app/api/composio"
)

APP_DISPLAY: dict[str, dict[str, str]] = {
    "gmail": {"name": "Gmail", "icon": "mail", "color": "#EA4335"},
    "googlecalendar": {
        "name": "Google Calendar",
        "icon": "calendar",
        "color": "#4285F4",
    },
    "slack": {"name": "Slack", "icon": "hash", "color": "#4A154B"},
    "notion": {"name": "Notion", "icon": "book-open", "color": "#000000"},
    "googledrive": {"name": "Google Drive", "icon": "folder", "color": "#0F9D58"},
    "github": {"name": "GitHub", "icon": "git-branch", "color": "#24292F"},
    "jira": {"name": "Jira", "icon": "layers", "color": "#0052CC"},
    "trello": {"name": "Trello", "icon": "layout-grid", "color": "#0079BF"},
    "todoist": {"name": "Todoist", "icon": "check-square", "color": "#E44332"},
    "linear": {"name": "Linear", "icon": "zap", "color": "#5E6AD2"},
    "asana": {"name": "Asana", "icon": "target", "color": "#F06A6A"},
    "hubspot": {"name": "HubSpot", "icon": "circle-dot", "color": "#FF7A59"},
}


def _get_cloud_token() -> str:
    """Load the zWork cloud auth token from settings."""
    try:
        from . import settings as settings_mod

        s = settings_mod.load()
        keys = s.api_keys or {}
        return keys.get("zwork_router", "")
    except Exception:
        return ""


class ComposioManager:
    def __init__(self) -> None:
        self._enabled: bool = False
        self._connected_apps: list[str] = []
        self._tool_cache: list[dict] = []
        self._initialized: bool = False
        self._cloud_token: str = ""

    def _headers(self) -> dict:
        token = self._cloud_token or _get_cloud_token()
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def initialize(self) -> None:
        self._cloud_token = _get_cloud_token()
        self._initialized = True
        await self._refresh_status()

    @property
    def is_available(self) -> bool:
        if not self._initialized:
            return False
        if self._enabled:
            return True
        token = self._cloud_token or _get_cloud_token()
        if token:
            self._enabled = True
            return True
        return False

    def all_tool_schemas(self) -> list[dict]:
        if not self.is_available:
            return []
        return list(self._tool_cache)

    async def call_tool(self, prefixed_name: str, params: dict) -> dict:
        if not prefixed_name.startswith(TOOL_PREFIX):
            return {
                "isError": True,
                "content": [
                    {"type": "text", "text": f"not a Composio tool: {prefixed_name}"}
                ],
            }
        slug = prefixed_name[len(TOOL_PREFIX) :]
        if not self.is_available:
            return {
                "isError": True,
                "content": [{"type": "text", "text": "Composio is not configured"}],
            }
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{COMPOSIO_CLOUD_BASE}/tools/execute/{slug}",
                    headers=self._headers(),
                    json=params,
                )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            log.warning("composio call_tool(%s) proxy failed: %s", slug, e)
            return {
                "isError": True,
                "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}],
            }

    async def get_connect_link(self, app_name: str) -> dict:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"{COMPOSIO_CLOUD_BASE}/connect",
                    headers=self._headers(),
                    json={"app": app_name},
                )
            resp.raise_for_status()
            return resp.json()
        except httpx.TimeoutError:
            raise RuntimeError(f"Timeout connecting to {app_name}") from None
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"Failed to get connect link for {app_name}: {e.response.status_code}"
            ) from None

    async def get_connected_accounts(self) -> list[dict]:
        if not self.is_available:
            return []
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    f"{COMPOSIO_CLOUD_BASE}/accounts",
                    headers=self._headers(),
                )
            resp.raise_for_status()
            data = resp.json()
            accounts = data.get("accounts", [])
            active = [a["app"] for a in accounts if a.get("status") == "ACTIVE"]
            if active != self._connected_apps:
                self._connected_apps = active
                await self._refresh_tool_cache()
            return accounts
        except Exception as e:
            log.warning("composio get_connected_accounts proxy failed: %s", e)
            return []

    async def disconnect(self, app_name: str) -> None:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"{COMPOSIO_CLOUD_BASE}/disconnect",
                    headers=self._headers(),
                    json={"app": app_name},
                )
            resp.raise_for_status()
            data = resp.json()
            self._connected_apps = data.get("connected_apps", [])
            await self._refresh_tool_cache()
        except httpx.TimeoutError:
            raise RuntimeError(f"Timeout disconnecting {app_name}") from None
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"Failed to disconnect {app_name}: {e.response.status_code}"
            ) from None

    async def _refresh_status(self) -> None:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{COMPOSIO_CLOUD_BASE}/status",
                    headers=self._headers(),
                )
            if resp.status_code == 200:
                data = resp.json()
                self._enabled = data.get("available", False)
            await self.get_connected_accounts()
        except httpx.TimeoutError:
            log.debug("composio _refresh_status timed out")
        except httpx.HTTPError as e:
            log.debug("composio _refresh_status failed: %s", e)

    async def _refresh_tool_cache(self) -> None:
        if not self.is_available:
            self._tool_cache = []
            return
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    f"{COMPOSIO_CLOUD_BASE}/tools",
                    headers=self._headers(),
                )
            resp.raise_for_status()
            data = resp.json()
            self._tool_cache = data.get("tools", [])
            self._connected_apps = data.get("connected_apps", self._connected_apps)
            log.info(
                "composio: cached %d tools for apps %s",
                len(self._tool_cache),
                self._connected_apps,
            )
        except Exception as e:
            log.warning("composio tool cache refresh failed: %s", e)

    def status(self) -> dict:
        token = self._cloud_token or _get_cloud_token()
        return {
            "enabled": self._enabled,
            "configured": bool(token),
            "available": self.is_available,
            "connected_apps": list(self._connected_apps),
            "tool_count": len(self._tool_cache),
            "user_id": "",
        }

    def set_api_key(self, key: str) -> None:
        """No-op: API key is managed server-side now."""

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled


_manager: Optional[ComposioManager] = None


def get_manager() -> ComposioManager:
    global _manager
    if _manager is None:
        _manager = ComposioManager()
    return _manager
