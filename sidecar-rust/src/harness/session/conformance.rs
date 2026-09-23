//! Backend conformance suite (port of the *shape* of pi's
//! `session/testing/conformance`). Every `Storage` backend must pass the
//! same invariants; call [`run_storage_conformance`] from each backend's
//! tests with a fresh-storage factory.

use crate::harness::agent_types::AgentMessage;
use crate::harness::types::{Message as LlmMessage, Usage};

use super::commit::{insert_entry, insert_usage, NewEntry, UsageRowNoSeq, Write};
use super::types::{BranchScan, EntryBody, EntryScan, LaneConfiguration, LaneState, Storage, StorageBranchScan, UsageScan};
use super::values::{append_list, branch_tip, lane_config, lane_state, list, session_name, set_value, value, ListReadOptions};

pub trait StorageFactory {
    fn create_storage(&self) -> super::types::SessionResult<Box<dyn Storage>>;
}

impl<F> StorageFactory for F
where
    F: Fn() -> super::types::SessionResult<Box<dyn Storage>>,
{
    fn create_storage(&self) -> super::types::SessionResult<Box<dyn Storage>> {
        self()
    }
}

fn user_msg(text: &str) -> AgentMessage {
    AgentMessage::Llm(LlmMessage::user_text(text))
}

fn user_entry(id: &str, parent: Option<String>, text: &str) -> Write {
    insert_entry(NewEntry { id: id.into(), parent_id: parent, body: EntryBody::Message { message: user_msg(text), terminate: None } })
}

pub fn run_storage_conformance(factory: &dyn StorageFactory) -> super::types::SessionResult<()> {
    // -- tree append + seq assignment --
    let storage = factory.create_storage()?;
    let r1 = storage.commit(vec![user_entry("a", None, "one")])?;
    assert_eq!(r1.seqs, vec![1]);
    let r2 = storage.commit(vec![user_entry("b", Some("a".into()), "two"), user_entry("c", Some("b".into()), "three")])?;
    assert_eq!(r2.seqs, vec![2, 3]);
    assert_eq!(r2.stats.message_count, 3);

    // -- duplicate id and missing parent are rejected --
    let err = storage.commit(vec![user_entry("a", None, "dup")]).unwrap_err();
    assert!(err.to_string().contains("Duplicate"), "got: {err}");
    let err = storage.commit(vec![user_entry("d", Some("ghost".into()), "x")]).unwrap_err();
    assert!(err.to_string().contains("Missing parent"), "got: {err}");

    // -- getEntries returns only what exists --
    let got = storage.get_entries(&["a".into(), "zzz".into()])?;
    assert!(got.contains_key("a") && !got.contains_key("zzz"));

    // -- branch scans (newest-first by default, like pi) --
    let all = storage.scan_branch(&StorageBranchScan { start: "c".into(), query: BranchScan::default() })?;
    assert_eq!(all.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["c", "b", "a"]);
    let oldest = storage.scan_branch(&StorageBranchScan {
        start: "c".into(),
        query: BranchScan { oldest_first: true, ..Default::default() },
    })?;
    assert_eq!(oldest.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    let structures = storage.scan_branch_structure(&StorageBranchScan { start: "b".into(), query: BranchScan::default() })?;
    assert_eq!(structures.len(), 2);
    assert_eq!(structures[0].entry_type, "message");
    let by_type = storage.scan_branch(&StorageBranchScan {
        start: "c".into(),
        query: BranchScan { entry_type: Some("message"), limit: Some(2), ..Default::default() },
    })?;
    assert_eq!(by_type.len(), 2);

    // -- entry scans (desc default semantics exercised via explicit desc) --
    let asc = storage.scan_entries(&EntryScan::default())?;
    assert_eq!(asc.len(), 3);
    let desc = storage.scan_entries(&EntryScan { desc: true, ..Default::default() })?;
    assert_eq!(desc[0].id, "c");

    // -- values + lists --
    let greeting = value("app", "greeting")?;
    storage.commit(vec![Write::Value(set_value(&greeting, serde_json::json!("hello")))])?;
    let stored = storage.get_value(&greeting)?.expect("value present");
    assert_eq!(stored.value, serde_json::json!("hello"));
    let prefix = value("app", "")?;
    let scanned = storage.scan_values(&prefix)?;
    assert_eq!(scanned.len(), 1);
    // Prefix must not match across namespaces.
    let other_ns = value("other", "greeting")?;
    assert!(storage.get_value(&other_ns)?.is_none());

    let frames = list("app", "frames")?;
    for i in 0..3 {
        storage.commit(vec![Write::List(append_list(&frames, serde_json::json!(i)))])?;
    }
    let elements = storage.read_list(&frames, ListReadOptions::default())?;
    assert_eq!(elements.len(), 3);
    assert_eq!(elements[0].value, serde_json::json!(0));
    let after = storage.read_list(&frames, ListReadOptions { cursor: Some(elements[1].seq), ..Default::default() })?;
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].value, serde_json::json!(2));

    // -- usage ledger + stats --
    let mut usage = Usage::default();
    usage.input = 10;
    usage.output = 5;
    storage.commit(vec![insert_usage(UsageRowNoSeq {
        id: "u1".into(),
        usage: usage.clone(),
        entry_id: Some("a".into()),
        adjustment: false,
        details: None,
    })])?;
    let stats = storage.get_stats()?;
    assert_eq!(stats.usage.input, 10);
    let rows = storage.scan_usage(&UsageScan::default())?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry_id.as_deref(), Some("a"));

    storage.close()?;
    Ok(())
}

/// Invariant checks for a forked destination storage (used by backends that
/// forked a source built by [`build_fork_source`]).
pub fn assert_fork_invariants(dest: &dyn Storage) -> super::types::SessionResult<()> {
    // Ancestry: a, b only; c dropped.
    let tip = dest.get_value(&branch_tip("main"))?.expect("branch tip");
    assert_eq!(tip.value, serde_json::json!("b"));
    let path = dest.scan_branch(&StorageBranchScan { start: "b".into(), query: BranchScan::default() })?;
    assert_eq!(path.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
    let c = dest.get_entries(&["c".into()])?;
    assert!(!c.contains_key("c"));

    // Lane config survives; lane state reset; usage starts at zero.
    let config = dest.get_value(&lane_config("main"))?.expect("lane config");
    assert_eq!(config.value["model_id"], "m");
    let state: LaneState = serde_json::from_value(dest.get_value(&lane_state("main"))?.expect("lane state").value).unwrap();
    assert_eq!(state.current_operation_id, None);
    assert!(state.inbox.is_empty());
    let stats = dest.get_stats()?;
    assert_eq!(stats.usage.input, 0);

    // Session name survives (product-level metadata).
    assert_eq!(dest.get_value(&session_name())?.unwrap().value, serde_json::json!("source-name"));
    Ok(())
}

/// Build the standard fork source on any storage: a -> b -> c on branch
/// "main" with lane config, busy lane state, a session name, and usage.
pub fn build_fork_source(storage: &dyn Storage) -> super::types::SessionResult<()> {
    let config = LaneConfiguration {
        provider: "p".into(),
        model_id: "m".into(),
        thinking_level: crate::harness::types::ThinkingLevel::Off,
        active_tool_names: vec!["read".into()],
    };
    let mut busy_state = LaneState::default();
    busy_state.current_operation_id = Some("op-1".into());
    let mut usage = Usage::default();
    usage.input = 42;
    storage.commit(vec![
        user_entry("a", None, "one"),
        Write::Value(set_value(&branch_tip("main"), serde_json::json!("a"))),
    ])?;
    storage.commit(vec![
        user_entry("b", Some("a".into()), "two"),
        Write::Value(set_value(&branch_tip("main"), serde_json::json!("b"))),
    ])?;
    storage.commit(vec![
        user_entry("c", Some("b".into()), "three"),
        Write::Value(set_value(&branch_tip("main"), serde_json::json!("c"))),
    ])?;
    storage.commit(vec![
        Write::Value(set_value(&lane_config("main"), serde_json::to_value(&config).unwrap())),
        Write::Value(set_value(&lane_state("main"), serde_json::to_value(&busy_state).unwrap())),
        Write::Value(set_value(&session_name(), serde_json::json!("source-name"))),
        insert_usage(UsageRowNoSeq { id: "u1".into(), usage, entry_id: None, adjustment: false, details: None }),
    ])?;
    Ok(())
}
