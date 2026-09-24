//! Port of pi `harness/runtime/transcript.ts` — entry chaining and the
//! lifecycle events one committed entry produces.
//!
//! The lane-dependent readers (`readBoundedContext`, `readBoundedEntries`)
//! live with the drive procedures that call them; everything here is pure.

use crate::harness::agent_types::AgentMessage;
use crate::harness::session::commit::{materialize_committed_entry, NewEntry};
use crate::harness::session::session::SessionMutator;
use crate::harness::session::types::{
    CommitResult, Entry, EntryBody, InboxItem, InboxItemKind, PendingEntry, SessionError, SessionResult,
};
use crate::harness::session::values::pending_entry;

use super::events::{HarnessEvent, LaneQueuedItem};

/// Link entries into a parent chain: each item's parent becomes the
/// previous item's id, starting at `parent_id`.
pub fn chain_entries(parent_id: Option<String>, items: Vec<NewEntry>) -> Vec<NewEntry> {
    let mut chained = items;
    let mut parent = parent_id;
    for entry in &mut chained {
        let next_parent = Some(entry.id.clone());
        entry.parent_id = parent;
        parent = next_parent;
    }
    chained
}

/// Events for one already-materialized entry: message entries announce
/// start+end before the entry_added observation; everything else just adds.
pub fn entry_lifecycle_events(entry: &Entry, lane: &str, run_id: Option<&str>) -> Vec<HarnessEvent> {
    if let EntryBody::Message { message, .. } = &entry.body {
        vec![
            HarnessEvent::MessageStart {
                lane: lane.into(),
                run_id: run_id.map(String::from),
                message: message.clone(),
                recovery: None,
            },
            HarnessEvent::MessageEnd {
                lane: lane.into(),
                run_id: run_id.map(String::from),
                message: message.clone(),
                entry_id: Some(entry.id.clone()),
                recovery: None,
            },
            HarnessEvent::EntryAdded { lane: lane.into(), entry: entry.clone(), recovery: None },
        ]
    } else {
        vec![HarnessEvent::EntryAdded { lane: lane.into(), entry: entry.clone(), recovery: None }]
    }
}

/// Materialize committed entries with storage-assigned seq/timestamp and
/// emit their lifecycle events. `first_write_index` maps the entries onto
/// their seq slots in the commit.
pub fn committed_entry_events(
    entries: &[NewEntry],
    commit: &CommitResult,
    lane: &str,
    run_id: Option<&str>,
    first_write_index: usize,
) -> Vec<HarnessEvent> {
    entries
        .iter()
        .enumerate()
        .flat_map(|(index, new_entry)| {
            let seq = commit.seqs[first_write_index + index];
            let entry = materialize_committed_entry(new_entry, seq, commit.timestamp);
            entry_lifecycle_events(&entry, lane, run_id)
        })
        .collect()
}

/// Load the queued payloads for an inbox snapshot (pi `readLaneQueues`):
/// every item must have its payload; non-write items must be messages.
pub fn read_lane_queues(reader: &SessionMutator<'_>, inbox: &[InboxItem]) -> SessionResult<Vec<LaneQueuedItem>> {
    inbox
        .iter()
        .map(|item| {
            let stored = reader.get_value(&pending_entry(&item.entry_id))?.ok_or_else(|| {
                SessionError::Invariant(format!("Pending {:?} entry {} is missing its payload", item.kind, item.entry_id))
            })?;
            let pending: PendingEntry = serde_json::from_value(stored.value).map_err(|e| {
                SessionError::Storage(format!("pending entry {}: {e}", item.entry_id))
            })?;
            match pending {
                PendingEntry::Message { payload } => Ok(LaneQueuedItem::Message {
                    entry_id: item.entry_id.clone(),
                    kind: item.kind,
                    message: payload,
                }),
                PendingEntry::Custom { custom_type, payload } => {
                    if item.kind != InboxItemKind::Write {
                        return Err(SessionError::Invariant(format!(
                            "Pending {:?} entry {} is not a message",
                            item.kind, item.entry_id
                        )));
                    }
                    Ok(LaneQueuedItem::Custom {
                        entry_id: item.entry_id.clone(),
                        kind: item.kind,
                        custom_type,
                        data: payload,
                    })
                }
            }
        })
        .collect()
}

/// Load the pending message payloads behind explicit entry ids.
pub fn read_pending_messages(
    reader: &SessionMutator<'_>,
    ids: &[String],
    description: &str,
) -> SessionResult<Vec<(String, AgentMessage)>> {
    ids.iter()
        .map(|entry_id| {
            let stored = reader.get_value(&pending_entry(entry_id))?.ok_or_else(|| {
                SessionError::Invariant(format!("{description} {entry_id} is missing its message payload"))
            })?;
            let pending: PendingEntry = serde_json::from_value(stored.value)
                .map_err(|e| SessionError::Storage(format!("pending entry {entry_id}: {e}")))?;
            match pending {
                PendingEntry::Message { payload } => Ok((entry_id.clone(), payload)),
                PendingEntry::Custom { .. } => Err(SessionError::Invariant(format!(
                    "{description} {entry_id} is missing its message payload"
                ))),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::session::memory::MemoryStorage;
    use crate::harness::session::session::Session;
    use crate::harness::session::values::set_value;
    use crate::harness::session::SessionMetadata;
    use std::sync::Arc;

    fn user_entry(id: &str, text: &str) -> NewEntry {
        NewEntry {
            id: id.into(),
            parent_id: None,
            body: EntryBody::Message { message: AgentMessage::user_text(text), terminate: None },
        }
    }

    #[test]
    fn chains_parents_in_order() {
        let chained = chain_entries(Some("root".into()), vec![user_entry("a", "1"), user_entry("b", "2")]);
        assert_eq!(chained[0].parent_id.as_deref(), Some("root"));
        assert_eq!(chained[1].parent_id.as_deref(), Some("a"));
    }

    #[test]
    fn message_entries_emit_three_events() {
        let entry = materialize_committed_entry(&user_entry("a", "hi"), 3, 99);
        let events = entry_lifecycle_events(&entry, "main", Some("op1"));
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].event_type(), "message_start");
        assert_eq!(events[1].event_type(), "message_end");
        assert_eq!(events[2].event_type(), "entry_added");

        let custom = Entry {
            id: "c".into(),
            parent_id: None,
            seq: 0,
            timestamp: 0,
            body: EntryBody::Custom { custom_type: "log".into(), data: None },
        };
        assert_eq!(entry_lifecycle_events(&custom, "main", None).len(), 1);
    }

    #[tokio::test]
    async fn queue_reading_enforces_payload_kinds() {
        let session = Session::new(
            SessionMetadata {
                id: "s".into(),
                created_at: 0,
                storage_version: 1,
                cwd: None,
                parent_session_id: None,
            },
            Arc::new(MemoryStorage::new()),
        );

        let steer_id = "q1".to_string();
        let write_id = "q2".to_string();
        session
            .mutate(move |mutator| {
                let steer = serde_json::to_value(PendingEntry::Message { payload: AgentMessage::user_text("steer") }).unwrap();
                let custom = serde_json::to_value(PendingEntry::Custom {
                    custom_type: "todo".into(),
                    payload: Some(serde_json::json!({"n": 1})),
                })
                .unwrap();
                mutator.commit(vec![
                    crate::harness::session::commit::Write::Value(set_value(&pending_entry(&steer_id), steer)),
                    crate::harness::session::commit::Write::Value(set_value(&pending_entry(&write_id), custom)),
                ])?;
                Ok(())
            })
            .await
            .unwrap();

        let inbox = vec![
            InboxItem { entry_id: "q1".into(), kind: InboxItemKind::Steer },
            InboxItem { entry_id: "q2".into(), kind: InboxItemKind::Write },
        ];
        let queues = session.mutate(|mutator| read_lane_queues(mutator, &inbox)).await.unwrap();
        assert_eq!(queues.len(), 2);
        assert!(matches!(&queues[0], LaneQueuedItem::Message { kind: InboxItemKind::Steer, .. }));
        assert!(matches!(&queues[1], LaneQueuedItem::Custom { custom_type, .. } if custom_type == "todo"));

        // A steer pointing at a custom payload is an invariant violation.
        let bad = vec![InboxItem { entry_id: "q2".into(), kind: InboxItemKind::Steer }];
        assert!(session.mutate(|mutator| read_lane_queues(mutator, &bad)).await.is_err());
    }
}
