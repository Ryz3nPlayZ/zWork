//! Port of pi `core/messages.ts` (the parts zWork needs).
//!
//! pi's coding agent layers a few "custom" message kinds on top of the
//! LLM roles and converts them to user messages right before the provider
//! call. zWork keeps the same shape: everything non-LLM is an
//! [`AgentMessage::Custom`] whose `custom_type` names the kind, and
//! [`convert_to_llm`] maps every custom message to a user message.

use serde_json::{json, Value};

use crate::harness::agent_types::{AgentMessage, CustomMessage};
use crate::harness::types::{now_ms, Message, UserContent, UserMessage, UserMessageContent};

pub const COMPACTION_SUMMARY_PREFIX: &str =
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
pub const COMPACTION_SUMMARY_SUFFIX: &str = "\n</summary>";

/// `custom_type` of a compaction summary message.
pub const COMPACTION_SUMMARY_TYPE: &str = "compactionSummary";

/// Create a generic custom message.
pub fn create_custom_message(
    custom_type: impl Into<String>,
    content: UserMessageContent,
    display: bool,
    details: Option<Value>,
) -> AgentMessage {
    AgentMessage::Custom(CustomMessage {
        custom_type: custom_type.into(),
        content,
        display,
        details,
        timestamp: now_ms(),
    })
}

/// Create a compaction summary message (`createCompactionSummaryMessage`).
///
/// The LLM-visible content already carries the `<summary>` wrapper so the
/// generic custom→user conversion is all the provider path needs. The raw
/// summary and metadata live in `details` for later re-compaction.
pub fn create_compaction_summary_message(summary: &str, tokens_before: u64, details: Option<Value>) -> AgentMessage {
    let mut d = json!({
        "summary": summary,
        "tokensBefore": tokens_before,
    });
    if let Some(Value::Object(extra)) = details {
        if let Value::Object(map) = &mut d {
            for (k, v) in extra {
                map.insert(k, v);
            }
        }
    }
    let text = format!("{COMPACTION_SUMMARY_PREFIX}{summary}{COMPACTION_SUMMARY_SUFFIX}");
    create_custom_message(COMPACTION_SUMMARY_TYPE, UserMessageContent::Text(text), true, Some(d))
}

pub fn is_compaction_summary(message: &AgentMessage) -> bool {
    matches!(message, AgentMessage::Custom(c) if c.custom_type == COMPACTION_SUMMARY_TYPE)
}

/// Raw summary text of a compaction summary message.
pub fn compaction_summary_text(message: &AgentMessage) -> Option<&str> {
    match message {
        AgentMessage::Custom(c) if c.custom_type == COMPACTION_SUMMARY_TYPE => {
            c.details.as_ref().and_then(|d| d.get("summary")).and_then(Value::as_str)
        }
        _ => None,
    }
}

/// `convertToLlm`: LLM messages pass through; custom messages become user
/// messages carrying their content.
pub fn convert_to_llm(messages: &[AgentMessage]) -> Vec<Message> {
    messages
        .iter()
        .map(|m| match m {
            AgentMessage::Llm(m) => m.clone(),
            AgentMessage::Custom(c) => {
                let content = match &c.content {
                    UserMessageContent::Text(t) => UserMessageContent::Blocks(vec![UserContent::text(t.clone())]),
                    blocks @ UserMessageContent::Blocks(_) => blocks.clone(),
                };
                Message::User(UserMessage { content, timestamp: c.timestamp })
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_summary_round_trips() {
        let m = create_compaction_summary_message("## Goal\nship", 1234, Some(json!({"readFiles": ["a.rs"]})));
        assert!(is_compaction_summary(&m));
        assert_eq!(compaction_summary_text(&m), Some("## Goal\nship"));
        let details = match &m {
            AgentMessage::Custom(c) => c.details.clone().unwrap(),
            _ => unreachable!(),
        };
        assert_eq!(details["tokensBefore"], 1234);
        assert_eq!(details["readFiles"][0], "a.rs");
        let llm = convert_to_llm(&[m]);
        assert_eq!(llm.len(), 1);
        let text = llm[0].as_user().unwrap().content.text();
        assert!(text.starts_with(COMPACTION_SUMMARY_PREFIX));
        assert!(text.ends_with(COMPACTION_SUMMARY_SUFFIX));
        assert!(text.contains("## Goal\nship"));
    }

    #[test]
    fn convert_passes_llm_messages_through() {
        let msgs = vec![
            AgentMessage::user_text("hi"),
            create_custom_message("note", UserMessageContent::Text("x".into()), false, None),
        ];
        let llm = convert_to_llm(&msgs);
        assert_eq!(llm.len(), 2);
        assert_eq!(llm[0].role(), "user");
        assert_eq!(llm[1].role(), "user");
        assert_eq!(llm[1].as_user().unwrap().content.text(), "x");
    }
}
