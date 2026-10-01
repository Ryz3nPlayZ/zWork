//! Google Generative AI (Gemini API, `generativelanguage.googleapis.com`).
//!
//! Port of pi-mono `packages/ai/src/api/google-generative-ai.ts` +
//! `google-shared.ts`, speaking the REST wire format directly
//! (`:streamGenerateContent?alt=sse`) instead of the `@google/genai` SDK.
//! Thought signatures ride on the block they arrived with (text, thinking or
//! tool call) and are replayed only to the same provider+model.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use super::transport::{self, push, sanitize_surrogates, Tx, USER_AGENT};
use crate::harness::retry::ProviderError;
use crate::harness::transcript::{
    collapse_system_messages, get_current_tools, get_initial_system_message, get_system_message_text,
    without_initial_system_message,
};
use crate::harness::transform_messages::transform_messages;
use crate::harness::types::{
    AssistantContent, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message, Model, StopReason,
    StreamOptions, TextContent, ThinkingContent, ThinkingLevel, Tool, ToolCall, TranscriptContext, UserContent,
    UserMessageContent,
};

static TOOL_CALL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn gemini_major(model_id: &str) -> Option<u32> {
    let id = model_id.to_lowercase();
    let rest = id.strip_prefix("gemini-live-").or_else(|| id.strip_prefix("gemini-"))?;
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

fn requires_tool_call_id(model_id: &str) -> bool {
    model_id.starts_with("claude-") || model_id.starts_with("gpt-oss-") || gemini_major(model_id).map_or(false, |v| v >= 3)
}

fn multimodal_function_response(model_id: &str) -> bool {
    gemini_major(model_id).map_or(true, |v| v >= 3)
}

/// Gemini 3 / flash-latest / Gemma 4 use discrete `thinkingLevel`; older
/// models use a token `thinkingBudget`.
fn uses_thinking_level(model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    let gemini3 = id
        .strip_prefix("gemini-3")
        .map(|rest| {
            let rest = rest.strip_prefix('.').map(|r| r.trim_start_matches(|c: char| c.is_ascii_digit())).unwrap_or(rest);
            rest.starts_with("-pro") || rest.starts_with("-flash")
        })
        .unwrap_or(false);
    gemini3 || id == "gemini-flash-latest" || id == "gemini-flash-lite-latest" || id.contains("gemma-4") || id.contains("gemma4")
}

fn valid_signature(sig: Option<&str>) -> Option<String> {
    let s = sig?;
    let ok = !s.is_empty()
        && s.len() % 4 == 0
        && s.trim_end_matches('=').chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/');
    ok.then(|| s.to_string())
}

fn inline_data(img: &crate::harness::types::ImageContent) -> Value {
    json!({"inlineData": {"mimeType": img.mime_type, "data": img.data}})
}

/// Transcript → Gemini `contents` (system prompt travels separately).
pub fn convert_messages(model: &Model, context: &TranscriptContext) -> Vec<Value> {
    let collapsed = collapse_system_messages(context);
    let conversation = without_initial_system_message(&collapsed.messages).to_vec();
    let needs_id = requires_tool_call_id(&model.id);
    let norm = |id: &str| -> String {
        if !needs_id {
            return id.to_string();
        }
        id.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .take(64)
            .collect()
    };
    let messages = transform_messages(conversation, model, Some(&norm));
    let mut contents: Vec<Value> = Vec::new();

    for msg in &messages {
        match msg {
            Message::System(_) => {}
            Message::User(u) => {
                let parts: Vec<Value> = match &u.content {
                    UserMessageContent::Text(s) => vec![json!({"text": sanitize_surrogates(s)})],
                    UserMessageContent::Blocks(blocks) => blocks
                        .iter()
                        .map(|b| match b {
                            UserContent::Text(t) => json!({"text": sanitize_surrogates(&t.text)}),
                            UserContent::Image(img) => inline_data(img),
                        })
                        .collect(),
                };
                if !parts.is_empty() {
                    contents.push(json!({"role": "user", "parts": parts}));
                }
            }
            Message::Assistant(a) => {
                let same = a.provider == model.provider && a.model == model.id;
                let sig = |s: Option<&String>| if same { valid_signature(s.map(String::as_str)) } else { None };
                let mut parts = Vec::new();
                for block in &a.content {
                    match block {
                        AssistantContent::Text(t) => {
                            let signature = sig(t.text_signature.as_ref());
                            if t.text.trim().is_empty() && signature.is_none() {
                                continue;
                            }
                            let mut p = json!({"text": sanitize_surrogates(&t.text)});
                            if let Some(s) = signature {
                                p["thoughtSignature"] = json!(s);
                            }
                            parts.push(p);
                        }
                        AssistantContent::Thinking(t) => {
                            if same {
                                let signature = sig(t.thinking_signature.as_ref());
                                if t.thinking.trim().is_empty() && signature.is_none() {
                                    continue;
                                }
                                let mut p = json!({"thought": true, "text": sanitize_surrogates(&t.thinking)});
                                if let Some(s) = signature {
                                    p["thoughtSignature"] = json!(s);
                                }
                                parts.push(p);
                            } else if !t.thinking.trim().is_empty() {
                                parts.push(json!({"text": sanitize_surrogates(&t.thinking)}));
                            }
                        }
                        AssistantContent::ToolCall(tc) => {
                            let mut call = json!({"name": tc.name, "args": if tc.arguments.is_object() { tc.arguments.clone() } else { json!({}) }});
                            if needs_id {
                                call["id"] = json!(tc.id);
                            }
                            let mut p = json!({"functionCall": call});
                            if let Some(s) = sig(tc.thought_signature.as_ref()) {
                                p["thoughtSignature"] = json!(s);
                            }
                            parts.push(p);
                        }
                    }
                }
                if !parts.is_empty() {
                    contents.push(json!({"role": "model", "parts": parts}));
                }
            }
            Message::ToolResult(tr) => {
                let text = tr.text();
                let images: Vec<Value> = if model.supports_images() {
                    tr.content
                        .iter()
                        .filter_map(|c| match c {
                            UserContent::Image(i) => Some(inline_data(i)),
                            _ => None,
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                let value = if !text.is_empty() {
                    sanitize_surrogates(&text)
                } else if !images.is_empty() {
                    "(see attached image)".into()
                } else {
                    String::new()
                };
                let multimodal = multimodal_function_response(&model.id);
                let mut fr = json!({
                    "name": tr.tool_name,
                    "response": if tr.is_error { json!({"error": value}) } else { json!({"output": value}) },
                });
                if !images.is_empty() && multimodal {
                    fr["parts"] = Value::Array(images.clone());
                }
                if needs_id {
                    fr["id"] = json!(tr.tool_call_id);
                }
                let part = json!({"functionResponse": fr});
                // All function responses of one step go in a single user turn.
                let merged = match contents.last_mut() {
                    Some(last) if last["role"] == "user" && last["parts"].as_array().map_or(false, |ps| ps.iter().any(|p| p.get("functionResponse").is_some())) => {
                        last["parts"].as_array_mut().unwrap().push(part.clone());
                        true
                    }
                    _ => false,
                };
                if !merged {
                    contents.push(json!({"role": "user", "parts": [part]}));
                }
                if !images.is_empty() && !multimodal {
                    let mut parts = vec![json!({"text": "Tool result image:"})];
                    parts.extend(images);
                    contents.push(json!({"role": "user", "parts": parts}));
                }
            }
        }
    }
    contents
}

const SCHEMA_META_KEYS: [&str; 8] = ["$schema", "$id", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment", "$defs", "definitions"];

fn strip_schema_meta(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| !SCHEMA_META_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), strip_schema_meta(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(strip_schema_meta).collect()),
        other => other.clone(),
    }
}

pub fn convert_tools(tools: &[Tool]) -> Value {
    json!([{
        "functionDeclarations": tools.iter().map(|t| json!({
            "name": t.name,
            "description": t.description,
            "parametersJsonSchema": strip_schema_meta(&t.parameters),
        })).collect::<Vec<_>>()
    }])
}

fn thinking_budget(model_id: &str, level: &str) -> i64 {
    let table: Option<[i64; 4]> = if model_id.contains("2.5-pro") {
        Some([128, 2048, 8192, 32768])
    } else if model_id.contains("2.5-flash-lite") {
        Some([512, 2048, 8192, 24576])
    } else if model_id.contains("2.5-flash") {
        Some([128, 2048, 8192, 24576])
    } else {
        None
    };
    let i = match level {
        "minimal" => 0,
        "low" => 1,
        "medium" => 2,
        _ => 3,
    };
    table.map_or(-1, |t| t[i])
}

fn resolve_level(model: &Model, level: ThinkingLevel) -> String {
    let mapped = match model.mapped_thinking_level(level) {
        Some(Some(m)) => m.to_lowercase(),
        _ => level.as_str().to_string(),
    };
    match mapped.as_str() {
        "minimal" | "low" | "medium" | "high" => mapped,
        _ => "high".into(),
    }
}

fn thinking_config(model: &Model, reasoning: Option<ThinkingLevel>) -> Option<Value> {
    if !model.reasoning {
        return None;
    }
    match reasoning.filter(|l| *l != ThinkingLevel::Off) {
        Some(level) => {
            let resolved = resolve_level(model, level);
            Some(if uses_thinking_level(&model.id) {
                json!({"includeThoughts": true, "thinkingLevel": resolved.to_uppercase()})
            } else {
                json!({"includeThoughts": true, "thinkingBudget": thinking_budget(&model.id, &resolved)})
            })
        }
        None => Some(if uses_thinking_level(&model.id) {
            // Gemini 3 cannot fully disable thinking; take its floor.
            json!({"thinkingLevel": if model.id.contains("pro") { "LOW" } else { "MINIMAL" }})
        } else if model.id.contains("2.5-pro") {
            json!({"thinkingBudget": 128})
        } else {
            json!({"thinkingBudget": 0})
        }),
    }
}

pub fn build_params(model: &Model, context: &TranscriptContext, options: &StreamOptions) -> Value {
    let mut body = Map::new();
    body.insert("contents".into(), Value::Array(convert_messages(model, context)));
    let collapsed = collapse_system_messages(context);
    if let Some(sm) = get_initial_system_message(&collapsed.messages) {
        let text = get_system_message_text(sm);
        if !text.is_empty() {
            body.insert("systemInstruction".into(), json!({"parts": [{"text": sanitize_surrogates(&text)}]}));
        }
    }
    let tools = get_current_tools(&collapsed.messages);
    if !tools.is_empty() {
        body.insert("tools".into(), convert_tools(&tools));
    }
    let mut gen = Map::new();
    if let Some(t) = options.temperature {
        gen.insert("temperature".into(), json!(t));
    }
    if let Some(m) = options.max_tokens {
        gen.insert("maxOutputTokens".into(), json!(m));
    }
    if let Some(tc) = thinking_config(model, options.reasoning) {
        gen.insert("thinkingConfig".into(), tc);
    }
    if !gen.is_empty() {
        body.insert("generationConfig".into(), Value::Object(gen));
    }
    if let Some(extra) = &options.sampling_params {
        for (k, v) in extra {
            body.insert(k.clone(), v.clone());
        }
    }
    Value::Object(body)
}

fn map_finish(reason: &str) -> StopReason {
    match reason {
        "STOP" => StopReason::Stop,
        "MAX_TOKENS" => StopReason::Length,
        _ => StopReason::Error,
    }
}

// ---------------------------------------------------------------------------
// Stream processing
// ---------------------------------------------------------------------------

struct State {
    output: AssistantMessage,
    /// Content index of the open text/thinking block.
    current: Option<usize>,
}

async fn close_current(st: &mut State, tx: &Tx) {
    let Some(idx) = st.current.take() else { return };
    let ev = match &st.output.content[idx] {
        AssistantContent::Text(t) => AssistantMessageEvent::TextEnd { content_index: idx, content: t.text.clone(), partial: st.output.clone() },
        AssistantContent::Thinking(t) => AssistantMessageEvent::ThinkingEnd { content_index: idx, content: t.thinking.clone(), partial: st.output.clone() },
        AssistantContent::ToolCall(_) => return,
    };
    push(tx, ev).await;
}

async fn process_chunk(st: &mut State, tx: &Tx, chunk: &Value, model: &Model) -> Result<(), ProviderError> {
    if let Some(err) = chunk.get("error") {
        return Err(ProviderError::new(err["code"].as_u64().map(|c| c as u16), err["message"].as_str().unwrap_or("Gemini error").to_string()));
    }
    if st.output.response_id.is_none() {
        st.output.response_id = chunk["responseId"].as_str().map(str::to_string);
    }
    let candidate = &chunk["candidates"][0];
    for part in candidate["content"]["parts"].as_array().into_iter().flatten() {
        let signature = part["thoughtSignature"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
        if let Some(text) = part["text"].as_str() {
            let thinking = part["thought"] == true;
            let open_kind_matches = st.current.map_or(false, |i| match &st.output.content[i] {
                AssistantContent::Thinking(_) => thinking,
                AssistantContent::Text(_) => !thinking,
                _ => false,
            });
            if !open_kind_matches {
                close_current(st, tx).await;
                st.output.content.push(if thinking {
                    AssistantContent::Thinking(ThinkingContent { thinking: String::new(), thinking_signature: None, redacted: None })
                } else {
                    AssistantContent::Text(TextContent { text: String::new(), text_signature: None })
                });
                let idx = st.output.content.len() - 1;
                st.current = Some(idx);
                let partial = st.output.clone();
                push(tx, if thinking {
                    AssistantMessageEvent::ThinkingStart { content_index: idx, partial }
                } else {
                    AssistantMessageEvent::TextStart { content_index: idx, partial }
                })
                .await;
            }
            let idx = st.current.expect("open block");
            match &mut st.output.content[idx] {
                AssistantContent::Thinking(t) => {
                    t.thinking.push_str(text);
                    if signature.is_some() {
                        t.thinking_signature = signature.clone();
                    }
                }
                AssistantContent::Text(t) => {
                    t.text.push_str(text);
                    if signature.is_some() {
                        t.text_signature = signature.clone();
                    }
                }
                _ => {}
            }
            let partial = st.output.clone();
            push(tx, if thinking {
                AssistantMessageEvent::ThinkingDelta { content_index: idx, delta: text.to_string(), partial }
            } else {
                AssistantMessageEvent::TextDelta { content_index: idx, delta: text.to_string(), partial }
            })
            .await;
        }
        if let Some(fc) = part.get("functionCall").filter(|v| v.is_object()) {
            close_current(st, tx).await;
            let name = fc["name"].as_str().unwrap_or("").to_string();
            let provided = fc["id"].as_str().filter(|s| !s.is_empty());
            let duplicate = provided.map_or(false, |p| st.output.content.iter().any(|c| c.as_tool_call().map_or(false, |t| t.id == p)));
            let id = match provided {
                Some(p) if !duplicate => p.to_string(),
                _ => format!("{name}_{}_{}", chrono::Utc::now().timestamp_millis(), TOOL_CALL_COUNTER.fetch_add(1, Ordering::Relaxed) + 1),
            };
            let tool_call = ToolCall {
                id,
                name,
                arguments: if fc["args"].is_object() { fc["args"].clone() } else { json!({}) },
                thought_signature: signature.clone(),
                namespace: None,
            };
            st.output.content.push(AssistantContent::ToolCall(tool_call.clone()));
            let idx = st.output.content.len() - 1;
            push(tx, AssistantMessageEvent::ToolcallStart { content_index: idx, partial: st.output.clone() }).await;
            push(tx, AssistantMessageEvent::ToolcallDelta { content_index: idx, delta: tool_call.arguments.to_string(), partial: st.output.clone() }).await;
            push(tx, AssistantMessageEvent::ToolcallEnd { content_index: idx, tool_call, partial: st.output.clone() }).await;
        }
    }
    if let Some(fr) = candidate["finishReason"].as_str() {
        st.output.raw_stop_reason = Some(fr.to_string());
        st.output.stop_reason = map_finish(fr);
        if st.output.stop_reason == StopReason::Error {
            st.output.error_message = Some(format!("Provider stopped with: {fr}"));
        }
        if st.output.stop_reason == StopReason::Stop && st.output.content.iter().any(|c| c.as_tool_call().is_some()) {
            st.output.stop_reason = StopReason::ToolUse;
        }
    }
    if let Some(u) = chunk.get("usageMetadata").filter(|u| u.is_object()) {
        let g = |k: &str| u[k].as_u64().unwrap_or(0);
        let cached = g("cachedContentTokenCount");
        st.output.usage.input = g("promptTokenCount").saturating_sub(cached);
        st.output.usage.output = g("candidatesTokenCount") + g("thoughtsTokenCount");
        st.output.usage.cache_read = cached;
        st.output.usage.cache_write = 0;
        st.output.usage.reasoning = Some(g("thoughtsTokenCount"));
        st.output.usage.total_tokens = g("totalTokenCount");
        st.output.usage.calculate_cost(model);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

fn build_headers(model: &Model, api_key: &str, options: &StreamOptions) -> BTreeMap<String, String> {
    let mut h = BTreeMap::new();
    h.insert("content-type".into(), "application/json".into());
    h.insert("user-agent".into(), USER_AGENT.into());
    if !api_key.is_empty() {
        h.insert("x-goog-api-key".into(), api_key.to_string());
    }
    transport::merge_headers(h, model, options)
}

pub fn stream(model: Model, context: TranscriptContext, options: StreamOptions) -> AssistantMessageEventStream {
    let (tx, rx) = mpsc::channel(256);
    tokio::spawn(async move {
        let mut st = State { output: AssistantMessage::pending(&model), current: None };
        let result = run(&model, &context, &options, &tx, &mut st).await;
        transport::finish(&tx, &mut st.output, result, &options).await;
    });
    rx
}

async fn run(model: &Model, context: &TranscriptContext, options: &StreamOptions, tx: &Tx, st: &mut State) -> Result<(), ProviderError> {
    let api_key = transport::require_api_key(model, options, &["x-goog-api-key", "authorization"])?;
    let body = build_params(model, context, options);
    if let Some(cb) = &options.on_payload {
        cb(&body);
    }
    let headers = build_headers(model, &api_key, options);
    let endpoint = format!("{}/models/{}:streamGenerateContent?alt=sse", model.base_url.trim_end_matches('/'), model.id);
    let mut sse = transport::open_sse(&endpoint, &headers, &body, options).await?;
    push(tx, AssistantMessageEvent::Start { partial: st.output.clone() }).await;
    while let Some(chunk) = sse.next_json().await? {
        process_chunk(st, tx, &chunk, model).await?;
    }
    close_current(st, tx).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::transcript::{normalize_context, tool};
    use crate::harness::types::{Api, InputType, ModelCost};

    fn model(id: &str) -> Model {
        Model {
            id: id.into(),
            name: id.into(),
            api: Api::GoogleGenerativeAI,
            provider: "google".into(),
            base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![InputType::Text, InputType::Image],
            cost: ModelCost::default(),
            prompt_cache: None,
            context_window: 1_000_000,
            max_tokens: 65_536,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn thinking_config_variants() {
        assert!(uses_thinking_level("gemini-3-pro-preview"));
        assert!(uses_thinking_level("gemini-3.1-flash"));
        assert!(!uses_thinking_level("gemini-2.5-pro"));
        let tc = thinking_config(&model("gemini-3-pro-preview"), Some(ThinkingLevel::High)).unwrap();
        assert_eq!(tc["thinkingLevel"], "HIGH");
        let tc = thinking_config(&model("gemini-2.5-flash"), Some(ThinkingLevel::Low)).unwrap();
        assert_eq!(tc["thinkingBudget"], 2048);
        let tc = thinking_config(&model("gemini-2.5-pro"), None).unwrap();
        assert_eq!(tc["thinkingBudget"], 128);
    }

    #[tokio::test]
    async fn chunks_and_round_trip() {
        let m = model("gemini-3-pro-preview");
        let ctx = normalize_context(
            Some("sys"),
            Some(&[tool("read", "Read", json!({"$schema":"x","type":"object","properties":{"path":{"type":"string"}}}))]),
            vec![Message::user_text("hi")],
        );
        let p = build_params(&m, &ctx, &StreamOptions::default());
        assert_eq!(p["systemInstruction"]["parts"][0]["text"], "sys");
        assert!(p["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"].get("$schema").is_none());

        let (tx, mut rx) = mpsc::channel(256);
        let mut st = State { output: AssistantMessage::pending(&m), current: None };
        let chunks = [
            json!({"responseId":"r1","candidates":[{"content":{"parts":[{"text":"plan","thought":true}]}}]}),
            json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a"},"id":"c1"},"thoughtSignature":"QUJD"}]},"finishReason":"STOP"}],
                   "usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":3,"totalTokenCount":18}}),
        ];
        for c in &chunks {
            process_chunk(&mut st, &tx, c, &m).await.unwrap();
        }
        drop(tx);
        while rx.recv().await.is_some() {}
        assert_eq!(st.output.stop_reason, StopReason::ToolUse);
        assert_eq!(st.output.usage.output, 8);
        let tc = st.output.content[1].as_tool_call().unwrap();
        assert_eq!(tc.thought_signature.as_deref(), Some("QUJD"));

        let replay = TranscriptContext { messages: vec![Message::user_text("hi"), Message::Assistant(st.output.clone())] };
        let contents = convert_messages(&m, &replay);
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][1]["thoughtSignature"], "QUJD");
        assert_eq!(contents[1]["parts"][1]["functionCall"]["id"], "c1");
    }
}
