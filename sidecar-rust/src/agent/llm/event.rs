//! Unified LLM stream event vocabulary.
//!
//! One contract consumed by the agent loop regardless of provider wire
//! format. This is the Rust mirror of opencode's `LLMEvent` union
//! (`packages/llm/src/schema/events.ts`), trimmed to the subset zWork's
//! single-agent loop actually needs.
//!
//! The streaming block lifecycle (text-start/text-end, reasoning-start/end)
//! opencode emits is tracked *internally* by each protocol parser; we only
//! surface deltas here because the agent loop concatenates them. That keeps
//! the loop simple without losing correctness.

use serde_json::Value;

/// Provider-reported token usage. Fields are independently meaningful so
/// consumers never have to subtract (mirrors opencode's `Usage` contract).
#[derive(Debug, Clone, Default)]
pub struct Usage {
    /// Inclusive prompt-token total (incl. cache reads/writes).
    pub input_tokens: Option<u64>,
    /// Inclusive output-token total (incl. reasoning).
    pub output_tokens: Option<u64>,
    /// Input tokens served from cache.
    pub cache_read: Option<u64>,
    /// Input tokens written to cache.
    pub cache_write: Option<u64>,
    /// Output tokens spent on hidden reasoning (subset of `output_tokens`).
    pub reasoning_tokens: Option<u64>,
}

impl Usage {
    /// Right-biased merge: each field prefers `right` when defined. Used to
    /// reconcile the multiple usage snapshots providers stream across a turn.
    pub fn merge(left: Option<Usage>, right: Option<Usage>) -> Option<Usage> {
        match (left, right) {
            (None, r) => r,
            (l, None) => l,
            (Some(l), Some(r)) => Some(Usage {
                input_tokens: r.input_tokens.or(l.input_tokens),
                output_tokens: r.output_tokens.or(l.output_tokens),
                cache_read: r.cache_read.or(l.cache_read),
                cache_write: r.cache_write.or(l.cache_write),
                reasoning_tokens: r.reasoning_tokens.or(l.reasoning_tokens),
            }),
        }
    }

    pub fn to_summary(&self) -> String {
        format!(
            "in={:?} out={:?} cache_read={:?} cache_write={:?} reasoning={:?}",
            self.input_tokens,
            self.output_tokens,
            self.cache_read,
            self.cache_write,
            self.reasoning_tokens
        )
    }
}

/// Why the stream terminated. Normalized across providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    /// Model stopped of its own accord (end_turn / stop / stop_sequence).
    Stop,
    /// Hit max_tokens / output cap.
    Length,
    /// Terminated because the model emitted tool calls.
    ToolCalls,
    /// Provider content filter / refusal.
    ContentFilter,
    /// Anything else.
    Unknown,
}

/// One event on the unified stream.
///
/// Some variants/fields are produced by the parsers but not yet read by the
/// agent loop (e.g. standalone `Usage`, `ReasoningDelta` text) — they're kept
/// to mirror opencode's unified `LLMEvent` contract so the loop can opt into
/// them without a parser change.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum LlmEvent {
    /// Assistant visible-text chunk.
    TextDelta { text: String },
    /// Model reasoning / chain-of-thought chunk (kept separate from visible
    /// text). Currently traced but not forwarded to the UI.
    ReasoningDelta { text: String },
    /// A fully-assembled Anthropic extended-thinking block, emitted at
    /// `content_block_stop`. The `signature` is required to replay the
    /// thinking block on the next turn for models that use extended thinking.
    ThinkingBlock { thinking: String, signature: String },
    /// A fully-assembled tool call: id + name + parsed input. Emitted exactly
    /// once per call, at the call's completion boundary. Malformed tool JSON
    /// never reaches here — it surfaces as `ProviderError` instead.
    ToolCall { id: String, name: String, input: Value },
    /// Provider token usage (may arrive more than once per turn).
    Usage(Usage),
    /// Terminal finish reason for the turn.
    Finish { reason: FinishReason, usage: Option<Usage> },
    /// Hard stream error: connection failure, non-2xx, malformed SSE frame,
    /// or bad tool-call JSON. `raw` carries the offending payload for
    /// diagnosis when applicable.
    ProviderError { message: String, raw: Option<String> },
    /// Stream closed cleanly.
    Done,
}
