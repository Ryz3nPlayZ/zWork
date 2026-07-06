//! Streaming tool-call accumulator.
//!
//! Providers emit a tool call's identity (id/name) and JSON argument text
//! across separate chunks. `ToolStream` accumulates the raw argument string
//! keyed by the provider's stream-local index, then finalizes it by parsing
//! once the call completes.
//!
//! This is the critical correctness seam. opencode's
//! `protocols/utils/tool-stream.ts` parses the accumulated JSON via
//! `parseToolInput`, which **fails loudly** (`eventError`) on malformed JSON.
//! The old zWork code did `serde_json::from_str(buf).unwrap_or(json!({}))` —
//! silently turning any malformed tool args into empty `{}`, so a tool like
//! `browser_navigate` ran with no URL and the agent looked broken. Here,
//! malformed JSON returns `Err` and the caller surfaces it as a
//! `ProviderError`; it never becomes a phantom empty-args call.

use serde_json::Value;
use std::collections::HashMap;

/// One pending streamed tool call. `input` is the raw JSON string collected so
/// far, NOT the parsed object.
#[derive(Debug, Clone)]
pub struct PendingTool {
    pub id: String,
    pub name: String,
    pub input: String,
}

/// Sparse parser state keyed by the provider's stream-local tool index
/// (Anthropic `content_block` index, OpenAI Chat `tool_calls[].index`).
#[derive(Debug, Default)]
pub struct ToolStream {
    tools: HashMap<usize, PendingTool>,
}

/// A finalized tool call that parsed cleanly.
#[derive(Debug, Clone)]
pub struct FinishedTool {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// Why finalization failed. Carried to the caller so it can emit a loud
/// `ProviderError` with the offending raw payload — never silently recovered.
/// (`route`/`name` are mirrored into `message` already but retained for
/// structured consumers.)
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ToolParseError {
    pub route: &'static str,
    pub name: String,
    pub raw: String,
    pub message: String,
}

impl ToolStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a tool call whose start event arrived before any argument
    /// deltas (Anthropic `content_block_start`, OpenAI Responses). No-op-safe:
    /// re-starting the same key just refreshes identity.
    pub fn start(&mut self, key: usize, id: impl Into<String>, name: impl Into<String>) {
        self.tools.insert(
            key,
            PendingTool {
                id: id.into(),
                name: name.into(),
                input: String::new(),
            },
        );
    }

    /// Append an argument delta to a tool that MUST already have been started
    /// (Anthropic `input_json_delta` — the `content_block_start` promised a
    /// start event before any delta).
    pub fn append_existing(
        &mut self,
        route: &'static str,
        key: usize,
        text: &str,
    ) -> Result<(), ToolParseError> {
        if text.is_empty() {
            return Ok(());
        }
        let tool = match self.tools.get_mut(&key) {
            Some(t) => t,
            None => {
                return Err(ToolParseError {
                    route,
                    name: String::new(),
                    raw: text.to_string(),
                    message: format!("{route}: tool argument delta has no prior tool_use start at index {key}"),
                });
            }
        };
        tool.input.push_str(text);
        Ok(())
    }

    /// Append an argument delta, starting the tool if this provider encodes
    /// identity on the first delta instead of a separate start event (OpenAI
    /// Chat: `tool_calls[].index` is the key; `id`/`name` may only appear on
    /// the first delta for that index). Errors if id or name is missing.
    pub fn append_or_start(
        &mut self,
        route: &'static str,
        key: usize,
        id: Option<&str>,
        name: Option<&str>,
        text: &str,
    ) -> Result<(), ToolParseError> {
        let current = self.tools.get(&key);
        let id = match id.or(current.map(|t| t.id.as_str())) {
            Some(i) if !i.is_empty() => i.to_string(),
            _ => {
                return Err(ToolParseError {
                    route,
                    name: name.unwrap_or("").to_string(),
                    raw: text.to_string(),
                    message: format!("{route}: tool call delta is missing id"),
                });
            }
        };
        let name = match name.or(current.map(|t| t.name.as_str())) {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => {
                return Err(ToolParseError {
                    route,
                    name: id.clone(),
                    raw: text.to_string(),
                    message: format!("{route}: tool call delta is missing name"),
                });
            }
        };
        // No-op if nothing changed (e.g. a metadata-only delta repeating id/name).
        if text.is_empty() {
            if let Some(t) = self.tools.get_mut(&key) {
                t.id = id;
                t.name = name;
            } else {
                self.tools.insert(
                    key,
                    PendingTool {
                        id,
                        name,
                        input: String::new(),
                    },
                );
            }
            return Ok(());
        }
        let prev_input = current.map(|t| t.input.as_str()).unwrap_or("").to_string();
        self.tools.insert(
            key,
            PendingTool {
                id,
                name,
                input: format!("{prev_input}{text}"),
            },
        );
        Ok(())
    }

    /// Finalize one pending tool call (Anthropic `content_block_stop`). A
    /// missing key is a no-op — providers emit stop events for non-tool blocks
    /// too.
    pub fn finish(
        &mut self,
        route: &'static str,
        key: usize,
    ) -> Result<Option<FinishedTool>, ToolParseError> {
        let Some(tool) = self.tools.remove(&key) else {
            return Ok(None);
        };
        Ok(Some(parse_tool_input(route, tool)?))
    }

    /// Finalize EVERY pending tool call at once (OpenAI Chat emits no per-tool
    /// stop events; all calls finish when the choice gets a terminal
    /// `finish_reason`). Finalizes in index order so multi-call turns are
    /// deterministic.
    pub fn finish_all(&mut self, route: &'static str) -> Result<Vec<FinishedTool>, ToolParseError> {
        let mut keys: Vec<usize> = self.tools.keys().copied().collect();
        keys.sort_unstable();
        let mut out = Vec::with_capacity(keys.len());
        for key in keys {
            let tool = self.tools.remove(&key).expect("key sourced from map");
            out.push(parse_tool_input(route, tool)?);
        }
        Ok(out)
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

/// Parse the streamed JSON input of a tool call. An empty string is treated as
/// `"{}"` (providers occasionally finish a zero-arg tool without ever emitting
/// input deltas). Malformed JSON is a loud `Err` — uniform message shape
/// matching opencode: `Invalid JSON input for <route> tool call <name>`.
pub fn parse_tool_input(
    route: &'static str,
    tool: PendingTool,
) -> Result<FinishedTool, ToolParseError> {
    let id = tool.id;
    let name = tool.name;
    let input = tool.input;
    let trimmed = input.trim();
    let parsed = if trimmed.is_empty() {
        Ok(Value::Object(serde_json::Map::new()))
    } else {
        serde_json::from_str::<Value>(trimmed)
    };
    match parsed {
        Ok(v) => Ok(FinishedTool {
            id,
            name,
            input: v,
        }),
        Err(e) => Err(ToolParseError {
            route,
            name: name.clone(),
            raw: input,
            message: format!("Invalid JSON input for {route} tool call {}: {e}", name),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_becomes_empty_object() {
        let mut ts = ToolStream::new();
        ts.start(0, "call_1", "browser_navigate");
        let f = ts.finish("anthropic", 0).unwrap().unwrap();
        assert_eq!(f.input, Value::Object(serde_json::Map::new()));
    }

    #[test]
    fn streamed_args_assemble_and_parse() {
        let mut ts = ToolStream::new();
        ts.start(0, "call_1", "browser_navigate");
        ts.append_existing("anthropic", 0, "{\"url\":").unwrap();
        ts.append_existing("anthropic", 0, " \"https://x.io\"}").unwrap();
        let f = ts.finish("anthropic", 0).unwrap().unwrap();
        assert_eq!(f.input["url"], "https://x.io");
    }

    #[test]
    fn malformed_json_is_loud() {
        let mut ts = ToolStream::new();
        ts.start(0, "call_1", "browser_navigate");
        ts.append_existing("anthropic", 0, "{\"url\":").unwrap();
        // never closed — malformed
        let err = ts.finish("anthropic", 0).unwrap_err();
        assert!(err.message.contains("Invalid JSON input"));
        assert!(err.raw.contains("\"url\""));
    }

    #[test]
    fn openai_append_or_start_uses_first_delta_identity() {
        let mut ts = ToolStream::new();
        ts.append_or_start("openai-chat", 0, Some("call_1"), Some("read_file"), "{\"path\":\"a")
            .unwrap();
        ts.append_or_start("openai-chat", 0, None, None, ".rs\"}")
            .unwrap();
        let out = ts.finish_all("openai-chat").unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].input["path"], "a.rs");
    }

    #[test]
    fn openai_missing_name_errors() {
        let mut ts = ToolStream::new();
        let err = ts
            .append_or_start("openai-chat", 0, Some("call_1"), None, "{}")
            .unwrap_err();
        assert!(err.message.contains("missing name"));
    }
}
