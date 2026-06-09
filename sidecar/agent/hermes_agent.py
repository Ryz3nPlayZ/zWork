"""A pruned, de-branded, and zero-config fork of the Hermes agent engine.

Exclusively uses the zWork Router for text and vision models, with all multi-platform
gateways, config wizards, and CLI setups removed.
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
import logging
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from . import compaction, settings as settings_mod
from .runtime import RunContext, current_run, run_scope
from .providers import _gated_execute_tool, _build_system_prompt

logger = logging.getLogger(__name__)

class zWorkHermesAgent:
    """The central agent runtime loop replacing our old backend harness."""

    def __init__(
        self,
        chat_id: str,
        model_id: str,
        base_url: str,
        token: str,
        shape: str = "anthropic",
        run_ctx: Optional[RunContext] = None,
    ):
        self.chat_id = chat_id
        self.model_id = model_id
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.shape = shape
        self.run_ctx = run_ctx or RunContext(
            run_id=str(uuid.uuid4()),
            chat_id=chat_id,
            requested_model_id=model_id,
        )
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=20.0))

    def _format_vision_blocks(self, text: str, attachments: List[Any]) -> List[Dict[str, Any]]:
        """Encode local image files to base64 and package as vision blocks."""
        blocks = []
        if text:
            blocks.append({"type": "text", "text": text})

        for a in attachments:
            try:
                # Handle both dict-like and object-like attachments
                path_str = getattr(a, "path", None) or a.get("path")
                name_str = getattr(a, "name", None) or a.get("name")
                if not path_str:
                    continue
                path = Path(path_str)
                if not path.exists():
                    continue

                ext = path.suffix.lower()
                if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
                    mime = {
                        ".png": "image/png",
                        ".jpg": "image/jpeg",
                        ".jpeg": "image/jpeg",
                        ".webp": "image/webp",
                        ".gif": "image/gif",
                    }.get(ext, "image/jpeg")

                    with open(path, "rb") as f:
                        b64_data = base64.b64encode(f.read()).decode("utf-8")

                    if self.shape == "anthropic":
                        blocks.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime,
                                "data": b64_data,
                            },
                        })
                    else:
                        blocks.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{mime};base64,{b64_data}"
                            },
                        })
            except Exception as e:
                logger.error(f"Failed to process attachment for vision: {e}")

        return blocks

    async def run_turn(
        self,
        messages: List[Dict[str, Any]],
        *,
        system_prompt: str,
        project_id: Optional[str] = None,
        project_context: Optional[str] = None,
        plan_mode: bool = False,
        auto_approve_destructive: bool = False,
        attachments: Optional[List[Any]] = None,
    ) -> AsyncIterator[Dict[str, Any]]:
        """Run the multi-turn agent execution loop."""
        
        # 1. Inject vision blocks into the latest user message if attachments are present
        if attachments and messages and messages[-1]["role"] == "user":
            last_msg = messages[-1]
            content = last_msg.get("content")
            if isinstance(content, str):
                last_msg["content"] = self._format_vision_blocks(content, attachments)

        # 2. Enforce token compaction limit
        if compaction.should_compact(messages):
            # Compact list to prevent context window overflow
            # We skip actual summary generation inside loop for simplicity
            messages = messages[-compaction.DEFAULT_KEEP_RECENT:]

        async with run_scope(self.run_ctx):
            for turn in range(15): # Max 15 turns per run
                self.run_ctx.turn_index = turn
                self.run_ctx.log("provider_turn_started", turn=turn, shape=self.shape)

                # Format routing destination
                if self.shape == "anthropic":
                    endpoint = f"{self.base_url}/v1/messages"
                    headers = {
                        "x-api-key": self.token,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    }
                    if self.token and not self.token.startswith("sk-ant-"):
                        headers["authorization"] = f"Bearer {self.token}"
                    # Convert messages to anthropic-compatible schema
                    from .providers import _anthropic_convert_input_messages, _anthropic_tools
                    base_system, convo = _anthropic_convert_input_messages(messages)
                    
                    full_system = _build_system_prompt(
                        system_prompt,
                        project_id=project_id,
                        project_context=project_context,
                        plan_mode=plan_mode,
                        auto_approve_destructive=auto_approve_destructive,
                    )
                    
                    body = {
                        "model": self.model_id,
                        "system": full_system,
                        "messages": convo,
                        "stream": True,
                        "tools": _anthropic_tools(plan_mode),
                    }
                else:
                    endpoint = f"{self.base_url}/chat/completions"
                    headers = {
                        "authorization": f"Bearer {self.token}",
                        "content-type": "application/json",
                    }
                    from .providers import _openai_tools
                    
                    full_system = _build_system_prompt(
                        system_prompt,
                        project_id=project_id,
                        project_context=project_context,
                        plan_mode=plan_mode,
                        auto_approve_destructive=auto_approve_destructive,
                    )
                    
                    openai_messages = [{"role": "system", "content": full_system}]
                    for m in messages:
                        if m.get("role") != "system":
                            openai_messages.append(m)
                            
                    body = {
                        "model": self.model_id,
                        "messages": openai_messages,
                        "stream": True,
                        "tools": _openai_tools(plan_mode),
                    }

                # Add extra run tracing headers
                headers["x-zwork-run-id"] = self.run_ctx.run_id
                headers["x-zwork-request-kind"] = "root" if turn == 0 else "continuation"

                yield {"type": "status", "text": "Thinking"}

                # Execute upstream stream call
                assistant_content_blocks = []
                tool_calls_to_execute = []
                
                try:
                    async with self.client.stream("POST", endpoint, json=body, headers=headers) as response:
                        if response.status_code != 200:
                            err_msg = f"Upstream router error: {response.status_code}"
                            yield {"type": "error", "text": err_msg}
                            yield {"type": "done"}
                            return

                        async for line in response.aiter_lines():
                            if not line or not line.startswith("data: "):
                                continue
                            data_str = line[6:].strip()
                            if data_str == "[DONE]":
                                break
                            
                            try:
                                chunk = json.loads(data_str)
                            except json.JSONDecodeError:
                                continue

                            # Parse Anthropic format chunks
                            if self.shape == "anthropic":
                                ev_type = chunk.get("type")
                                if ev_type == "content_block_delta":
                                    delta = chunk.get("delta") or {}
                                    if delta.get("type") == "text_delta":
                                        txt = delta.get("text") or ""
                                        assistant_content_blocks.append({"type": "text", "text": txt})
                                        yield {"type": "delta", "text": txt}
                                    elif delta.get("type") == "thinking_delta":
                                        # support thinking outputs
                                        pass
                                elif ev_type == "content_block_start":
                                    block = chunk.get("content_block") or {}
                                    if block.get("type") == "tool_use":
                                        tool_calls_to_execute.append({
                                            "id": block.get("id"),
                                            "name": block.get("name"),
                                            "input": block.get("input") or {},
                                        })
                            # Parse OpenAI format chunks
                            else:
                                choices = chunk.get("choices") or []
                                if not choices:
                                    continue
                                delta = choices[0].get("delta") or {}
                                if "content" in delta and delta["content"]:
                                    txt = delta["content"]
                                    assistant_content_blocks.append({"type": "text", "text": txt})
                                    yield {"type": "delta", "text": txt}
                                if "tool_calls" in delta:
                                    for tc in delta["tool_calls"]:
                                        idx = tc.get("index", 0)
                                        if len(tool_calls_to_execute) <= idx:
                                            tool_calls_to_execute.append({"id": "", "name": "", "input": ""})
                                        item = tool_calls_to_execute[idx]
                                        if tc.get("id"):
                                            item["id"] = tc["id"]
                                        if tc.get("function", {}).get("name"):
                                            item["name"] = tc["function"]["name"]
                                        if tc.get("function", {}).get("arguments"):
                                            item["input"] += tc["function"]["arguments"]

                except Exception as e:
                    yield {"type": "error", "text": f"Router connection failed: {e}"}
                    yield {"type": "done"}
                    return

                # Decode OpenAI tool arguments from buffer string
                if self.shape != "anthropic":
                    for tc in tool_calls_to_execute:
                        if isinstance(tc["input"], str):
                            try:
                                tc["input"] = json.loads(tc["input"]) if tc["input"].strip() else {}
                            except json.JSONDecodeError:
                                tc["input"] = {}

                # 3. Append assistant response to messages
                assistant_msg_content = []
                for tc in tool_calls_to_execute:
                    assistant_msg_content.append({
                        "type": "tool_use",
                        "id": tc["id"],
                        "name": tc["name"],
                        "input": tc["input"],
                    })
                
                text_content = "".join(b["text"] for b in assistant_content_blocks if b["type"] == "text")
                if text_content:
                    assistant_msg_content.append({"type": "text", "text": text_content})
                
                if assistant_msg_content:
                    messages.append({"role": "assistant", "content": assistant_msg_content})

                # 4. If no tools were called, the loop finishes
                if not tool_calls_to_execute:
                    yield {"type": "done"}
                    return

                # 5. Execute tool calls and append results
                tool_results = []
                for tc in tool_calls_to_execute:
                    name = tc["name"]
                    params = tc["input"] or {}
                    result_text = ""
                    ok = True

                    try:
                        async for tev in _gated_execute_tool(
                            name,
                            params,
                            auto_approve_destructive=auto_approve_destructive,
                        ):
                            tt = tev.get("type")
                            if tt in ("activity", "permission", "ask_question"):
                                yield tev
                            elif tt == "tool_result":
                                ok = tev.get("ok", False)
                                result_text = tev.get("message", "")
                                yield tev
                    except Exception as e:
                        ok = False
                        result_text = f"Tool '{name}' failed: {e}"
                        yield {"type": "error", "text": result_text}

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tc["id"],
                        "content": result_text or ("ok" if ok else "failed"),
                        "is_error": not ok,
                    })

                # Append tool result turn to history for the next iteration
                messages.append({"role": "user", "content": tool_results})

            # Finished turns
            yield {"type": "done"}

    async def close(self):
        """Close connection client."""
        await self.client.aclose()
