//! OpenAI Chat Completions streaming parser.
//!
//! Rust mirror of opencode's `protocols/openai-chat.ts` `step` state machine.
//! This is the parser reused by every OpenAI-compatible provider — including
//! DeepSeek, which is zWork's primary router model, so this is the hot path.
//!
//! Two correctness invariants carried over from opencode:
//!   1. Tool calls are accumulated across `tool_calls[].function.arguments`
//!      deltas and finalized *eagerly* when `finish_reason` arrives
//!      (`ToolStream.finish_all`), because OpenAI emits no per-tool stop event.
//!   2. Finalized JSON is parsed loudly; malformed args surface a
//!      [`LlmEvent::ProviderError`], never a phantom empty-args call.

use serde_json::Value;

use super::event::{FinishReason, LlmEvent, Usage};
use super::tool_stream::{FinishedTool, ToolParseError, ToolStream};
use super::ProtocolParser;

const ROUTE: &str = "openai-chat";

pub struct OpenAIChatParser {
    tools: ToolStream,
    usage: Option<Usage>,
    finish_reason: Option<FinishReason>,
    had_tool_calls: bool,
    finalized: bool,
}

impl OpenAIChatParser {
    pub fn new() -> Self {
        Self {
            tools: ToolStream::new(),
            usage: None,
            finish_reason: None,
            had_tool_calls: false,
            finalized: false,
        }
    }
}

impl ProtocolParser for OpenAIChatParser {
    fn route(&self) -> &'static str {
        ROUTE
    }

    fn step(&mut self, event: Value) -> Vec<LlmEvent> {
        let mut out = Vec::new();

        if let Some(u) = event.get("usage").and_then(map_usage) {
            self.usage = Usage::merge(self.usage.take(), Some(u));
        }

        let choice = match event.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first()) {
            Some(c) => c,
            None => return out,
        };

        if let Some(reason_str) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            let reason = map_finish_reason(reason_str);
            // First time we see a terminal reason: eagerly finalize all pending
            // tool calls so JSON parse failures fail the stream at the boundary.
            if self.finish_reason.is_none() && !self.finalized && !self.tools.is_empty() {
                self.finalized = true;
                match self.tools.finish_all(ROUTE) {
                    Ok(calls) => {
                        for c in calls {
                            self.had_tool_calls = true;
                            out.push(finished_to_event(c));
                        }
                    }
                    Err(e) => {
                        out.push(parse_error_to_event(e));
                        self.finish_reason = Some(reason);
                        return out;
                    }
                }
            }
            self.finish_reason = Some(reason);
        }

        let Some(delta) = choice.get("delta") else {
            return out;
        };

        if let Some(text) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                out.push(LlmEvent::ReasoningDelta {
                    text: text.to_string(),
                });
            }
        }

        if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                out.push(LlmEvent::TextDelta {
                    text: text.to_string(),
                });
            }
        }

        if let Some(tool_deltas) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for tc in tool_deltas {
                let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let id = tc.get("id").and_then(|v| v.as_str());
                let func = tc.get("function");
                let name = func.and_then(|f| f.get("name")).and_then(|v| v.as_str());
                let args = func
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if let Err(e) = self.tools.append_or_start(ROUTE, idx, id, name, args) {
                    out.push(parse_error_to_event(e));
                    return out;
                }
            }
        }

        out
    }

    fn finish(&mut self) -> Vec<LlmEvent> {
        let mut out = Vec::new();
        // If finish_reason never arrived but we have pending calls (truncated
        // stream), flush best-effort before emitting Finish.
        if !self.finalized && !self.tools.is_empty() {
            self.finalized = true;
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
            // OpenAI reports "stop" even when the turn produced tool calls;
            // normalize so the loop recognizes a tool-calling turn.
            (Some(FinishReason::Stop), true) => FinishReason::ToolCalls,
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

fn map_usage(usage: &Value) -> Option<Usage> {
    let prompt = usage.get("prompt_tokens").and_then(|v| v.as_u64());
    let completion = usage.get("completion_tokens").and_then(|v| v.as_u64());
    if prompt.is_none() && completion.is_none() {
        return None;
    }
    let cache_read = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64());
    let reasoning = usage
        .get("completion_tokens_details")
        .and_then(|d| d.get("reasoning_tokens"))
        .and_then(|v| v.as_u64());
    Some(Usage {
        input_tokens: prompt,
        output_tokens: completion,
        cache_read,
        cache_write: None,
        reasoning_tokens: reasoning,
    })
}

fn map_finish_reason(reason: &str) -> FinishReason {
    match reason {
        "stop" => FinishReason::Stop,
        "length" => FinishReason::Length,
        "tool_calls" | "function_call" => FinishReason::ToolCalls,
        "content_filter" => FinishReason::ContentFilter,
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
