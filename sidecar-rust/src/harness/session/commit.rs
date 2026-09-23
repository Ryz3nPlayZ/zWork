//! Port of pi `harness/session/commit.ts` — the write model and commit
//! validation.
//!
//! A commit is an atomic batch of writes; storage assigns each write one
//! monotonically increasing seq and a shared timestamp. Validation enforces
//! the write-once tree invariants *before* application: monotonic seq, no
//! duplicate entry/usage ids, and parent-exists.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use super::types::{Entry, UsageRow};

/// A write supplied to a transaction before storage assigns seq/timestamp.
#[derive(Debug, Clone)]
pub enum Write {
    Entry(NewEntry),
    Usage(UsageRowNoSeq),
    Value(ValueWrite),
    List(ListWrite),
}

/// An entry before storage assigns `seq` / `timestamp`.
#[derive(Debug, Clone)]
pub struct NewEntry {
    pub id: String,
    pub parent_id: Option<String>,
    pub body: super::types::EntryBody,
}

#[derive(Debug, Clone)]
pub struct UsageRowNoSeq {
    pub id: String,
    pub usage: crate::harness::types::Usage,
    pub entry_id: Option<String>,
    pub adjustment: bool,
    pub details: Option<Json>,
}

#[derive(Debug, Clone)]
pub enum ValueWrite {
    Set { namespace: String, key: String, value: Json },
    Delete { namespace: String, key: String },
}

#[derive(Debug, Clone)]
pub enum ListWrite {
    Append { namespace: String, key: String, value: Json },
    Delete { namespace: String, key: String },
}

pub fn insert_entry(entry: NewEntry) -> Write {
    Write::Entry(entry)
}

pub fn insert_usage(row: UsageRowNoSeq) -> Write {
    Write::Usage(row)
}

/// A write after seq/timestamp assignment, as applied to storage.
#[derive(Debug, Clone)]
pub enum CommittedWrite {
    Entry { entry: Entry },
    Usage { row: UsageRow },
    ValueSet { seq: u64, namespace: String, key: String, value: Json },
    ValueDelete { seq: u64, namespace: String, key: String },
    ListAppend { seq: u64, namespace: String, key: String, value: Json },
    ListDelete { seq: u64, namespace: String, key: String },
}

impl CommittedWrite {
    pub fn seq(&self) -> u64 {
        match self {
            CommittedWrite::Entry { entry } => entry.seq,
            CommittedWrite::Usage { row } => row.seq,
            CommittedWrite::ValueSet { seq, .. }
            | CommittedWrite::ValueDelete { seq, .. }
            | CommittedWrite::ListAppend { seq, .. }
            | CommittedWrite::ListDelete { seq, .. } => *seq,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PreparedCommit {
    pub writes: Vec<CommittedWrite>,
    pub first_seq: u64,
    pub seqs: Vec<u64>,
    pub timestamp: u64,
}

fn commit_write(write: Write, seq: u64, timestamp: u64) -> CommittedWrite {
    match write {
        Write::Entry(e) => CommittedWrite::Entry {
            entry: Entry {
                id: e.id,
                parent_id: e.parent_id,
                seq,
                timestamp,
                body: e.body,
            },
        },
        Write::Usage(r) => CommittedWrite::Usage {
            row: UsageRow {
                id: r.id,
                seq,
                usage: r.usage,
                entry_id: r.entry_id,
                adjustment: r.adjustment,
                details: r.details,
            },
        },
        Write::Value(ValueWrite::Set { namespace, key, value }) => CommittedWrite::ValueSet { seq, namespace, key, value },
        Write::Value(ValueWrite::Delete { namespace, key }) => CommittedWrite::ValueDelete { seq, namespace, key },
        Write::List(ListWrite::Append { namespace, key, value }) => CommittedWrite::ListAppend { seq, namespace, key, value },
        Write::List(ListWrite::Delete { namespace, key }) => CommittedWrite::ListDelete { seq, namespace, key },
    }
}

pub fn prepare_storage_commit(writes: Vec<Write>, first_seq: u64, timestamp: u64) -> PreparedCommit {
    let committed: Vec<CommittedWrite> = writes
        .into_iter()
        .enumerate()
        .map(|(index, write)| commit_write(write, first_seq + index as u64, timestamp))
        .collect();
    let seqs = committed.iter().map(|w| w.seq()).collect();
    PreparedCommit { writes: committed, first_seq, seqs, timestamp }
}

/// View of already-committed state needed to validate a new transaction.
pub trait CommitValidationState {
    fn has_entry_or_usage_id(&self, id: &str) -> bool;
    fn has_entry_id(&self, id: &str) -> bool;
}

pub fn validate_committed_writes(
    writes: &[CommittedWrite],
    first_seq: u64,
    state: &dyn CommitValidationState,
) -> Result<(), String> {
    let mut previous_seq = first_seq - 1;
    let mut transaction_ids = std::collections::HashSet::new();
    let mut transaction_entry_ids = std::collections::HashSet::new();
    for write in writes {
        let seq = write.seq();
        if seq <= previous_seq {
            return Err(format!("Non-monotonic storage sequence: {seq}"));
        }
        previous_seq = seq;
        let (id, parent_id, is_entry) = match write {
            CommittedWrite::Entry { entry } => (entry.id.as_str(), entry.parent_id.as_deref(), true),
            CommittedWrite::Usage { row } => (row.id.as_str(), None, false),
            _ => continue,
        };
        if state.has_entry_or_usage_id(id) || transaction_ids.contains(id) {
            return Err(format!("Duplicate entry or usage id: {id}"));
        }
        if let Some(parent) = parent_id {
            if !state.has_entry_id(parent) && !transaction_entry_ids.contains(parent) {
                return Err(format!("Missing parent entry: {parent}"));
            }
        }
        transaction_ids.insert(id.to_string());
        if is_entry {
            transaction_entry_ids.insert(id.to_string());
        }
    }
    Ok(())
}

/// Serialize/deserialize support for backends that persist committed writes
/// (e.g. a JSONL journal). One distinct tag per write shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WriteJson {
    Entry { entry: Entry },
    Usage { row: UsageRow },
    ValueSet { seq: u64, namespace: String, key: String, value: Json },
    ValueDelete { seq: u64, namespace: String, key: String },
    ListAppend { seq: u64, namespace: String, key: String, value: Json },
    ListDelete { seq: u64, namespace: String, key: String },
}

impl From<&CommittedWrite> for WriteJson {
    fn from(w: &CommittedWrite) -> Self {
        match w {
            CommittedWrite::Entry { entry } => WriteJson::Entry { entry: entry.clone() },
            CommittedWrite::Usage { row } => WriteJson::Usage { row: row.clone() },
            CommittedWrite::ValueSet { seq, namespace, key, value } => {
                WriteJson::ValueSet { seq: *seq, namespace: namespace.clone(), key: key.clone(), value: value.clone() }
            }
            CommittedWrite::ValueDelete { seq, namespace, key } => {
                WriteJson::ValueDelete { seq: *seq, namespace: namespace.clone(), key: key.clone() }
            }
            CommittedWrite::ListAppend { seq, namespace, key, value } => {
                WriteJson::ListAppend { seq: *seq, namespace: namespace.clone(), key: key.clone(), value: value.clone() }
            }
            CommittedWrite::ListDelete { seq, namespace, key } => {
                WriteJson::ListDelete { seq: *seq, namespace: namespace.clone(), key: key.clone() }
            }
        }
    }
}

impl From<WriteJson> for CommittedWrite {
    fn from(w: WriteJson) -> Self {
        match w {
            WriteJson::Entry { entry } => CommittedWrite::Entry { entry },
            WriteJson::Usage { row } => CommittedWrite::Usage { row },
            WriteJson::ValueSet { seq, namespace, key, value } => CommittedWrite::ValueSet { seq, namespace, key, value },
            WriteJson::ValueDelete { seq, namespace, key } => CommittedWrite::ValueDelete { seq, namespace, key },
            WriteJson::ListAppend { seq, namespace, key, value } => CommittedWrite::ListAppend { seq, namespace, key, value },
            WriteJson::ListDelete { seq, namespace, key } => CommittedWrite::ListDelete { seq, namespace, key },
        }
    }
}
