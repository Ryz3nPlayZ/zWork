//! SQLite `Storage` backend (M3 part 2) — native tables with indexed
//! scans, one database file per session.
//!
//! pi keeps its SQLite backend in a separate package with a runtime-injected
//! factory; zWork ships rusqlite (bundled) directly. Schema is ours (pi's
//! JSONL format is explicitly pre-stabilization upstream, so we don't
//! mirror it): entries/usage/values/lists tables plus a meta table, with
//! the seq high-water derived from the write tables inside the same
//! transaction that assigns new seqs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::harness::types::Usage;

use super::commit::{prepare_storage_commit, validate_committed_writes, CommitValidationState, CommittedWrite, Write};
use super::fork_policy::{project_fork_current_state_write, select_branch_fork, ForkCurrentStatePlan};
use super::types::{
    CommitResult, Entry, EntryBody, EntryScan, EntryStructure, ForkOptions, SessionError, SessionMetadata,
    SessionResult, SessionStats, Storage, StorageBranchScan, UsageRow, UsageScan, STORAGE_VERSION,
};
use super::values::{lane_config, lane_state, Addr, ListElement, ListReadOptions, StoredValue};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    seq INTEGER NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    custom_type TEXT,
    body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_parent ON entries(parent_id);
CREATE TABLE IF NOT EXISTS usage_rows (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    entry_id TEXT,
    adjustment INTEGER NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cache_write_1h INTEGER,
    reasoning INTEGER,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_total REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS values_tbl (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
);
CREATE TABLE IF NOT EXISTS lists_tbl (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (namespace, key, seq)
);
";

pub struct SqliteStorage {
    conn: Mutex<Connection>,
}

struct RawEntry {
    id: String,
    parent_id: Option<String>,
    seq: i64,
    timestamp: i64,
    body: String,
}

fn raw_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawEntry> {
    Ok(RawEntry {
        id: row.get("id")?,
        parent_id: row.get("parent_id")?,
        seq: row.get("seq")?,
        timestamp: row.get("timestamp")?,
        body: row.get("body")?,
    })
}

fn decode_entry(raw: RawEntry) -> SessionResult<Entry> {
    let body: EntryBody = serde_json::from_str(&raw.body).map_err(|e| SessionError::Storage(format!("entry body: {e}")))?;
    Ok(Entry {
        id: raw.id,
        parent_id: raw.parent_id,
        seq: raw.seq as u64,
        timestamp: raw.timestamp as u64,
        body,
    })
}

fn decode_usage(row: &rusqlite::Row<'_>) -> rusqlite::Result<UsageRow> {
    let usage = Usage {
        input: row.get::<_, i64>("input")? as u64,
        output: row.get::<_, i64>("output")? as u64,
        cache_read: row.get::<_, i64>("cache_read")? as u64,
        cache_write: row.get::<_, i64>("cache_write")? as u64,
        cache_write_1h: row.get::<_, Option<i64>>("cache_write_1h")?.map(|v| v as u64),
        reasoning: row.get::<_, Option<i64>>("reasoning")?.map(|v| v as u64),
        total_tokens: row.get::<_, i64>("total_tokens")? as u64,
        cost: crate::harness::types::UsageCost {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total: row.get("cost_total")?,
        },
    };
    Ok(UsageRow {
        id: row.get("id")?,
        seq: row.get::<_, i64>("seq")? as u64,
        usage,
        entry_id: row.get("entry_id")?,
        adjustment: row.get::<_, i64>("adjustment")? != 0,
        details: None,
    })
}

struct DbValidationState<'a> {
    conn: &'a Connection,
}

impl CommitValidationState for DbValidationState<'_> {
    fn has_entry_or_usage_id(&self, id: &str) -> bool {
        self.conn
            .query_row("SELECT 1 FROM entries WHERE id = ?1 UNION SELECT 1 FROM usage_rows WHERE id = ?1", params![id], |_| Ok(()))
            .optional()
            .unwrap_or(None)
            .is_some()
    }

    fn has_entry_id(&self, id: &str) -> bool {
        self.conn
            .query_row("SELECT 1 FROM entries WHERE id = ?1", params![id], |_| Ok(()))
            .optional()
            .unwrap_or(None)
            .is_some()
    }
}

fn next_seq(conn: &Connection) -> SessionResult<u64> {
    let max = conn
        .query_row(
            "SELECT MAX(s) FROM (
                SELECT MAX(seq) AS s FROM entries
                UNION ALL SELECT MAX(seq) FROM usage_rows
                UNION ALL SELECT MAX(seq) FROM values_tbl
                UNION ALL SELECT MAX(seq) FROM lists_tbl)",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|e| SessionError::Storage(e.to_string()))?;
    Ok(max.map(|m| m as u64 + 1).unwrap_or(1))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl SqliteStorage {
    pub fn open(path: &Path) -> SessionResult<Self> {
        let conn = Connection::open(path).map_err(|e| SessionError::Storage(e.to_string()))?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA case_sensitive_like = ON;")
            .map_err(|e| SessionError::Storage(e.to_string()))?;
        conn.execute_batch(SCHEMA).map_err(|e| SessionError::Storage(e.to_string()))?;
        Ok(SqliteStorage { conn: Mutex::new(conn) })
    }

    pub fn in_memory() -> SessionResult<Self> {
        let conn = Connection::open_in_memory().map_err(|e| SessionError::Storage(e.to_string()))?;
        conn.execute_batch(SCHEMA).map_err(|e| SessionError::Storage(e.to_string()))?;
        Ok(SqliteStorage { conn: Mutex::new(conn) })
    }

    fn apply_write(conn: &Connection, write: &CommittedWrite) -> SessionResult<()> {
        let err = |e: rusqlite::Error| SessionError::Storage(e.to_string());
        match write {
            CommittedWrite::Entry { entry } => {
                let body = serde_json::to_string(&entry.body).map_err(|e| SessionError::Storage(e.to_string()))?;
                conn.execute(
                    "INSERT INTO entries (id, parent_id, seq, timestamp, type, custom_type, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        entry.id,
                        entry.parent_id,
                        entry.seq as i64,
                        entry.timestamp as i64,
                        entry.entry_type(),
                        entry.custom_type(),
                        body
                    ],
                )
                .map_err(err)?;
            }
            CommittedWrite::Usage { row } => {
                conn.execute(
                    "INSERT INTO usage_rows (id, seq, entry_id, adjustment, input, output, cache_read, cache_write, cache_write_1h, reasoning, total_tokens, cost_total)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        row.id,
                        row.seq as i64,
                        row.entry_id,
                        row.adjustment as i64,
                        row.usage.input as i64,
                        row.usage.output as i64,
                        row.usage.cache_read as i64,
                        row.usage.cache_write as i64,
                        row.usage.cache_write_1h.map(|v| v as i64),
                        row.usage.reasoning.map(|v| v as i64),
                        row.usage.total_tokens as i64,
                        row.usage.cost.total
                    ],
                )
                .map_err(err)?;
            }
            CommittedWrite::ValueSet { seq, namespace, key, value } => {
                let json = serde_json::to_string(value).map_err(|e| SessionError::Storage(e.to_string()))?;
                conn.execute(
                    "INSERT INTO values_tbl (namespace, key, seq, json) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(namespace, key) DO UPDATE SET seq = excluded.seq, json = excluded.json",
                    params![namespace, key, *seq as i64, json],
                )
                .map_err(err)?;
            }
            CommittedWrite::ValueDelete { seq: _, namespace, key } => {
                conn.execute("DELETE FROM values_tbl WHERE namespace = ?1 AND key = ?2", params![namespace, key])
                    .map_err(err)?;
            }
            CommittedWrite::ListAppend { seq, namespace, key, value } => {
                let json = serde_json::to_string(value).map_err(|e| SessionError::Storage(e.to_string()))?;
                conn.execute(
                    "INSERT OR IGNORE INTO lists_tbl (namespace, key, seq, json) VALUES (?1, ?2, ?3, ?4)",
                    params![namespace, key, *seq as i64, json],
                )
                .map_err(err)?;
            }
            CommittedWrite::ListDelete { seq: _, namespace, key } => {
                conn.execute("DELETE FROM lists_tbl WHERE namespace = ?1 AND key = ?2", params![namespace, key])
                    .map_err(err)?;
            }
        }
        Ok(())
    }

    fn stats(conn: &Connection) -> SessionResult<SessionStats> {
        let err = |e: rusqlite::Error| SessionError::Storage(e.to_string());
        let message_count = conn
            .query_row("SELECT COUNT(*) FROM entries WHERE type = 'message'", [], |row| row.get::<_, i64>(0))
            .map_err(err)? as u64;
        let usage = conn
            .query_row(
                "SELECT
                    COALESCE(SUM(input), 0), COALESCE(SUM(output), 0), COALESCE(SUM(cache_read), 0),
                    COALESCE(SUM(cache_write), 0), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_total), 0.0)
                 FROM usage_rows WHERE adjustment = 0",
                [],
                |row| {
                    Ok(Usage {
                        input: row.get::<_, i64>(0)? as u64,
                        output: row.get::<_, i64>(1)? as u64,
                        cache_read: row.get::<_, i64>(2)? as u64,
                        cache_write: row.get::<_, i64>(3)? as u64,
                        cache_write_1h: None,
                        reasoning: None,
                        total_tokens: row.get::<_, i64>(4)? as u64,
                        cost: crate::harness::types::UsageCost {
                            input: 0.0,
                            output: 0.0,
                            cache_read: 0.0,
                            cache_write: 0.0,
                            total: row.get::<_, f64>(5)?,
                        },
                    })
                },
            )
            .map_err(err)?;
        Ok(SessionStats { message_count, usage })
    }

    /// Fork destination built by copying selected rows per the fork policy.
    pub fn fork(&self, options: &ForkOptions) -> SessionResult<SqliteStorage> {
        let conn = self.conn.lock().unwrap();
        let dest = SqliteStorage::in_memory()?;
        {
            let mut dest_conn = dest.conn.lock().unwrap();
            let tx = dest_conn
                .transaction()
                .map_err(|e| SessionError::Storage(e.to_string()))?;

            let plan = fork_plan(&conn, options)?;

            // Reads the row from the source connection, writes it into the
            // destination transaction.
            let copy_entry = |source: &Connection, dest: &Connection, id: &str| -> SessionResult<()> {
                let row = source
                    .query_row("SELECT id, parent_id, seq, timestamp, type, custom_type, body FROM entries WHERE id = ?1", params![id], raw_entry)
                    .map_err(|e| SessionError::Storage(e.to_string()))
                    .and_then(decode_entry)?;
                Self::apply_write(dest, &CommittedWrite::Entry { entry: row })?;
                Ok(())
            };

            match &plan {
                ForkPlan::Tree => {
                    let mut stmt = tx
                        .prepare("SELECT id FROM entries ORDER BY seq")
                        .map_err(|e| SessionError::Storage(e.to_string()))?;
                    let ids: Vec<String> = stmt
                        .query_map([], |row| row.get::<_, String>(0))
                        .map_err(|e| SessionError::Storage(e.to_string()))?
                        .filter_map(|r| r.ok())
                        .collect();
                    drop(stmt);
                    for id in ids {
                        copy_entry(&conn, &tx, &id)?;
                    }
                    copy_current_state(&conn, &tx, &ForkCurrentStatePlan::Tree, &|_| true)?;
                }
                ForkPlan::Branch { branch, entry_ids, destination_tip } => {
                    for id in entry_ids {
                        copy_entry(&conn, &tx, id)?;
                    }
                    let current = ForkCurrentStatePlan::Branch {
                        branch: branch.clone(),
                        destination_tip: destination_tip.clone(),
                    };
                    let is_copied = |id: &str| entry_ids.contains(id);
                    copy_current_state(&conn, &tx, &current, &is_copied)?;
                }
            }
            tx.commit().map_err(|e| SessionError::Storage(e.to_string()))?;
        }
        Ok(dest)
    }
}

enum ForkPlan {
    Tree,
    Branch {
        branch: String,
        entry_ids: std::collections::HashSet<String>,
        destination_tip: Option<String>,
    },
}

fn fork_plan(conn: &Connection, options: &ForkOptions) -> SessionResult<ForkPlan> {
    match options {
        ForkOptions::Tree { .. } => Ok(ForkPlan::Tree),
        ForkOptions::Branch { branch, entry_id, before, .. } => {
            let tip: Option<String> = conn
                .query_row(
                    "SELECT json FROM values_tbl WHERE namespace = 'pi.branch.tip' AND key = ?1",
                    params![branch],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| SessionError::Storage(e.to_string()))?
                .and_then(|json| serde_json::from_str::<Option<String>>(&json).ok().flatten());

            let mut parent_of = |id: &str| -> Option<Option<String>> {
                match conn
                    .query_row("SELECT parent_id FROM entries WHERE id = ?1", params![id], |row| {
                        row.get::<_, Option<String>>(0)
                    })
                    .optional()
                {
                    Ok(Some(parent)) => Some(parent), // entry exists; parent may be NULL
                    Ok(None) | Err(_) => None,        // entry missing → corrupt
                }
            };

            let mut entry_ids = std::collections::HashSet::new();
            let (branch_name, destination_tip) = select_branch_fork(
                branch,
                entry_id.as_deref(),
                *before,
                tip,
                &mut |id| {
                    entry_ids.insert(id.to_string());
                },
                &mut parent_of,
            )
            .map_err(SessionError::Storage)?;

            let configured = |addr: &Addr| -> bool {
                conn.query_row(
                    "SELECT 1 FROM values_tbl WHERE namespace = ?1 AND key = ?2",
                    params![addr.namespace, addr.key],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|e| SessionError::Storage(e.to_string()))
                .unwrap_or(None)
                .is_some()
            };
            if !configured(&lane_config(branch)) || !configured(&lane_state(branch)) {
                return Err(SessionError::Storage(format!(
                    "Source branch {branch:?} is not a configured AgentLane"
                )));
            }

            Ok(ForkPlan::Branch { branch: branch_name, entry_ids, destination_tip })
        }
    }
}

fn copy_current_state(
    source: &Connection,
    dest: &Connection,
    plan: &ForkCurrentStatePlan,
    is_entry_copied: &dyn Fn(&str) -> bool,
) -> SessionResult<()> {
    let mut stmt = source
        .prepare("SELECT namespace, key, seq, json FROM values_tbl ORDER BY key")
        .map_err(|e| SessionError::Storage(e.to_string()))?;
    let rows: Vec<(String, String, i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| SessionError::Storage(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    for (namespace, key, seq, json) in rows {
        let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| SessionError::Storage(e.to_string()))?;
        let write = CommittedWrite::ValueSet { seq: seq as u64, namespace, key, value };
        if let Some(projected) = project_fork_current_state_write(write, plan, is_entry_copied)? {
            SqliteStorage::apply_write(dest, &projected)?;
        }
    }

    let mut stmt = source
        .prepare("SELECT namespace, key, seq, json FROM lists_tbl ORDER BY key, seq")
        .map_err(|e| SessionError::Storage(e.to_string()))?;
    let rows: Vec<(String, String, i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| SessionError::Storage(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    for (namespace, key, seq, json) in rows {
        let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| SessionError::Storage(e.to_string()))?;
        let write = CommittedWrite::ListAppend { seq: seq as u64, namespace, key, value };
        if let Some(projected) = project_fork_current_state_write(write, plan, is_entry_copied)? {
            SqliteStorage::apply_write(dest, &projected)?;
        }
    }
    Ok(())
}

impl Storage for SqliteStorage {
    fn commit(&self, writes: Vec<Write>) -> SessionResult<CommitResult> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| SessionError::Storage(e.to_string()))?;
        let first_seq = next_seq(&tx)?;
        let timestamp = now_ms();
        let prepared = prepare_storage_commit(writes, first_seq, timestamp);
        validate_committed_writes(&prepared.writes, first_seq, &DbValidationState { conn: &tx })
            .map_err(SessionError::Storage)?;
        for write in &prepared.writes {
            Self::apply_write(&tx, write)?;
        }
        let stats = Self::stats(&tx)?;
        tx.commit().map_err(|e| SessionError::Storage(e.to_string()))?;
        Ok(CommitResult { first_seq, seqs: prepared.seqs, timestamp, stats })
    }

    fn get_entries(&self, ids: &[String]) -> SessionResult<HashMap<String, Entry>> {
        let conn = self.conn.lock().unwrap();
        let mut out = HashMap::new();
        for id in ids {
            let found = conn
                .query_row(
                    "SELECT id, parent_id, seq, timestamp, type, custom_type, body FROM entries WHERE id = ?1",
                    params![id],
                    raw_entry,
                )
                .optional()
                .map_err(|e| SessionError::Storage(e.to_string()))?
                .map(decode_entry)
                .transpose()?;
            if let Some(entry) = found {
                out.insert(id.clone(), entry);
            }
        }
        Ok(out)
    }

    fn get_value(&self, address: &Addr) -> SessionResult<Option<StoredValue>> {
        let conn = self.conn.lock().unwrap();
        let found = conn
            .query_row(
                "SELECT seq, json FROM values_tbl WHERE namespace = ?1 AND key = ?2",
                params![address.namespace, address.key],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? as u64,
                        row.get::<_, String>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| SessionError::Storage(e.to_string()))?;
        Ok(found.map(|(seq, json)| StoredValue {
            address: Addr { namespace: address.namespace.clone(), key: address.key.clone() },
            value: serde_json::from_str(&json).unwrap_or(serde_json::Value::Null),
            seq,
        }))
    }

    fn scan_values(&self, prefix: &Addr) -> SessionResult<Vec<StoredValue>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT namespace, key, seq, json FROM values_tbl WHERE namespace = ?1 AND key LIKE ?2 ESCAPE '\\' ORDER BY key")
            .map_err(|e| SessionError::Storage(e.to_string()))?;
        let pattern = format!("%{}", escape_like(&prefix.key));
        let rows = stmt
            .query_map(params![prefix.namespace, pattern], |row| {
                Ok(StoredValue {
                    address: Addr { namespace: row.get(0)?, key: row.get(1)? },
                    seq: row.get::<_, i64>(2)? as u64,
                    value: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or(serde_json::Value::Null),
                })
            })
            .map_err(|e| SessionError::Storage(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    fn read_list(&self, address: &Addr, options: ListReadOptions) -> SessionResult<Vec<ListElement>> {
        let conn = self.conn.lock().unwrap();
        let (cursor, desc, limit) = super::values::resolve_list_read_options(options);
        let order = if desc { "DESC" } else { "ASC" };
        let sql = match cursor {
            Some(_) => format!(
                "SELECT seq, json FROM lists_tbl WHERE namespace = ?1 AND key = ?2 AND seq {op} ?3 ORDER BY seq {order} LIMIT ?4",
                op = if desc { "<" } else { ">" },
                order = order,
            ),
            None => format!(
                "SELECT seq, json FROM lists_tbl WHERE namespace = ?1 AND key = ?2 ORDER BY seq {order} LIMIT ?3",
                order = order,
            ),
        };
        let mut stmt = conn.prepare(&sql).map_err(|e| SessionError::Storage(e.to_string()))?;
        let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<ListElement> {
            Ok(ListElement {
                seq: row.get::<_, i64>(0)? as u64,
                value: serde_json::from_str(&row.get::<_, String>(1)?).unwrap_or(serde_json::Value::Null),
            })
        };
        let rows = match cursor {
            Some(c) => stmt
                .query_map(params![address.namespace, address.key, c as i64, limit as i64], map_row)
                .map_err(|e| SessionError::Storage(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect(),
            None => stmt
                .query_map(params![address.namespace, address.key, limit as i64], map_row)
                .map_err(|e| SessionError::Storage(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect(),
        };
        Ok(rows)
    }

    fn scan_branch(&self, query: &StorageBranchScan) -> SessionResult<Vec<Entry>> {
        // Walk the parent chain from the start entry (point lookups).
        let conn = self.conn.lock().unwrap();
        let mut path: Vec<Entry> = Vec::new();
        let mut current: Option<String> = Some(query.start.clone());
        while let Some(id) = current {
            let entry = conn
                .query_row(
                    "SELECT id, parent_id, seq, timestamp, type, custom_type, body FROM entries WHERE id = ?1",
                    params![id],
                    raw_entry,
                )
                .optional()
                .map_err(|e| SessionError::Storage(e.to_string()))?
                .map(decode_entry)
                .transpose()?;
            let Some(entry) = entry else {
                return Err(SessionError::Storage(format!("Unknown branch start: {}", query.start)));
            };
            current = entry.parent_id.clone();
            path.push(entry);
        }
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

    fn scan_branch_structure(&self, query: &StorageBranchScan) -> SessionResult<Vec<EntryStructure>> {
        Ok(self.scan_branch(query)?.iter().map(EntryStructure::from).collect())
    }

    fn scan_entries(&self, query: &EntryScan) -> SessionResult<Vec<Entry>> {
        let conn = self.conn.lock().unwrap();
        let order = if query.desc { "DESC" } else { "ASC" };
        let sql = format!(
            "SELECT id, parent_id, seq, timestamp, type, custom_type, body FROM entries
             WHERE (?1 IS NULL OR type = ?1)
               AND (?2 IS NULL OR custom_type = ?2)
               AND (?3 IS NULL OR seq >= ?3)
               AND (?4 IS NULL OR seq <= ?4)
             ORDER BY seq {order} LIMIT ?5"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| SessionError::Storage(e.to_string()))?;
        let entry_type = query.entry_type.map(String::from);
        let from = query.from_seq.map(|v| v as i64);
        let to = query.to_seq.map(|v| v as i64);
        let limit = query.limit.map(|v| v as i64).unwrap_or(i64::MAX);
        let rows: Vec<Entry> = stmt
            .query_map(params![entry_type, query.custom_type, from, to, limit], raw_entry)
            .map_err(|e| SessionError::Storage(e.to_string()))?
            .filter_map(|r| r.ok())
            .map(decode_entry)
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn scan_usage(&self, query: &UsageScan) -> SessionResult<Vec<UsageRow>> {
        let conn = self.conn.lock().unwrap();
        let order = if query.desc { "DESC" } else { "ASC" };
        let sql = format!(
            "SELECT id, seq, entry_id, adjustment, input, output, cache_read, cache_write, cache_write_1h, reasoning, total_tokens, cost_total
             FROM usage_rows
             WHERE (?1 IS NULL OR seq >= ?1) AND (?2 IS NULL OR seq <= ?2)
             ORDER BY seq {order} LIMIT COALESCE(?3, -1)"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| SessionError::Storage(e.to_string()))?;
        let from = query.from_seq.map(|v| v as i64);
        let to = query.to_seq.map(|v| v as i64);
        // NULL limit = no limit in SQLite.
        let limit = query.limit.map(|v| v as i64);
        let rows = stmt
            .query_map(params![from, to, limit], decode_usage)
            .map_err(|e| SessionError::Storage(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    fn get_stats(&self) -> SessionResult<SessionStats> {
        let conn = self.conn.lock().unwrap();
        Self::stats(&conn)
    }

    fn close(&self) -> SessionResult<()> {
        Ok(())
    }
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// One SQLite file per session under `dir`.
pub struct SqliteSessionRepo {
    dir: PathBuf,
}

impl SqliteSessionRepo {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        SqliteSessionRepo { dir: dir.into() }
    }

    fn db_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.db"))
    }

    fn write_meta(&self, conn: &Connection, metadata: &SessionMetadata) -> SessionResult<()> {
        let set = |k: &str, v: String| -> SessionResult<()> {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, v],
            )
            .map_err(|e| SessionError::Storage(e.to_string()))?;
            Ok(())
        };
        set("id", metadata.id.clone())?;
        set("created_at", metadata.created_at.to_string())?;
        set("storage_version", metadata.storage_version.to_string())?;
        if let Some(parent) = &metadata.parent_session_id {
            set("parent_session_id", parent.clone())?;
        }
        Ok(())
    }

    fn read_meta(conn: &Connection) -> SessionResult<SessionMetadata> {
        let get = |k: &str| -> SessionResult<Option<String>> {
            Ok(conn
                .query_row("SELECT value FROM meta WHERE key = ?1", params![k], |row| row.get::<_, String>(0))
                .optional()
                .map_err(|e| SessionError::Storage(e.to_string()))?)
        };
        Ok(SessionMetadata {
            id: get("id")?.ok_or_else(|| SessionError::Storage("missing meta id".into()))?,
            created_at: get("created_at")?.and_then(|v| v.parse().ok()).unwrap_or(0),
            storage_version: get("storage_version")?.and_then(|v| v.parse().ok()).unwrap_or(STORAGE_VERSION),
            cwd: None,
            parent_session_id: get("parent_session_id")?,
        })
    }

    pub fn create(&self, id: &str, parent_session_id: Option<String>) -> SessionResult<super::session::Session> {
        std::fs::create_dir_all(&self.dir).map_err(|e| SessionError::Storage(e.to_string()))?;
        let path = self.db_path(id);
        if path.exists() {
            return Err(SessionError::Other(format!("Session already exists: {id}")));
        }
        let storage = SqliteStorage::open(&path)?;
        let metadata = SessionMetadata {
            id: id.to_string(),
            created_at: now_ms(),
            storage_version: STORAGE_VERSION,
            cwd: None,
            parent_session_id,
        };
        {
            let conn = storage.conn.lock().unwrap();
            self.write_meta(&conn, &metadata)?;
        }
        Ok(super::session::Session::new(metadata, std::sync::Arc::new(storage)))
    }

    pub fn open(&self, id: &str) -> SessionResult<super::session::Session> {
        let path = self.db_path(id);
        if !path.exists() {
            return Err(SessionError::Other(format!("Unknown session: {id}")));
        }
        let storage = SqliteStorage::open(&path)?;
        let metadata = {
            let conn = storage.conn.lock().unwrap();
            Self::read_meta(&conn)?
        };
        Ok(super::session::Session::new(metadata, std::sync::Arc::new(storage)))
    }

    pub fn list(&self) -> SessionResult<Vec<SessionMetadata>> {
        let mut out = Vec::new();
        let entries = std::fs::read_dir(&self.dir).map_err(|e| SessionError::Storage(e.to_string()))?;
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("db") {
                continue;
            }
            match SqliteStorage::open(&path) {
                Ok(storage) => {
                    let metadata = {
                        let conn = storage.conn.lock().unwrap();
                        Self::read_meta(&conn)
                    };
                    match metadata {
                        Ok(m) => out.push(m),
                        Err(e) => tracing::warn!("session list: {} meta unreadable: {e}", path.display()),
                    }
                }
                Err(e) => tracing::warn!("session list: {} open failed: {e}", path.display()),
            }
        }
        out.sort_by_key(|m| m.created_at);
        Ok(out)
    }

    pub fn delete(&self, id: &str) -> SessionResult<()> {
        let path = self.db_path(id);
        if !path.exists() {
            return Err(SessionError::Other(format!("Unknown session: {id}")));
        }
        std::fs::remove_file(&path).map_err(|e| SessionError::Storage(e.to_string()))?;
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
        Ok(())
    }

    pub fn fork(&self, source_id: &str, options: &ForkOptions) -> SessionResult<super::session::Session> {
        let source = self.open(source_id)?;
        let source_storage = SqliteStorage::open(&self.db_path(source_id))?;
        let fork_id = match &options {
            ForkOptions::Tree { id } => id.clone(),
            ForkOptions::Branch { id, .. } => id.clone(),
        }
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());

        let destination = source_storage.fork(options)?;
        // Persist the forked in-memory destination to its own file.
        std::fs::create_dir_all(&self.dir).map_err(|e| SessionError::Storage(e.to_string()))?;
        let dest_path = self.db_path(&fork_id);
        if dest_path.exists() {
            return Err(SessionError::Other(format!("Session already exists: {fork_id}")));
        }
        let dest_file = SqliteStorage::open(&dest_path)?;
        {
            let mem_conn = destination.conn.lock().unwrap();
            let mut file_conn = dest_file.conn.lock().unwrap();
            let tx = file_conn.transaction().map_err(|e| SessionError::Storage(e.to_string()))?;
            copy_all(&mem_conn, &tx)?;
            let metadata = SessionMetadata {
                id: fork_id.clone(),
                created_at: now_ms(),
                storage_version: STORAGE_VERSION,
                cwd: None,
                parent_session_id: Some(source_id.to_string()),
            };
            self.write_meta(&tx, &metadata)?;
            tx.commit().map_err(|e| SessionError::Storage(e.to_string()))?;
        }
        let _ = source; // caller may hold the source open; nothing to do here
        self.open(&fork_id)
    }
}

fn copy_all(source: &Connection, dest: &Connection) -> SessionResult<()> {
    let mut stmt = source
        .prepare("SELECT id, parent_id, seq, timestamp, type, custom_type, body FROM entries ORDER BY seq")
        .map_err(|e| SessionError::Storage(e.to_string()))?;
    let entries: Vec<Entry> = stmt.query_map([], raw_entry).map_err(|e| SessionError::Storage(e.to_string()))?.filter_map(|r| r.ok()).map(decode_entry).collect::<Result<_, _>>()?;
    drop(stmt);
    for entry in entries {
        SqliteStorage::apply_write(dest, &CommittedWrite::Entry { entry })?;
    }
    let mut stmt = source
        .prepare("SELECT id, seq, entry_id, adjustment, input, output, cache_read, cache_write, cache_write_1h, reasoning, total_tokens, cost_total FROM usage_rows ORDER BY seq")
        .map_err(|e| SessionError::Storage(e.to_string()))?;
    let usage: Vec<UsageRow> = stmt.query_map([], decode_usage).map_err(|e| SessionError::Storage(e.to_string()))?.filter_map(|r| r.ok()).collect();
    drop(stmt);
    for row in usage {
        SqliteStorage::apply_write(dest, &CommittedWrite::Usage { row })?;
    }
    copy_current_state(source, dest, &ForkCurrentStatePlan::Tree, &|_| true)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::session::conformance::{assert_fork_invariants, build_fork_source, run_storage_conformance};
    use crate::harness::session::types::BranchScan;

    #[test]
    fn sqlite_backend_passes_conformance() {
        run_storage_conformance(&|| Ok(Box::new(SqliteStorage::in_memory().unwrap()) as Box<dyn Storage>)).unwrap();
    }

    #[test]
    fn sqlite_branch_fork_invariants() {
        let source = SqliteStorage::in_memory().unwrap();
        build_fork_source(&source).unwrap();
        let dest = source
            .fork(&ForkOptions::Branch { branch: "main".into(), entry_id: Some("b".into()), before: false, id: None })
            .unwrap();
        assert_fork_invariants(&dest).unwrap();
    }

    #[test]
    fn repo_round_trip_across_reopen() {
        let dir = std::env::temp_dir().join(format!("zwork-sessions-{}", uuid::Uuid::new_v4().simple()));
        let repo = SqliteSessionRepo::new(&dir);
        {
            let session = repo.create("s1", None).unwrap();
            let _ = session.create_branch("main", None).await_test();
            let branch = session.branch("main").unwrap().unwrap();
            let _ = branch
                .append_message(crate::harness::agent_types::AgentMessage::Llm(
                    crate::harness::types::Message::user_text("persisted"),
                ))
                .await_test();
        }
        // Reopen from disk: the entry survives.
        let session = repo.open("s1").unwrap();
        let branch = session.branch("main").unwrap().unwrap();
        let entries = branch.find_entries(BranchScan::default()).unwrap();
        assert_eq!(entries.len(), 1);
        let stats = session.get_stats().unwrap();
        assert_eq!(stats.message_count, 1);
        let listed = repo.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "s1");
        repo.delete("s1").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Tiny block-on helper so tests can drive async session methods without
    // pulling a test runtime into every assertion.
    trait AwaitTest: std::future::Future {
        fn await_test(self) -> Self::Output;
    }
    impl<T: std::future::Future> AwaitTest for T {
        fn await_test(self) -> T::Output {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(self)
        }
    }
}

#[cfg(test)]
mod list_probe {
    #[test]
    fn lists_crashed_session_with_hot_wal() {
        let dir = "/tmp/zwork-smoke-durable/sessions";
        if !std::path::Path::new(dir).exists() {
            return; // smoke dir absent (CI) — no-op
        }
        if !std::path::Path::new(
            "/tmp/zwork-smoke-durable/sessions/634577ed3a1d4a33974efd0c7d9d455f__af5a90d552a74f9f98a9aa96d154ce7c.db",
        )
        .exists()
        {
            return; // the specific crashed-session artifact is gone; nothing to assert
        }
        let repo = super::SqliteSessionRepo::new(dir);
        let listed = repo.list().unwrap();
        let ids: Vec<&str> = listed.iter().map(|m| m.id.as_str()).collect();
        assert!(
            ids.iter().any(|id| id.starts_with("634577ed")),
            "crashed session missing from list(): {ids:?}"
        );
    }
}
