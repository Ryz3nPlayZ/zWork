"""Minimal task and event persistence — stores user-facing tasks and events under ~/.zwork/tasks.json."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

from .home import zwork_home
from .utils import now_ms, uid


@dataclass
class Task:
    id: str
    title: str
    column: str  # "inbox" | "todo" | "doing" | "done"
    created_at: int
    updated_at: int
    due_date: str | None = None  # "YYYY-MM-DD"
    completed_at: int | None = None
    description: str = ""
    assignee: str = ""  # "me" | "zwork" | ""
    priority: str = "medium"  # "low" | "medium" | "high"


@dataclass
class CalendarEvent:
    id: str
    title: str
    date: str  # "YYYY-MM-DD"
    created_at: int
    start_time: str | None = None  # "HH:MM"
    end_time: str | None = None  # "HH:MM"


def _path() -> Path:
    """Return the JSONL storage path for the given *chat_id*."""
    return zwork_home() / "tasks.json"


def _load_data() -> dict[str, list[dict[str, Any]]]:
    p = _path()
    if not p.exists():
        return {"tasks": [], "events": []}
    try:
        content = p.read_text(encoding="utf-8")
        data = json.loads(content)
        if not isinstance(data, dict):
            return {"tasks": [], "events": []}
        return {
            "tasks": data.get("tasks") or [],
            "events": data.get("events") or [],
        }
    except Exception:
        return {"tasks": [], "events": []}


def _save_data(data: dict[str, list[dict[str, Any]]]) -> None:
    p = _path()
    formatted = json.dumps(data, indent=2)
    fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
    try:
        os.write(fd, formatted.encode("utf-8"))
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


# --- Task CRUD Operations ---


def get_tasks() -> list[Task]:
    data = _load_data()
    out = []
    for t in data.get("tasks", []):
        try:
            out.append(
                Task(
                    id=t["id"],
                    title=t["title"],
                    column=t["column"],
                    created_at=t["created_at"],
                    updated_at=t["updated_at"],
                    due_date=t.get("due_date"),
                    completed_at=t.get("completed_at"),
                    description=t.get("description", ""),
                    assignee=t.get("assignee", ""),
                    priority=t.get("priority", "medium"),
                )
            )
        except (KeyError, TypeError):
            continue
    return out


def save_task(
    title: str,
    column: str = "inbox",
    due_date: str | None = None,
    task_id: str | None = None,
    description: str = "",
    assignee: str = "",
    priority: str = "medium",
) -> Task:
    data = _load_data()
    tasks_list = data["tasks"]
    now = now_ms()

    # Find existing or create new
    existing_idx = -1
    if task_id:
        for i, t in enumerate(tasks_list):
            if t["id"] == task_id:
                existing_idx = i
                break

    if existing_idx >= 0:
        t_data = tasks_list[existing_idx]
        prev_column = t_data.get("column", "inbox")
        completed_at = t_data.get("completed_at")

        # If transitioning to "done", set completed_at
        if column == "done" and prev_column != "done":
            completed_at = now
        elif column != "done":
            completed_at = None

        t_data.update(
            {
                "title": title,
                "column": column,
                "due_date": due_date,
                "completed_at": completed_at,
                "updated_at": now,
                "description": description or t_data.get("description", ""),
                "assignee": assignee or t_data.get("assignee", ""),
                "priority": priority or t_data.get("priority", "medium"),
            }
        )
        task = Task(**t_data)
    else:
        # Create a new task
        completed_at = now if column == "done" else None
        task = Task(
            id=uid(),
            title=title,
            column=column,
            created_at=now,
            updated_at=now,
            due_date=due_date,
            completed_at=completed_at,
            description=description,
            assignee=assignee,
            priority=priority,
        )
        tasks_list.append(asdict(task))

    _save_data(data)
    return task


def update_task_column(task_id: str, column: str) -> Task | None:
    data = _load_data()
    tasks_list = data["tasks"]
    now = now_ms()

    for t_data in tasks_list:
        if t_data["id"] == task_id:
            prev_column = t_data.get("column", "inbox")
            completed_at = t_data.get("completed_at")

            if column == "done" and prev_column != "done":
                completed_at = now
            elif column != "done":
                completed_at = None

            t_data.update(
                {
                    "column": column,
                    "completed_at": completed_at,
                    "updated_at": now,
                }
            )
            task = Task(**t_data)
            _save_data(data)
            return task
    return None


def delete_task(task_id: str) -> bool:
    """Remove the task record file for *task_id*."""
    data = _load_data()
    tasks_list = data["tasks"]
    filtered = [t for t in tasks_list if t["id"] != task_id]
    if len(filtered) == len(tasks_list):
        return False
    data["tasks"] = filtered
    _save_data(data)
    return True


# --- Calendar Event CRUD Operations ---


def get_events() -> list[CalendarEvent]:
    data = _load_data()
    out = []
    for e in data.get("events", []):
        try:
            out.append(
                CalendarEvent(
                    id=e["id"],
                    title=e["title"],
                    date=e["date"],
                    created_at=e["created_at"],
                    start_time=e.get("start_time"),
                    end_time=e.get("end_time"),
                )
            )
        except (KeyError, TypeError):
            continue
    return out


def save_event(
    title: str,
    date: str,
    start_time: str | None = None,
    end_time: str | None = None,
    event_id: str | None = None,
) -> CalendarEvent:
    data = _load_data()
    events_list = data["events"]
    now = now_ms()

    # Find existing or create new
    existing_idx = -1
    if event_id:
        for i, e in enumerate(events_list):
            if e["id"] == event_id:
                existing_idx = i
                break

    if existing_idx >= 0:
        e_data = events_list[existing_idx]
        e_data.update(
            {
                "title": title,
                "date": date,
                "start_time": start_time,
                "end_time": end_time,
            }
        )
        event = CalendarEvent(**e_data)
    else:
        event = CalendarEvent(
            id=uid(),
            title=title,
            date=date,
            created_at=now,
            start_time=start_time,
            end_time=end_time,
        )
        events_list.append(asdict(event))

    _save_data(data)
    return event


def delete_event(event_id: str) -> bool:
    data = _load_data()
    events_list = data["events"]
    filtered = [e for e in events_list if e["id"] != event_id]
    if len(filtered) == len(events_list):
        return False
    data["events"] = filtered
    _save_data(data)
    return True
