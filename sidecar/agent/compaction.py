"""Conversation compaction for long-running chats."""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from . import providers

# For runtime, we'll use Any for the type hints to avoid circular import
from typing import Any


_CHARS_PER_TOKEN = 4
DEFAULT_COMPACT_THRESHOLD_CHARS = 120_000
DEFAULT_KEEP_RECENT = 4


def estimate_chars(messages: list[dict]) -> int:
    return sum(len(_msg_text(m)) for m in messages)


def estimate_tokens(messages: list[dict]) -> int:
    return estimate_chars(messages) // _CHARS_PER_TOKEN


def _msg_text(m: dict) -> str:
    c = m.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out: list[str] = []
        for blk in c:
            if not isinstance(blk, dict):
                continue
            if "text" in blk:
                out.append(str(blk.get("text") or ""))
            elif blk.get("type") == "tool_result":
                out.append(str(blk.get("content") or ""))
        return "\n".join(out)
    return ""


def should_compact(
    messages: list[dict],
    threshold_chars: int = DEFAULT_COMPACT_THRESHOLD_CHARS,
    keep_recent: int = DEFAULT_KEEP_RECENT,
) -> bool:
    if estimate_chars(messages) < threshold_chars:
        return False
    if len(messages) <= keep_recent + 2:
        return False
    return True


@dataclass
class CompactionPlan:
    keep_head: list[dict]
    middle: list[dict]
    keep_tail: list[dict]
    cursor: int


def plan_compaction(
    messages: list[dict],
    keep_recent: int = DEFAULT_KEEP_RECENT,
    keep_head: int = 0,
) -> CompactionPlan:
    n = len(messages)
    head_end = min(keep_head, n)
    tail_start = max(head_end, n - keep_recent)
    return CompactionPlan(
        keep_head=list(messages[:head_end]),
        middle=list(messages[head_end:tail_start]),
        keep_tail=list(messages[tail_start:]),
        cursor=tail_start,
    )


SUMMARIZE_PROMPT = (
    "You are summarizing the earlier portion of a conversation between a "
    "user and a desktop AI assistant (zWork). Future turns will rely on "
    "this summary instead of replaying the original messages.\n\n"
    "Preserve, in this order:\n"
    "1. The user's stated goals and any constraints they gave.\n"
    "2. Decisions that have been made and the reasoning when non-obvious.\n"
    "3. Files created or modified and their purpose (give exact paths).\n"
    "4. Tools that were run and what they returned in summary form (do not "
    "quote long output; record outcomes).\n"
    "5. Anything the assistant promised, deferred, or left unfinished.\n\n"
    "Drop pleasantries, drafts that were thrown away, and verbatim tool "
    "output. Output 3 to 8 short paragraphs in plain markdown. No preamble."
)


async def summarize(
    middle_messages: list[dict],
    *,
    creds: Any,  # providers.Credentials - use Any to avoid circular import
    model_id: str,
    shape: str,
    timeout: float = 90.0,
) -> str:
    user_msg = (
        "Conversation snippet to summarize:\n\n<conversation>\n"
        + _render_for_summary(middle_messages)
        + "\n</conversation>"
    )
    try:
        if shape == "anthropic":
            return await _summarize_anthropic(creds, model_id, user_msg, timeout)
        return await _summarize_openai(creds, model_id, user_msg, timeout)
    except Exception as e:
        return f"[compaction failed: {type(e).__name__}: {e}]"


def _render_for_summary(messages: list[dict]) -> str:
    lines: list[str] = []
    for m in messages:
        role = m.get("role", "?")
        text = _msg_text(m).strip()
        if not text:
            continue
        if role == "user":
            lines.append(f"USER: {text}")
        elif role == "assistant":
            lines.append(f"ASSISTANT: {text}")
        elif role == "tool":
            lines.append(f"TOOL_RESULT: {text}")
        else:
            lines.append(f"{role.upper()}: {text}")
    return "\n\n".join(lines)


async def _summarize_anthropic(
    creds: providers.Credentials,
    model_id: str,
    user_msg: str,
    timeout: float,
) -> str:
    url = f"{creds.base_url}/v1/messages"
    headers = {"content-type": "application/json", "anthropic-version": "2023-06-01"}
    if creds.api_key.startswith("sk-ant-"):
        headers["x-api-key"] = creds.api_key
    else:
        headers["authorization"] = f"Bearer {creds.api_key}"
        headers["x-api-key"] = creds.api_key
    body = {
        "model": model_id,
        "max_tokens": 1500,
        "system": SUMMARIZE_PROMPT,
        "messages": [{"role": "user", "content": user_msg}],
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=20.0)) as c:
        r = await c.post(url, json=body, headers=headers)
        r.raise_for_status()
        data = r.json()
    blocks = data.get("content") or []
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()


async def _summarize_openai(
    creds: providers.Credentials,
    model_id: str,
    user_msg: str,
    timeout: float,
) -> str:
    url = f"{creds.base_url}/chat/completions"
    headers = {"content-type": "application/json"}
    if creds.api_key:
        headers["authorization"] = f"Bearer {creds.api_key}"
    body = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": SUMMARIZE_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "max_tokens": 1500,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=20.0)) as c:
        r = await c.post(url, json=body, headers=headers)
        r.raise_for_status()
        data = r.json()
    return (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()


def render_summary_message(summary: str) -> dict:
    body = (
        "[Earlier conversation compacted to fit the context window.]\n\n"
        + (summary or "(no summary produced)").strip()
    )
    return {"role": "assistant", "content": body}
