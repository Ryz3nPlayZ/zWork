//! OpenAI Responses API (OpenAI, Azure OpenAI, xAI, Meta, opencode Zen GPT).
//!
//! Port of pi-mono `packages/ai/src/api/openai-responses.ts` +
//! `openai-responses-shared.ts`. Stateless (`store: false`): reasoning items
//! round-trip through the thinking block's signature as the raw JSON item
//! (with `encrypted_content`), assistant text carries a `{v:1,id,phase}`
//! signature, and tool-call ids are `call_id|item_id`. Dropped: grammar
//! "custom" tools, tool-search / additional-tools anchoring, Copilot headers.

use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use super::transport::{self, push, sanitize_surrogates, short_hash, Tx, USER_AGENT};
use crate::harness::json_parse::parse_streaming_json;
use crate::harness::retry::ProviderError;
use crate::harness::transcript::{get_system_message_text, render_system_message_update, resolve_transcript, resolve_transcript_tools};
use crate::harness::transform_messages::transform_messages;
use crate::harness::types::{
    AssistantContent, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message, Model, StopReason,
    StreamOptions, TextContent, ThinkingContent, ThinkingLevel, Tool, ToolCall, TranscriptContext, UserContent,
    UserMessageContent,
};

/// Providers whose `call_id|item_id` pairs are replayed verbatim.
const TOOL_CALL_PROVIDERS: [&str; 4] = ["openai", "openai-codex", "opencode", "azure"];
/// Responses rejects `max_output_tokens` below 16.
const MIN_OUTPUT_TOKENS: u64 = 16;

fn is_azure(model: &Model) -> bool {
    model.provider.starts_with("azure") || model.base_url.contains(".openai.azure.com") || model.base_url.contains(".cognitiveservices.azure.com")
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

fn encode_text_signature(id: &str, phase: Option<&str>) -> String {
    let mut v = json!({"v": 1, "id": id});
    if let Some(p) = phase {
        v["phase"] = json!(p);
    }
    v.to_string()
}

fn parse_text_signature(sig: Option<&str>) -> Option<(String, Option<String>)> {
    let sig = sig?;
    if sig.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<Value>(sig) {
            if v["v"] == 1 {
                if let Some(id) = v["id"].as_str() {
                    let phase = v["phase"].as_str().filter(|p| *p == "commentary" || *p == "final_answer");
                    return Some((id.to_string(), phase.map(str::to_string)));
                }
            }
        }
    }
    Some((sig.to_string(), None))
}

fn normalize_id_part(part: &str) -> String {
    let s: String = part
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(64)
        .collect();
    s.trim_end_matches('_').to_string()
}

fn image_url(img: &crate::harness::types::ImageContent) -> String {
    format!("data:{};base64,{}", img.mime_type, img.data)
}

fn tool_result_output(model: &Model, content: &[UserContent]) -> Value {
    let text = content
        .iter()
        .filter_map(|c| match c {
            UserContent::Text(t) => Some(t.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let images: Vec<_> = content
        .iter()
        .filter_map(|c| match c {
            UserContent::Image(i) => Some(i),
            _ => None,
        })
        .collect();
    if images.is_empty() || !model.supports_images() {
        let s = if !text.is_empty() {
            text
        } else if !images.is_empty() {
            "(see attached image)".into()
        } else {
            "(no tool output)".into()
        };
        return json!(sanitize_surrogates(&s));
    }
    let mut out = Vec::new();
    if !text.is_empty() {
        out.push(json!({"type": "input_text", "text": sanitize_surrogates(&text)}));
    }
    for img in images {
        out.push(json!({"type": "input_image", "detail": "auto", "image_url": image_url(img)}));
    }
    Value::Array(out)
}

pub fn convert_tools(tools: &[Tool]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
                "strict": false,
            })
        })
        .collect()
}

/// Transcript → Responses `input` items.
pub fn convert_messages(model: &Model, context: &TranscriptContext) -> Vec<Value> {
    let normalized = resolve_transcript(context, false);
    let replay_pairs = TOOL_CALL_PROVIDERS.contains(&model.provider.as_str()) || is_azure(model);
    let norm = |id: &str| -> String {
        if !replay_pairs || !id.contains('|') {
            return normalize_id_part(id);
        }
        let (call_id, item_id) = id.split_once('|').unwrap_or((id, ""));
        let mut item = normalize_id_part(item_id);
        if !item.starts_with("fc_") {
            item = normalize_id_part(&format!("fc_{}", short_hash(item_id)));
        }
        format!("{}|{}", normalize_id_part(call_id), item)
    };
    let messages = transform_messages(normalized.messages.clone(), model, Some(&norm));
    let instruction_role = if model.reasoning { "developer" } else { "system" };

    let mut out: Vec<Value> = Vec::new();
    let mut msg_index = 0usize;
    for (source_index, msg) in messages.iter().enumerate() {
        let leading_system = source_index == 0 && matches!(msg, Message::System(_));
        match msg {
            Message::System(sm) => {
                let text = if leading_system { get_system_message_text(sm) } else { render_system_message_update(sm) };
                if !text.is_empty() {
                    out.push(json!({"role": instruction_role, "content": sanitize_surrogates(&text)}));
                }
            }
            Message::User(u) => match &u.content {
                UserMessageContent::Text(s) => {
                    out.push(json!({"role": "user", "content": [{"type": "input_text", "text": sanitize_surrogates(s)}]}));
                }
                UserMessageContent::Blocks(blocks) => {
                    let content: Vec<Value> = blocks
                        .iter()
                        .map(|b| match b {
                            UserContent::Text(t) => json!({"type": "input_text", "text": sanitize_surrogates(&t.text)}),
                            UserContent::Image(img) => json!({"type": "input_image", "detail": "auto", "image_url": image_url(img)}),
                        })
                        .collect();
                    if !content.is_empty() {
                        out.push(json!({"role": "user", "content": content}));
                    }
                }
            },
            Message::Assistant(a) => {
                let same_api = a.provider == model.provider && a.api == model.api;
                let different_model = same_api && a.model != model.id;
                let mut text_block_index = 0usize;
                for block in &a.content {
                    match block {
                        AssistantContent::Thinking(t) => {
                            if let Some(item) = t.thinking_signature.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()) {
                                if item.get("type").and_then(|v| v.as_str()) == Some("reasoning") {
                                    out.push(item);
                                }
                            }
                        }
                        AssistantContent::Text(t) => {
                            let parsed = parse_text_signature(t.text_signature.as_deref());
                            let fallback = if text_block_index == 0 {
                                format!("msg_pi_{msg_index}")
                            } else {
                                format!("msg_pi_{msg_index}_{text_block_index}")
                            };
                            text_block_index += 1;
                            let mut id = parsed.as_ref().map(|p| p.0.clone()).unwrap_or(fallback);
                            if id.len() > 64 {
                                id = format!("msg_{}", short_hash(&id));
                            }
                            let mut item = json!({
                                "type": "message",
                                "role": "assistant",
                                "content": [{"type": "output_text", "text": sanitize_surrogates(&t.text), "annotations": []}],
                                "status": "completed",
                                "id": id,
                            });
                            if let Some(phase) = parsed.and_then(|p| p.1) {
                                item["phase"] = json!(phase);
                            }
                            out.push(item);
                        }
                        AssistantContent::ToolCall(tc) => {
                            let (call_id, item_id) = tc.id.split_once('|').map(|(c, i)| (c, Some(i))).unwrap_or((tc.id.as_str(), None));
                            let item_id = item_id.filter(|i| i.starts_with("fc_") && !different_model);
                            let mut item = json!({
                                "type": "function_call",
                                "call_id": call_id,
                                "name": tc.name,
                                "arguments": serde_json::to_string(&tc.arguments).unwrap_or_else(|_| "{}".into()),
                            });
                            if let Some(id) = item_id {
                                item["id"] = json!(id);
                            }
                            out.push(item);
                        }
                    }
                }
            }
            Message::ToolResult(tr) => {
                let call_id = tr.tool_call_id.split('|').next().unwrap_or("");
                out.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": tool_result_output(model, &tr.content),
                }));
            }
        }
        if !leading_system {
            msg_index += 1;
        }
    }
    out
}

fn mapped_effort(model: &Model, level: ThinkingLevel) -> Option<String> {
    match model.mapped_thinking_level(level) {
        Some(mapped) => mapped,
        None => Some(
            match level {
                ThinkingLevel::Max => "xhigh",
                other => other.as_str(),
            }
            .to_string(),
        ),
    }
}

pub fn build_params(model: &Model, context: &TranscriptContext, options: &StreamOptions) -> Value {
    let normalized = resolve_transcript(context, false);
    let tools = resolve_transcript_tools(&normalized.messages, false);
    let mut p = Map::new();
    p.insert("model".into(), json!(model.id));
    p.insert("input".into(), Value::Array(convert_messages(model, context)));
    p.insert("stream".into(), json!(true));
    p.insert("store".into(), json!(false));
    if options.cache_retention.as_deref() != Some("none") {
        if let Some(sid) = &options.session_id {
            p.insert("prompt_cache_key".into(), json!(sid.chars().take(64).collect::<String>()));
        }
        if options.cache_retention.as_deref() == Some("long") && !is_azure(model) {
            p.insert("prompt_cache_retention".into(), json!("24h"));
        }
    }
    if let Some(max) = options.max_tokens {
        p.insert("max_output_tokens".into(), json!(max.max(MIN_OUTPUT_TOKENS)));
    }
    if let Some(t) = options.temperature {
        p.insert("temperature".into(), json!(t));
    }
    if !tools.request_tools.is_empty() {
        p.insert("tools".into(), Value::Array(convert_tools(&tools.request_tools)));
    }
    if model.reasoning {
        match options.reasoning.filter(|l| *l != ThinkingLevel::Off) {
            Some(level) => {
                if let Some(effort) = mapped_effort(model, level) {
                    p.insert("reasoning".into(), json!({"effort": effort, "summary": "auto"}));
                }
                p.insert("include".into(), json!(["reasoning.encrypted_content"]));
            }
            None => {
                // Only send an explicit "off" when the catalog maps one; the
                // accepted value differs per model generation.
                if let Some(Some(off)) = model.mapped_thinking_level(ThinkingLevel::Off) {
                    p.insert("reasoning".into(), json!({"effort": off}));
                }
                p.insert("include".into(), json!(["reasoning.encrypted_content"]));
            }
        }
    }
    if let Some(extra) = &options.sampling_params {
        for (k, v) in extra {
            p.insert(k.clone(), v.clone());
        }
    }
    Value::Object(p)
}

fn build_headers(model: &Model, api_key: &str, options: &StreamOptions) -> BTreeMap<String, String> {
    let mut h = BTreeMap::new();
    h.insert("content-type".into(), "application/json".into());
    h.insert("user-agent".into(), USER_AGENT.into());
    if !api_key.is_empty() {
        if is_azure(model) {
            h.insert("api-key".into(), api_key.to_string());
        } else {
            h.insert("authorization".into(), format!("Bearer {api_key}"));
        }
    }
    if let Some(sid) = &options.session_id {
        if model.provider == "openrouter" || model.base_url.contains("openrouter.ai") {
            h.insert("x-session-id".into(), sid.clone());
        } else {
            h.insert("session_id".into(), sid.clone());
            h.insert("x-client-request-id".into(), sid.clone());
        }
    }
    transport::merge_headers(h, model, options)
}

// ---------------------------------------------------------------------------
// Stream processing
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum SlotKind {
    Thinking,
    Text,
    ToolCall,
}

struct State {
    output: AssistantMessage,
    /// output_index → (kind, content index)
    slots: HashMap<u64, (SlotKind, usize)>,
    /// content index → partial JSON args
    partial_args: HashMap<usize, String>,
    /// reasoning item id → content index (for encrypted_content backfill)
    reasoning_by_id: HashMap<String, usize>,
    saw_terminal: bool,
}

impl State {
    fn slot(&self, ev: &Value, kind: SlotKind) -> Option<usize> {
        let oi = ev["output_index"].as_u64()?;
        self.slots.get(&oi).filter(|(k, _)| *k == kind).map(|(_, i)| *i)
    }
}

async fn create_slot(st: &mut State, tx: &Tx, output_index: u64, item: &Value) -> Option<(SlotKind, usize)> {
    let ty = item["type"].as_str().unwrap_or("");
    let (kind, block) = match ty {
        "reasoning" => (
            SlotKind::Thinking,
            AssistantContent::Thinking(ThinkingContent { thinking: String::new(), thinking_signature: None, redacted: None }),
        ),
        "message" => {
            if item["phase"] == "final_answer" {
                st.output.stop_reason = StopReason::Stop;
            }
            (SlotKind::Text, AssistantContent::Text(TextContent { text: String::new(), text_signature: None }))
        }
        "function_call" => (
            SlotKind::ToolCall,
            AssistantContent::ToolCall(ToolCall {
                id: format!("{}|{}", item["call_id"].as_str().unwrap_or(""), item["id"].as_str().unwrap_or("")),
                name: item["name"].as_str().unwrap_or("").to_string(),
                arguments: json!({}),
                thought_signature: None,
                namespace: item["namespace"].as_str().map(str::to_string),
            }),
        ),
        _ => return None,
    };
    st.output.content.push(block);
    let idx = st.output.content.len() - 1;
    st.slots.insert(output_index, (kind, idx));
    let partial = st.output.clone();
    let ev = match kind {
        SlotKind::Thinking => AssistantMessageEvent::ThinkingStart { content_index: idx, partial },
        SlotKind::Text => AssistantMessageEvent::TextStart { content_index: idx, partial },
        SlotKind::ToolCall => {
            st.partial_args.insert(idx, item["arguments"].as_str().unwrap_or("").to_string());
            AssistantMessageEvent::ToolcallStart { content_index: idx, partial }
        }
    };
    push(tx, ev).await;
    Some((kind, idx))
}

async fn thinking_delta(st: &mut State, tx: &Tx, idx: usize, delta: &str) {
    if let AssistantContent::Thinking(t) = &mut st.output.content[idx] {
        t.thinking.push_str(delta);
    }
    push(tx, AssistantMessageEvent::ThinkingDelta { content_index: idx, delta: delta.to_string(), partial: st.output.clone() }).await;
}

async fn text_delta(st: &mut State, tx: &Tx, idx: usize, delta: &str) {
    if let AssistantContent::Text(t) = &mut st.output.content[idx] {
        t.text.push_str(delta);
    }
    push(tx, AssistantMessageEvent::TextDelta { content_index: idx, delta: delta.to_string(), partial: st.output.clone() }).await;
}

async fn args_delta(st: &mut State, tx: &Tx, idx: usize, delta: &str) {
    let buf = st.partial_args.entry(idx).or_default();
    buf.push_str(delta);
    let parsed = parse_streaming_json(buf);
    if let AssistantContent::ToolCall(tc) = &mut st.output.content[idx] {
        tc.arguments = parsed;
    }
    push(tx, AssistantMessageEvent::ToolcallDelta { content_index: idx, delta: delta.to_string(), partial: st.output.clone() }).await;
}

fn map_stop(status: Option<&str>, incomplete: Option<&str>) -> (StopReason, Option<String>) {
    match status {
        None | Some("completed") | Some("in_progress") | Some("queued") => (StopReason::Stop, None),
        Some("incomplete") => match incomplete {
            Some("max_output_tokens") => (StopReason::Length, None),
            Some(r) => (StopReason::Error, Some(format!("Response incomplete: {r}"))),
            None => (StopReason::Error, Some("Response incomplete without a provider reason".into())),
        },
        Some(_) => (StopReason::Error, None),
    }
}

fn finalize_response(st: &mut State, response: &Value, model: &Model) {
    st.saw_terminal = true;
    // Azure can omit encrypted_content from output_item.done; backfill it.
    for item in response["output"].as_array().into_iter().flatten() {
        let (Some("reasoning"), Some(enc), Some(id)) = (item["type"].as_str(), item["encrypted_content"].as_str(), item["id"].as_str()) else {
            continue;
        };
        let Some(&idx) = st.reasoning_by_id.get(id) else { continue };
        if let AssistantContent::Thinking(t) = &mut st.output.content[idx] {
            if let Some(mut stored) = t.thinking_signature.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()) {
                if stored["encrypted_content"].as_str().map_or(true, str::is_empty) {
                    stored["encrypted_content"] = json!(enc);
                    t.thinking_signature = Some(stored.to_string());
                }
            }
        }
    }
    if let Some(id) = response["id"].as_str() {
        st.output.response_id = Some(id.to_string());
    }
    if let Some(u) = response.get("usage").filter(|u| u.is_object()) {
        let g = |v: &Value| v.as_u64().unwrap_or(0);
        let cached = g(&u["input_tokens_details"]["cached_tokens"]);
        let cache_write = g(&u["input_tokens_details"]["cache_write_tokens"]);
        st.output.usage.input = g(&u["input_tokens"]).saturating_sub(cached + cache_write);
        st.output.usage.output = g(&u["output_tokens"]);
        st.output.usage.cache_read = cached;
        st.output.usage.cache_write = cache_write;
        st.output.usage.reasoning = Some(g(&u["output_tokens_details"]["reasoning_tokens"]));
        st.output.usage.total_tokens = g(&u["total_tokens"]);
    }
    st.output.usage.calculate_cost(model);
    let status = response["status"].as_str();
    let incomplete = response["incomplete_details"]["reason"].as_str();
    st.output.raw_stop_reason = match (status, incomplete) {
        (Some(s), Some(r)) => Some(format!("{s}.{r}")),
        (s, _) => s.map(str::to_string),
    };
    let (reason, err) = map_stop(status, incomplete);
    st.output.stop_reason = reason;
    st.output.error_message = err;
    if reason == StopReason::Stop && st.output.content.iter().any(|c| c.as_tool_call().is_some()) {
        st.output.stop_reason = StopReason::ToolUse;
    }
}

async fn process_event(st: &mut State, tx: &Tx, ev: &Value, model: &Model) -> Result<(), ProviderError> {
    let ty = ev["type"].as_str().unwrap_or("");
    let delta = ev["delta"].as_str().unwrap_or("");
    match ty {
        "response.created" => {
            if let Some(id) = ev["response"]["id"].as_str() {
                st.output.response_id = Some(id.to_string());
            }
        }
        "response.output_item.added" => {
            if let Some(oi) = ev["output_index"].as_u64() {
                create_slot(st, tx, oi, &ev["item"]).await;
            }
        }
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
            if let Some(i) = st.slot(ev, SlotKind::Thinking) {
                thinking_delta(st, tx, i, delta).await;
            }
        }
        "response.reasoning_summary_part.done" => {
            if let Some(i) = st.slot(ev, SlotKind::Thinking) {
                thinking_delta(st, tx, i, "\n\n").await;
            }
        }
        "response.output_text.delta" | "response.refusal.delta" => {
            if let Some(i) = st.slot(ev, SlotKind::Text) {
                text_delta(st, tx, i, delta).await;
            }
        }
        "response.function_call_arguments.delta" => {
            if let Some(i) = st.slot(ev, SlotKind::ToolCall) {
                args_delta(st, tx, i, delta).await;
            }
        }
        "response.function_call_arguments.done" => {
            if let Some(i) = st.slot(ev, SlotKind::ToolCall) {
                let full = ev["arguments"].as_str().unwrap_or("");
                let prev = st.partial_args.get(&i).cloned().unwrap_or_default();
                if let Some(rest) = full.strip_prefix(prev.as_str()).filter(|r| !r.is_empty()) {
                    args_delta(st, tx, i, rest).await;
                } else if !full.starts_with(prev.as_str()) {
                    st.partial_args.insert(i, String::new());
                    args_delta(st, tx, i, full).await;
                }
            }
        }
        "response.output_item.done" => {
            let item = &ev["item"];
            let Some(oi) = ev["output_index"].as_u64() else { return Ok(()) };
            if item["type"] == "message" && item["phase"] == "final_answer" {
                st.output.stop_reason = StopReason::Stop;
            }
            let slot = match st.slots.get(&oi).copied() {
                Some(s) => Some(s),
                None => create_slot(st, tx, oi, item).await,
            };
            let Some((kind, idx)) = slot else { return Ok(()) };
            match kind {
                SlotKind::Thinking => {
                    let join = |key: &str| -> String {
                        item[key]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|s| s["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    };
                    let (summary, content) = (join("summary"), join("content"));
                    if let AssistantContent::Thinking(t) = &mut st.output.content[idx] {
                        if !summary.is_empty() {
                            t.thinking = summary;
                        } else if !content.is_empty() {
                            t.thinking = content;
                        }
                        t.thinking_signature = Some(item.to_string());
                    }
                    if let Some(id) = item["id"].as_str() {
                        st.reasoning_by_id.insert(id.to_string(), idx);
                    }
                    let content = st.output.content[idx].as_thinking().map(|t| t.thinking.clone()).unwrap_or_default();
                    push(tx, AssistantMessageEvent::ThinkingEnd { content_index: idx, content, partial: st.output.clone() }).await;
                }
                SlotKind::Text => {
                    let text: String = item["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|c| c["text"].as_str().or_else(|| c["refusal"].as_str()).unwrap_or(""))
                        .collect();
                    if let AssistantContent::Text(t) = &mut st.output.content[idx] {
                        if !text.is_empty() {
                            t.text = text;
                        }
                        t.text_signature = Some(encode_text_signature(item["id"].as_str().unwrap_or(""), item["phase"].as_str()));
                    }
                    let content = st.output.content[idx].as_text().map(|t| t.text.clone()).unwrap_or_default();
                    push(tx, AssistantMessageEvent::TextEnd { content_index: idx, content, partial: st.output.clone() }).await;
                }
                SlotKind::ToolCall => {
                    let raw = item["arguments"]
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| st.partial_args.remove(&idx))
                        .unwrap_or_else(|| "{}".into());
                    st.partial_args.remove(&idx);
                    if let AssistantContent::ToolCall(tc) = &mut st.output.content[idx] {
                        tc.arguments = parse_streaming_json(&raw);
                        if !tc.arguments.is_object() {
                            tc.arguments = json!({});
                        }
                        if let Some(ns) = item["namespace"].as_str() {
                            tc.namespace = Some(ns.to_string());
                        }
                    }
                    let tool_call = st.output.content[idx].as_tool_call().cloned().expect("tool call slot");
                    push(tx, AssistantMessageEvent::ToolcallEnd { content_index: idx, tool_call, partial: st.output.clone() }).await;
                }
            }
            st.slots.remove(&oi);
        }
        "response.completed" | "response.incomplete" => finalize_response(st, &ev["response"], model),
        "error" => {
            return Err(ProviderError::new(
                None,
                format!("Error Code {}: {}", ev["code"].as_str().unwrap_or("unknown"), ev["message"].as_str().unwrap_or("Unknown error")),
            ));
        }
        "response.failed" => {
            st.saw_terminal = true;
            let r = &ev["response"];
            st.output.raw_stop_reason = r["status"].as_str().map(str::to_string);
            let msg = if r["error"].is_object() {
                format!("{}: {}", r["error"]["code"].as_str().unwrap_or("unknown"), r["error"]["message"].as_str().unwrap_or("no message"))
            } else if let Some(reason) = r["incomplete_details"]["reason"].as_str() {
                format!("incomplete: {reason}")
            } else {
                "Unknown error (no error details in response)".into()
            };
            return Err(ProviderError::new(None, msg));
        }
        _ => {}
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

pub fn stream(model: Model, context: TranscriptContext, options: StreamOptions) -> AssistantMessageEventStream {
    let (tx, rx) = mpsc::channel(256);
    tokio::spawn(async move {
        let mut st = State {
            output: AssistantMessage::pending(&model),
            slots: HashMap::new(),
            partial_args: HashMap::new(),
            reasoning_by_id: HashMap::new(),
            saw_terminal: false,
        };
        let result = run(&model, &context, &options, &tx, &mut st).await;
        transport::finish(&tx, &mut st.output, result, &options).await;
    });
    rx
}

async fn run(model: &Model, context: &TranscriptContext, options: &StreamOptions, tx: &Tx, st: &mut State) -> Result<(), ProviderError> {
    let api_key = transport::require_api_key(model, options, &["authorization", "api-key", "cf-aig-authorization"])?;
    let body = build_params(model, context, options);
    if let Some(cb) = &options.on_payload {
        cb(&body);
    }
    let headers = build_headers(model, &api_key, options);
    let endpoint = format!("{}/responses", model.base_url.trim_end_matches('/'));
    let mut sse = transport::open_sse(&endpoint, &headers, &body, options).await?;
    push(tx, AssistantMessageEvent::Start { partial: st.output.clone() }).await;
    while let Some(ev) = sse.next_json().await? {
        process_event(st, tx, &ev, model).await?;
    }
    if !st.saw_terminal {
        return Err(ProviderError::new(None, "OpenAI Responses stream ended before a terminal response event"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::transcript::{normalize_context, tool};
    use crate::harness::types::{Api, InputType, ModelCost};

    fn model() -> Model {
        Model {
            id: "gpt-5.1".into(),
            name: "GPT-5.1".into(),
            api: Api::OpenAIResponses,
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![InputType::Text, InputType::Image],
            cost: ModelCost::default(),
            prompt_cache: None,
            context_window: 400_000,
            max_tokens: 128_000,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn params_shape() {
        let ctx = normalize_context(
            Some("be brief"),
            Some(&[tool("read", "Read a file", json!({"type":"object","properties":{"path":{"type":"string"}}}))]),
            vec![Message::user_text("hi")],
        );
        let opts = StreamOptions { reasoning: Some(ThinkingLevel::High), max_tokens: Some(8), ..Default::default() };
        let p = build_params(&model(), &ctx, &opts);
        assert_eq!(p["store"], false);
        assert_eq!(p["max_output_tokens"], 16);
        assert_eq!(p["input"][0]["role"], "developer");
        assert_eq!(p["input"][1]["content"][0]["type"], "input_text");
        assert_eq!(p["tools"][0]["name"], "read");
        assert_eq!(p["reasoning"]["effort"], "high");
        assert_eq!(p["include"][0], "reasoning.encrypted_content");
    }

    #[tokio::test]
    async fn stream_events_build_message() {
        let (tx, mut rx) = mpsc::channel(256);
        let m = model();
        let mut st = State {
            output: AssistantMessage::pending(&m),
            slots: HashMap::new(),
            partial_args: HashMap::new(),
            reasoning_by_id: HashMap::new(),
            saw_terminal: false,
        };
        let events = [
            json!({"type":"response.created","response":{"id":"resp_1"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1"}}),
            json!({"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"thinking"}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"text":"thinking"}]}}),
            json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","id":"fc_1","name":"read","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"path\":"}),
            json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"\"a.txt\"}"}),
            json!({"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_1","id":"fc_1","name":"read","arguments":"{\"path\":\"a.txt\"}"}}),
            json!({"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":40}},"output":[{"type":"reasoning","id":"rs_1","encrypted_content":"ENC"}]}}),
        ];
        for ev in &events {
            process_event(&mut st, &tx, ev, &m).await.unwrap();
        }
        drop(tx);
        while rx.recv().await.is_some() {}
        assert_eq!(st.output.stop_reason, StopReason::ToolUse);
        assert_eq!(st.output.usage.input, 60);
        assert_eq!(st.output.usage.cache_read, 40);
        let tc = st.output.content[1].as_tool_call().unwrap();
        assert_eq!(tc.id, "call_1|fc_1");
        assert_eq!(tc.arguments["path"], "a.txt");
        let sig = st.output.content[0].as_thinking().unwrap().thinking_signature.clone().unwrap();
        assert!(sig.contains("ENC"), "encrypted_content backfilled: {sig}");

        // Round-trip: the reasoning item and function_call replay with ids.
        let ctx = TranscriptContext {
            messages: vec![Message::user_text("hi"), Message::Assistant(st.output.clone())],
        };
        let input = convert_messages(&m, &ctx);
        assert_eq!(input[1]["type"], "reasoning");
        assert_eq!(input[2]["type"], "function_call");
        assert_eq!(input[2]["id"], "fc_1");
        assert_eq!(input[2]["call_id"], "call_1");
    }
}
