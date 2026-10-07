//! Context-size estimation.
//!
//! Port of pi-mono `packages/ai/src/utils/estimate.ts`: the last usable
//! assistant `usage` block anchors the count, and everything after it is
//! estimated at ~4 chars/token. Used for max_tokens clamping and compaction.

use super::transcript::get_system_message_text;
use super::types::{Message, StopReason, TranscriptContext, Usage, UserContent, UserMessageContent};

const CHARS_PER_TOKEN: usize = 4;
const ESTIMATED_IMAGE_CHARS: usize = 4800;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextUsageEstimate {
    /// Estimated total context tokens.
    pub tokens: u64,
    /// Tokens reported by the most recent applicable assistant usage block.
    pub usage_tokens: u64,
    /// Estimated tokens after that usage block.
    pub trailing_tokens: u64,
    /// Index of the message that provided usage, if any.
    pub last_usage_index: Option<usize>,
}

pub fn calculate_context_tokens(usage: &Usage) -> u64 {
    if usage.total_tokens > 0 {
        usage.total_tokens
    } else {
        usage.input + usage.output + usage.cache_read + usage.cache_write
    }
}

fn ceil_div(chars: usize) -> u64 {
    ((chars + CHARS_PER_TOKEN - 1) / CHARS_PER_TOKEN) as u64
}

pub fn estimate_text_tokens(text: &str) -> u64 {
    ceil_div(text.len())
}

fn blocks_chars(blocks: &[UserContent]) -> usize {
    blocks
        .iter()
        .map(|b| match b {
            UserContent::Text(t) => t.text.len(),
            UserContent::Image(_) => ESTIMATED_IMAGE_CHARS,
        })
        .sum()
}

pub fn estimate_message_tokens(message: &Message) -> u64 {
    match message {
        Message::System(s) => {
            let mut t = estimate_text_tokens(&get_system_message_text(s));
            if let Some(list) = s.tools_added.as_ref().filter(|l| !l.is_empty()) {
                t += estimate_text_tokens(&serde_json::to_string(list).unwrap_or_default());
            }
            if let Some(list) = s.tools_removed.as_ref().filter(|l| !l.is_empty()) {
                t += estimate_text_tokens(&serde_json::to_string(list).unwrap_or_default());
            }
            t
        }
        Message::User(u) => match &u.content {
            UserMessageContent::Text(s) => ceil_div(s.len()),
            UserMessageContent::Blocks(b) => ceil_div(blocks_chars(b)),
        },
        Message::ToolResult(t) => ceil_div(blocks_chars(&t.content)),
        Message::Assistant(a) => {
            let chars: usize = a
                .content
                .iter()
                .map(|c| match c {
                    super::types::AssistantContent::Text(t) => t.text.len(),
                    super::types::AssistantContent::Thinking(t) => t.thinking.len(),
                    super::types::AssistantContent::ToolCall(tc) => {
                        tc.name.len() + serde_json::to_string(&tc.arguments).map(|s| s.len()).unwrap_or(0)
                    }
                })
                .sum();
            ceil_div(chars)
        }
    }
}

fn last_assistant_usage(messages: &[Message]) -> Option<(&Usage, usize)> {
    let mut latest_prefix_ts: i64 = i64::MIN;
    let mut found = None;
    for (i, m) in messages.iter().enumerate() {
        if let Message::Assistant(a) = m {
            // A newer prefix message (e.g. a compaction summary) inserted
            // after this response means its usage no longer describes the
            // current prefix.
            let applies = a.timestamp >= latest_prefix_ts;
            if applies
                && !matches!(a.stop_reason, StopReason::Aborted | StopReason::Error)
                && calculate_context_tokens(&a.usage) > 0
            {
                found = Some((&a.usage, i));
            }
        }
        latest_prefix_ts = latest_prefix_ts.max(m.timestamp());
    }
    found
}

pub fn estimate_context_tokens(messages: &[Message]) -> ContextUsageEstimate {
    if let Some((usage, idx)) = last_assistant_usage(messages) {
        let usage_tokens = calculate_context_tokens(usage);
        let trailing: u64 = messages[idx + 1..].iter().map(estimate_message_tokens).sum();
        return ContextUsageEstimate {
            tokens: usage_tokens + trailing,
            usage_tokens,
            trailing_tokens: trailing,
            last_usage_index: Some(idx),
        };
    }
    let tokens: u64 = messages.iter().map(estimate_message_tokens).sum();
    ContextUsageEstimate {
        tokens,
        usage_tokens: 0,
        trailing_tokens: tokens,
        last_usage_index: None,
    }
}

pub fn estimate_context(context: &TranscriptContext) -> ContextUsageEstimate {
    estimate_context_tokens(&context.messages)
}

const CONTEXT_SAFETY_TOKENS: u64 = 4096;
const MIN_MAX_TOKENS: u64 = 1;

/// `clampMaxTokensToContext`: never ask for more output than the window has room for.
pub fn clamp_max_tokens_to_context(context_window: u64, context: &TranscriptContext, max_tokens: u64) -> u64 {
    if context_window == 0 {
        return max_tokens.max(MIN_MAX_TOKENS);
    }
    let used = estimate_context(context).tokens;
    let available = context_window.saturating_sub(used).saturating_sub(CONTEXT_SAFETY_TOKENS);
    max_tokens.min(available.max(MIN_MAX_TOKENS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::types::{Api, AssistantMessage, Message};

    #[test]
    fn uses_usage_anchor_then_estimates_trailing() {
        let mut a = AssistantMessage {
            content: vec![],
            api: Api::OpenAICompletions,
            provider: "p".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: 10,
        };
        a.usage.input = 900;
        a.usage.output = 100;
        let user = |s: String, ts: i64| {
            Message::User(crate::harness::types::UserMessage {
                content: UserMessageContent::Text(s),
                timestamp: ts,
            })
        };
        let msgs = vec![user("x".repeat(400), 5), Message::Assistant(a), user("y".repeat(40), 20)];
        let e = estimate_context_tokens(&msgs);
        assert_eq!(e.usage_tokens, 1000);
        assert_eq!(e.trailing_tokens, 10);
        assert_eq!(e.tokens, 1010);
        assert_eq!(e.last_usage_index, Some(1));
    }

    #[test]
    fn no_usage_estimates_everything() {
        let msgs = vec![Message::user_text("x".repeat(40))];
        let e = estimate_context_tokens(&msgs);
        assert_eq!(e.tokens, 10);
        assert_eq!(e.last_usage_index, None);
    }
}
