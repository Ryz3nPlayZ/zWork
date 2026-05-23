"""Minimal chat persistence — one JSON file per chat under ~/.zwork/chats/."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

from .home import chats_dir
from .utils import now_ms, uid


@dataclass
class ChatMessage:
    id: str
    role: str  # "user" | "assistant" | "system"
    content: str
    created_at: int
    activities: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Chat:
    id: str
    title: str
    created_at: int
    updated_at: int
    messages: list[ChatMessage] = field(default_factory=list)
    model: str = ""
    project_id: str = ""
    compacted_summary: str = ""
    compaction_cursor: int = 0


def _path(chat_id: str):
    return chats_dir() / f"{chat_id}.json"


def create(title: str = "New chat", model: str = "", project_id: str = "") -> Chat:
    now = now_ms()
    c = Chat(
        id=uid(),
        title=title,
        created_at=now,
        updated_at=now,
        model=model,
        project_id=project_id,
    )
    save(c)
    return c


def list_all() -> list[dict[str, Any]]:
    out = []
    for p in chats_dir().glob("*.json"):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out.append(
                {
                    "id": d["id"],
                    "title": d.get("title", "Untitled"),
                    "created_at": d.get("created_at", 0),
                    "updated_at": d.get("updated_at", 0),
                    "message_count": len(d.get("messages") or []),
                    "model": d.get("model", ""),
                    "project_id": d.get("project_id", ""),
                }
            )
        except Exception:
            continue
    out.sort(key=lambda x: x["updated_at"], reverse=True)
    return out


def get(chat_id: str) -> Chat | None:
    p = _path(chat_id)
    if not p.exists():
        return None
    d = json.loads(p.read_text(encoding="utf-8"))
    msgs = [ChatMessage(**m) for m in d.get("messages", [])]
    return Chat(
        id=d["id"],
        title=d.get("title", "Untitled"),
        created_at=d.get("created_at", 0),
        updated_at=d.get("updated_at", 0),
        messages=msgs,
        model=d.get("model", ""),
        project_id=d.get("project_id", ""),
        compacted_summary=d.get("compacted_summary", ""),
        compaction_cursor=int(d.get("compaction_cursor", 0) or 0),
    )


def save(chat: Chat) -> None:
    p = _path(chat.id)
    data = json.dumps(asdict(chat), indent=2)
    fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
    try:
        os.write(fd, data.encode("utf-8"))
        os.close(fd)
        fd = -1
        os.replace(tmp, p)
    except BaseException:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def delete(chat_id: str) -> bool:
    p = _path(chat_id)
    if p.exists():
        p.unlink()
        return True
    return False


def rename(chat_id: str, title: str) -> Chat | None:
    c = get(chat_id)
    if not c:
        return None
    c.title = title
    c.updated_at = now_ms()
    save(c)
    return c


def append_message(chat_id: str, role: str, content: str) -> ChatMessage | None:
    c = get(chat_id)
    if not c:
        return None
    msg = ChatMessage(id=uid(), role=role, content=content, created_at=now_ms())
    c.messages.append(msg)
    c.updated_at = msg.created_at
    # Auto-title from first user message
    if c.title == "New chat" and role == "user":
        c.title = (content.strip().splitlines()[0])[:64] or "New chat"
    save(c)
    return msg


def update_message(
    chat_id: str,
    message_id: str,
    *,
    content: str | None = None,
    activities: list[dict[str, Any]] | None = None,
) -> ChatMessage | None:
    c = get(chat_id)
    if not c:
        return None
    updated: ChatMessage | None = None
    for msg in c.messages:
        if msg.id != message_id:
            continue
        if content is not None:
            msg.content = content
        if activities is not None:
            msg.activities = list(activities)
        updated = msg
        break
    if updated is None:
        return None
    c.updated_at = now_ms()
    save(c)
    return updated


def set_project(chat_id: str, project_id: str) -> Chat | None:
    c = get(chat_id)
    if not c:
        return None
    c.project_id = project_id
    c.updated_at = now_ms()
    save(c)
    return c


def set_compaction(chat_id: str, summary: str, cursor: int) -> Chat | None:
    c = get(chat_id)
    if not c:
        return None
    c.compacted_summary = summary
    c.compaction_cursor = max(0, int(cursor))
    c.updated_at = now_ms()
    save(c)
    return c
