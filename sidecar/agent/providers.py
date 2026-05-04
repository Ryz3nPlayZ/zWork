"""Provider abstraction + agentic harness.

A "provider" here is an API *shape* (Anthropic-compatible or
OpenAI-compatible). Credentials are stored per shape in zWork settings,
or pulled from the local credential integration env block.

Models are user-defined (zWork-local ids). Each model declares which
shape to speak and which credential source to use. There is no
hard-coded model catalog.

The harness:
- Uses native tool-calling for both shapes.
- Streams text deltas to the UI.
- Captures tool_use content blocks, executes them, feeds results back
  into the next turn.
- Loops until the model stops calling tools or we hit MAX_TURNS.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Optional

import httpx

from . import detect, settings as settings_mod
from .tools import TOOL_SCHEMAS, execute_tool, parse_tool_calls


MAX_TURNS = 24
ZWORK_ROUTER_MODEL_ID = "zwork-router"
ZWORK_ROUTER_ZWORK_ID = "zwork-router"
ZWORK_ROUTER_MODEL_NAME = "zWork Router"
ZWORK_ROUTER_BASE_URL = "https://api.tryzwork.app/api/v1"
PREV1_OLLAMA_MODEL_ID = "qwen3.5:cloud"
PREV1_OLLAMA_ZWORK_ID = "qwen3-5-cloud-ollama"


def _max_tokens_for(model_id: str) -> int:
    """Sensible ceiling per model family. Anthropic claude-sonnet-4/4.5 allow 64k."""
    mid = (model_id or "").lower()
    if "claude-sonnet-4" in mid or "claude-opus-4" in mid or "claude-4" in mid:
        return 32000
    if "claude-3-5" in mid or "claude-3.5" in mid:
        return 8192
    if "claude" in mid:
        return 8192
    # OpenAI/OpenAI-compatible: not used for `max_tokens` the same way; safe default
    return 16384


# ---------------- Credential resolution ----------------

@dataclass
class Credentials:
    shape: str            # "anthropic" | "openai"
    api_key: str
    base_url: str
    source: str           # "byok" | "claude_code" | "env"


def _shape_for_credential(credential: str) -> str:
    if credential == "claude_code" or credential == "anthropic":
        return "anthropic"
    return "openai"


def _is_local_ollama_base(url: str) -> bool:
    base = (url or "").strip().rstrip("/")
    return (
        base.startswith("http://localhost:11434")
        or base.startswith("http://127.0.0.1:11434")
    )


def is_safe_ollama_url(url: str) -> bool:
    """
    Validate that an Ollama base_url is safe to proxy.
    Allows localhost, private IP ranges (LAN), and official ollama.com domains.
    """
    from urllib.parse import urlparse
    import ipaddress
    try:
        p = urlparse(url)
        if not p.scheme or p.scheme not in ("http", "https"):
            return False
        host = (p.hostname or "").lower()
        if host == "localhost" or host.endswith(".ollama.com") or host == "ollama.com":
            return True
        # Allow private IP ranges and loopback
        try:
            ip = ipaddress.ip_address(host)
            return ip.is_private or ip.is_loopback
        except ValueError:
            return False
    except Exception:
        return False


def resolve(credential: str, s: settings_mod.Settings, override_base_url: str = "") -> Optional[Credentials]:
    shape = _shape_for_credential(credential)

    if credential == "anthropic":
        key = (s.api_keys.get("anthropic") or "").strip()
        if key:
            base = override_base_url or (s.provider_config.get("anthropic", {}).get("base_url")
                                         or "https://api.anthropic.com")
            return Credentials("anthropic", key, base.rstrip("/"), "byok")
        tok = os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
        if tok:
            base = override_base_url or (os.environ.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com")
            return Credentials("anthropic", tok, base.rstrip("/"), "env")
        return None

    if credential == "openai":
        configured_base = (s.provider_config.get("openai", {}).get("base_url") or "").strip()
        selected_base = (override_base_url or configured_base).strip()

        key = (s.api_keys.get("openai") or "").strip()
        if key:
            base = selected_base or "https://api.openai.com/v1"
            return Credentials("openai", key, base.rstrip("/"), "byok")

        # Local Ollama does not require an API key.
        if selected_base and _is_local_ollama_base(selected_base):
            return Credentials("openai", "", selected_base.rstrip("/"), "byok")

        env = os.environ.get("OPENAI_API_KEY")
        if env:
            base = selected_base or (os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1")
            return Credentials("openai", env, base.rstrip("/"), "env")

        # Allow local Ollama-compatible setups without auth token.
        if _is_local_ollama_base(selected_base):
            base = selected_base or "http://localhost:11434/v1"
            return Credentials("openai", "", base.rstrip("/"), "env")

        return None

    if credential == "claude_code":
        if not s.use_claude_code_config:
            return None
        env = detect.read_claude_code_env()
        tok = env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY")
        if tok:
            base = override_base_url or (env.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com")
            return Credentials("anthropic", tok, base.rstrip("/"), "claude_code")
        return None

    _ = shape
    return None


def credential_status(s: settings_mod.Settings) -> dict:
    out: dict[str, dict] = {}
    for src in ("anthropic", "openai", "claude_code"):
        c = resolve(src, s)
        out[src] = {
            "configured": bool(c),
            "source": c.source if c else None,
            "base_url": c.base_url if c else None,
            "shape": _shape_for_credential(src),
        }
    return out


# ---------------- Dynamic model list ----------------

def available_models(s: settings_mod.Settings) -> list[dict]:
    out: list[dict] = []

    cc = resolve("claude_code", s)
    if cc is not None:
        existing = any(m.get("credential") == "claude_code" for m in s.custom_models)
        if not existing:
            cc_model = detect.read_claude_code_model() or ""
            out.append({
                "id": "__claude_code__",
                "name": "Local credentials",
                "subtitle": f"via {cc.base_url}",
                "shape": "anthropic",
                "credential": "claude_code",
                "model_id": cc_model or "(default)",
                "configured": True,
                "synthesized": True,
            })

    for m in s.custom_models:
        cred = resolve(m.get("credential", ""), s, m.get("base_url_override", ""))
        out.append({
            "id": m["id"],
            "name": m.get("name") or m["id"],
            "subtitle": _subtitle_for(m, cred),
            "shape": m.get("shape", "anthropic"),
            "credential": m.get("credential", ""),
            "model_id": m.get("model_id", ""),
            "base_url_override": m.get("base_url_override", ""),
            "configured": bool(cred),
            "synthesized": False,
        })
    return out


def _subtitle_for(m: dict, cred: Optional[Credentials]) -> str:
    base = m.get("base_url_override") or (cred.base_url if cred else "")
    cred_label = {
        "anthropic": "Anthropic-compatible",
        "openai": "OpenAI-compatible",
        "claude_code": "via local credentials",
    }.get(m.get("credential", ""), m.get("credential", ""))
    if base:
        return f"{cred_label} · {base}"
    return cred_label


def lookup_model(zwork_model_id: str, s: settings_mod.Settings) -> Optional[dict]:
    for m in available_models(s):
        if m["id"] == zwork_model_id:
            return m
    return None


# ---------------- Anthropic tool schemas (from tools module) ----------------

def _anthropic_tools() -> list[dict]:
    """Convert our generic TOOL_SCHEMAS into Anthropic's input_schema shape."""
    out = []
    for t in TOOL_SCHEMAS:
        out.append({
            "name": t["name"],
            "description": t["description"],
            "input_schema": t["parameters"],
        })
    return out


def _openai_tools() -> list[dict]:
    out = []
    for t in TOOL_SCHEMAS:
        out.append({
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            },
        })
    return out


# ---------------- Anthropic streaming turn ----------------

async def _anthropic_turn(
    creds: Credentials,
    messages: list[dict],
    model_id: str,
    system: str,
) -> AsyncIterator[dict]:
    """Run one Anthropic turn. Yields UI events and finally a 'turn_end' event
    with {content_blocks: [...], stop_reason: str | None}.

    Accumulates text (as type=delta) and tool_use blocks (as input_json assembled
    from input_json_delta fragments).
    """
    url = f"{creds.base_url}/v1/messages"
    headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
    }
    if creds.api_key.startswith("sk-ant-"):
        headers["x-api-key"] = creds.api_key
    else:
        headers["authorization"] = f"Bearer {creds.api_key}"
        headers["x-api-key"] = creds.api_key

    body: dict = {
        "model": model_id,
        "max_tokens": _max_tokens_for(model_id),
        "stream": True,
        "messages": messages,
        "tools": _anthropic_tools(),
    }
    if system:
        body["system"] = system

    yield {"type": "status", "text": "Thinking"}

    # Track the assistant response assembly
    blocks_by_index: dict[int, dict] = {}  # idx -> partial block
    stop_reason: Optional[str] = None

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=20.0)) as client:
            async with client.stream("POST", url, json=body, headers=headers) as resp:
                if resp.status_code >= 400:
                    text = (await resp.aread()).decode("utf-8", errors="replace")
                    yield {"type": "error", "text": f"{resp.status_code}: {text[:500]}"}
                    yield {"type": "turn_end", "content_blocks": [], "stop_reason": "error"}
                    return

                started_text = False
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data:
                        continue
                    try:
                        evt = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    et = evt.get("type")

                    if et == "content_block_start":
                        idx = evt.get("index", 0)
                        block = evt.get("content_block") or {}
                        btype = block.get("type")
                        if btype == "text":
                            blocks_by_index[idx] = {"type": "text", "text": ""}
                        elif btype == "tool_use":
                            blocks_by_index[idx] = {
                                "type": "tool_use",
                                "id": block.get("id", ""),
                                "name": block.get("name", ""),
                                "input_buf": "",
                            }
                            yield {
                                "type": "activity",
                                "id": block.get("id", f"tool_{idx}"),
                                "label": f"Preparing {block.get('name', 'tool')}…",
                                "icon": "tool",
                                "done": False,
                            }

                    elif et == "content_block_delta":
                        idx = evt.get("index", 0)
                        delta = evt.get("delta") or {}
                        dtype = delta.get("type")
                        block = blocks_by_index.get(idx)
                        if not block:
                            continue
                        if dtype == "text_delta" and block["type"] == "text":
                            piece = delta.get("text", "")
                            block["text"] += piece
                            if not started_text:
                                yield {"type": "status", "text": "Drafting"}
                                started_text = True
                            yield {"type": "delta", "text": piece}
                        elif dtype == "input_json_delta" and block["type"] == "tool_use":
                            block["input_buf"] += delta.get("partial_json", "")

                    elif et == "content_block_stop":
                        idx = evt.get("index", 0)
                        block = blocks_by_index.get(idx)
                        if block and block["type"] == "tool_use":
                            try:
                                block["input"] = json.loads(block["input_buf"] or "{}")
                            except json.JSONDecodeError:
                                block["input"] = {}

                    elif et == "message_delta":
                        delta = evt.get("delta") or {}
                        if "stop_reason" in delta:
                            stop_reason = delta.get("stop_reason")

                    elif et == "message_stop":
                        break

                    elif et == "error":
                        yield {"type": "error", "text": json.dumps(evt.get("error") or evt)}
                        yield {"type": "turn_end", "content_blocks": [], "stop_reason": "error"}
                        return

    except httpx.HTTPError as e:
        yield {"type": "error", "text": f"network error: could not reach {creds.base_url} ({e})"}
        yield {"type": "turn_end", "content_blocks": [], "stop_reason": "error"}
        return

    # Flatten final blocks in order
    ordered = [blocks_by_index[i] for i in sorted(blocks_by_index.keys())]
    final_blocks = []
    for b in ordered:
        if b["type"] == "text":
            final_blocks.append({"type": "text", "text": b.get("text", "")})
        elif b["type"] == "tool_use":
            final_blocks.append({
                "type": "tool_use",
                "id": b.get("id", ""),
                "name": b.get("name", ""),
                "input": b.get("input", {}),
            })

    yield {"type": "turn_end", "content_blocks": final_blocks, "stop_reason": stop_reason}


# ---------------- OpenAI streaming turn ----------------

async def _openai_turn(
    creds: Credentials,
    messages: list[dict],
    model_id: str,
    extra_headers: Optional[dict[str, str]] = None,
) -> AsyncIterator[dict]:
    """One OpenAI-compatible turn with tool use.

    OpenAI chat messages use roles: system, user, assistant, tool.
    We assume `messages` is already in that shape.
    """
    url = f"{creds.base_url}/chat/completions"
    headers = {"content-type": "application/json"}
    if creds.api_key:
        headers["authorization"] = f"Bearer {creds.api_key}"
    if extra_headers:
        headers.update(extra_headers)
    body = {
        "model": model_id,
        "stream": True,
        "messages": messages,
        "tools": _openai_tools(),
    }

    yield {"type": "status", "text": "Thinking"}

    collected_text = ""
    tool_calls: dict[int, dict] = {}  # index -> {id, name, args_buf}
    finish_reason: Optional[str] = None
    started_text = False

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=20.0)) as client:
            async with client.stream("POST", url, json=body, headers=headers) as resp:
                if resp.status_code >= 400:
                    text = (await resp.aread()).decode("utf-8", errors="replace")
                    detail = text[:500]
                    if resp.status_code == 401 and "api.tryzwork.app" in creds.base_url.lower():
                        detail = (
                            "401 unauthorized from zWork Router. "
                            "Sign in again or reactivate managed mode from Analytics."
                        )
                    elif resp.status_code == 401 and "ollama" in creds.base_url.lower():
                        detail = (
                            "401 unauthorized from Ollama endpoint. "
                            "If using ollama.com cloud, set a valid API key; "
                            "for local Ollama use http://localhost:11434/v1 with no key."
                        )
                    yield {"type": "error", "text": f"{resp.status_code}: {detail}"}
                    yield {"type": "turn_end", "content_blocks": [], "stop_reason": "error"}
                    return
                router_provider = resp.headers.get("x-zwork-router-provider") or ""
                router_model = resp.headers.get("x-zwork-router-model") or model_id
                router_label = resp.headers.get("x-zwork-router-label") or ""
                if router_provider or router_label:
                    yield {
                        "type": "meta",
                        "provider": router_label or router_provider,
                        "resolved_model": router_model,
                        "upstream_provider": router_provider or router_label,
                    }
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        evt = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = evt.get("choices") or []
                    if not choices:
                        continue
                    ch = choices[0]
                    delta = ch.get("delta") or {}
                    piece = delta.get("content")
                    if piece:
                        collected_text += piece
                        if not started_text:
                            yield {"type": "status", "text": "Drafting"}
                            started_text = True
                        yield {"type": "delta", "text": piece}
                    for tc in (delta.get("tool_calls") or []):
                        idx = tc.get("index", 0)
                        slot = tool_calls.setdefault(idx, {"id": "", "name": "", "args_buf": ""})
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] = fn["name"]
                            yield {
                                "type": "activity",
                                "id": slot["id"] or f"tc_{idx}",
                                "label": f"Preparing {slot['name']}…",
                                "icon": "tool",
                                "done": False,
                            }
                        if fn.get("arguments"):
                            slot["args_buf"] += fn["arguments"]
                    if ch.get("finish_reason"):
                        finish_reason = ch["finish_reason"]
    except httpx.HTTPError as e:
        yield {"type": "error", "text": f"network error: could not reach {creds.base_url} ({e})"}
        yield {"type": "turn_end", "content_blocks": [], "stop_reason": "error"}
        return

    final_blocks: list[dict] = []
    if collected_text:
        final_blocks.append({"type": "text", "text": collected_text})
    for idx in sorted(tool_calls.keys()):
        tc = tool_calls[idx]
        try:
            inp = json.loads(tc["args_buf"] or "{}")
        except json.JSONDecodeError:
            inp = {}
        final_blocks.append({
            "type": "tool_use",
            "id": tc["id"] or f"tc_{idx}",
            "name": tc["name"],
            "input": inp,
        })

    yield {"type": "turn_end", "content_blocks": final_blocks, "stop_reason": finish_reason}


# ---------------- Agentic harness ----------------

def _anthropic_convert_input_messages(messages: list[dict]) -> tuple[str, list[dict]]:
    """Pull out the system prompt and convert role=user/assistant to Anthropic shape.
    For the first turn, messages are simple {role, content} text entries.
    """
    system_parts = [m["content"] for m in messages if m.get("role") == "system"]
    convo = []
    for m in messages:
        if m.get("role") in ("user", "assistant"):
            convo.append({"role": m["role"], "content": m["content"]})
    return "\n\n".join(system_parts), convo


async def stream_chat(
    messages: list[dict], zwork_model_id: str, s: settings_mod.Settings
) -> AsyncIterator[dict]:
    """Top-level chat stream. Handles the multi-turn tool loop."""
    model = lookup_model(zwork_model_id, s)
    if model is None:
        yield {
            "type": "error",
            "text": f"Model '{zwork_model_id}' not found. Add one in Settings → Models.",
        }
        yield {"type": "done"}
        return

    creds = resolve(model["credential"], s, model.get("base_url_override", ""))
    if creds is None:
        yield {
            "type": "error",
                "text": (
                    f"No credentials for '{model['credential']}'. "
                    "Add an API key in Settings → Credentials, or enable local credential reuse."
                ),
            }
        yield {"type": "done"}
        return

    real_model_id = model.get("model_id") or ""
    if real_model_id == "(default)":
        real_model_id = "claude-sonnet-4-5-20250929"
    if not real_model_id:
        yield {"type": "error", "text": "This model has no model_id set."}
        yield {"type": "done"}
        return

    if model["shape"] == "anthropic":
        system, convo = _anthropic_convert_input_messages(messages)
        async for evt in _run_anthropic_loop(creds, convo, system, real_model_id):
            yield evt
    else:
        # OpenAI: messages already in correct shape (role=system/user/assistant)
        async for evt in _run_openai_loop(creds, list(messages), real_model_id):
            yield evt


async def _run_anthropic_loop(
    creds: Credentials,
    convo: list[dict],
    system: str,
    model_id: str,
) -> AsyncIterator[dict]:
    """Multi-turn tool loop for Anthropic-shape APIs."""
    for turn in range(MAX_TURNS):
        content_blocks: list[dict] = []
        stop_reason: Optional[str] = None

        async for evt in _anthropic_turn(creds, convo, model_id, system):
            t = evt.get("type")
            if t == "turn_end":
                content_blocks = evt.get("content_blocks") or []
                stop_reason = evt.get("stop_reason")
                continue
            # Forward UI events
            yield evt

        # Also scan text for legacy <<TOOL>> blocks as a fallback
        all_text = "".join(b.get("text", "") for b in content_blocks if b.get("type") == "text")
        legacy_calls = parse_tool_calls(all_text) if all_text else []

        tool_use_blocks = [b for b in content_blocks if b.get("type") == "tool_use"]

        if not tool_use_blocks and not legacy_calls:
            yield {"type": "done"}
            return

        # Append the assistant turn (with tool_use blocks) to the conversation
        assistant_content = []
        for b in content_blocks:
            if b["type"] == "text" and b.get("text"):
                assistant_content.append({"type": "text", "text": b["text"]})
            elif b["type"] == "tool_use":
                assistant_content.append({
                    "type": "tool_use",
                    "id": b["id"],
                    "name": b["name"],
                    "input": b["input"],
                })
        if assistant_content:
            convo.append({"role": "assistant", "content": assistant_content})

        # Execute native tool_use blocks; produce tool_result content
        tool_result_content: list[dict] = []
        for b in tool_use_blocks:
            name = b["name"]
            params = b["input"] or {}
            result_text = ""
            ok = True
            async for tev in execute_tool(name, params):
                tt = tev.get("type")
                if tt == "activity":
                    # Override the "Preparing..." activity with the live one
                    yield tev
                elif tt == "tool_result":
                    ok = tev.get("ok", False)
                    result_text = tev.get("message", "")
                    yield tev
            tool_result_content.append({
                "type": "tool_result",
                "tool_use_id": b["id"],
                "content": result_text or ("ok" if ok else "failed"),
                "is_error": not ok,
            })

        # Execute legacy <<TOOL>> calls too (fold results as user text)
        legacy_results: list[str] = []
        for call in legacy_calls:
            name = call["tool"]
            params = call["params"]
            msg = ""
            async for tev in execute_tool(name, params):
                tt = tev.get("type")
                if tt in ("activity", "tool_result"):
                    yield tev
                if tt == "tool_result":
                    msg = tev.get("message", "")
            legacy_results.append(f"Tool '{name}' result: {msg}")

        # Build the next user turn (tool results)
        next_user_parts: list[dict] = list(tool_result_content)
        if legacy_results:
            next_user_parts.append({"type": "text", "text": "\n\n".join(legacy_results)})
        if next_user_parts:
            convo.append({"role": "user", "content": next_user_parts})

        # If the model stopped with end_turn AND we had no tools, we're done (handled above)
        if stop_reason == "end_turn" and not tool_use_blocks and not legacy_calls:
            yield {"type": "done"}
            return

    yield {"type": "done"}


async def _run_openai_loop(
    creds: Credentials,
    messages: list[dict],
    model_id: str,
) -> AsyncIterator[dict]:
    """Multi-turn tool loop for OpenAI-shape APIs."""
    run_id = str(uuid.uuid4())
    for turn in range(MAX_TURNS):
        content_blocks: list[dict] = []
        request_kind = "root" if turn == 0 else "continuation"
        async for evt in _openai_turn(
            creds,
            messages,
            model_id,
            extra_headers={
                "x-zwork-run-id": run_id,
                "x-zwork-request-kind": request_kind,
            },
        ):
            t = evt.get("type")
            if t == "turn_end":
                content_blocks = evt.get("content_blocks") or []
                continue
            yield evt

        tool_uses = [b for b in content_blocks if b["type"] == "tool_use"]
        text = "".join(b.get("text", "") for b in content_blocks if b["type"] == "text")
        legacy_calls = parse_tool_calls(text) if text else []

        if not tool_uses and not legacy_calls:
            yield {"type": "done"}
            return

        # Append assistant message (with tool_calls) per OpenAI shape
        openai_tool_calls = [
            {
                "id": tu["id"],
                "type": "function",
                "function": {
                    "name": tu["name"],
                    "arguments": json.dumps(tu["input"]),
                },
            }
            for tu in tool_uses
        ]
        messages.append({
            "role": "assistant",
            "content": text or "",
            **({"tool_calls": openai_tool_calls} if openai_tool_calls else {}),
        })

        # Execute tool calls; append role=tool messages
        for tu in tool_uses:
            name = tu["name"]
            params = tu["input"] or {}
            result_text = ""
            async for tev in execute_tool(name, params):
                tt = tev.get("type")
                if tt in ("activity", "tool_result"):
                    yield tev
                if tt == "tool_result":
                    result_text = tev.get("message", "")
            messages.append({
                "role": "tool",
                "tool_call_id": tu["id"],
                "content": result_text or "",
            })

        # Legacy <<TOOL>>: append as a user message
        legacy_results: list[str] = []
        for call in legacy_calls:
            name = call["tool"]
            params = call["params"]
            msg = ""
            async for tev in execute_tool(name, params):
                tt = tev.get("type")
                if tt in ("activity", "tool_result"):
                    yield tev
                if tt == "tool_result":
                    msg = tev.get("message", "")
            legacy_results.append(f"Tool '{name}' result: {msg}")
        if legacy_results:
            messages.append({"role": "user", "content": "\n\n".join(legacy_results)})

    yield {"type": "done"}
