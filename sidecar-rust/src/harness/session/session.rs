//! Port of pi `harness/session/session.ts` — `StorageBackedSession` and
//! `Branch`.
//!
//! A session is a read view over [`Storage`] plus an exclusive mutation
//! line: every write path funnels through [`Session::mutate`], which
//! serializes read-modify-write jobs and grants exactly one commit per
//! job (pi's `SessionMutation` capability, collapsed into a closure-scoped
//! borrow — the begin/end capability form returns with the M4 runtime if
//! a lane planner needs to hold one across awaits).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value as Json;

use crate::harness::agent_types::AgentMessage;
use crate::harness::types::{Message as LlmMessage, StopReason};

use super::commit::{insert_entry, NewEntry, UsageRowNoSeq, Write};
use super::mutation_line::MutationLine;
use super::types::{
    BranchScan, Entry, EntryBody, EntryScan, IdGenerator, SessionError, SessionMetadata, SessionResult, SessionStats,
    Storage, StorageBranchScan, UuidV7Generator,
};
use super::values::{
    append_list, branch_tip, delete_list, delete_value, entry_label, session_name, set_value, Addr, ListReadOptions,
    StoredValue,
};

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct SessionInner {
    metadata: SessionMetadata,
    storage: Arc<dyn Storage>,
    mutation_line: Arc<MutationLine>,
    id_generator: Box<dyn IdGenerator>,
    open: AtomicBool,
}

pub struct Session {
    inner: Arc<SessionInner>,
}

impl Clone for Session {
    fn clone(&self) -> Self {
        Session { inner: self.inner.clone() }
    }
}

/// Read + single-commit capability handed to a `mutate` callback.
pub struct SessionMutator<'a> {
    storage: &'a dyn Storage,
    committed: bool,
}

impl<'a> SessionMutator<'a> {
    pub fn get_entries(&self, ids: &[String]) -> SessionResult<Vec<Entry>> {
        let map = self.storage.get_entries(ids)?;
        Ok(ids.iter().filter_map(|id| map.get(id).cloned()).collect())
    }

    pub fn has_entry(&self, id: &str) -> SessionResult<bool> {
        Ok(self.storage.get_entries(std::slice::from_ref(&id.to_string()))?.contains_key(id))
    }

    pub fn get_value(&self, address: &Addr) -> SessionResult<Option<StoredValue>> {
        self.storage.get_value(address)
    }

    pub fn commit(&mut self, writes: Vec<Write>) -> SessionResult<super::types::CommitResult> {
        if self.committed {
            return Err(SessionError::Other("SessionMutator commit already attempted".into()));
        }
        for write in &writes {
            if let Write::Entry(NewEntry { body: EntryBody::Message { message, .. }, .. }) = write {
                if is_pending_assistant(message) {
                    return Err(SessionError::PendingAssistantMessage);
                }
            }
        }
        self.committed = true;
        self.storage.commit(writes)
    }
}

fn is_pending_assistant(message: &AgentMessage) -> bool {
    matches!(message, AgentMessage::Llm(LlmMessage::Assistant(am)) if am.stop_reason == StopReason::Pending)
}

impl Session {
    pub(crate) fn new(metadata: SessionMetadata, storage: Arc<dyn Storage>) -> Self {
        Session {
            inner: Arc::new(SessionInner {
                metadata,
                storage,
                mutation_line: MutationLine::shared(),
                id_generator: Box::new(UuidV7Generator),
                open: AtomicBool::new(true),
            }),
        }
    }

    pub fn metadata(&self) -> &SessionMetadata {
        &self.inner.metadata
    }

    pub fn next_id(&self) -> String {
        self.inner.id_generator.next()
    }

    fn assert_open(&self) -> SessionResult<()> {
        if self.inner.open.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(SessionError::Closed)
        }
    }

    /// Run one exclusive read-modify-write job. Jobs queue in submission
    /// order; each gets a mutator allowing exactly one commit.
    pub async fn mutate<T, F>(&self, job: F) -> SessionResult<T>
    where
        F: FnOnce(&mut SessionMutator<'_>) -> SessionResult<T>,
    {
        self.assert_open()?;
        let storage = self.inner.storage.as_ref();
        let outcome = self.inner
            .mutation_line
            .run(move || async move {
                let mut mutator = SessionMutator { storage, committed: false };
                job(&mut mutator)
            })
            .await
            .map_err(|_| SessionError::Closed)?;
        outcome
    }

    // -- reads (sync: storage is sync) --

    pub fn get_entries(&self, ids: &[String]) -> SessionResult<Vec<Entry>> {
        self.assert_open()?;
        let map = self.inner.storage.get_entries(ids)?;
        Ok(ids.iter().filter_map(|id| map.get(id).cloned()).collect())
    }

    pub fn get_entry(&self, id: &str) -> SessionResult<Option<Entry>> {
        self.assert_open()?;
        Ok(self.inner.storage.get_entries(std::slice::from_ref(&id.to_string()))?.remove(id))
    }

    pub fn get_value_raw(&self, address: &Addr) -> SessionResult<Option<StoredValue>> {
        self.assert_open()?;
        self.inner.storage.get_value(address)
    }

    pub fn get_value<T: serde::de::DeserializeOwned>(&self, address: &Addr) -> SessionResult<Option<(T, u64)>> {
        let stored = self.get_value_raw(address)?;
        match stored {
            None => Ok(None),
            Some(s) => {
                let parsed = serde_json::from_value(s.value.clone()).map_err(|e| {
                    SessionError::Storage(format!("value at {}:{} failed to decode: {e}", s.address.namespace, s.address.key))
                })?;
                Ok(Some((parsed, s.seq)))
            }
        }
    }

    pub fn scan_values(&self, prefix: &Addr) -> SessionResult<Vec<StoredValue>> {
        self.assert_open()?;
        self.inner.storage.scan_values(prefix)
    }

    pub fn read_list(&self, address: &Addr, options: ListReadOptions) -> SessionResult<Vec<super::values::ListElement>> {
        self.assert_open()?;
        self.inner.storage.read_list(address, options)
    }

    pub fn scan_branch(&self, query: &StorageBranchScan) -> SessionResult<Vec<Entry>> {
        self.assert_open()?;
        self.inner.storage.scan_branch(query)
    }

    pub fn scan_entries(&self, query: &EntryScan) -> SessionResult<Vec<Entry>> {
        self.assert_open()?;
        self.inner.storage.scan_entries(query)
    }

    pub fn get_stats(&self) -> SessionResult<SessionStats> {
        self.assert_open()?;
        self.inner.storage.get_stats()
    }

    pub fn get_name(&self) -> SessionResult<Option<String>> {
        Ok(self.get_value_raw(&session_name())?.and_then(|s| s.value.as_str().map(String::from)))
    }

    pub fn get_label(&self, target_id: &str) -> SessionResult<Option<String>> {
        Ok(self.get_value_raw(&entry_label(target_id))?.and_then(|s| s.value.as_str().map(String::from)))
    }

    // -- branches --

    pub fn get_branch_tip(&self, name: &str) -> SessionResult<Option<String>> {
        match self.get_value_raw(&branch_tip(name))? {
            Some(stored) => Ok(stored.value.as_str().map(String::from)),
            None => Err(SessionError::Invariant(format!("Unknown branch: {name}"))),
        }
    }

    pub fn branch(&self, name: &str) -> SessionResult<Option<Branch>> {
        self.assert_valid_branch_name(name)?;
        if self.get_value_raw(&branch_tip(name))?.is_none() {
            return Ok(None);
        }
        Ok(Some(Branch { session: self.clone(), name: name.to_string() })
        )
    }

    pub async fn create_branch(&self, name: &str, at: Option<String>) -> SessionResult<Branch> {
        self.assert_open()?;
        self.assert_valid_branch_name(name)?;
        let branch_name = name.to_string();
        self.mutate(move |mutator| {
            if mutator.get_value(&branch_tip(&branch_name))?.is_some() {
                return Err(SessionError::BranchExists(branch_name.clone()));
            }
            if let Some(at) = &at {
                if !mutator.has_entry(at)? {
                    return Err(SessionError::UnknownTarget(at.clone()));
                }
            }
            let at_value = at.clone().map(Json::String).unwrap_or(Json::Null);
            mutator.commit(vec![Write::Value(set_value(&branch_tip(&branch_name), at_value))])?;
            Ok(())
        })
        .await?;
        Ok(Branch { session: self.clone(), name: name.to_string() })
    }

    /// Append a message (or custom entry) to a branch as one mutation:
    /// entry + tip move, atomically.
    pub async fn append_to_branch(&self, name: &str, body: EntryBody) -> SessionResult<String> {
        self.assert_open()?;
        if let EntryBody::Message { message, .. } = &body {
            if is_pending_assistant(message) {
                return Err(SessionError::PendingAssistantMessage);
            }
        }
        let id = self.next_id();
        let id_for_closure = id.clone();
        let branch_name = name.to_string();
        self.mutate(move |mutator| {
            let tip = mutator
                .get_value(&branch_tip(&branch_name))?
                .ok_or_else(|| SessionError::Invariant(format!("Unknown branch: {branch_name}")))?;
            let parent_id = tip.value.as_str().map(String::from);
            mutator.commit(vec![
                insert_entry(NewEntry { id: id_for_closure.clone(), parent_id, body }),
                Write::Value(set_value(&branch_tip(&branch_name), Json::String(id_for_closure.clone()))),
            ])?;
            Ok(())
        })
        .await?;
        Ok(id)
    }

    // -- value/list writers --

    pub async fn set_value(&self, address: &Addr, next: Json) -> SessionResult<()> {
        let addr = address.clone();
        self.mutate(move |mutator| mutator.commit(vec![Write::Value(set_value(&addr, next))]).map(|_| ())).await
    }

    pub async fn delete_value(&self, address: &Addr) -> SessionResult<()> {
        let addr = address.clone();
        self.mutate(move |mutator| mutator.commit(vec![Write::Value(delete_value(&addr))]).map(|_| ())).await
    }

    pub async fn append_list(&self, address: &Addr, element: Json) -> SessionResult<()> {
        let addr = address.clone();
        self.mutate(move |mutator| mutator.commit(vec![Write::List(append_list(&addr, element))]).map(|_| ()))
            .await
    }

    pub async fn delete_list(&self, address: &Addr) -> SessionResult<()> {
        let addr = address.clone();
        self.mutate(move |mutator| mutator.commit(vec![Write::List(delete_list(&addr))]).map(|_| ())).await
    }

    pub async fn set_name(&self, name: Option<String>) -> SessionResult<()> {
        match name {
            Some(n) => self.set_value(&session_name(), Json::String(n)).await,
            None => self.delete_value(&session_name()).await,
        }
    }

    pub async fn set_label(&self, target_id: &str, label: Option<String>) -> SessionResult<()> {
        let addr = entry_label(target_id);
        match label {
            Some(l) => self.set_value(&addr, Json::String(l)).await,
            None => self.delete_value(&addr).await,
        }
    }

    /// Record one usage ledger row (pi `recordUsage`).
    pub async fn record_usage_row(&self, row: UsageRowNoSeq) -> SessionResult<()> {
        self.mutate(move |mutator| mutator.commit(vec![Write::Usage(row)]).map(|_| ())).await
    }

    pub async fn close(&self) -> SessionResult<()> {
        if self.inner.open.swap(false, Ordering::SeqCst) {
            self.inner.mutation_line.seal("session closed".into()).await;
            self.inner.storage.close()?;
        }
        Ok(())
    }

    fn assert_valid_branch_name(&self, name: &str) -> SessionResult<()> {
        if name.is_empty() {
            return Err(SessionError::InvalidBranch { branch: name.into(), reason: "branch name must not be empty".into() });
        }
        if name.contains('\u{0}') {
            return Err(SessionError::InvalidBranch {
                branch: name.into(),
                reason: "branch name must not contain \\u0000".into(),
            });
        }
        Ok(())
    }
}

/// A named movable tip over the session's shared entry tree.
pub struct Branch {
    session: Session,
    pub name: String,
}

impl Branch {
    pub async fn tip_id(&self) -> SessionResult<Option<String>> {
        self.session.get_branch_tip(&self.name)
    }

    pub fn find_entries(&self, query: BranchScan) -> SessionResult<Vec<Entry>> {
        let start = self.session.get_branch_tip(&self.name)?;
        let Some(start) = start else {
            return Ok(Vec::new());
        };
        self.session.scan_branch(&StorageBranchScan { start, query })
    }

    pub fn find_entry(&self, mut query: BranchScan) -> SessionResult<Option<Entry>> {
        query.limit = Some(1);
        Ok(self.find_entries(query)?.into_iter().next())
    }

    pub async fn append_message(&self, message: AgentMessage) -> SessionResult<String> {
        self.session
            .append_to_branch(&self.name, EntryBody::Message { message, terminate: None })
            .await
    }

    pub async fn append_custom_entry(&self, custom_type: &str, data: Option<Json>) -> SessionResult<String> {
        self.session
            .append_to_branch(
                &self.name,
                EntryBody::Custom { custom_type: custom_type.to_string(), data },
            )
            .await
    }
}
