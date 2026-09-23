//! Port of pi `harness/session/` — the durable session model (M3 of the
//! parity plan; see `../SPEC.md` §session).
//!
//! Three stores, one invariant: every payload is in an entry, a bound
//! value/list, or the usage ledger — there is no third place. Entries form
//! a write-once tree; branches are named movable tips over that tree;
//! every mutation is an atomic multi-write commit with monotonic seqs.
//!
//! Deviations from pi, all deliberate: `Context` threading dropped
//! (single-process sidecar), `Storage` synchronous (serialization happens
//! on the mutation line), phantom-typed values replaced by untyped
//! addresses with typed reads at the session boundary.

pub mod commit;
pub mod conformance;
pub mod fork_policy;
#[allow(clippy::type_complexity)]
pub mod memory;
pub mod mutation_line;
pub mod session;
pub mod sqlite;
pub mod state;
pub mod types;
pub mod values;

// Ergonomic public surface for M3+ callers (the harness root re-exports
// the `session` module wholesale, so these read as unused until then).
#[allow(unused_imports)]
pub use memory::{MemorySessionRepo, MemoryStorage};
#[allow(unused_imports)]
pub use session::{Branch, Session, SessionMutator};
#[allow(unused_imports)]
pub use types::{
    Entry, EntryBody, ForkOptions, SessionError, SessionMetadata, SessionResult, SessionStats, Storage, STORAGE_VERSION,
};

#[cfg(test)]
mod tests {
    use super::conformance::{assert_fork_invariants, build_fork_source, run_storage_conformance};
    use super::memory::MemoryStorage;
    use super::types::{BranchScan, ForkOptions, Storage, StorageBranchScan};
    use super::values::branch_tip;

    #[test]
    fn memory_backend_passes_conformance() {
        run_storage_conformance(&|| Ok(Box::new(MemoryStorage::new()) as Box<dyn super::types::Storage>)).unwrap();
    }

    #[test]
    fn memory_branch_fork_invariants() {
        let source = MemoryStorage::new();
        build_fork_source(&source).unwrap();
        let dest = source
            .fork(&ForkOptions::Branch { branch: "main".into(), entry_id: Some("b".into()), before: false, id: None })
            .unwrap();
        assert_fork_invariants(&dest).unwrap();

        // The source is untouched by the fork.
        let tip = source.get_value(&branch_tip("main")).unwrap().unwrap();
        assert_eq!(tip.value, serde_json::json!("c"));
        let path = source
            .scan_branch(&StorageBranchScan { start: "c".into(), query: BranchScan::default() })
            .unwrap();
        assert_eq!(path.len(), 3);
    }

    #[tokio::test]
    async fn session_append_and_branch_walk() {
        let repo = super::MemorySessionRepo::new();
        let session = repo.create(super::types::SessionCreateOptions::default()).unwrap();
        session.create_branch("main", None).await.unwrap();
        let branch = session.branch("main").unwrap().unwrap();
        branch.append_message(crate::harness::agent_types::AgentMessage::Llm(
            crate::harness::types::Message::user_text("hello"),
        ))
        .await
        .unwrap();
        let entries = branch.find_entries(BranchScan::default()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].as_message().unwrap().role(), "user");
        let stats = session.get_stats().unwrap();
        assert_eq!(stats.message_count, 1);

        // Pending assistant messages are a session-layer invariant: a
        // half-streamed assistant message must never enter the tree.
        let pending = crate::harness::types::AssistantMessage {
            content: vec![],
            api: crate::harness::types::Api::OpenAICompletions,
            provider: "p".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            usage: Default::default(),
            stop_reason: crate::harness::types::StopReason::Pending,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: 0,
        };
        let err = session
            .mutate(|mutator| {
                mutator.commit(vec![super::commit::Write::Entry(super::commit::NewEntry {
                    id: "pending".into(),
                    parent_id: None,
                    body: super::types::EntryBody::Message {
                        message: crate::harness::agent_types::AgentMessage::Llm(
                            crate::harness::types::Message::Assistant(pending),
                        ),
                        terminate: None,
                    },
                })])
                .map(|_| ())
            })
            .await
            .unwrap_err();
        assert!(matches!(err, super::types::SessionError::PendingAssistantMessage));
    }
}
