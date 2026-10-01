//! Port of pi `harness/session/in-memory-storage-state.ts` — complete
//! materialized session state powering the memory backend (and reusable
//! by any backend that prefers index queries — see pi's note that
//! database backends should query durable state instead).

use std::collections::HashMap;

use super::commit::{prepare_storage_commit, validate_committed_writes, CommitValidationState, CommittedWrite, PreparedCommit, Write};
use super::fork_policy::{project_fork_current_state_write, select_branch_fork, ForkCurrentStatePlan};
use super::types::{
    Entry, EntryScan, EntryStructure, ForkOptions, SessionError, SessionResult, SessionStats, StorageBranchScan,
    UsageRow, UsageScan,
};
use super::values::{
    branch_tip, lane_config, lane_state, resolve_list_read_options, Addr, ListElement, ListReadOptions, StoredValue,
};

/// `namespace \u{0} key` — the physical collation key pi uses.
fn physical_key(namespace: &str, key: &str) -> String {
    format!("{namespace}\u{0}{key}")
}

enum MemoryForkPlan {
    Tree,
    Branch { branch: String, destination_tip: Option<String>, entry_ids: std::collections::HashSet<String> },
}

#[derive(Default)]
pub struct InMemoryStorageState {
    entries: HashMap<String, Entry>,
    entries_by_seq: Vec<Entry>,
    scalar_values: HashMap<String, StoredValue>,
    list_values: HashMap<String, (Addr, Vec<ListElement>)>,
    usage: HashMap<String, UsageRow>,
    stats: SessionStats,
    next_seq: u64,
}

impl InMemoryStorageState {
    pub fn new() -> Self {
        Self { next_seq: 1, ..Default::default() }
    }

    pub fn prepare_commit(&self, writes: Vec<Write>, timestamp: u64) -> SessionResult<PreparedCommit> {
        let prepared = prepare_storage_commit(writes, self.next_seq, timestamp);
        self.validate_committed(&prepared.writes)?;
        Ok(prepared)
    }

    fn validate_committed(&self, writes: &[CommittedWrite]) -> SessionResult<()> {
        struct View<'a>(&'a InMemoryStorageState);
        impl CommitValidationState for View<'_> {
            fn has_entry_or_usage_id(&self, id: &str) -> bool {
                self.0.entries.contains_key(id) || self.0.usage.contains_key(id)
            }
            fn has_entry_id(&self, id: &str) -> bool {
                self.0.entries.contains_key(id)
            }
        }
        validate_committed_writes(writes, self.next_seq, &View(self)).map_err(SessionError::Storage)
    }

    /// Apply writes already accepted by `validate_committed` and return the
    /// post-apply totals.
    pub fn apply_validated(&mut self, writes: Vec<CommittedWrite>) -> SessionStats {
        for write in writes {
            match &write {
                CommittedWrite::Entry { entry } => {
                    if entry.entry_type() == "message" {
                        self.stats.message_count += 1;
                    }
                    self.entries_by_seq.push(entry.clone());
                    self.entries.insert(entry.id.clone(), entry.clone());
                }
                CommittedWrite::Usage { row } => {
                    self.stats.usage = self.stats.usage.add(&row.usage);
                    self.usage.insert(row.id.clone(), row.clone());
                }
                CommittedWrite::ValueDelete { namespace, key, .. } => {
                    self.scalar_values.remove(&physical_key(namespace, key));
                }
                CommittedWrite::ListDelete { namespace, key, .. } => {
                    self.list_values.remove(&physical_key(namespace, key));
                }
                CommittedWrite::ValueSet { namespace, key, value, seq } => {
                    let addr = super::values::value(namespace, key).expect("validated address");
                    self.scalar_values.insert(
                        physical_key(namespace, key),
                        StoredValue { address: addr, value: value.clone(), seq: *seq },
                    );
                }
                CommittedWrite::ListAppend { namespace, key, value, seq } => {
                    let addr = super::values::list(namespace, key).expect("validated address");
                    let slot = self.list_values.entry(physical_key(namespace, key)).or_insert_with(|| (addr, Vec::new()));
                    slot.1.push(ListElement { seq: *seq, value: value.clone() });
                }
            }
            self.next_seq = write.seq() + 1;
        }
        self.stats.clone()
    }

    pub fn create_fork(&self, options: &ForkOptions) -> SessionResult<InMemoryStorageState> {
        let plan = self.select_fork_plan(options)?;

        let is_entry_copied = |entry_id: &str| match &plan {
            MemoryForkPlan::Tree => true,
            MemoryForkPlan::Branch { entry_ids, .. } => entry_ids.contains(entry_id),
        };

        let mut destination = InMemoryStorageState::new();
        let mut message_count = 0u64;
        for entry in &self.entries_by_seq {
            if !is_entry_copied(&entry.id) {
                continue;
            }
            if entry.entry_type() == "message" {
                message_count += 1;
            }
            destination.entries.insert(entry.id.clone(), entry.clone());
            destination.entries_by_seq.push(entry.clone());
        }
        destination.stats.message_count = message_count;

        let current_plan = match &plan {
            MemoryForkPlan::Tree => ForkCurrentStatePlan::Tree,
            MemoryForkPlan::Branch { branch, destination_tip, .. } => {
                ForkCurrentStatePlan::Branch { branch: branch.clone(), destination_tip: destination_tip.clone() }
            }
        };

        for stored in self.scalar_values.values() {
            let write = CommittedWrite::ValueSet {
                seq: stored.seq,
                namespace: stored.address.namespace.clone(),
                key: stored.address.key.clone(),
                value: stored.value.clone(),
            };
            if let Some(projected) = project_fork_current_state_write(write, &current_plan, &is_entry_copied)? {
                destination.apply_validated(vec![projected]);
            }
        }
        for (_physical, (addr, elements)) in &self.list_values {
            for element in elements {
                let write = CommittedWrite::ListAppend {
                    seq: element.seq,
                    namespace: addr.namespace.clone(),
                    key: addr.key.clone(),
                    value: element.value.clone(),
                };
                if let Some(projected) = project_fork_current_state_write(write, &current_plan, &is_entry_copied)? {
                    destination.apply_validated(vec![projected]);
                }
            }
        }
        destination.usage = HashMap::new(); // usage ledger excluded from forks
        destination.next_seq = self.next_seq;
        Ok(destination)
    }

    fn select_fork_plan(&self, options: &ForkOptions) -> SessionResult<MemoryForkPlan> {
        match options {
            ForkOptions::Tree { .. } => Ok(MemoryForkPlan::Tree),
            ForkOptions::Branch { branch, entry_id, before, .. } => {
                let mut entry_ids = std::collections::HashSet::new();
                let tip = match self.get_value(&branch_tip(branch)) {
                    Some(stored) => stored.value.as_str().map(String::from),
                    None => None,
                };
                let (destination_branch, destination_tip) = select_branch_fork(
                    branch,
                    entry_id.as_deref(),
                    *before,
                    tip,
                    &mut |entry_id| {
                        entry_ids.insert(entry_id.to_string());
                    },
                    &mut |entry_id| self.entries.get(entry_id).map(|e| e.parent_id.clone()),
                )
                .map_err(SessionError::Storage)?;
                if self.get_value(&lane_config(branch)).is_none() || self.get_value(&lane_state(branch)).is_none() {
                    return Err(SessionError::Storage(format!(
                        "Source branch {branch:?} is not a configured AgentLane"
                    )));
                }
                Ok(MemoryForkPlan::Branch { branch: destination_branch, destination_tip, entry_ids })
            }
        }
    }

    pub fn advance_next_seq(&mut self, next_seq: u64) {
        assert!(next_seq >= 1, "invalid seq high-water mark");
        self.next_seq = self.next_seq.max(next_seq);
    }

    pub fn get_entries(&self, ids: &[String]) -> HashMap<String, Entry> {
        ids.iter().filter_map(|id| self.entries.get(id).cloned().map(|e| (id.clone(), e))).collect()
    }

    pub fn get_value(&self, address: &Addr) -> Option<StoredValue> {
        self.scalar_values.get(&physical_key(&address.namespace, &address.key)).cloned()
    }

    pub fn scan_values(&self, prefix: &Addr) -> Vec<StoredValue> {
        let mut found: Vec<StoredValue> = self
            .scalar_values
            .values()
            .filter(|stored| stored.address.namespace == prefix.namespace && stored.address.key.starts_with(&prefix.key))
            .cloned()
            .collect();
        found.sort_by(|l, r| l.address.key.cmp(&r.address.key));
        found
    }

    pub fn read_list(&self, address: &Addr, options: ListReadOptions) -> Vec<ListElement> {
        let (cursor, desc, limit) = resolve_list_read_options(options);
        let elements = &self
            .list_values
            .get(&physical_key(&address.namespace, &address.key))
            .map(|(_, elements)| elements.clone())
            .unwrap_or_default();
        let mut filtered: Vec<ListElement> = elements
            .iter()
            .filter(|element| match (cursor, desc) {
                (Some(c), false) => element.seq > c,
                (Some(c), true) => element.seq < c,
                (None, _) => true,
            })
            .cloned()
            .collect();
        if desc {
            filtered.reverse();
        }
        filtered.truncate(limit);
        filtered
    }

    pub fn scan_branch(&self, query: &StorageBranchScan) -> SessionResult<Vec<Entry>> {
        let start = self
            .entries
            .get(&query.start)
            .ok_or_else(|| SessionError::Storage(format!("Unknown branch start: {}", query.start)))?;

        let mut path: Vec<Entry> = Vec::new();
        let mut current: Option<Entry> = Some(start.clone());
        while let Some(entry) = current {
            let parent = entry.parent_id.clone();
            path.push(entry);
            match parent {
                None => break,
                Some(parent_id) => {
                    current = self.entries.get(&parent_id).cloned();
                    if current.is_none() {
                        return Err(SessionError::Storage(format!("Corrupt branch: missing parent {parent_id}")));
                    }
                }
            }
        }
        // pi: the walk is start→root; only oldestFirst reverses it. Default
        // output is newest-first.
        if query.query.oldest_first {
            path.reverse();
        }

        let mut stopped: Vec<Entry> = Vec::new();
        for candidate in path {
            let hit = Some(candidate.id.as_str()) == query.query.stop_at_id.as_deref()
                || Some(candidate.entry_type()) == query.query.stop_at_type;
            stopped.push(candidate);
            if hit {
                break;
            }
        }
        let filtered: Vec<Entry> = stopped
            .into_iter()
            .filter(|c| query.query.entry_type.is_none() || Some(c.entry_type()) == query.query.entry_type)
            .filter(|c| query.query.custom_type.is_none() || c.custom_type() == query.query.custom_type.as_deref())
            .filter(|c| match (query.query.cursor, query.query.oldest_first) {
                (Some(cur), false) => c.seq > cur,
                (Some(cur), true) => c.seq < cur,
                (None, _) => true,
            })
            .collect();
        let mut limited = filtered;
        if let Some(limit) = query.query.limit {
            limited.truncate(limit);
        }
        Ok(limited)
    }

    pub fn scan_branch_structure(&self, query: &StorageBranchScan) -> SessionResult<Vec<EntryStructure>> {
        Ok(self.scan_branch(query)?.iter().map(EntryStructure::from).collect())
    }

    pub fn scan_entries(&self, query: &EntryScan) -> Vec<Entry> {
        let limit = query.limit.unwrap_or(usize::MAX);
        let mut out = Vec::new();
        let descending = query.desc;
        let mut index = if descending {
            self.entries_by_seq.len() as i64 - 1
        } else {
            0
        };
        while index >= 0 && (index as usize) < self.entries_by_seq.len() && out.len() < limit {
            let entry = &self.entries_by_seq[index as usize];
            let matches = (query.entry_type.is_none() || Some(entry.entry_type()) == query.entry_type)
                && (query.custom_type.is_none() || entry.custom_type() == query.custom_type.as_deref())
                && query.from_seq.map_or(true, |from| entry.seq >= from)
                && query.to_seq.map_or(true, |to| entry.seq <= to);
            if matches {
                out.push(entry.clone());
            }
            index += if descending { -1 } else { 1 };
        }
        out
    }

    pub fn scan_usage(&self, query: &UsageScan) -> Vec<UsageRow> {
        let mut rows: Vec<UsageRow> = self
            .usage
            .values()
            .filter(|row| query.from_seq.map_or(true, |from| row.seq >= from))
            .filter(|row| query.to_seq.map_or(true, |to| row.seq <= to))
            .cloned()
            .collect();
        rows.sort_by(|l, r| if query.desc { r.seq.cmp(&l.seq) } else { l.seq.cmp(&r.seq) });
        if let Some(limit) = query.limit {
            rows.truncate(limit);
        }
        rows
    }

    pub fn get_stats(&self) -> SessionStats {
        self.stats.clone()
    }

    pub fn get_next_seq(&self) -> u64 {
        self.next_seq
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::agent_types::AgentMessage;
    use crate::harness::types::Message as LlmMessage;
    use super::super::types::BranchScan;

    fn user_entry(id: &str, parent: Option<String>) -> Write {
        Write::Entry(super::super::commit::NewEntry {
            id: id.into(),
            parent_id: parent,
            body: super::super::types::EntryBody::Message {
                message: AgentMessage::Llm(LlmMessage::user_text("hi")),
                terminate: None,
            },
        })
    }

    #[test]
    fn commit_assigns_monotonic_seqs_and_rejects_duplicates() {
        let mut state = InMemoryStorageState::new();
        let prepared = state.prepare_commit(vec![user_entry("a", None), user_entry("b", Some("a".into()))], 1_000).unwrap();
        assert_eq!(prepared.seqs, vec![1, 2]);
        state.apply_validated(prepared.writes);

        // Duplicate id rejected.
        let err = state.prepare_commit(vec![user_entry("a", None)], 2_000).unwrap_err();
        assert!(err.to_string().contains("Duplicate entry or usage id"));

        // Missing parent rejected.
        let err = state.prepare_commit(vec![user_entry("z", Some("missing".into()))], 3_000).unwrap_err();
        assert!(err.to_string().contains("Missing parent entry"));
    }

    #[test]
    fn branch_scan_walks_ancestry_with_stops() {
        let mut state = InMemoryStorageState::new();
        let prepared = state
            .prepare_commit(vec![user_entry("a", None), user_entry("b", Some("a".into())), user_entry("c", Some("b".into()))], 1)
            .unwrap();
        state.apply_validated(prepared.writes);

        let all = state
            .scan_branch(&StorageBranchScan { start: "c".into(), query: BranchScan::default() })
            .unwrap();
        assert_eq!(all.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["c", "b", "a"]);

        let stopped = state
            .scan_branch(&StorageBranchScan {
                start: "c".into(),
                query: BranchScan { stop_at_id: Some("a".into()), ..Default::default() },
            })
            .unwrap();
        assert_eq!(stopped.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["c", "b", "a"]);

        let newest = state
            .scan_branch(&StorageBranchScan {
                start: "c".into(),
                query: BranchScan { limit: Some(1), ..Default::default() },
            })
            .unwrap();
        assert_eq!(newest.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["c"]);
    }
}
