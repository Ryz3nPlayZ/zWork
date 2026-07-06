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
use std::collections::HashMap;

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
    /// Maps the provider's stream-local `tool_calls[].index` to the internal
    /// accumulator key we allocated for it, plus the last tool-call `id` seen
    /// at that index. The standard OpenAI contract uses a distinct `index` per
    /// tool call (id/name appear only on the first delta for that index), so
    /// keying by `index` alone is correct. But some OpenAI-compatible providers
    /// — DeepSeek among them — stream each tool call as its own delta carrying
    /// a fresh `id` while omitting `index` (every delta then defaults to index
    /// 0). Keying purely by `index` would funnel all those calls into one
    /// accumulator bucket and concatenate their arguments
    /// (`{"element_id":4}{"element_id":8}…`), which then fails to parse. We
    /// therefore treat a delta that carries a NEW `id` at an already-seen
    /// index as the start of a brand-new tool call and allocate a fresh key.
    index_to_key: HashMap<usize, (usize, String)>,
    next_key: usize,
}

impl OpenAIChatParser {
    pub fn new() -> Self {
        Self {
            tools: ToolStream::new(),
            usage: None,
            finish_reason: None,
            had_tool_calls: false,
            finalized: false,
            index_to_key: HashMap::new(),
            next_key: 0,
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

                // Resolve the accumulator key (see `index_to_key` doc). A new
                // `id` at an already-seen index means a new tool call reusing
                // that index — split it into its own bucket. An arg-only delta
                // (no id) routes to whatever call currently owns that index.
                let key = match (id, self.index_to_key.get(&idx)) {
                    (Some(new_id), Some((_prev_key, prev_id))) if prev_id != new_id => {
                        let k = self.next_key;
                        self.next_key += 1;
                        self.index_to_key.insert(idx, (k, new_id.to_string()));
                        k
                    }
                    (Some(new_id), None) => {
                        let k = self.next_key;
                        self.next_key += 1;
                        self.index_to_key.insert(idx, (k, new_id.to_string()));
                        k
                    }
                    (_, Some((prev_key, _))) => *prev_key,
                    (None, None) => {
                        // Args/fragment with no prior start at this index:
                        // allocate a fresh key so append_or_start emits the loud
                        // "missing id" error rather than colliding with an
                        // existing bucket.
                        let k = self.next_key;
                        self.next_key += 1;
                        k
                    }
                };

                if let Err(e) = self.tools.append_or_start(ROUTE, key, id, name, args) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Build one streamed chunk carrying a single `tool_calls` delta.
    fn tc_chunk(index: Option<u64>, id: Option<&str>, name: Option<&str>, args: &str) -> Value {
        let mut func = json!({ "arguments": args });
        if let Some(n) = name {
            func["name"] = json!(n);
        }
        let mut tc = json!({});
        if let Some(i) = index {
            tc["index"] = json!(i);
        }
        if let Some(i) = id {
            tc["id"] = json!(i);
        }
        tc["function"] = func;
        json!({ "choices": [{ "delta": { "tool_calls": [tc] } }] })
    }

    fn terminal(reason: &str) -> Value {
        json!({ "choices": [{ "delta": {}, "finish_reason": reason }] })
    }

    fn tool_calls(events: Vec<LlmEvent>) -> Vec<(String, String, Value)> {
        events
            .into_iter()
            .filter_map(|e| match e {
                LlmEvent::ToolCall { id, name, input } => Some((id, name, input)),
                _ => None,
            })
            .collect()
    }

    /// The bug: DeepSeek streams each tool call as its own delta with a fresh
    /// `id` but the SAME `index` (0). They must NOT be concatenated.
    #[test]
    fn deepseek_multi_call_same_index_stays_separate() {
        let mut p = OpenAIChatParser::new();
        let _ = p.step(tc_chunk(Some(0), Some("call_A"), Some("browser_click"), r#"{"element_id":4}"#));
        let _ = p.step(tc_chunk(Some(0), Some("call_B"), Some("browser_click"), r#"{"element_id":8}"#));
        let _ = p.step(tc_chunk(Some(0), Some("call_C"), Some("browser_click"), r#"{"element_id":10}"#));
        let events = p.step(terminal("tool_calls"));
        let calls = tool_calls(events);

        assert_eq!(calls.len(), 3, "three calls must stay separate, not concatenated");
        assert_eq!(calls[0].0, "call_A");
        assert_eq!(calls[0].2["element_id"], 4);
        assert_eq!(calls[1].0, "call_B");
        assert_eq!(calls[1].2["element_id"], 8);
        assert_eq!(calls[2].0, "call_C");
        assert_eq!(calls[2].2["element_id"], 10);
    }

    /// Same, but `index` omitted entirely (also observed from providers that
    /// default every delta to index 0).
    #[test]
    fn deepseek_multi_call_no_index_stays_separate() {
        let mut p = OpenAIChatParser::new();
        let _ = p.step(tc_chunk(None, Some("call_A"), Some("browser_click"), r#"{"element_id":4}"#));
        let _ = p.step(tc_chunk(None, Some("call_B"), Some("browser_click"), r#"{"element_id":8}"#));
        let events = p.step(terminal("tool_calls"));
        assert_eq!(tool_calls(events).len(), 2);
    }

    /// Regression guard for the standard OpenAI contract: distinct indices,
    /// id/name only on the first delta, args streamed as fragments.
    #[test]
    fn standard_openai_fragmented_args_assemble() {
        let mut p = OpenAIChatParser::new();
        let _ = p.step(tc_chunk(Some(0), Some("call_A"), Some("read_file"), ""));
        let _ = p.step(tc_chunk(Some(0), None, None, r#"{"path":"a"#));
        let _ = p.step(tc_chunk(Some(0), None, None, r#".rs"}"#));
        let _ = p.step(tc_chunk(Some(1), Some("call_B"), Some("read_file"), ""));
        let _ = p.step(tc_chunk(Some(1), None, None, r#"{"path":"b.rs"}"#));
        let events = p.step(terminal("tool_calls"));
        let calls = tool_calls(events);

        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].2["path"], "a.rs");
        assert_eq!(calls[1].2["path"], "b.rs");
    }
}
