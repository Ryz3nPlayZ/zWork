//! Anthropic Messages provider.
//!
//! Port of pi-mono `packages/ai/src/api/anthropic-messages.ts` minus the
//! bits zWork doesn't need: OAuth / Claude Code identity spoofing, Copilot,
//! server-side model fallbacks, managed mid-conversation effort, and native
//! mid-conversation tool changes (tool_addition/tool_removal blocks). Keeps
//! prompt caching, adaptive + budget thinking, redacted thinking replay,
//! signature deltas, and the exact stop-reason mapping.

use std::collections::BTreeMap;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use crate::harness::estimate::clamp_max_tokens_to_context;
use crate::harness::json_parse::{parse_json_with_repair, parse_streaming_json};
use crate::harness::retry::{retry_provider_request, ProviderError};
use crate::harness::sse::SseDecoder;
use crate::harness::transcript::{
    get_current_tools, get_initial_system_message, get_system_message_text, render_system_message_update,
    resolve_transcript,
};
use crate::harness::transform_messages::transform_messages;
use crate::harness::types::{
    AssistantContent, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message, Model,
    StopReason, StreamOptions, TextContent, ThinkingContent, ThinkingLevel, Tool, ToolCall, ToolResultMessage,
    TranscriptContext, UserContent, UserMessageContent,
};

use super::openai_completions::USER_AGENT;

const ANTHROPIC_VERSION: &str = "2023-06-01";
const INTERLEAVED_THINKING_BETA: &str = "interleaved-thinking-2025-05-14";
const FINE_GRAINED_TOOL_STREAMING_BETA: &str = "fine-grained-tool-streaming-2025-05-14";

/// Tokens always left for the answer when a thinking budget shares the ceiling.
pub const MIN_ANSWER_TOKENS: u64 = 1024;

// ---------------------------------------------------------------------------
// Compat
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AnthropicCompat {
    pub supports_eager_tool_input_streaming: bool,
    pub supports_long_cache_retention: bool,
    pub send_session_affinity_headers: bool,
    pub session_affinity_openrouter: bool,
    pub supports_cache_control_on_tools: bool,
    pub supports_temperature: bool,
    pub allow_empty_signature: bool,
    pub supports_strict_tools: bool,
    pub supports_mid_convo_system_messages: bool,
    pub force_adaptive_thinking: bool,
}

pub fn get_compat(model: &Model) -> AnthropicCompat {
    let is_openrouter = model.provider == "openrouter" || model.base_url.contains("openrouter.ai");
    let c = model.compat.as_ref();
    let g = |f: Option<bool>, d: bool| f.unwrap_or(d);
    AnthropicCompat {
        supports_eager_tool_input_streaming: g(c.and_then(|c| c.supports_eager_tool_input_streaming), true),
        supports_long_cache_retention: g(c.and_then(|c| c.supports_long_cache_retention), true),
        send_session_affinity_headers: g(c.and_then(|c| c.send_session_affinity_headers), is_openrouter),
        session_affinity_openrouter: is_openrouter,
        supports_cache_control_on_tools: g(c.and_then(|c| c.supports_cache_control_on_tools), true),
        supports_temperature: g(c.and_then(|c| c.supports_temperature), true),
        allow_empty_signature: g(c.and_then(|c| c.allow_empty_signature), false),
        supports_strict_tools: g(c.and_then(|c| c.supports_strict_tools), false),
        supports_mid_convo_system_messages: g(c.and_then(|c| c.supports_mid_convo_system_messages), false),
        force_adaptive_thinking: g(c.and_then(|c| c.force_adaptive_thinking), false),
    }
}

// ---------------------------------------------------------------------------
// Thinking budgets (simple-options.ts)
// ---------------------------------------------------------------------------

pub fn thinking_budget_for_level(level: ThinkingLevel) -> u64 {
    match level {
        ThinkingLevel::Off | ThinkingLevel::Minimal => 1024,
        ThinkingLevel::Low => 2048,
        ThinkingLevel::Medium => 8192,
        ThinkingLevel::High | ThinkingLevel::Xhigh | ThinkingLevel::Max => 16384,
    }
}

/// `adjustMaxTokensForThinking`: fit the thinking budget inside the ceiling.
pub fn adjust_max_tokens_for_thinking(base_max: Option<u64>, model_max: u64, level: ThinkingLevel) -> (u64, u64) {
    let mut budget = thinking_budget_for_level(level);
    let max_tokens = match base_max {
        None => model_max,
        Some(b) => (b + budget).min(model_max),
    };
    if max_tokens <= budget {
        budget = budget.min(max_tokens.saturating_sub(MIN_ANSWER_TOKENS));
    }
    (max_tokens, budget)
}

fn map_thinking_level_to_effort(model: &Model, level: ThinkingLevel) -> String {
    if let Some(Some(mapped)) = model.mapped_thinking_level(level) {
        return mapped;
    }
    match level {
        ThinkingLevel::Minimal | ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        _ => "high",
    }
    .to_string()
}

/// Resolved per-request thinking configuration.
#[derive(Debug, Clone)]
struct ThinkingConfig {
    enabled: bool,
    /// Adaptive effort ("low" | "medium" | "high" | "xhigh" | "max").
    effort: Option<String>,
    budget_tokens: Option<u64>,
    max_tokens: u64,
}

fn resolve_thinking(model: &Model, context: &TranscriptContext, options: &StreamOptions, compat: &AnthropicCompat) -> ThinkingConfig {
    let base_max = clamp_max_tokens_to_context(model.context_window, context, options.max_tokens.unwrap_or(model.max_tokens));
    let level = options.reasoning.filter(|l| *l != ThinkingLevel::Off);
    let Some(level) = level else {
        return ThinkingConfig {
            enabled: false,
            effort: None,
            budget_tokens: None,
            max_tokens: base_max,
        };
    };
    if !model.reasoning {
        return ThinkingConfig {
            enabled: false,
            effort: None,
            budget_tokens: None,
            max_tokens: base_max,
        };
    }
    if compat.force_adaptive_thinking {
        return ThinkingConfig {
            enabled: true,
            effort: Some(map_thinking_level_to_effort(model, level)),
            budget_tokens: None,
            max_tokens: base_max,
        };
    }
    let (adjusted_max, budget) = adjust_max_tokens_for_thinking(options.max_tokens, model.max_tokens, level);
    let max_tokens = clamp_max_tokens_to_context(model.context_window, context, adjusted_max);
    ThinkingConfig {
        enabled: true,
        effort: None,
        budget_tokens: Some(budget.min(max_tokens.saturating_sub(1024))),
        max_tokens,
    }
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

fn cache_control(compat: &AnthropicCompat, retention: Option<&str>) -> Option<Value> {
    match retention {
        Some("none") => None,
        Some("long") if compat.supports_long_cache_retention => Some(json!({"type":"ephemeral","ttl":"1h"})),
        _ => Some(json!({"type":"ephemeral"})),
    }
}

fn normalize_tool_call_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(64)
        .collect()
}

fn image_block(mime: &str, data: &str) -> Value {
    json!({"type":"image","source":{"type":"base64","media_type": mime,"data": data}})
}

/// `convertContentBlocks`: text-only → joined string; otherwise block array
/// with a placeholder text if there are only images.
fn convert_content_blocks(content: &[UserContent]) -> Value {
    let has_images = content.iter().any(|c| matches!(c, UserContent::Image(_)));
    if !has_images {
        let text = content
            .iter()
            .filter_map(|c| match c {
                UserContent::Text(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        return Value::String(text);
    }
    let mut blocks: Vec<Value> = content
        .iter()
        .map(|c| match c {
            UserContent::Text(t) => json!({"type":"text","text": t.text}),
            UserContent::Image(i) => image_block(&i.mime_type, &i.data),
        })
        .collect();
    if !blocks.iter().any(|b| b["type"] == "text") {
        blocks.insert(0, json!({"type":"text","text":"(see attached image)"}));
    }
    Value::Array(blocks)
}

fn convert_tool_result(msg: &ToolResultMessage) -> Value {
    json!({
        "type": "tool_result",
        "tool_use_id": msg.tool_call_id,
        "content": convert_content_blocks(&msg.content),
        "is_error": msg.is_error,
    })
}

/// `convertMessages` (non-OAuth, no native tool changes).
pub fn convert_messages(transformed: &[Message], cache_control: Option<&Value>, allow_empty_signature: bool) -> Vec<Value> {
    let mut params: Vec<Value> = Vec::new();
    // Later system messages are held back and emitted directly before the
    // next assistant message: Anthropic requires tool_result blocks to
    // immediately follow their tool_use.
    let mut pending_system: Vec<Value> = Vec::new();

    let mut i = 0;
    while i < transformed.len() {
        match &transformed[i] {
            Message::System(s) => {
                let text = render_system_message_update(s);
                if !text.is_empty() {
                    pending_system.push(json!({"role":"system","content":[{"type":"text","text": text}]}));
                }
            }
            Message::User(u) => match &u.content {
                UserMessageContent::Text(t) => {
                    if !t.trim().is_empty() {
                        params.push(json!({"role":"user","content": t}));
                    }
                }
                UserMessageContent::Blocks(blocks) => {
                    let filtered: Vec<Value> = blocks
                        .iter()
                        .filter_map(|b| match b {
                            UserContent::Text(t) if t.text.trim().is_empty() => None,
                            UserContent::Text(t) => Some(json!({"type":"text","text": t.text})),
                            UserContent::Image(img) => Some(image_block(&img.mime_type, &img.data)),
                        })
                        .collect();
                    if !filtered.is_empty() {
                        params.push(json!({"role":"user","content": filtered}));
                    }
                }
            },
            Message::Assistant(a) => {
                params.append(&mut pending_system);
                let mut blocks: Vec<Value> = Vec::new();
                for block in &a.content {
                    match block {
                        AssistantContent::Text(t) => {
                            if t.text.trim().is_empty() {
                                continue;
                            }
                            blocks.push(json!({"type":"text","text": t.text}));
                        }
                        AssistantContent::Thinking(th) => {
                            if th.redacted == Some(true) {
                                blocks.push(json!({"type":"redacted_thinking","data": th.thinking_signature.clone().unwrap_or_default()}));
                                continue;
                            }
                            let sig = th.thinking_signature.as_deref().unwrap_or("");
                            let has_sig = !sig.trim().is_empty();
                            if th.thinking.trim().is_empty() && !has_sig {
                                continue;
                            }
                            if !has_sig {
                                // Missing signature (aborted stream): replay as
                                // text unless the provider accepts empty ones.
                                if allow_empty_signature {
                                    blocks.push(json!({"type":"thinking","thinking": th.thinking,"signature":""}));
                                } else {
                                    blocks.push(json!({"type":"text","text": th.thinking}));
                                }
                            } else {
                                blocks.push(json!({"type":"thinking","thinking": th.thinking,"signature": sig}));
                            }
                        }
                        AssistantContent::ToolCall(tc) => {
                            let input = if tc.arguments.is_object() { tc.arguments.clone() } else { json!({}) };
                            blocks.push(json!({"type":"tool_use","id": tc.id,"name": tc.name,"input": input}));
                        }
                    }
                }
                if blocks.is_empty() {
                    i += 1;
                    continue;
                }
                params.push(json!({"role":"assistant","content": blocks}));
            }
            Message::ToolResult(_) => {
                // Collect consecutive tool results into one user message
                // (required by z.ai's Anthropic endpoint).
                let mut results: Vec<Value> = Vec::new();
                let mut j = i;
                while let Some(Message::ToolResult(tr)) = transformed.get(j) {
                    results.push(convert_tool_result(tr));
                    j += 1;
                }
                i = j - 1;
                params.push(json!({"role":"user","content": results}));
            }
        }
        i += 1;
    }
    params.append(&mut pending_system);

    // Cache the conversation history: breakpoint on the last user/system message.
    if let (Some(cc), Some(last)) = (cache_control, params.last_mut()) {
        let role = last["role"].as_str().unwrap_or("");
        if role == "user" || role == "system" {
            match last.get_mut("content") {
                Some(Value::Array(arr)) => {
                    if let Some(lb) = arr.last_mut() {
                        let ty = lb["type"].as_str().unwrap_or("");
                        if matches!(ty, "text" | "image" | "tool_result") {
                            lb["cache_control"] = cc.clone();
                        }
                    }
                }
                Some(Value::String(s)) => {
                    let text = s.clone();
                    last["content"] = json!([{"type":"text","text": text,"cache_control": cc}]);
                }
                _ => {}
            }
        }
    }
    params
}

fn convert_tools(tools: &[Tool], compat: &AnthropicCompat, cache_control: Option<&Value>) -> Vec<Value> {
    let n = tools.len();
    tools
        .iter()
        .enumerate()
        .map(|(idx, t)| {
            let props = t.parameters.get("properties").cloned().unwrap_or_else(|| json!({}));
            let required = t.parameters.get("required").cloned().unwrap_or_else(|| json!([]));
            let mut tool = json!({
                "name": t.name,
                "description": t.description,
                "input_schema": {"type":"object","properties": props,"required": required},
            });
            if compat.supports_eager_tool_input_streaming {
                tool["eager_input_streaming"] = json!(true);
            }
            if let (Some(cc), true) = (cache_control, idx == n - 1) {
                tool["cache_control"] = cc.clone();
            }
            tool
        })
        .collect()
}

fn beta_features(model: &Model, context: &TranscriptContext, thinking: &ThinkingConfig, options: &StreamOptions, compat: &AnthropicCompat) -> Vec<String> {
    // An explicit `anthropic-beta` header (model or options) wins outright.
    for headers in [model.headers.as_ref(), Some(&options.headers)].into_iter().flatten() {
        for (k, v) in headers {
            if k.eq_ignore_ascii_case("anthropic-beta") {
                let mut seen = Vec::new();
                for f in v.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    if !seen.iter().any(|s: &String| s == f) {
                        seen.push(f.to_string());
                    }
                }
                return seen;
            }
        }
    }
    let mut features = Vec::new();
    if !get_current_tools(&context.messages).is_empty() && !compat.supports_eager_tool_input_streaming {
        features.push(FINE_GRAINED_TOOL_STREAMING_BETA.to_string());
    }
    if model.reasoning && thinking.enabled && !compat.force_adaptive_thinking {
        features.push(INTERLEAVED_THINKING_BETA.to_string());
    }
    features
}

/// `buildParams`: the JSON request body.
pub fn build_params(model: &Model, context: &TranscriptContext, options: &StreamOptions, compat: &AnthropicCompat) -> Value {
    let cc = cache_control(compat, options.cache_retention.as_deref());
    let thinking = resolve_thinking(model, context, options, compat);

    let initial_system = get_initial_system_message(&context.messages);
    let initial_text = initial_system.map(get_system_message_text).unwrap_or_default();
    let transformed = transform_messages(context.messages.clone(), model, Some(&normalize_tool_call_id));
    let conversation: &[Message] = if initial_system.is_some() { &transformed[1.min(transformed.len())..] } else { &transformed };
    let messages = convert_messages(conversation, cc.as_ref(), compat.allow_empty_signature);

    let mut params = Map::new();
    params.insert("model".into(), json!(model.id));
    params.insert("messages".into(), Value::Array(messages));
    params.insert("max_tokens".into(), json!(thinking.max_tokens));
    params.insert("stream".into(), json!(true));

    if !initial_text.is_empty() {
        let mut sys = json!({"type":"text","text": initial_text});
        if let Some(cc) = &cc {
            sys["cache_control"] = cc.clone();
        }
        params.insert("system".into(), json!([sys]));
    }

    // Temperature is incompatible with extended thinking.
    if let Some(t) = options.temperature {
        if !thinking.enabled && compat.supports_temperature {
            params.insert("temperature".into(), json!(t));
        }
    }

    let tools = get_current_tools(&context.messages);
    if !tools.is_empty() {
        let tool_cc = if compat.supports_cache_control_on_tools { cc.as_ref() } else { None };
        params.insert("tools".into(), Value::Array(convert_tools(&tools, compat, tool_cc)));
    }

    if model.reasoning {
        if thinking.enabled {
            if compat.force_adaptive_thinking {
                params.insert("thinking".into(), json!({"type":"adaptive","display":"summarized"}));
                if let Some(e) = &thinking.effort {
                    params.insert("output_config".into(), json!({"effort": e}));
                }
            } else {
                params.insert(
                    "thinking".into(),
                    json!({"type":"enabled","budget_tokens": thinking.budget_tokens.filter(|b| *b > 0).unwrap_or(1024),"display":"summarized"}),
                );
            }
        } else if !matches!(model.mapped_thinking_level(ThinkingLevel::Off), Some(None)) {
            params.insert("thinking".into(), json!({"type":"disabled"}));
        }
    }

    if let Some(extra) = &options.sampling_params {
        for (k, v) in extra {
            params.insert(k.clone(), v.clone());
        }
    }
    let _ = beta_features; // betas go on the header, see build_headers
    Value::Object(params)
}

fn build_headers(model: &Model, context: &TranscriptContext, api_key: &str, options: &StreamOptions, compat: &AnthropicCompat) -> BTreeMap<String, String> {
    let mut h: BTreeMap<String, String> = BTreeMap::new();
    h.insert("content-type".into(), "application/json".into());
    h.insert("accept".into(), "application/json".into());
    h.insert("user-agent".into(), USER_AGENT.into());
    h.insert("anthropic-version".into(), ANTHROPIC_VERSION.into());
    if !api_key.is_empty() {
        h.insert("x-api-key".into(), api_key.into());
    }
    if let Some(sid) = &options.session_id {
        if compat.send_session_affinity_headers && options.cache_retention.as_deref() != Some("none") {
            let name = if compat.session_affinity_openrouter { "x-session-id" } else { "x-session-affinity" };
            h.insert(name.into(), sid.clone());
        }
    }
    let thinking = resolve_thinking(model, context, options, compat);
    let betas = beta_features(model, context, &thinking, options, compat);
    if !betas.is_empty() {
        h.insert("anthropic-beta".into(), betas.join(","));
    }
    if let Some(mh) = &model.headers {
        for (k, v) in mh {
            h.insert(k.to_lowercase(), v.clone());
        }
    }
    for (k, v) in &options.headers {
        h.insert(k.to_lowercase(), v.clone());
    }
    h
}

fn endpoint_for(model: &Model) -> String {
    let base = model.base_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

fn map_stop_reason(reason: &str, stop_details: Option<&Value>) -> Result<(StopReason, Option<String>), String> {
    Ok(match reason {
        "end_turn" | "pause_turn" | "stop_sequence" => (StopReason::Stop, None),
        "max_tokens" => (StopReason::Length, None),
        "tool_use" => (StopReason::ToolUse, None),
        "refusal" => (
            StopReason::Error,
            Some(
                stop_details
                    .and_then(|d| d.get("explanation"))
                    .and_then(|e| e.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| "The model refused to complete the request".into()),
            ),
        ),
        "sensitive" => (StopReason::Error, Some("Provider stopped with: sensitive".into())),
        other => return Err(format!("Unhandled stop reason: {other}")),
    })
}

struct StreamState {
    output: AssistantMessage,
    /// Anthropic block index → position in `output.content`, plus partial JSON.
    blocks: Vec<(u64, String)>,
    saw_message_start: bool,
    saw_message_stop: bool,
}

impl StreamState {
    fn find(&self, index: u64) -> Option<usize> {
        self.blocks.iter().position(|(i, _)| *i == index)
    }
}

async fn push(tx: &mpsc::Sender<AssistantMessageEvent>, ev: AssistantMessageEvent) {
    let _ = tx.send(ev).await;
}

fn apply_usage(st: &mut StreamState, usage: &Value, model: &Model, overwrite_missing: bool) {
    let g = |k: &str| usage.get(k).and_then(|v| v.as_u64());
    let u = &mut st.output.usage;
    if overwrite_missing {
        u.input = g("input_tokens").unwrap_or(0);
        u.output = g("output_tokens").unwrap_or(0);
        u.cache_read = g("cache_read_input_tokens").unwrap_or(0);
        u.cache_write = g("cache_creation_input_tokens").unwrap_or(0);
        u.cache_write_1h = usage
            .get("cache_creation")
            .and_then(|c| c.get("ephemeral_1h_input_tokens"))
            .and_then(|v| v.as_u64())
            .or(Some(0));
    } else {
        // message_delta: only overwrite fields that are present so proxies
        // that omit input_tokens don't wipe the message_start value.
        if let Some(v) = g("input_tokens") {
            u.input = v;
        }
        if let Some(v) = g("output_tokens") {
            u.output = v;
        }
        if let Some(v) = g("cache_read_input_tokens") {
            u.cache_read = v;
        }
        if let Some(v) = g("cache_creation_input_tokens") {
            u.cache_write = v;
        }
        if let Some(v) = usage
            .get("output_tokens_details")
            .and_then(|d| d.get("thinking_tokens"))
            .and_then(|v| v.as_u64())
        {
            u.reasoning = Some(v);
        }
    }
    u.total_tokens = u.input + u.output + u.cache_read + u.cache_write;
    u.calculate_cost(model);
}

async fn process_event(st: &mut StreamState, tx: &mpsc::Sender<AssistantMessageEvent>, event: &Value, model: &Model) -> Result<(), ProviderError> {
    let ty = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match ty {
        "error" => {
            let msg = event
                .get("error")
                .map(|e| {
                    let m = e.get("message").and_then(|m| m.as_str()).unwrap_or("");
                    let t = e.get("type").and_then(|m| m.as_str()).unwrap_or("error");
                    if m.is_empty() { t.to_string() } else { format!("{t}: {m}") }
                })
                .unwrap_or_else(|| event.to_string());
            return Err(ProviderError::new(None, msg));
        }
        "message_start" => {
            st.saw_message_start = true;
            let Some(m) = event.get("message") else { return Ok(()) };
            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                st.output.response_id = Some(id.to_string());
            }
            if let Some(rm) = m.get("model").and_then(|v| v.as_str()) {
                if rm != model.id {
                    st.output.response_model = Some(rm.to_string());
                }
            }
            if let Some(u) = m.get("usage") {
                apply_usage(st, u, model, true);
            }
        }
        "content_block_start" => {
            let index = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
            let Some(cb) = event.get("content_block") else { return Ok(()) };
            let cb_type = cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let s = |k: &str| cb.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let ev = match cb_type {
                "text" => {
                    st.output.content.push(AssistantContent::Text(TextContent {
                        text: s("text"),
                        text_signature: None,
                    }));
                    Some("text")
                }
                "thinking" => {
                    st.output.content.push(AssistantContent::Thinking(ThinkingContent {
                        thinking: s("thinking"),
                        thinking_signature: Some(s("signature")),
                        redacted: None,
                    }));
                    Some("thinking")
                }
                "redacted_thinking" => {
                    st.output.content.push(AssistantContent::Thinking(ThinkingContent {
                        thinking: "[Reasoning redacted]".into(),
                        thinking_signature: Some(s("data")),
                        redacted: Some(true),
                    }));
                    Some("thinking")
                }
                "tool_use" => {
                    let input = cb.get("input").cloned().filter(|v| v.is_object()).unwrap_or_else(|| json!({}));
                    st.output.content.push(AssistantContent::ToolCall(ToolCall {
                        id: s("id"),
                        name: s("name"),
                        arguments: input,
                        thought_signature: None,
                        namespace: None,
                    }));
                    Some("toolCall")
                }
                _ => None,
            };
            if let Some(kind) = ev {
                st.blocks.push((index, String::new()));
                let ci = st.output.content.len() - 1;
                let partial = st.output.clone();
                push(
                    tx,
                    match kind {
                        "text" => AssistantMessageEvent::TextStart { content_index: ci, partial },
                        "thinking" => AssistantMessageEvent::ThinkingStart { content_index: ci, partial },
                        _ => AssistantMessageEvent::ToolcallStart { content_index: ci, partial },
                    },
                )
                .await;
            }
        }
        "content_block_delta" => {
            let index = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
            let Some(pos) = st.find(index) else { return Ok(()) };
            let Some(delta) = event.get("delta") else { return Ok(()) };
            let dtype = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match dtype {
                "text_delta" => {
                    let text = delta.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if let AssistantContent::Text(b) = &mut st.output.content[pos] {
                        b.text.push_str(&text);
                        push(tx, AssistantMessageEvent::TextDelta { content_index: pos, delta: text, partial: st.output.clone() }).await;
                    }
                }
                "thinking_delta" => {
                    let text = delta.get("thinking").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if let AssistantContent::Thinking(b) = &mut st.output.content[pos] {
                        b.thinking.push_str(&text);
                        push(tx, AssistantMessageEvent::ThinkingDelta { content_index: pos, delta: text, partial: st.output.clone() }).await;
                    }
                }
                "input_json_delta" => {
                    let pj = delta.get("partial_json").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if let AssistantContent::ToolCall(_) = &st.output.content[pos] {
                        st.blocks[pos].1.push_str(&pj);
                        let parsed = parse_streaming_json(&st.blocks[pos].1);
                        if let AssistantContent::ToolCall(b) = &mut st.output.content[pos] {
                            b.arguments = parsed;
                        }
                        push(tx, AssistantMessageEvent::ToolcallDelta { content_index: pos, delta: pj, partial: st.output.clone() }).await;
                    }
                }
                "signature_delta" => {
                    let sig = delta.get("signature").and_then(|v| v.as_str()).unwrap_or("");
                    if let AssistantContent::Thinking(b) = &mut st.output.content[pos] {
                        b.thinking_signature.get_or_insert_with(String::new).push_str(sig);
                    }
                }
                _ => {}
            }
        }
        "content_block_stop" => {
            let index = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
            let Some(pos) = st.find(index) else { return Ok(()) };
            let ev = match &st.output.content[pos] {
                AssistantContent::Text(t) => AssistantMessageEvent::TextEnd { content_index: pos, content: t.text.clone(), partial: st.output.clone() },
                AssistantContent::Thinking(t) => AssistantMessageEvent::ThinkingEnd { content_index: pos, content: t.thinking.clone(), partial: st.output.clone() },
                AssistantContent::ToolCall(_) => {
                    let parsed = parse_streaming_json(&st.blocks[pos].1);
                    if let AssistantContent::ToolCall(b) = &mut st.output.content[pos] {
                        b.arguments = if parsed.is_object() { parsed } else { json!({}) };
                    }
                    let AssistantContent::ToolCall(b) = &st.output.content[pos] else { unreachable!() };
                    AssistantMessageEvent::ToolcallEnd { content_index: pos, tool_call: b.clone(), partial: st.output.clone() }
                }
            };
            push(tx, ev).await;
        }
        "message_delta" => {
            if let Some(delta) = event.get("delta") {
                if let Some(sr) = delta.get("stop_reason").and_then(|v| v.as_str()) {
                    st.output.raw_stop_reason = Some(sr.to_string());
                    let (stop, err) = map_stop_reason(sr, delta.get("stop_details")).map_err(|m| ProviderError::new(None, m))?;
                    st.output.stop_reason = stop;
                    if let Some(e) = err {
                        st.output.error_message = Some(e);
                    }
                }
            }
            if let Some(u) = event.get("usage").filter(|u| u.is_object()) {
                apply_usage(st, u, model, false);
            } else {
                let u = &mut st.output.usage;
                u.total_tokens = u.input + u.output + u.cache_read + u.cache_write;
                u.calculate_cost(model);
            }
        }
        "message_stop" => {
            st.saw_message_stop = true;
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
        run_stream(model, context, options, tx).await;
    });
    rx
}

async fn run_stream(model: Model, context: TranscriptContext, options: StreamOptions, tx: mpsc::Sender<AssistantMessageEvent>) {
    let compat = get_compat(&model);
    let mut st = StreamState {
        output: AssistantMessage::pending(&model),
        blocks: Vec::new(),
        saw_message_start: false,
        saw_message_stop: false,
    };

    let result: Result<(), ProviderError> = async {
        let api_key = options.api_key.clone().unwrap_or_default();
        let has_auth = options.headers.keys().any(|k| {
            let k = k.to_lowercase();
            k == "authorization" || k == "x-api-key" || k == "cf-aig-authorization"
        });
        if api_key.is_empty() && !has_auth {
            return Err(ProviderError::new(None, format!("No API key for provider: {}", model.provider)));
        }

        let normalized = resolve_transcript(&context, compat.supports_mid_convo_system_messages);
        let body = build_params(&model, &normalized, &options, &compat);
        if let Some(cb) = &options.on_payload {
            cb(&body);
        }
        let headers = build_headers(&model, &normalized, &api_key, &options, &compat);
        let endpoint = endpoint_for(&model);
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| ProviderError::new(None, format!("http client: {e}")))?;

        let signal = options.signal.clone();
        let response = retry_provider_request(
            || {
                let client = client.clone();
                let headers = headers.clone();
                let body = body.clone();
                let endpoint = endpoint.clone();
                let signal = signal.clone();
                async move {
                    let mut req = client.post(&endpoint);
                    for (k, v) in &headers {
                        req = req.header(k.as_str(), v.as_str());
                    }
                    let send = req.json(&body).send();
                    let resp = match signal {
                        Some(sig) => tokio::select! {
                            r = send => r,
                            _ = sig.cancelled() => return Err(ProviderError::new(None, "Request aborted")),
                        },
                        None => send.await,
                    }
                    .map_err(|e| ProviderError::new(None, format!("request failed: {e}")))?;
                    let status = resp.status();
                    if !status.is_success() {
                        let hdrs: Vec<(String, String)> = resp
                            .headers()
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                            .collect();
                        let body_txt = resp.text().await.unwrap_or_default();
                        return Err(ProviderError {
                            status: Some(status.as_u16()),
                            message: status.canonical_reason().unwrap_or("HTTP error").to_string(),
                            headers: hdrs,
                            body: Some(body_txt),
                        });
                    }
                    Ok(resp)
                }
            },
            options.max_retries,
            options.max_retry_delay_ms,
            options.signal.as_ref(),
        )
        .await?;

        push(&tx, AssistantMessageEvent::Start { partial: st.output.clone() }).await;

        let mut decoder = SseDecoder::new();
        let mut bytes = response.bytes_stream();
        loop {
            let next = match &options.signal {
                Some(sig) => tokio::select! {
                    n = bytes.next() => n,
                    _ = sig.cancelled() => return Err(ProviderError::new(None, "Request was aborted")),
                },
                None => bytes.next().await,
            };
            let chunk = match next {
                Some(Ok(c)) => c,
                Some(Err(e)) => return Err(ProviderError::new(None, format!("stream read error: {e}"))),
                None => break,
            };
            let text = String::from_utf8_lossy(&chunk);
            for frame in decoder.push(&text) {
                let ev = parse_json_with_repair(&frame)
                    .map_err(|e| ProviderError::new(None, format!("Could not parse Anthropic SSE event: {e}; data={}", truncate(&frame, 300))))?;
                process_event(&mut st, &tx, &ev, &model).await?;
            }
        }
        for frame in decoder.finish() {
            if let Ok(ev) = parse_json_with_repair(&frame) {
                process_event(&mut st, &tx, &ev, &model).await?;
            }
        }

        if options.signal.as_ref().map_or(false, |s| s.is_aborted()) {
            return Err(ProviderError::new(None, "Request was aborted"));
        }
        if st.saw_message_start && !st.saw_message_stop {
            return Err(ProviderError::new(None, "Anthropic stream ended before message_stop"));
        }
        if st.output.stop_reason == StopReason::Pending {
            return Err(ProviderError::new(None, "Anthropic stream ended without a stop reason"));
        }
        if matches!(st.output.stop_reason, StopReason::Aborted | StopReason::Error) {
            return Err(ProviderError::new(
                None,
                st.output.error_message.clone().unwrap_or_else(|| "An unknown error occurred".into()),
            ));
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            push(&tx, AssistantMessageEvent::Done { reason: st.output.stop_reason, message: st.output.clone() }).await;
        }
        Err(err) => {
            let aborted = options.signal.as_ref().map_or(false, |s| s.is_aborted());
            st.output.stop_reason = if aborted { StopReason::Aborted } else { StopReason::Error };
            st.output.error_message = Some(err.format());
            push(&tx, AssistantMessageEvent::Error { reason: st.output.stop_reason, error: st.output.clone() }).await;
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::transcript::{normalize_context, tool};
    use crate::harness::types::{Api, InputType, ModelCost, OpenAICompletionsCompat};

    fn model(adaptive: bool) -> Model {
        Model {
            id: "claude-sonnet-5".into(),
            name: "Sonnet".into(),
            api: Api::AnthropicMessages,
            provider: "anthropic".into(),
            base_url: "https://api.anthropic.com".into(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![InputType::Text, InputType::Image],
            cost: ModelCost::default(),
            prompt_cache: Some(true),
            context_window: 200_000,
            max_tokens: 32_000,
            headers: None,
            compat: Some(OpenAICompletionsCompat {
                force_adaptive_thinking: Some(adaptive),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn build_params_budget_thinking_and_cache() {
        let m = model(false);
        let ctx = normalize_context(
            Some("sys"),
            Some(&[tool("read", "Read", json!({"type":"object","properties":{"p":{"type":"string"}},"required":["p"]}))]),
            vec![Message::user_text("hi")],
        );
        let opts = StreamOptions {
            reasoning: Some(ThinkingLevel::Medium),
            max_tokens: Some(4000),
            temperature: Some(0.5),
            ..Default::default()
        };
        let c = get_compat(&m);
        let p = build_params(&m, &ctx, &opts, &c);
        assert_eq!(p["model"], "claude-sonnet-5");
        assert_eq!(p["max_tokens"], 4000 + 8192);
        assert_eq!(p["thinking"]["type"], "enabled");
        assert_eq!(p["thinking"]["budget_tokens"], 8192);
        assert!(p.get("temperature").is_none(), "temperature dropped with thinking");
        assert_eq!(p["system"][0]["text"], "sys");
        assert_eq!(p["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(p["tools"][0]["input_schema"]["required"][0], "p");
        assert_eq!(p["tools"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(p["tools"][0]["eager_input_streaming"], true);
        // last user message carries the conversation breakpoint
        assert_eq!(p["messages"][0]["content"][0]["cache_control"]["type"], "ephemeral");
        let h = build_headers(&m, &ctx, "k", &opts, &c);
        assert_eq!(h["anthropic-beta"], INTERLEAVED_THINKING_BETA);
        assert_eq!(h["x-api-key"], "k");
    }

    #[test]
    fn build_params_adaptive_thinking() {
        let m = model(true);
        let ctx = normalize_context(Some("sys"), None, vec![Message::user_text("hi")]);
        let opts = StreamOptions {
            reasoning: Some(ThinkingLevel::High),
            ..Default::default()
        };
        let c = get_compat(&m);
        let p = build_params(&m, &ctx, &opts, &c);
        assert_eq!(p["thinking"]["type"], "adaptive");
        assert_eq!(p["output_config"]["effort"], "high");
        assert_eq!(p["max_tokens"], 32_000);
        let h = build_headers(&m, &ctx, "k", &opts, &c);
        assert!(h.get("anthropic-beta").is_none());
    }

    #[test]
    fn convert_messages_groups_tool_results_and_replays_thinking() {
        let m = model(true);
        let mut a = AssistantMessage::pending(&m);
        a.stop_reason = StopReason::ToolUse;
        a.content = vec![
            AssistantContent::Thinking(ThinkingContent { thinking: "t".into(), thinking_signature: Some("sig".into()), redacted: None }),
            AssistantContent::Thinking(ThinkingContent { thinking: "unsigned".into(), thinking_signature: None, redacted: None }),
            AssistantContent::ToolCall(ToolCall { id: "a".into(), name: "read".into(), arguments: json!({"p":"x"}), thought_signature: None, namespace: None }),
            AssistantContent::ToolCall(ToolCall { id: "b".into(), name: "read".into(), arguments: json!({"p":"y"}), thought_signature: None, namespace: None }),
        ];
        let tr = |id: &str| {
            Message::ToolResult(ToolResultMessage {
                tool_call_id: id.into(),
                tool_name: "read".into(),
                content: vec![UserContent::text("ok")],
                details: None,
                usage: None,
                is_error: false,
                timestamp: 0,
            })
        };
        let msgs = vec![Message::user_text("hi"), Message::Assistant(a), tr("a"), tr("b")];
        let out = convert_messages(&msgs, None, false);
        assert_eq!(out.len(), 3);
        let blocks = out[1]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[0]["signature"], "sig");
        assert_eq!(blocks[1]["type"], "text");
        assert_eq!(blocks[1]["text"], "unsigned");
        assert_eq!(blocks[2]["type"], "tool_use");
        let results = out[2]["content"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[1]["tool_use_id"], "b");
        assert_eq!(results[1]["content"], "ok");
    }

    #[tokio::test]
    async fn event_state_machine() {
        let m = model(true);
        let (tx, mut rx) = mpsc::channel(64);
        let mut st = StreamState { output: AssistantMessage::pending(&m), blocks: Vec::new(), saw_message_start: false, saw_message_stop: false };
        let events = [
            json!({"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5","usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":50}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"p\":"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"x\"}"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}),
            json!({"type":"message_stop"}),
        ];
        for e in &events {
            process_event(&mut st, &tx, e, &m).await.unwrap();
        }
        drop(tx);
        let mut kinds = Vec::new();
        while let Some(ev) = rx.recv().await {
            kinds.push(ev.kind());
        }
        assert_eq!(kinds, vec!["thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end"]);
        assert_eq!(st.output.stop_reason, StopReason::ToolUse);
        assert_eq!(st.output.usage.input, 100);
        assert_eq!(st.output.usage.output, 20);
        assert_eq!(st.output.usage.cache_read, 50);
        assert_eq!(st.output.usage.total_tokens, 170);
        let th = st.output.content[0].as_thinking().unwrap();
        assert_eq!(th.thinking, "hmm");
        assert_eq!(th.thinking_signature.as_deref(), Some("SIG"));
        let tc = st.output.content[1].as_tool_call().unwrap();
        assert_eq!(tc.arguments, json!({"p":"x"}));
        assert!(st.saw_message_stop);
    }

    #[test]
    fn stop_reason_mapping() {
        assert_eq!(map_stop_reason("end_turn", None).unwrap().0, StopReason::Stop);
        assert_eq!(map_stop_reason("max_tokens", None).unwrap().0, StopReason::Length);
        let (r, e) = map_stop_reason("refusal", Some(&json!({"explanation":"nope"}))).unwrap();
        assert_eq!(r, StopReason::Error);
        assert_eq!(e.as_deref(), Some("nope"));
        assert!(map_stop_reason("weird", None).is_err());
    }

    #[test]
    fn endpoint_handles_v1_suffix() {
        let mut m = model(true);
        assert_eq!(endpoint_for(&m), "https://api.anthropic.com/v1/messages");
        m.base_url = "https://gateway.example/v1/".into();
        assert_eq!(endpoint_for(&m), "https://gateway.example/v1/messages");
    }
}
