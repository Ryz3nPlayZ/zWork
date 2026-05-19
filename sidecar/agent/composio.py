"""Composio integration: connect user apps (Gmail, Calendar, Slack, etc.)
and expose their actions as tools prefixed ``composio__``.

Follows the MCPManager singleton pattern in mcp.py.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from .home import zwork_home

log = logging.getLogger(__name__)

TOOL_PREFIX = "composio__"
CONFIG_FILENAME = "composio.json"

APP_DISPLAY: dict[str, dict[str, str]] = {
    "gmail": {"name": "Gmail", "icon": "mail", "color": "#EA4335"},
    "googlecalendar": {"name": "Google Calendar", "icon": "calendar", "color": "#4285F4"},
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

PREFERRED_TOOLS: dict[str, list[str]] = {
    "gmail": [
        "GMAIL_SEND_EMAIL", "GMAIL_READ_EMAILS", "GMAIL_SEARCH_EMAILS",
        "GMAIL_GET_THREAD", "GMAIL_CREATE_DRAFT", "GMAIL_REPLY_TO_EMAIL",
    ],
    "googlecalendar": [
        "GOOGLECALENDAR_CREATE_EVENT", "GOOGLECALENDAR_GET_EVENTS",
        "GOOGLECALENDAR_UPDATE_EVENT", "GOOGLECALENDAR_DELETE_EVENT",
        "GOOGLECALENDAR_LIST_CALENDARS",
    ],
    "slack": [
        "SLACK_SEND_MESSAGE", "SLACK_GET_CHANNEL_MESSAGES",
        "SLACK_CREATE_CHANNEL", "SLACK_ADD_REACTION",
        "SLACK_LIST_CHANNELS", "SLACK_UPDATE_MESSAGE",
    ],
    "notion": [
        "NOTION_CREATE_PAGE", "NOTION_GET_PAGE", "NOTION_UPDATE_PAGE",
        "NOTION_SEARCH_PAGES", "NOTION_CREATE_DATABASE",
        "NOTION_QUERY_DATABASE",
    ],
    "googledrive": [
        "GOOGLEDRIVE_LIST_FILES", "GOOGLEDRIVE_UPLOAD_FILE",
        "GOOGLEDRIVE_DOWNLOAD_FILE", "GOOGLEDRIVE_CREATE_FOLDER",
        "GOOGLEDRIVE_SHARE_FILE",
    ],
    "github": [
        "GITHUB_CREATE_ISSUE", "GITHUB_GET_ISSUE", "GITHUB_LIST_ISSUES",
        "GITHUB_CREATE_PULL_REQUEST", "GITHUB_GET_PULL_REQUEST",
        "GITHUB_LIST_REPOS",
    ],
    "jira": [
        "JIRA_CREATE_ISSUE", "JIRA_GET_ISSUE", "JIRA_UPDATE_ISSUE",
        "JIRA_SEARCH_ISSUES", "JIRA_LIST_PROJECTS",
    ],
    "trello": [
        "TRELLO_CREATE_CARD", "TRELLO_GET_CARD", "TRELLO_UPDATE_CARD",
        "TRELLO_LIST_BOARDS", "TRELLO_LIST_CARDS",
    ],
    "todoist": [
        "TODOIST_CREATE_TASK", "TODOIST_GET_TASK", "TODOIST_UPDATE_TASK",
        "TODOIST_LIST_TASKS", "TODOIST_CREATE_PROJECT",
    ],
    "linear": [
        "LINEAR_CREATE_ISSUE", "LINEAR_GET_ISSUE", "LINEAR_UPDATE_ISSUE",
        "LINEAR_LIST_TEAMS", "LINEAR_SEARCH_ISSUES",
    ],
}


def _config_path() -> Path:
    return zwork_home() / CONFIG_FILENAME


def _load_config() -> dict:
    p = _config_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_config(data: dict) -> None:
    p = _config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _get_api_key() -> str:
    """Load Composio API key. Checks secretstore first, then env var."""
    try:
        from .secretstore import get_api_key as _ss_get
        key = _ss_get("composio")
        if key:
            return key
    except Exception:
        pass
    return os.environ.get("COMPOSIO_API_KEY", "")


def _get_or_create_user_id() -> str:
    cfg = _load_config()
    uid = cfg.get("user_id", "")
    if uid:
        return uid
    uid = uuid.uuid4().hex
    cfg["user_id"] = uid
    _save_config(cfg)
    return uid


class ComposioManager:
    def __init__(self) -> None:
        self._api_key: str = ""
        self._enabled: bool = False
        self._user_id: str = ""
        self._connected_apps: list[str] = []
        self._tool_cache: list[dict] = []
        self._initialized: bool = False

    async def initialize(self) -> None:
        cfg = _load_config()
        api_key = _get_api_key()
        self._api_key = (api_key or "").strip()
        self._enabled = cfg.get("enabled", bool(self._api_key))
        self._user_id = cfg.get("user_id", "") or _get_or_create_user_id()
        self._connected_apps = cfg.get("connected_apps", [])
        self._initialized = True
        if self.is_available and self._connected_apps:
            await self._refresh_tool_cache()

    @property
    def is_available(self) -> bool:
        return self._initialized and self._enabled and bool(self._api_key)

    def all_tool_schemas(self) -> list[dict]:
        if not self.is_available:
            return []
        return list(self._tool_cache)

    async def call_tool(self, prefixed_name: str, params: dict) -> dict:
        if not prefixed_name.startswith(TOOL_PREFIX):
            return {"isError": True, "content": [{"type": "text", "text": f"not a Composio tool: {prefixed_name}"}]}
        slug = prefixed_name[len(TOOL_PREFIX):]
        if not self.is_available:
            return {"isError": True, "content": [{"type": "text", "text": "Composio is not configured"}]}
        try:
            from composio import Composio
            client = Composio(api_key=self._api_key)
            result = client.tools.execute(slug=slug, user_id=self._user_id, params=params)
            text = json.dumps(result, default=str) if result else "ok"
            return {"isError": False, "content": [{"type": "text", "text": text}]}
        except Exception as e:
            log.warning("composio call_tool(%s) failed: %s", slug, e)
            return {"isError": True, "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}]}

    async def get_connect_link(self, app_name: str) -> dict:
        if not self.is_available:
            raise RuntimeError("Composio is not configured")
        from composio import Composio
        client = Composio(api_key=self._api_key)
        toolkit = app_name.upper()
        try:
            link = client.get_connect_link(user_id=self._user_id, toolkits=[toolkit])
            return {"url": str(link.url) if hasattr(link, "url") else str(link)}
        except Exception as e:
            raise RuntimeError(f"Failed to generate connect link for {app_name}: {e}") from e

    async def get_connected_accounts(self) -> list[dict]:
        if not self.is_available:
            return []
        try:
            from composio import Composio
            client = Composio(api_key=self._api_key)
            accounts = client.get_connected_accounts(user_id=self._user_id) or []
            result = []
            for acc in accounts:
                app_id = str(getattr(acc, "appUniqueId", "") or getattr(acc, "app", "") or "").lower()
                status = str(getattr(acc, "status", "UNKNOWN"))
                display = APP_DISPLAY.get(app_id, {})
                result.append({
                    "app": app_id,
                    "status": status,
                    "account_id": str(getattr(acc, "id", "")),
                    "app_name": display.get("name", app_id.title()),
                    "icon": display.get("icon", "plug"),
                    "color": display.get("color", "#6B7280"),
                })
            active = [a["app"] for a in result if a["status"] == "ACTIVE"]
            if active != self._connected_apps:
                self._connected_apps = active
                self._persist_state()
                await self._refresh_tool_cache()
            return result
        except Exception as e:
            log.warning("composio get_connected_accounts failed: %s", e)
            return []

    async def disconnect(self, app_name: str) -> None:
        app_name = app_name.lower()
        if app_name in self._connected_apps:
            self._connected_apps.remove(app_name)
        self._persist_state()
        await self._refresh_tool_cache()

    async def _refresh_tool_cache(self) -> None:
        if not self._connected_apps or not self._api_key:
            self._tool_cache = []
            return
        try:
            from composio import Composio
            client = Composio(api_key=self._api_key)
            all_tools: list[dict] = []
            for app in self._connected_apps:
                whitelist = set(PREFERRED_TOOLS.get(app, []))
                try:
                    tools = client.tools.get(user_id=self._user_id, toolkits=[app.upper()])
                except Exception:
                    continue
                for t in tools or []:
                    slug = str(getattr(t, "slug", "") or "")
                    if whitelist and slug not in whitelist:
                        continue
                    name = str(getattr(t, "name", slug) or slug)
                    desc = str(getattr(t, "description", "") or "")
                    params = getattr(t, "parameters", None)
                    if not isinstance(params, dict):
                        params = {"type": "object", "properties": {}}
                    all_tools.append({
                        "name": f"{TOOL_PREFIX}{slug}",
                        "description": desc or f"Composio action: {name}",
                        "parameters": params,
                    })
            self._tool_cache = all_tools
            log.info("composio: cached %d tools for apps %s", len(all_tools), self._connected_apps)
        except Exception as e:
            log.warning("composio tool cache refresh failed: %s", e)

    def status(self) -> dict:
        return {
            "enabled": self._enabled,
            "configured": bool(self._api_key),
            "available": self.is_available,
            "connected_apps": list(self._connected_apps),
            "tool_count": len(self._tool_cache),
            "user_id": self._user_id[:8] + "..." if self._user_id else "",
        }

    def set_api_key(self, key: str) -> None:
        from .secretstore import set_api_key, delete_api_key
        key = (key or "").strip()
        if key:
            set_api_key("composio", key)
            self._api_key = key
        else:
            delete_api_key("composio")
            self._api_key = ""

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled
        self._persist_state()

    def _persist_state(self) -> None:
        cfg = _load_config()
        cfg["enabled"] = self._enabled
        cfg["user_id"] = self._user_id
        cfg["connected_apps"] = self._connected_apps
        _save_config(cfg)


_manager: Optional[ComposioManager] = None


def get_manager() -> ComposioManager:
    global _manager
    if _manager is None:
        _manager = ComposioManager()
    return _manager
