//! Anthropic Messages streaming parser.
//!
//! Rust mirror of opencode's `protocols/anthropic-messages.ts` `step` state
//! machine. Each SSE `data:` payload (already JSON-decoded by the caller) is
//! one Anthropic event; `step` returns the unified events produced by it.
//!
//! Tool calls are accumulated by [`ToolStream`] across `input_json_delta`
//! chunks and finalized at `content_block_stop`. A tool block that finishes
//! with malformed JSON surfaces a loud [`LlmEvent::ProviderError`] — never a
//! phantom empty-args call.

use serde_json::Value;

use super::event::{FinishReason, LlmEvent, Usage};
use super::tool_stream::{FinishedTool, ToolParseError, ToolStream};
use super::ProtocolParser;

const ROUTE: &str = "anthropic-messages";

pub struct AnthropicParser {
    tools: ToolStream,
    usage: Option<Usage>,
    finish_reason: Option<FinishReason>,
    had_tool_calls: bool,
}

impl AnthropicParser {
    pub fn new() -> Self {
        Self {
            tools: ToolStream::new(),
            usage: None,
            finish_reason: None,
            had_tool_calls: false,
        }
    }
}

impl ProtocolParser for AnthropicParser {
    fn route(&self) -> &'static str {
        ROUTE
    }

    fn step(&mut self, event: Value) -> Vec<LlmEvent> {
        let ev_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ev_type {
            "message_start" => {
                if let Some(u) = event
                    .get("message")
                    .and_then(|m| m.get("usage"))
                    .and_then(map_usage)
                {
                    self.usage = Usage::merge(self.usage.take(), Some(u));
                }
                Vec::new()
            }
            "content_block_start" => on_content_block_start(self, &event),
            "content_block_delta" => on_content_block_delta(self, &event),
            "content_block_stop" => on_content_block_stop(self, &event),
            "message_delta" => {
                if let Some(u) = event.get("usage").and_then(map_usage) {
                    self.usage = Usage::merge(self.usage.take(), Some(u));
                }
                if let Some(reason) = event
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(|v| v.as_str())
                    .map(map_finish_reason)
                {
                    self.finish_reason = Some(reason);
                }
                Vec::new()
            }
            "error" => {
                let msg = event
                    .get("error")
                    .map(|e| {
                        let t = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        let m = e.get("message").and_then(|v| v.as_str()).unwrap_or("");
                        if !t.is_empty() && !m.is_empty() {
                            format!("{t}: {m}")
                        } else if !m.is_empty() {
                            m.to_string()
                        } else if !t.is_empty() {
                            t.to_string()
                        } else {
                            "Anthropic stream error".to_string()
                        }
                    })
                    .unwrap_or_else(|| "Anthropic stream error".to_string());
                vec![LlmEvent::ProviderError {
                    message: msg,
                    raw: Some(event.to_string()),
                }]
            }
            // `ping`, `message_stop`, and anything else carry no content.
            _ => Vec::new(),
        }
    }

    fn finish(&mut self) -> Vec<LlmEvent> {
        let mut out = Vec::new();
        // If the stream ended mid-tool-call (no content_block_stop), flush what
        // we have rather than dropping it.
        if !self.tools.is_empty() {
            match self.tools.finish_all(ROUTE) {
                Ok(calls) => {
                    for c in calls {
                        self.had_tool_calls = true;
                        out.push(finished_to_event(c));
                    }
                }
                Err(e) => {
                    out.push(parse_error_to_event(e));
                    return out;
                }
            }
        }
        let reason = match (self.finish_reason, self.had_tool_calls) {
            (Some(r), _) => r,
            (None, true) => FinishReason::ToolCalls,
            (None, false) => FinishReason::Stop,
        };
        out.push(LlmEvent::Finish {
            reason,
            usage: self.usage.clone(),
        });
        out
    }
}

fn on_content_block_start(state: &mut AnthropicParser, event: &Value) -> Vec<LlmEvent> {
    let Some(block) = event.get("content_block") else {
        return Vec::new();
    };
    let idx = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match block_type {
        "tool_use" | "server_tool_use" => {
            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            state.tools.start(idx, id, name);
            Vec::new()
        }
        "text" => {
            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    return vec![LlmEvent::TextDelta { text: text.to_string() }];
                }
            }
            Vec::new()
        }
        "thinking" => {
            if let Some(text) = block.get("thinking").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    return vec![LlmEvent::ReasoningDelta {
                        text: text.to_string(),
                    }];
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn on_content_block_delta(state: &mut AnthropicParser, event: &Value) -> Vec<LlmEvent> {
    let Some(delta) = event.get("delta") else {
        return Vec::new();
    };
    let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match delta_type {
        "text_delta" => {
            let text = delta.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                Vec::new()
            } else {
                vec![LlmEvent::TextDelta { text: text.to_string() }]
            }
        }
        "thinking_delta" => {
            let text = delta.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                Vec::new()
            } else {
                vec![LlmEvent::ReasoningDelta {
                    text: text.to_string(),
                }]
            }
        }
        "input_json_delta" => {
            let idx = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let partial = delta.get("partial_json").and_then(|v| v.as_str()).unwrap_or("");
            match state.tools.append_existing(ROUTE, idx, partial) {
                Ok(()) => Vec::new(),
                Err(e) => vec![parse_error_to_event(e)],
            }
        }
        // signature_delta, citations_delta, etc. — not model-visible content.
        _ => Vec::new(),
    }
}

fn on_content_block_stop(state: &mut AnthropicParser, event: &Value) -> Vec<LlmEvent> {
    let idx = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    match state.tools.finish(ROUTE, idx) {
        Ok(Some(c)) => {
            state.had_tool_calls = true;
            vec![finished_to_event(c)]
        }
        Ok(None) => Vec::new(), // non-tool block
        Err(e) => vec![parse_error_to_event(e)],
    }
}

fn map_usage(usage: &Value) -> Option<Usage> {
    let get = |k: &str| usage.get(k).and_then(|v| v.as_u64());
    let input_tokens = get("input_tokens");
    let output_tokens = get("output_tokens");
    let cache_read = get("cache_read_input_tokens");
    let cache_write = get("cache_creation_input_tokens");
    if input_tokens.is_none()
        && output_tokens.is_none()
        && cache_read.is_none()
        && cache_write.is_none()
    {
        return None;
    }
    Some(Usage {
        input_tokens,
        output_tokens,
        cache_read,
        cache_write,
        reasoning_tokens: None, // Anthropic folds thinking into output_tokens.
    })
}

fn map_finish_reason(reason: &str) -> FinishReason {
    match reason {
        "end_turn" | "stop_sequence" | "pause_turn" => FinishReason::Stop,
        "max_tokens" => FinishReason::Length,
        "tool_use" => FinishReason::ToolCalls,
        "refusal" => FinishReason::ContentFilter,
        _ => FinishReason::Unknown,
    }
}

fn finished_to_event(c: FinishedTool) -> LlmEvent {
    LlmEvent::ToolCall {
        id: c.id,
        name: c.name,
        input: c.input,
    }
}

fn parse_error_to_event(e: ToolParseError) -> LlmEvent {
    LlmEvent::ProviderError {
        message: e.message,
        raw: Some(e.raw),
    }
}
