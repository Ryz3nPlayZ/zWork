//! OpenAI Chat Completions provider (DeepSeek, GLM, OpenRouter, zWork gateway).
//!
//! Port of pi-mono `packages/ai/src/api/openai-completions.ts`. Drops pieces
//! zWork has no use for: grammar-constrained "custom" tools, GitHub Copilot
//! headers, Vercel gateway routing, chat-template thinking budgets. Keeps the
//! provider-quirk table (`detect_compat`), the reasoning-field handling
//! (`reasoning_content` / `reasoning` / `reasoning_text` / OpenRouter
//! `reasoning_details`), cache-control injection for Anthropic-via-OpenRouter,
//! and the streaming block state machine.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use crate::harness::sse::SseDecoder;
use crate::harness::json_parse::parse_streaming_json;
use crate::harness::retry::{retry_provider_request, ProviderError};
use crate::harness::transcript::{
    get_system_message_text, has_tool_history, render_system_message_update, resolve_transcript,
    resolve_transcript_tools,
};
use crate::harness::transform_messages::transform_messages;
use crate::harness::types::{
    AssistantContent, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, CacheControlFormat,
    MaxTokensField, Model, StopReason, StreamOptions, TextContent, ThinkingContent, ThinkingFormat, ThinkingLevel,
    Tool, ToolCall, TranscriptContext, Usage, UserContent, UserMessageContent, Message,
};

pub const USER_AGENT: &str = concat!("zwork/", env!("CARGO_PKG_VERSION"));

// ---------------------------------------------------------------------------
// Compat resolution
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ResolvedCompat {
    pub supports_store: bool,
    pub supports_developer_role: bool,
    pub supports_reasoning_effort: bool,
    pub supports_usage_in_streaming: bool,
    pub supports_finish_reason: bool,
    pub max_tokens_field: MaxTokensField,
    pub requires_tool_result_name: bool,
    pub requires_assistant_after_tool_result: bool,
    pub requires_thinking_as_text: bool,
    pub requires_reasoning_content_on_assistant_messages: bool,
    pub thinking_format: ThinkingFormat,
    pub open_router_routing: Option<Value>,
    pub zai_tool_stream: bool,
    pub supports_strict_mode: bool,
    pub supports_mid_convo_system_messages: bool,
    pub supports_mid_convo_tool_additions: bool,
    pub cache_control_format: Option<CacheControlFormat>,
    pub send_session_affinity_headers: bool,
    pub session_affinity_openrouter: bool,
    pub supports_long_cache_retention: bool,
}

/// Auto-detect compatibility settings from provider name and base URL.
pub fn detect_compat(model: &Model) -> ResolvedCompat {
    let provider = model.provider.as_str();
    let base = model.base_url.as_str();
    let has = |s: &str| base.contains(s);

    let is_zai = provider == "zai" || provider == "zai-coding-cn" || has("api.z.ai") || has("open.bigmodel.cn");
    let is_together = provider == "together" || has("api.together.ai") || has("api.together.xyz");
    let is_moonshot = provider == "moonshotai" || provider == "moonshotai-cn" || has("api.moonshot.");
    let is_openrouter = provider == "openrouter" || has("openrouter.ai");
    let is_cf_workers = provider == "cloudflare-workers-ai" || has("api.cloudflare.com");
    let is_cf_gateway = provider == "cloudflare-ai-gateway" || has("gateway.ai.cloudflare.com");
    let is_nvidia = provider == "nvidia" || has("integrate.api.nvidia.com");
    let is_ant_ling = provider == "ant-ling" || has("api.ant-ling.com");
    let is_cerebras = provider == "cerebras" || has("cerebras.ai");
    let is_deepseek = provider == "deepseek" || base.to_lowercase().contains("deepseek.com");
    let is_grok = provider == "xai" || has("api.x.ai");

    let is_non_standard = is_nvidia
        || is_cerebras
        || is_grok
        || is_together
        || has("chutes.ai")
        || is_deepseek
        || is_zai
        || is_moonshot
        || provider == "opencode"
        || has("opencode.ai")
        || is_cf_workers
        || is_cf_gateway
        || is_ant_ling;

    let use_max_tokens = has("chutes.ai")
        || is_deepseek
        || is_moonshot
        || is_cf_gateway
        || is_together
        || is_nvidia
        || is_ant_ling
        || is_zai;

    let is_openrouter_dev_role_model =
        is_openrouter && (model.id.starts_with("anthropic/") || model.id.starts_with("openai/"));
    let cache_control_format = if provider == "openrouter" && model.id.starts_with("anthropic/") {
        Some(CacheControlFormat::Anthropic)
    } else {
        None
    };

    ResolvedCompat {
        supports_store: !is_non_standard,
        supports_developer_role: is_openrouter_dev_role_model || (!is_non_standard && !is_openrouter),
        supports_reasoning_effort: !is_grok
            && !is_zai
            && !is_moonshot
            && !is_together
            && !is_cf_gateway
            && !is_nvidia
            && !is_ant_ling,
        supports_usage_in_streaming: true,
        supports_finish_reason: true,
        max_tokens_field: if use_max_tokens {
            MaxTokensField::MaxTokens
        } else {
            MaxTokensField::MaxCompletionTokens
        },
        requires_tool_result_name: false,
        requires_assistant_after_tool_result: false,
        requires_thinking_as_text: false,
        requires_reasoning_content_on_assistant_messages: is_deepseek,
        thinking_format: if is_deepseek {
            ThinkingFormat::Deepseek
        } else if is_zai {
            ThinkingFormat::Zai
        } else if is_together {
            ThinkingFormat::Together
        } else if is_ant_ling {
            ThinkingFormat::AntLing
        } else if is_openrouter {
            ThinkingFormat::Openrouter
        } else {
            ThinkingFormat::Openai
        },
        open_router_routing: None,
        zai_tool_stream: false,
        supports_strict_mode: !is_moonshot && !is_together && !is_cf_gateway && !is_nvidia && !is_cerebras,
        supports_mid_convo_system_messages: false,
        supports_mid_convo_tool_additions: false,
        cache_control_format,
        send_session_affinity_headers: is_openrouter,
        session_affinity_openrouter: is_openrouter,
        supports_long_cache_retention: !(is_together || is_cf_workers || is_cf_gateway || is_nvidia || is_ant_ling),
    }
}

/// Auto-detect, then override with explicit `model.compat`.
pub fn get_compat(model: &Model) -> ResolvedCompat {
    let mut d = detect_compat(model);
    let Some(c) = &model.compat else { return d };
    macro_rules! ov {
        ($field:ident) => {
            if let Some(v) = c.$field {
                d.$field = v;
            }
        };
    }
    ov!(supports_store);
    ov!(supports_developer_role);
    ov!(supports_reasoning_effort);
    ov!(supports_usage_in_streaming);
    ov!(supports_finish_reason);
    ov!(max_tokens_field);
    ov!(requires_tool_result_name);
    ov!(requires_assistant_after_tool_result);
    ov!(requires_thinking_as_text);
    ov!(requires_reasoning_content_on_assistant_messages);
    ov!(thinking_format);
    ov!(zai_tool_stream);
    ov!(supports_strict_mode);
    ov!(supports_mid_convo_system_messages);
    ov!(supports_mid_convo_tool_additions);
    ov!(send_session_affinity_headers);
    ov!(supports_long_cache_retention);
    if let Some(v) = c.cache_control_format {
        d.cache_control_format = Some(v);
    }
    if let Some(v) = &c.open_router_routing {
        d.open_router_routing = Some(v.clone());
    }
    d
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CacheRetention {
    None,
    Short,
    Long,
}

fn resolve_cache_retention(opt: Option<&str>) -> CacheRetention {
    match opt {
        Some("none") => CacheRetention::None,
        Some("long") => CacheRetention::Long,
        _ => CacheRetention::Short,
    }
}

fn sanitize_surrogates(s: &str) -> String {
    // Rust strings are always valid UTF-8; lone surrogates can't exist here.
    s.to_string()
}

const REASONING_FIELDS: [&str; 3] = ["reasoning_content", "reasoning", "reasoning_text"];

fn is_reasoning_field(s: &str) -> bool {
    REASONING_FIELDS.contains(&s)
}

const REASONING_DETAILS_SIGNATURE_PREFIX: &str = "openai_reasoning_details:";

fn parse_reasoning_details(signature: Option<&str>) -> Option<Vec<Value>> {
    let sig = signature?;
    let json = sig.strip_prefix(REASONING_DETAILS_SIGNATURE_PREFIX)?;
    serde_json::from_str::<Vec<Value>>(json).ok()
}

fn encode_reasoning_details(details: &[Value]) -> String {
    format!(
        "{}{}",
        REASONING_DETAILS_SIGNATURE_PREFIX,
        serde_json::to_string(details).unwrap_or_else(|_| "[]".into())
    )
}

fn normalize_tool_call_id(model: &Model, id: &str) -> String {
    if let Some(sep) = id.find('|') {
        let sanitize = |s: &str| -> String {
            s.chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
                .collect()
        };
        let call_id = sanitize(&id[..sep]);
        let item_id = sanitize(&id[sep + 1..]);
        let combined = if item_id.is_empty() {
            call_id.clone()
        } else {
            format!("{call_id}_{item_id}")
        };
        if combined.len() <= 40 {
            return combined;
        }
        let hash = short_hash(id);
        let hash = &hash[..8.min(hash.len())];
        let prefix: String = call_id.chars().take((40usize.saturating_sub(hash.len() + 1)).max(1)).collect();
        return format!("{prefix}_{hash}");
    }
    if model.provider == "openai" && id.len() > 40 {
        return id[..40].to_string();
    }
    id.to_string()
}

fn short_hash(s: &str) -> String {
    // FNV-1a 64-bit, hex. Stable across runs; only needs to be unique-ish.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn convert_tools(tools: &[Tool], compat: &ResolvedCompat) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            let mut f = json!({
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            });
            if compat.supports_strict_mode {
                f["strict"] = Value::Bool(false);
            }
            json!({ "type": "function", "function": f })
        })
        .collect()
}

/// `convertMessages`: transcript → Chat Completions `messages`.
pub fn convert_messages(model: &Model, context: &TranscriptContext, compat: &ResolvedCompat) -> Vec<Value> {
    let normalized = resolve_transcript(context, compat.supports_mid_convo_system_messages);
    let norm = |id: &str| normalize_tool_call_id(model, id);
    let messages = transform_messages(normalized.messages.clone(), model, Some(&norm));
    let transcript_tools = resolve_transcript_tools(
        &normalized.messages,
        compat.supports_mid_convo_system_messages && compat.supports_mid_convo_tool_additions,
    );
    let instruction_role = if model.reasoning && compat.supports_developer_role {
        "developer"
    } else {
        "system"
    };

    let mut params: Vec<Value> = Vec::with_capacity(messages.len());
    let mut last_role: Option<&str> = None;
    let mut i = 0;
    while i < messages.len() {
        let msg = &messages[i];
        if compat.requires_assistant_after_tool_result && last_role == Some("toolResult") && matches!(msg, Message::User(_)) {
            params.push(json!({"role":"assistant","content":"I have processed the tool results."}));
        }
        match msg {
            Message::System(sm) => {
                let added: &[Tool] = if i > 0 && transcript_tools.anchors_additions {
                    sm.tools_added.as_deref().unwrap_or(&[])
                } else {
                    &[]
                };
                if !added.is_empty() {
                    params.push(json!({"role":"system","tools": convert_tools(added, compat)}));
                }
                let text = if i == 0 {
                    get_system_message_text(sm)
                } else {
                    render_system_message_update(sm)
                };
                if !text.is_empty() {
                    params.push(json!({"role": instruction_role, "content": sanitize_surrogates(&text)}));
                }
            }
            Message::User(u) => match &u.content {
                UserMessageContent::Text(s) => {
                    params.push(json!({"role":"user","content": sanitize_surrogates(s)}));
                }
                UserMessageContent::Blocks(blocks) => {
                    let content: Vec<Value> = blocks
                        .iter()
                        .map(|b| match b {
                            UserContent::Text(t) => json!({"type":"text","text": sanitize_surrogates(&t.text)}),
                            UserContent::Image(img) => json!({"type":"image_url","image_url":{"url": format!("data:{};base64,{}", img.mime_type, img.data)}}),
                        })
                        .collect();
                    if content.is_empty() {
                        i += 1;
                        continue;
                    }
                    params.push(json!({"role":"user","content": content}));
                }
            },
            Message::Assistant(a) => {
                let mut am = Map::new();
                am.insert("role".into(), json!("assistant"));
                am.insert(
                    "content".into(),
                    if compat.requires_assistant_after_tool_result {
                        json!("")
                    } else {
                        Value::Null
                    },
                );

                let text_parts: Vec<String> = a
                    .content
                    .iter()
                    .filter_map(|c| c.as_text())
                    .filter(|t| !t.text.trim().is_empty())
                    .map(|t| sanitize_surrogates(&t.text))
                    .collect();
                let assistant_text = text_parts.join("");
                let thinking_blocks: Vec<&ThinkingContent> = a.content.iter().filter_map(|c| c.as_thinking()).collect();
                let tool_calls: Vec<&ToolCall> = a.content.iter().filter_map(|c| c.as_tool_call()).collect();
                let preserved_reasoning_details = thinking_blocks
                    .iter()
                    .find_map(|b| parse_reasoning_details(b.thinking_signature.as_deref()));

                let non_empty_thinking: Vec<&ThinkingContent> =
                    thinking_blocks.iter().copied().filter(|b| !b.thinking.trim().is_empty()).collect();
                if !non_empty_thinking.is_empty() {
                    if compat.requires_thinking_as_text {
                        let thinking_text = non_empty_thinking
                            .iter()
                            .map(|b| sanitize_surrogates(&b.thinking))
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        let mut parts = vec![json!({"type":"text","text": thinking_text})];
                        parts.extend(text_parts.iter().map(|t| json!({"type":"text","text": t})));
                        am.insert("content".into(), Value::Array(parts));
                    } else {
                        if !assistant_text.is_empty() {
                            am.insert("content".into(), json!(assistant_text));
                        }
                        if preserved_reasoning_details.is_none() {
                            if let Some(sig) = non_empty_thinking[0].thinking_signature.as_deref() {
                                if is_reasoning_field(sig) {
                                    let joined = non_empty_thinking
                                        .iter()
                                        .map(|b| b.thinking.as_str())
                                        .collect::<Vec<_>>()
                                        .join("\n");
                                    am.insert(sig.to_string(), json!(joined));
                                }
                            }
                        }
                    }
                } else if !assistant_text.is_empty() {
                    am.insert("content".into(), json!(assistant_text));
                }

                if !tool_calls.is_empty() {
                    let tcs: Vec<Value> = tool_calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": serde_json::to_string(&tc.arguments).unwrap_or_else(|_| "{}".into()),
                                }
                            })
                        })
                        .collect();
                    am.insert("tool_calls".into(), Value::Array(tcs));
                }
                if let Some(details) = preserved_reasoning_details {
                    am.insert("reasoning_details".into(), Value::Array(details));
                }
                if compat.requires_reasoning_content_on_assistant_messages
                    && model.reasoning
                    && !am.contains_key("reasoning_content")
                {
                    am.insert("reasoning_content".into(), json!(""));
                }
                let has_content = match am.get("content") {
                    Some(Value::String(s)) => !s.is_empty(),
                    Some(Value::Array(a)) => !a.is_empty(),
                    _ => false,
                };
                if !has_content && !am.contains_key("tool_calls") {
                    i += 1;
                    continue;
                }
                params.push(Value::Object(am));
            }
            Message::ToolResult(_) => {
                let mut image_blocks: Vec<Value> = Vec::new();
                let mut j = i;
                while j < messages.len() {
                    let Message::ToolResult(tr) = &messages[j] else { break };
                    let text_result = tr.text();
                    let has_images = tr.content.iter().any(|c| matches!(c, UserContent::Image(_)));
                    let tool_result_text = if !text_result.is_empty() {
                        text_result
                    } else if has_images {
                        "(see attached image)".to_string()
                    } else {
                        "(no tool output)".to_string()
                    };
                    let mut trm = json!({
                        "role": "tool",
                        "content": sanitize_surrogates(&tool_result_text),
                        "tool_call_id": tr.tool_call_id,
                    });
                    if compat.requires_tool_result_name && !tr.tool_name.is_empty() {
                        trm["name"] = json!(tr.tool_name);
                    }
                    params.push(trm);
                    if has_images && model.supports_images() {
                        for c in &tr.content {
                            if let UserContent::Image(img) = c {
                                image_blocks.push(json!({"type":"image_url","image_url":{"url": format!("data:{};base64,{}", img.mime_type, img.data)}}));
                            }
                        }
                    }
                    j += 1;
                }
                i = j - 1;
                if !image_blocks.is_empty() {
                    if compat.requires_assistant_after_tool_result {
                        params.push(json!({"role":"assistant","content":"I have processed the tool results."}));
                    }
                    let mut content = vec![json!({"type":"text","text":"Attached image(s) from tool result:"})];
                    content.extend(image_blocks);
                    params.push(json!({"role":"user","content": content}));
                    last_role = Some("user");
                } else {
                    last_role = Some("toolResult");
                }
                i += 1;
                continue;
            }
        }
        last_role = Some(msg.role());
        i += 1;
    }
    params
}

fn cache_control_value(compat: &ResolvedCompat, retention: CacheRetention) -> Option<Value> {
    if compat.cache_control_format != Some(CacheControlFormat::Anthropic) || retention == CacheRetention::None {
        return None;
    }
    if retention == CacheRetention::Long && compat.supports_long_cache_retention {
        Some(json!({"type":"ephemeral","ttl":"1h"}))
    } else {
        Some(json!({"type":"ephemeral"}))
    }
}

fn add_cache_control_to_text_content(message: &mut Value, cc: &Value) -> bool {
    let Some(content) = message.get_mut("content") else { return false };
    match content {
        Value::String(s) => {
            if s.is_empty() {
                return false;
            }
            let text = s.clone();
            *content = json!([{"type":"text","text": text, "cache_control": cc}]);
            true
        }
        Value::Array(parts) => {
            for part in parts.iter_mut().rev() {
                if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                    part["cache_control"] = cc.clone();
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

fn apply_anthropic_cache_control(messages: &mut [Value], tools: Option<&mut Vec<Value>>, cc: &Value) {
    // System prompt.
    for m in messages.iter_mut() {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "system" || role == "developer" {
            add_cache_control_to_text_content(m, cc);
            break;
        }
    }
    // Last tool.
    if let Some(tools) = tools {
        if let Some(last) = tools.last_mut() {
            last["cache_control"] = cc.clone();
        }
    }
    // Last conversation message.
    for m in messages.iter_mut().rev() {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "user" || role == "assistant" || role == "tool" {
            if add_cache_control_to_text_content(m, cc) {
                return;
            }
        }
    }
}

/// Wire value for `reasoning_effort` & friends after `thinkingLevelMap`.
fn mapped_effort(model: &Model, level: ThinkingLevel) -> Option<String> {
    match model.mapped_thinking_level(level) {
        Some(mapped) => mapped,
        None => Some(level.as_str().to_string()),
    }
}

/// `buildParams`: the JSON request body.
pub fn build_params(model: &Model, context: &TranscriptContext, options: &StreamOptions, compat: &ResolvedCompat) -> Value {
    let retention = resolve_cache_retention(options.cache_retention.as_deref());
    let normalized = resolve_transcript(context, compat.supports_mid_convo_system_messages);
    let transcript_tools = resolve_transcript_tools(
        &normalized.messages,
        compat.supports_mid_convo_system_messages && compat.supports_mid_convo_tool_additions,
    );
    let mut messages = convert_messages(model, context, compat);

    let mut params = Map::new();
    params.insert("model".into(), json!(model.id));
    params.insert("stream".into(), json!(true));

    let is_openai_com = model.base_url.contains("api.openai.com");
    if (is_openai_com && retention != CacheRetention::None) || (retention == CacheRetention::Long && compat.supports_long_cache_retention) {
        if let Some(sid) = &options.session_id {
            let key: String = sid.chars().take(64).collect();
            params.insert("prompt_cache_key".into(), json!(key));
        }
    }
    if retention == CacheRetention::Long && compat.supports_long_cache_retention {
        params.insert("prompt_cache_retention".into(), json!("24h"));
    }
    if compat.supports_usage_in_streaming {
        params.insert("stream_options".into(), json!({"include_usage": true}));
    }
    if compat.supports_store {
        params.insert("store".into(), json!(false));
    }
    if let Some(max) = options.max_tokens {
        let field = match compat.max_tokens_field {
            MaxTokensField::MaxTokens => "max_tokens",
            MaxTokensField::MaxCompletionTokens => "max_completion_tokens",
        };
        params.insert(field.into(), json!(max));
    }
    if let Some(t) = options.temperature {
        params.insert("temperature".into(), json!(t));
    }

    let mut tools: Option<Vec<Value>> = None;
    if !transcript_tools.request_tools.is_empty() {
        tools = Some(convert_tools(&transcript_tools.request_tools, compat));
        if compat.zai_tool_stream {
            params.insert("tool_stream".into(), json!(true));
        }
    } else if has_tool_history(&context.messages) {
        tools = Some(Vec::new());
    }

    if let Some(cc) = cache_control_value(compat, retention) {
        apply_anthropic_cache_control(&mut messages, tools.as_mut(), &cc);
    }
    params.insert("messages".into(), Value::Array(messages));
    if let Some(t) = tools {
        params.insert("tools".into(), Value::Array(t));
    }

    // Reasoning / thinking.
    let effort = options.reasoning.filter(|l| *l != ThinkingLevel::Off);
    let off_mapped = model.mapped_thinking_level(ThinkingLevel::Off);
    // `thinkingLevelMap.off !== null` in TS: unmapped counts as "not null".
    let off_is_null = matches!(off_mapped, Some(None));
    if model.reasoning {
        match compat.thinking_format {
            ThinkingFormat::Zai => {
                params.insert(
                    "thinking".into(),
                    if effort.is_some() {
                        json!({"type":"enabled","clear_thinking": false})
                    } else {
                        json!({"type":"disabled"})
                    },
                );
                if let (Some(e), true) = (effort, compat.supports_reasoning_effort) {
                    if let Some(v) = mapped_effort(model, e) {
                        params.insert("reasoning_effort".into(), json!(v));
                    }
                }
            }
            ThinkingFormat::Qwen => {
                params.insert("enable_thinking".into(), json!(effort.is_some()));
                if let (Some(e), true) = (effort, compat.supports_reasoning_effort) {
                    if let Some(v) = mapped_effort(model, e) {
                        params.insert("reasoning_effort".into(), json!(v));
                    }
                }
            }
            ThinkingFormat::QwenChatTemplate => {
                params.insert(
                    "chat_template_kwargs".into(),
                    json!({"enable_thinking": effort.is_some(), "preserve_thinking": true}),
                );
            }
            ThinkingFormat::ChatTemplate | ThinkingFormat::Baseten => {
                // Chat-template kwargs need per-model config pi carries in
                // its model registry; zWork has no such models. Fall back to
                // the plain effort field when supported.
                if let (Some(e), true) = (effort, compat.supports_reasoning_effort) {
                    if let Some(v) = mapped_effort(model, e) {
                        params.insert("reasoning_effort".into(), json!(v));
                    }
                }
            }
            ThinkingFormat::Deepseek => {
                if effort.is_some() {
                    params.insert("thinking".into(), json!({"type":"enabled"}));
                } else if !off_is_null {
                    params.insert("thinking".into(), json!({"type":"disabled"}));
                }
                if let (Some(e), true) = (effort, compat.supports_reasoning_effort) {
                    if let Some(v) = mapped_effort(model, e) {
                        params.insert("reasoning_effort".into(), json!(v));
                    }
                }
            }
            ThinkingFormat::Openrouter => {
                if let Some(e) = effort {
                    if let Some(v) = mapped_effort(model, e) {
                        params.insert("reasoning".into(), json!({"effort": v}));
                    }
                } else if !off_is_null {
                    let v = off_mapped.flatten().unwrap_or_else(|| "none".into());
                    params.insert("reasoning".into(), json!({"effort": v}));
                }
            }
            ThinkingFormat::AntLing => {
                if let Some(e) = effort {
                    if let Some(Some(v)) = model.mapped_thinking_level(e) {
                        params.insert("reasoning".into(), json!({"effort": v}));
                    }
                }
            }
            ThinkingFormat::Together => {
                params.insert("reasoning".into(), json!({"enabled": effort.is_some()}));
                if let (Some(e), true) = (effort, compat.supports_reasoning_effort) {
                    if let Some(v) = mapped_effort(model, e) {
                        params.insert("reasoning_effort".into(), json!(v));
                    }
                }
            }
            ThinkingFormat::StringThinking => {
                if let Some(e) = effort {
                    if let Some(v) = mapped_effort(model, e) {
                        params.insert("thinking".into(), json!(v));
                    }
                } else if !off_is_null {
                    let v = off_mapped.flatten().unwrap_or_else(|| "none".into());
                    params.insert("thinking".into(), json!(v));
                }
            }
            ThinkingFormat::Openai => {
                if compat.supports_reasoning_effort {
                    if let Some(e) = effort {
                        if let Some(v) = mapped_effort(model, e) {
                            params.insert("reasoning_effort".into(), json!(v));
                        }
                    } else if let Some(Some(v)) = off_mapped {
                        params.insert("reasoning_effort".into(), json!(v));
                    }
                }
            }
        }
    }

    if let Some(routing) = &compat.open_router_routing {
        if routing.as_object().map_or(false, |o| !o.is_empty()) {
            params.insert("provider".into(), routing.clone());
        }
    }

    // Last so custom keys override the named request fields.
    if let Some(extra) = &options.sampling_params {
        for (k, v) in extra {
            params.insert(k.clone(), v.clone());
        }
    }
    Value::Object(params)
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

fn parse_chunk_usage(raw: &Value, model: &Model) -> Usage {
    let g = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_u64());
    let prompt_tokens = g(raw, "prompt_tokens").unwrap_or(0);
    let details = raw.get("prompt_tokens_details");
    let cache_read = details
        .and_then(|d| g(d, "cached_tokens"))
        .or_else(|| g(raw, "prompt_cache_hit_tokens"))
        .or_else(|| g(raw, "cached_tokens"))
        .unwrap_or(0);
    let cache_write = details.and_then(|d| g(d, "cache_write_tokens")).unwrap_or(0);
    let input = prompt_tokens.saturating_sub(cache_read).saturating_sub(cache_write);
    let output = g(raw, "completion_tokens").unwrap_or(0);
    let reasoning = raw
        .get("completion_tokens_details")
        .and_then(|d| g(d, "reasoning_tokens"))
        .unwrap_or(0);
    let mut usage = Usage {
        input,
        output,
        cache_read,
        cache_write,
        cache_write_1h: None,
        reasoning: Some(reasoning),
        total_tokens: input + output + cache_read + cache_write,
        cost: Default::default(),
    };
    usage.calculate_cost(model);
    usage
}

fn map_stop_reason(reason: &str) -> (StopReason, Option<String>) {
    match reason {
        "stop" | "end" => (StopReason::Stop, None),
        "length" => (StopReason::Length, None),
        "function_call" | "tool_calls" => (StopReason::ToolUse, None),
        "content_filter" => (StopReason::Error, Some("Provider finish_reason: content_filter".into())),
        "network_error" => (StopReason::Error, Some("Provider finish_reason: network_error".into())),
        other => (StopReason::Error, Some(format!("Provider finish_reason: {other}"))),
    }
}

/// Streaming scratch state for one tool-call block.
struct ToolCallScratch {
    content_index: usize,
    partial_args: String,
}

struct StreamState {
    output: AssistantMessage,
    text_index: Option<usize>,
    thinking_index: Option<usize>,
    by_stream_index: HashMap<u64, usize>,
    by_id: HashMap<String, usize>,
    /// Indexed by position in `scratch`, mirrors tool-call blocks.
    scratch: Vec<ToolCallScratch>,
    reasoning_details: Option<Vec<Value>>,
    has_finish_reason: bool,
}

impl StreamState {
    fn scratch_for(&mut self, content_index: usize) -> &mut ToolCallScratch {
        let pos = self
            .scratch
            .iter()
            .position(|s| s.content_index == content_index)
            .expect("scratch exists for tool call block");
        &mut self.scratch[pos]
    }
}

async fn push(tx: &mpsc::Sender<AssistantMessageEvent>, ev: AssistantMessageEvent) {
    let _ = tx.send(ev).await;
}

async fn ensure_text_block(st: &mut StreamState, tx: &mpsc::Sender<AssistantMessageEvent>) -> usize {
    if let Some(i) = st.text_index {
        return i;
    }
    st.output.content.push(AssistantContent::Text(TextContent {
        text: String::new(),
        text_signature: None,
    }));
    let i = st.output.content.len() - 1;
    st.text_index = Some(i);
    push(
        tx,
        AssistantMessageEvent::TextStart {
            content_index: i,
            partial: st.output.clone(),
        },
    )
    .await;
    i
}

async fn ensure_thinking_block(st: &mut StreamState, tx: &mpsc::Sender<AssistantMessageEvent>, signature: &str) -> usize {
    if let Some(i) = st.thinking_index {
        return i;
    }
    st.output.content.push(AssistantContent::Thinking(ThinkingContent {
        thinking: String::new(),
        thinking_signature: Some(signature.to_string()),
        redacted: None,
    }));
    let i = st.output.content.len() - 1;
    st.thinking_index = Some(i);
    push(
        tx,
        AssistantMessageEvent::ThinkingStart {
            content_index: i,
            partial: st.output.clone(),
        },
    )
    .await;
    i
}

async fn ensure_tool_call_block(st: &mut StreamState, tx: &mpsc::Sender<AssistantMessageEvent>, tc: &Value) -> usize {
    let stream_index = tc.get("index").and_then(|v| v.as_u64());
    let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let name = tc
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut existing = stream_index.and_then(|si| st.by_stream_index.get(&si).copied());
    if existing.is_none() && !id.is_empty() {
        existing = st.by_id.get(id).copied();
    }
    let idx = match existing {
        Some(i) => i,
        None => {
            st.output.content.push(AssistantContent::ToolCall(ToolCall {
                id: id.to_string(),
                name: name.to_string(),
                arguments: json!({}),
                thought_signature: None,
                namespace: None,
            }));
            let i = st.output.content.len() - 1;
            st.scratch.push(ToolCallScratch {
                content_index: i,
                partial_args: String::new(),
            });
            if let Some(si) = stream_index {
                st.by_stream_index.insert(si, i);
            }
            if !id.is_empty() {
                st.by_id.insert(id.to_string(), i);
            }
            push(
                tx,
                AssistantMessageEvent::ToolcallStart {
                    content_index: i,
                    partial: st.output.clone(),
                },
            )
            .await;
            i
        }
    };
    if let Some(si) = stream_index {
        st.by_stream_index.entry(si).or_insert(idx);
    }
    if !id.is_empty() {
        st.by_id.insert(id.to_string(), idx);
    }
    if let AssistantContent::ToolCall(block) = &mut st.output.content[idx] {
        if block.id.is_empty() && !id.is_empty() {
            block.id = id.to_string();
        }
        if block.name.is_empty() && !name.is_empty() {
            block.name = name.to_string();
        }
    }
    idx
}

/// Apply accumulated `reasoning_details` to the thinking block's signature.
fn apply_streamed_reasoning_details(st: &mut StreamState) {
    let Some(details) = &st.reasoning_details else { return };
    if details.is_empty() {
        return;
    }
    if let Some(i) = st.thinking_index {
        if let AssistantContent::Thinking(b) = &mut st.output.content[i] {
            b.thinking_signature = Some(encode_reasoning_details(details));
        }
    }
}

fn append_reasoning_detail(list: &mut Vec<Value>, detail: &Value) {
    // Consecutive text/summary deltas merge into one logical entry; encrypted
    // entries stay discrete.
    let ty = detail.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let text_key = match ty {
        "reasoning.text" => Some("text"),
        "reasoning.summary" => Some("summary"),
        _ => None,
    };
    if let Some(key) = text_key {
        if let Some(last) = list.last_mut() {
            let same_type = last.get("type").and_then(|t| t.as_str()) == Some(ty);
            let same_id = last.get("id") == detail.get("id");
            if same_type && same_id {
                let addition = detail.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
                if let Some(Value::String(existing)) = last.get_mut(key) {
                    existing.push_str(&addition);
                    // Later deltas can carry the signature.
                    if let Some(sig) = detail.get("signature") {
                        last["signature"] = sig.clone();
                    }
                    return;
                }
            }
        }
    }
    list.push(detail.clone());
}

async fn finish_block(st: &mut StreamState, tx: &mpsc::Sender<AssistantMessageEvent>, idx: usize) {
    let ev = match &st.output.content[idx] {
        AssistantContent::Text(t) => AssistantMessageEvent::TextEnd {
            content_index: idx,
            content: t.text.clone(),
            partial: st.output.clone(),
        },
        AssistantContent::Thinking(_) => {
            apply_streamed_reasoning_details(st);
            let AssistantContent::Thinking(t) = &st.output.content[idx] else { unreachable!() };
            AssistantMessageEvent::ThinkingEnd {
                content_index: idx,
                content: t.thinking.clone(),
                partial: st.output.clone(),
            }
        }
        AssistantContent::ToolCall(_) => {
            let partial_args = st.scratch_for(idx).partial_args.clone();
            if let AssistantContent::ToolCall(tc) = &mut st.output.content[idx] {
                tc.arguments = parse_streaming_json(&partial_args);
                if !tc.arguments.is_object() {
                    tc.arguments = json!({});
                }
            }
            let AssistantContent::ToolCall(tc) = &st.output.content[idx] else { unreachable!() };
            AssistantMessageEvent::ToolcallEnd {
                content_index: idx,
                tool_call: tc.clone(),
                partial: st.output.clone(),
            }
        }
    };
    push(tx, ev).await;
}

/// Process one decoded chunk from the SSE stream.
async fn process_chunk(st: &mut StreamState, tx: &mpsc::Sender<AssistantMessageEvent>, chunk: &Value, model: &Model) {
    if !chunk.is_object() {
        return;
    }
    if st.output.response_id.is_none() {
        if let Some(id) = chunk.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            st.output.response_id = Some(id.to_string());
        }
    }
    if st.output.response_model.is_none() {
        if let Some(m) = chunk.get("model").and_then(|v| v.as_str()).filter(|s| !s.is_empty() && *s != model.id) {
            st.output.response_model = Some(m.to_string());
        }
    }
    if let Some(u) = chunk.get("usage").filter(|u| u.is_object()) {
        st.output.usage = parse_chunk_usage(u, model);
    }
    let Some(choice) = chunk.get("choices").and_then(|c| c.as_array()).and_then(|c| c.first()) else {
        return;
    };
    if chunk.get("usage").map_or(true, |u| u.is_null()) {
        if let Some(u) = choice.get("usage").filter(|u| u.is_object()) {
            st.output.usage = parse_chunk_usage(u, model);
        }
    }
    if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
        st.output.raw_stop_reason = Some(fr.to_string());
        let (sr, err) = map_stop_reason(fr);
        st.output.stop_reason = sr;
        if let Some(e) = err {
            st.output.error_message = Some(e);
        }
        st.has_finish_reason = true;
    }
    let Some(delta) = choice.get("delta").filter(|d| d.is_object()) else { return };

    if let Some(content) = delta.get("content").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        let i = ensure_text_block(st, tx).await;
        if let AssistantContent::Text(t) = &mut st.output.content[i] {
            t.text.push_str(content);
        }
        push(
            tx,
            AssistantMessageEvent::TextDelta {
                content_index: i,
                delta: content.to_string(),
                partial: st.output.clone(),
            },
        )
        .await;
    }

    // First non-empty reasoning field wins (some providers send duplicates).
    let found = REASONING_FIELDS
        .iter()
        .find_map(|f| delta.get(*f).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| (*f, s)));
    if let Some((field, reasoning)) = found {
        let signature = if model.provider == "opencode-go" && field == "reasoning" {
            "reasoning_content"
        } else {
            field
        };
        let i = ensure_thinking_block(st, tx, signature).await;
        if let AssistantContent::Thinking(t) = &mut st.output.content[i] {
            t.thinking.push_str(reasoning);
        }
        push(
            tx,
            AssistantMessageEvent::ThinkingDelta {
                content_index: i,
                delta: reasoning.to_string(),
                partial: st.output.clone(),
            },
        )
        .await;
    }

    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tool_calls {
            let i = ensure_tool_call_block(st, tx, tc).await;
            let mut delta_text = String::new();
            if let Some(args) = tc.get("function").and_then(|f| f.get("arguments")).and_then(|v| v.as_str()) {
                delta_text = args.to_string();
                let s = st.scratch_for(i);
                s.partial_args.push_str(args);
                let parsed = parse_streaming_json(&s.partial_args);
                if let AssistantContent::ToolCall(block) = &mut st.output.content[i] {
                    block.arguments = parsed;
                }
            }
            push(
                tx,
                AssistantMessageEvent::ToolcallDelta {
                    content_index: i,
                    delta: delta_text,
                    partial: st.output.clone(),
                },
            )
            .await;
        }
    }

    if let Some(details) = delta.get("reasoning_details").and_then(|v| v.as_array()) {
        for d in details {
            if !d.is_object() || d.get("type").and_then(|t| t.as_str()).is_none() {
                continue;
            }
            ensure_thinking_block(st, tx, "").await;
            append_reasoning_detail(st.reasoning_details.get_or_insert_with(Vec::new), d);
        }
    }
}

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

fn build_headers(model: &Model, api_key: &str, options: &StreamOptions, compat: &ResolvedCompat) -> BTreeMap<String, String> {
    let mut h: BTreeMap<String, String> = BTreeMap::new();
    h.insert("content-type".into(), "application/json".into());
    h.insert("user-agent".into(), USER_AGENT.into());
    if !api_key.is_empty() {
        h.insert("authorization".into(), format!("Bearer {api_key}"));
    }
    if let Some(mh) = &model.headers {
        for (k, v) in mh {
            h.insert(k.to_lowercase(), v.clone());
        }
    }
    if let Some(sid) = &options.session_id {
        if compat.send_session_affinity_headers {
            if compat.session_affinity_openrouter {
                h.insert("x-session-id".into(), sid.clone());
            } else {
                h.insert("session_id".into(), sid.clone());
                h.insert("x-client-request-id".into(), sid.clone());
                h.insert("x-session-affinity".into(), sid.clone());
            }
        }
    }
    for (k, v) in &options.headers {
        h.insert(k.to_lowercase(), v.clone());
    }
    h
}

fn endpoint_for(model: &Model) -> String {
    format!("{}/chat/completions", model.base_url.trim_end_matches('/'))
}

/// Stream a completion. Never panics/errors out-of-band: every failure ends
/// with an `Error` event carrying an assistant message with `stopReason`
/// `error` or `aborted`.
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
        text_index: None,
        thinking_index: None,
        by_stream_index: HashMap::new(),
        by_id: HashMap::new(),
        scratch: Vec::new(),
        reasoning_details: None,
        has_finish_reason: false,
    };

    let result: Result<(), ProviderError> = async {
        let api_key = options.api_key.clone().unwrap_or_default();
        let has_auth_header = options.headers.keys().any(|k| k.eq_ignore_ascii_case("authorization"));
        if api_key.is_empty() && !has_auth_header {
            return Err(ProviderError::new(
                None,
                format!("No API key for provider {}", model.provider),
            ));
        }

        let body = build_params(&model, &context, &options, &compat);
        if let Some(cb) = &options.on_payload {
            cb(&body);
        }
        let headers = build_headers(&model, &api_key, &options, &compat);
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

        push(
            &tx,
            AssistantMessageEvent::Start {
                partial: st.output.clone(),
            },
        )
        .await;

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
                match serde_json::from_str::<Value>(&frame) {
                    Ok(v) => process_chunk(&mut st, &tx, &v, &model).await,
                    Err(e) => {
                        return Err(ProviderError::new(None, format!("malformed SSE frame: {e}: {}", truncate_str(&frame, 300))));
                    }
                }
            }
        }
        for frame in decoder.finish() {
            if let Ok(v) = serde_json::from_str::<Value>(&frame) {
                process_chunk(&mut st, &tx, &v, &model).await;
            }
        }

        for idx in 0..st.output.content.len() {
            finish_block(&mut st, &tx, idx).await;
        }
        if options.signal.as_ref().map_or(false, |s| s.is_aborted()) {
            return Err(ProviderError::new(None, "Request was aborted"));
        }
        if !st.has_finish_reason && !compat.supports_finish_reason {
            st.output.stop_reason = if st.output.content.iter().any(|c| c.as_tool_call().is_some()) {
                StopReason::ToolUse
            } else {
                StopReason::Stop
            };
        }
        if st.output.stop_reason == StopReason::Error {
            return Err(ProviderError::new(
                None,
                st.output
                    .error_message
                    .clone()
                    .unwrap_or_else(|| "Provider returned an error stop reason".into()),
            ));
        }
        if (compat.supports_finish_reason && !st.has_finish_reason) || st.output.stop_reason == StopReason::Pending {
            return Err(ProviderError::new(None, "Stream ended without finish_reason"));
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            push(
                &tx,
                AssistantMessageEvent::Done {
                    reason: st.output.stop_reason,
                    message: st.output.clone(),
                },
            )
            .await;
        }
        Err(err) => {
            apply_streamed_reasoning_details(&mut st);
            let aborted = options.signal.as_ref().map_or(false, |s| s.is_aborted());
            st.output.stop_reason = if aborted { StopReason::Aborted } else { StopReason::Error };
            st.output.error_message = Some(err.format());
            push(
                &tx,
                AssistantMessageEvent::Error {
                    reason: st.output.stop_reason,
                    error: st.output.clone(),
                },
            )
            .await;
        }
    }
}

fn truncate_str(s: &str, max: usize) -> String {
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
    use crate::harness::types::{Api, InputType, ModelCost, ToolResultMessage};

    fn model(provider: &str, base: &str) -> Model {
        Model {
            id: "deepseek-chat".into(),
            name: "DeepSeek".into(),
            api: Api::OpenAICompletions,
            provider: provider.into(),
            base_url: base.into(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![InputType::Text],
            cost: ModelCost::default(),
            prompt_cache: None,
            context_window: 128_000,
            max_tokens: 8192,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn deepseek_compat() {
        let c = get_compat(&model("deepseek", "https://api.deepseek.com"));
        assert!(!c.supports_store);
        assert_eq!(c.max_tokens_field, MaxTokensField::MaxTokens);
        assert_eq!(c.thinking_format, ThinkingFormat::Deepseek);
        assert!(c.requires_reasoning_content_on_assistant_messages);
        let c = get_compat(&model("openrouter", "https://openrouter.ai/api/v1"));
        assert_eq!(c.thinking_format, ThinkingFormat::Openrouter);
        assert!(c.send_session_affinity_headers);
        assert!(!c.supports_developer_role);
    }

    #[test]
    fn build_params_deepseek_shape() {
        let m = model("deepseek", "https://api.deepseek.com");
        let ctx = normalize_context(
            Some("sys"),
            Some(&[tool("read", "Read a file", json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}))]),
            vec![Message::user_text("hi")],
        );
        let opts = StreamOptions {
            max_tokens: Some(1000),
            reasoning: Some(ThinkingLevel::Medium),
            ..Default::default()
        };
        let p = build_params(&m, &ctx, &opts, &get_compat(&m));
        assert_eq!(p["model"], "deepseek-chat");
        assert_eq!(p["stream"], true);
        assert_eq!(p["max_tokens"], 1000);
        assert!(p.get("store").is_none());
        assert_eq!(p["stream_options"]["include_usage"], true);
        assert_eq!(p["thinking"]["type"], "enabled");
        assert_eq!(p["reasoning_effort"], "medium");
        assert_eq!(p["messages"][0]["role"], "system");
        assert_eq!(p["messages"][0]["content"], "sys");
        assert_eq!(p["messages"][1]["role"], "user");
        assert_eq!(p["tools"][0]["type"], "function");
        assert_eq!(p["tools"][0]["function"]["name"], "read");
        assert_eq!(p["tools"][0]["function"]["strict"], false);
    }

    #[test]
    fn convert_messages_round_trips_tool_calls() {
        let m = model("deepseek", "https://api.deepseek.com");
        let mut a = AssistantMessage::pending(&m);
        a.stop_reason = StopReason::ToolUse;
        a.content = vec![
            AssistantContent::Thinking(ThinkingContent {
                thinking: "think".into(),
                thinking_signature: Some("reasoning_content".into()),
                redacted: None,
            }),
            AssistantContent::Text(TextContent {
                text: "calling".into(),
                text_signature: None,
            }),
            AssistantContent::ToolCall(ToolCall {
                id: "call_1".into(),
                name: "read".into(),
                arguments: json!({"path":"/x"}),
                thought_signature: None,
                namespace: None,
            }),
        ];
        let ctx = TranscriptContext {
            messages: vec![
                Message::user_text("hi"),
                Message::Assistant(a),
                Message::ToolResult(ToolResultMessage {
                    tool_call_id: "call_1".into(),
                    tool_name: "read".into(),
                    content: vec![UserContent::text("file body")],
                    details: None,
                    usage: None,
                    is_error: false,
                    timestamp: 0,
                }),
            ],
        };
        let out = convert_messages(&m, &ctx, &get_compat(&m));
        assert_eq!(out.len(), 3);
        assert_eq!(out[1]["role"], "assistant");
        assert_eq!(out[1]["content"], "calling");
        assert_eq!(out[1]["reasoning_content"], "think");
        assert_eq!(out[1]["tool_calls"][0]["id"], "call_1");
        assert_eq!(out[1]["tool_calls"][0]["function"]["arguments"], "{\"path\":\"/x\"}");
        assert_eq!(out[2]["role"], "tool");
        assert_eq!(out[2]["tool_call_id"], "call_1");
        assert_eq!(out[2]["content"], "file body");
    }

    #[test]
    fn deepseek_assistant_gets_empty_reasoning_content() {
        let m = model("deepseek", "https://api.deepseek.com");
        let mut a = AssistantMessage::pending(&m);
        a.stop_reason = StopReason::Stop;
        a.content = vec![AssistantContent::Text(TextContent {
            text: "hello".into(),
            text_signature: None,
        })];
        let ctx = TranscriptContext {
            messages: vec![Message::user_text("hi"), Message::Assistant(a)],
        };
        let out = convert_messages(&m, &ctx, &get_compat(&m));
        assert_eq!(out[1]["reasoning_content"], "");
    }

    #[test]
    fn usage_parsing_deepseek_cache_hits() {
        let m = model("deepseek", "https://api.deepseek.com");
        let u = parse_chunk_usage(
            &json!({"prompt_tokens": 1000, "completion_tokens": 50, "prompt_cache_hit_tokens": 800, "completion_tokens_details": {"reasoning_tokens": 10}}),
            &m,
        );
        assert_eq!(u.input, 200);
        assert_eq!(u.cache_read, 800);
        assert_eq!(u.output, 50);
        assert_eq!(u.reasoning, Some(10));
        assert_eq!(u.total_tokens, 1050);
    }

    #[tokio::test]
    async fn chunk_state_machine_assembles_blocks() {
        let m = model("deepseek", "https://api.deepseek.com");
        let (tx, mut rx) = mpsc::channel(64);
        let mut st = StreamState {
            output: AssistantMessage::pending(&m),
            text_index: None,
            thinking_index: None,
            by_stream_index: HashMap::new(),
            by_id: HashMap::new(),
            scratch: Vec::new(),
            reasoning_details: None,
            has_finish_reason: false,
        };
        let chunks = [
            json!({"id":"r1","choices":[{"delta":{"reasoning_content":"let me "}}]}),
            json!({"id":"r1","choices":[{"delta":{"reasoning_content":"think"}}]}),
            json!({"id":"r1","choices":[{"delta":{"content":"Sure"}}]}),
            json!({"id":"r1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\"pa"}}]}}]}),
            json!({"id":"r1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"/x\"}"}}]}}]}),
            json!({"id":"r1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}),
        ];
        for c in &chunks {
            process_chunk(&mut st, &tx, c, &m).await;
        }
        for i in 0..st.output.content.len() {
            finish_block(&mut st, &tx, i).await;
        }
        drop(tx);
        let mut kinds = Vec::new();
        while let Some(ev) = rx.recv().await {
            kinds.push(ev.kind());
        }
        assert_eq!(
            kinds,
            vec![
                "thinking_start",
                "thinking_delta",
                "thinking_delta",
                "text_start",
                "text_delta",
                "toolcall_start",
                "toolcall_delta",
                "toolcall_delta",
                "thinking_end",
                "text_end",
                "toolcall_end"
            ]
        );
        assert_eq!(st.output.stop_reason, StopReason::ToolUse);
        assert_eq!(st.output.response_id.as_deref(), Some("r1"));
        assert_eq!(st.output.usage.input, 10);
        let tc = st.output.content[2].as_tool_call().unwrap();
        assert_eq!(tc.id, "c1");
        assert_eq!(tc.name, "read");
        assert_eq!(tc.arguments, json!({"path":"/x"}));
        assert_eq!(st.output.content[0].as_thinking().unwrap().thinking, "let me think");
        assert_eq!(st.output.content[1].as_text().unwrap().text, "Sure");
    }

    #[tokio::test]
    async fn missing_api_key_yields_error_event() {
        let m = model("deepseek", "https://api.deepseek.com");
        let ctx = normalize_context(Some("s"), None, vec![Message::user_text("hi")]);
        let mut rx = stream(m, ctx, StreamOptions::default());
        let ev = rx.recv().await.unwrap();
        match ev {
            AssistantMessageEvent::Error { reason, error } => {
                assert_eq!(reason, StopReason::Error);
                assert!(error.error_message.unwrap().contains("No API key"));
            }
            other => panic!("unexpected {}", other.kind()),
        }
        assert!(rx.recv().await.is_none());
    }

    #[test]
    fn tool_call_id_normalization() {
        let m = model("openrouter", "https://openrouter.ai/api/v1");
        assert_eq!(normalize_tool_call_id(&m, "call_abc|item+1"), "call_abc_item_1");
        let long = format!("call_abc|{}", "x".repeat(100));
        let n = normalize_tool_call_id(&m, &long);
        assert!(n.len() <= 40);
        assert!(n.starts_with("call_abc_"));
    }
}
