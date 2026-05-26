from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .home import runs_dir
from .utils import now_ms


def _path(run_id: str) -> Path:
    """Return the JSONL storage path for the given *chat_id*."""
    return runs_dir() / f"{run_id}.jsonl"


def _sanitize(value: Any) -> Any:
    """Recursively sanitise a log payload: truncate long strings, strip null bytes, stringify dict keys."""
    if isinstance(value, dict):
        return {str(k): _sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize(v) for v in value]
    if isinstance(value, str):
        text = value.replace("\x00", "")
        if len(text) > 4000:
            return text[:4000] + "…[truncated]"
        return text
    return value


def append(run_id: str, event: str, **fields: Any) -> None:
    """Append a timestamped event record to the run log for *run_id*."""
    payload = {
        "ts": now_ms(),
        "event": event,
        **{k: _sanitize(v) for k, v in fields.items()},
    }
    path = _path(run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
