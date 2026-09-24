//! Port of pi `harness/session/context.ts` — rebuilding the provider-facing
//! message list from a branch path of entries.
//!
//! The newest compaction entry on the path replaces everything before it:
//! its summary message plus the retained tail become the context head.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::harness::agent_types::AgentMessage;
use crate::harness::messages::{create_branch_summary_message, create_compaction_summary_message};
use crate::harness::types::StopReason;

use super::types::{Entry, EntryBody, SessionResult};

/// Maps one custom entry onto context messages (pi `EntryProjector`).
/// Custom entries without a registered projector contribute nothing.
pub type EntryProjector = Arc<dyn Fn(&Entry) -> SessionResult<Vec<AgentMessage>> + Send + Sync>;
pub type EntryProjectors = BTreeMap<String, EntryProjector>;

/// Keep only the newest compaction plus everything after it.
pub fn build_context_entries(path_entries: &[Entry]) -> Vec<Entry> {
    let compaction_index = path_entries
        .iter()
        .rposition(|entry| matches!(entry.body, EntryBody::Compaction { .. }));
    match compaction_index {
        None => path_entries.to_vec(),
        Some(index) => {
            let mut entries = Vec::with_capacity(path_entries.len() - index);
            entries.push(path_entries[index].clone());
            entries.extend(path_entries[index + 1..].iter().cloned());
            entries
        }
    }
}

/// Assistant messages that never reach the provider: errored, aborted, and
/// deferred turns carry no usable content.
fn is_context_message(message: &AgentMessage) -> bool {
    match message.as_assistant() {
        None => true,
        Some(am) => !matches!(am.stop_reason, StopReason::Error | StopReason::Aborted | StopReason::Deferred),
    }
}

pub fn session_entry_to_context_messages(entry: &Entry) -> Vec<AgentMessage> {
    match &entry.body {
        EntryBody::Message { message, .. } => {
            if is_context_message(message) {
                vec![message.clone()]
            } else {
                Vec::new()
            }
        }
        EntryBody::Compaction { summary, retained_tail, tokens_before, details, .. } => {
            let mut messages =
                vec![create_compaction_summary_message(summary, *tokens_before, details.clone())];
            messages.extend(retained_tail.iter().filter(|m| is_context_message(m)).cloned());
            messages
        }
        EntryBody::BranchSummary { from_id, summary, details, .. } => {
            if summary.is_empty() {
                Vec::new()
            } else {
                vec![create_branch_summary_message(summary, from_id.as_deref(), details.clone())]
            }
        }
        EntryBody::Custom { .. } => Vec::new(),
    }
}

/// Build the context message list for one branch path (pi
/// `buildSessionContext`): compaction truncation first, then each entry's
/// contribution, with custom entries going through their projectors.
pub fn build_session_context(path_entries: &[Entry], projectors: &EntryProjectors) -> SessionResult<Vec<AgentMessage>> {
    let mut messages = Vec::new();
    for entry in build_context_entries(path_entries) {
        let custom_type = match entry.custom_type() {
            Some(t) => t.to_string(),
            None => {
                messages.extend(session_entry_to_context_messages(&entry));
                continue;
            }
        };
        if let Some(projector) = projectors.get(&custom_type) {
            messages.extend(projector(&entry)?);
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::agent_types::AgentMessage;
    use crate::harness::types::{AssistantMessage, StopReason};

    fn message_entry(id: &str, parent: Option<&str>, message: AgentMessage) -> Entry {
        Entry {
            id: id.into(),
            parent_id: parent.map(String::from),
            seq: 0,
            timestamp: 0,
            body: EntryBody::Message { message, terminate: None },
        }
    }

    fn assistant(stop_reason: StopReason) -> AgentMessage {
        AgentMessage::Llm(crate::harness::types::Message::Assistant(AssistantMessage {
            content: vec![],
            api: crate::harness::types::Api::AnthropicMessages,
            provider: "p".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            usage: Default::default(),
            stop_reason,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: 0,
        }))
    }

    #[test]
    fn drops_unusable_assistant_turns() {
        let entries = vec![
            message_entry("a", None, AgentMessage::user_text("hi")),
            message_entry("b", Some("a"), assistant(StopReason::Error)),
            message_entry("c", Some("b"), assistant(StopReason::Stop)),
            message_entry("d", Some("c"), assistant(StopReason::Aborted)),
        ];
        let messages = build_session_context(&entries, &EntryProjectors::new()).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0], AgentMessage::user_text("hi"));
        assert!(messages[1].is_assistant());
    }

    #[test]
    fn newest_compaction_replaces_history() {
        let compaction = Entry {
            id: "k2".into(),
            parent_id: Some("old".into()),
            seq: 4,
            timestamp: 0,
            body: EntryBody::Compaction {
                summary: "second".into(),
                retained_tail: vec![AgentMessage::user_text("kept")],
                tokens_before: 100,
                details: None,
                usage: None,
                from_hook: false,
            },
        };
        let entries = vec![
            Entry {
                id: "k1".into(),
                parent_id: None,
                seq: 1,
                timestamp: 0,
                body: EntryBody::Compaction {
                    summary: "first".into(),
                    retained_tail: vec![],
                    tokens_before: 50,
                    details: None,
                    usage: None,
                    from_hook: false,
                },
            },
            message_entry("old", Some("k1"), AgentMessage::user_text("stale")),
            compaction,
            message_entry("after", Some("k2"), AgentMessage::user_text("fresh")),
        ];
        let messages = build_session_context(&entries, &EntryProjectors::new()).unwrap();
        assert_eq!(messages.len(), 3);
        assert!(crate::harness::messages::is_compaction_summary(&messages[0]));
        assert_eq!(
            crate::harness::messages::compaction_summary_text(&messages[0]),
            Some("second")
        );
        assert_eq!(messages[1], AgentMessage::user_text("kept"));
        assert_eq!(messages[2], AgentMessage::user_text("fresh"));
    }

    #[test]
    fn custom_entries_need_projectors() {
        let custom = Entry {
            id: "x".into(),
            parent_id: None,
            seq: 0,
            timestamp: 0,
            body: EntryBody::Custom { custom_type: "log".into(), data: None },
        };
        assert!(build_session_context(std::slice::from_ref(&custom), &EntryProjectors::new())
            .unwrap()
            .is_empty());

        let mut projectors = EntryProjectors::new();
        projectors.insert(
            "log".into(),
            Arc::new(|entry: &Entry| Ok(vec![AgentMessage::user_text(format!("log:{}", entry.id))])),
        );
        let messages = build_session_context(std::slice::from_ref(&custom), &projectors).unwrap();
        assert_eq!(messages, vec![AgentMessage::user_text("log:x")]);
    }
}
