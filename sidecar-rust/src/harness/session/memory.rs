//! Port of pi `harness/session/memory.ts` — in-memory `Storage` and
//! `SessionRepo`. The reference backend; the conformance suite in
//! `conformance.rs` runs against it (and every other backend).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::commit::Write;
use super::state::InMemoryStorageState;
use super::types::{
    CommitResult, Entry, EntryScan, EntryStructure, ForkOptions, IdGenerator, SessionCreateOptions, SessionError,
    SessionMetadata, SessionResult, SessionStats, Storage, StorageBranchScan, UsageRow, UsageScan, UuidV7Generator,
};
use super::values::{Addr, ListElement, ListReadOptions, StoredValue};

/// In-memory storage: `InMemoryStorageState` behind a mutex. Forks read a
/// consistent snapshot under the same lock.
pub struct MemoryStorage {
    state: Mutex<InMemoryStorageState>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self::with_clock(Box::new(super::session::now_ms))
    }

    pub fn with_clock(now: Box<dyn Fn() -> u64 + Send + Sync>) -> Self {
        MemoryStorage { state: Mutex::new(InMemoryStorageState::new()), now }
    }

    /// Construct destination storage at a consistent boundary between
    /// source commits.
    pub fn fork(&self, options: &ForkOptions) -> SessionResult<MemoryStorage> {
        let forked = self.state.lock().unwrap().create_fork(options)?;
        Ok(MemoryStorage {
            state: Mutex::new(forked),
            now: Box::new(super::session::now_ms),
        })
    }
}

impl Default for MemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl Storage for MemoryStorage {
    fn commit(&self, writes: Vec<Write>) -> SessionResult<CommitResult> {
        let mut state = self.state.lock().unwrap();
        let timestamp = (self.now)();
        let prepared = state.prepare_commit(writes, timestamp)?;
        let stats = state.apply_validated(prepared.writes);
        Ok(CommitResult { first_seq: prepared.first_seq, seqs: prepared.seqs, timestamp, stats })
    }

    fn get_entries(&self, ids: &[String]) -> SessionResult<HashMap<String, Entry>> {
        Ok(self.state.lock().unwrap().get_entries(ids))
    }

    fn get_value(&self, address: &Addr) -> SessionResult<Option<StoredValue>> {
        Ok(self.state.lock().unwrap().get_value(address))
    }

    fn scan_values(&self, prefix: &Addr) -> SessionResult<Vec<StoredValue>> {
        Ok(self.state.lock().unwrap().scan_values(prefix))
    }

    fn read_list(&self, address: &Addr, options: ListReadOptions) -> SessionResult<Vec<ListElement>> {
        Ok(self.state.lock().unwrap().read_list(address, options))
    }

    fn scan_branch(&self, query: &StorageBranchScan) -> SessionResult<Vec<Entry>> {
        self.state.lock().unwrap().scan_branch(query)
    }

    fn scan_branch_structure(&self, query: &StorageBranchScan) -> SessionResult<Vec<EntryStructure>> {
        self.state.lock().unwrap().scan_branch_structure(query)
    }

    fn scan_entries(&self, query: &EntryScan) -> SessionResult<Vec<Entry>> {
        Ok(self.state.lock().unwrap().scan_entries(query))
    }

    fn scan_usage(&self, query: &UsageScan) -> SessionResult<Vec<UsageRow>> {
        Ok(self.state.lock().unwrap().scan_usage(query))
    }

    fn get_stats(&self) -> SessionResult<SessionStats> {
        Ok(self.state.lock().unwrap().get_stats())
    }

    fn close(&self) -> SessionResult<()> {
        Ok(())
    }
}

// Re-exported for callers reasoning about fork plans.
struct MemorySessionRecord {
    metadata: SessionMetadata,
    storage: Arc<MemoryStorage>,
    open: bool,
}

pub struct MemorySessionRepo {
    sessions: Mutex<HashMap<String, MemorySessionRecord>>,
    id_generator: Box<dyn IdGenerator>,
}

impl MemorySessionRepo {
    pub fn new() -> Self {
        MemorySessionRepo { sessions: Mutex::new(HashMap::new()), id_generator: Box::new(UuidV7Generator) }
    }

    pub fn create(&self, options: SessionCreateOptions) -> SessionResult<super::session::Session> {
        let created_at = super::session::now_ms();
        let id = options.id.unwrap_or_else(|| self.id_generator.next());
        let metadata = SessionMetadata {
            id: id.clone(),
            created_at,
            storage_version: super::types::STORAGE_VERSION,
            cwd: None,
            parent_session_id: options.parent_session_id,
        };
        let storage = Arc::new(MemoryStorage::new());
        let session = super::session::Session::new(metadata.clone(), storage.clone());
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(&id) {
            return Err(SessionError::Other(format!("Session already exists: {id}")));
        }
        sessions.insert(id, MemorySessionRecord { metadata, storage, open: true });
        Ok(session)
    }

    pub fn open(&self, id: &str) -> SessionResult<super::session::Session> {
        let mut sessions = self.sessions.lock().unwrap();
        let record = sessions
            .get_mut(id)
            .ok_or_else(|| SessionError::Other(format!("Unknown session: {id}")))?;
        if record.open {
            return Err(SessionError::Other(format!("Session is already open: {id}")));
        }
        record.open = true;
        Ok(super::session::Session::new(record.metadata.clone(), record.storage.clone()))
    }

    pub fn list(&self) -> SessionResult<Vec<SessionMetadata>> {
        Ok(self.sessions.lock().unwrap().values().map(|r| r.metadata.clone()).collect())
    }

    pub fn delete(&self, id: &str) -> SessionResult<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let record = sessions
            .get_mut(id)
            .ok_or_else(|| SessionError::Other(format!("Unknown session: {id}")))?;
        if record.open {
            return Err(SessionError::Other(format!("Session is open: {id}")));
        }
        sessions.remove(id);
        Ok(())
    }

    pub fn fork(&self, source_id: &str, options: &ForkOptions) -> SessionResult<super::session::Session> {
        let source_storage = {
            let sessions = self.sessions.lock().unwrap();
            let record = sessions
                .get(source_id)
                .ok_or_else(|| SessionError::Other(format!("Unknown session: {source_id}")))?;
            record.storage.clone()
        };
        let created_at = super::session::now_ms();
        let fork_id = match &options {
            ForkOptions::Tree { id } => id.clone(),
            ForkOptions::Branch { id, .. } => id.clone(),
        }
        .unwrap_or_else(|| self.id_generator.next());
        let storage = Arc::new(source_storage.fork(options)?);
        let metadata = SessionMetadata {
            id: fork_id.clone(),
            created_at,
            storage_version: super::types::STORAGE_VERSION,
            cwd: None,
            parent_session_id: Some(source_id.to_string()),
        };
        let session = super::session::Session::new(metadata.clone(), storage.clone());
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(&fork_id) {
            return Err(SessionError::Other(format!("Session already exists: {fork_id}")));
        }
        sessions.insert(fork_id, MemorySessionRecord { metadata, storage, open: true });
        Ok(session)
    }
}
