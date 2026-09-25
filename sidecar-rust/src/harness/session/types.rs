//! Port of pi `harness/session/types.ts` — entry tree, storage contract,
//! and the durable operation state vocabulary.
//!
//! Deviations from pi, all deliberate:
//! - The `Context` parameter is dropped everywhere (single-process sidecar;
//!   cancellation arrives with the runtime in M4, not with storage calls).
//! - `Storage` is synchronous: the memory backend is pure and rusqlite is
//!   synchronous; serialization happens one level up on the mutation line.
//! - pi's phantom-typed `Value<T>` becomes untyped addresses with typed
//!   reads at the session boundary.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::harness::agent_types::AgentMessage;
use crate::harness::compaction::CompactionSettings;
use crate::harness::types::{ThinkingLevel, Usage};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    /// Durable session state is internally inconsistent and cannot be advanced.
    #[error("session invariant violated: {0}")]
    Invariant(String),
    #[error("invalid branch {branch:?}: {reason}")]
    InvalidBranch { branch: String, reason: String },
    #[error("branch already exists: {0}")]
    BranchExists(String),
    /// A pending assistant message cannot be persisted as a session entry.
    #[error("cannot persist a pending assistant message")]
    PendingAssistantMessage,
    #[error("unknown target: {0}")]
    UnknownTarget(String),
    #[error("session is closed")]
    Closed,
    #[error("storage failure: {0}")]
    Storage(String),
    #[error("{0}")]
    Other(String),
}

pub type SessionResult<T> = Result<T, SessionError>;

impl From<String> for SessionError {
    fn from(message: String) -> Self {
        SessionError::Other(message)
    }
}

// ---------------------------------------------------------------------------
// Entry tree
// ---------------------------------------------------------------------------

pub const ENTRY_TYPE_MESSAGE: &str = "message";
pub const ENTRY_TYPE_COMPACTION: &str = "compaction";
pub const ENTRY_TYPE_BRANCH_SUMMARY: &str = "branch_summary";
pub const ENTRY_TYPE_CUSTOM: &str = "custom";

/// One write-once node in the conversation tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub parent_id: Option<String>,
    pub seq: u64,
    pub timestamp: u64,
    #[serde(flatten)]
    pub body: EntryBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EntryBody {
    Message {
        message: AgentMessage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminate: Option<bool>,
    },
    Compaction {
        summary: String,
        retained_tail: Vec<AgentMessage>,
        tokens_before: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<Json>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        from_hook: bool,
    },
    BranchSummary {
        from_id: Option<String>,
        summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<Json>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        from_hook: bool,
    },
    Custom {
        custom_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Json>,
    },
}

impl Entry {
    pub fn entry_type(&self) -> &'static str {
        match &self.body {
            EntryBody::Message { .. } => ENTRY_TYPE_MESSAGE,
            EntryBody::Compaction { .. } => ENTRY_TYPE_COMPACTION,
            EntryBody::BranchSummary { .. } => ENTRY_TYPE_BRANCH_SUMMARY,
            EntryBody::Custom { .. } => ENTRY_TYPE_CUSTOM,
        }
    }

    pub fn custom_type(&self) -> Option<&str> {
        match &self.body {
            EntryBody::Custom { custom_type, .. } => Some(custom_type),
            _ => None,
        }
    }

    pub fn as_message(&self) -> Option<&AgentMessage> {
        match &self.body {
            EntryBody::Message { message, .. } => Some(message),
            _ => None,
        }
    }
}

/// Structure-only projection for cheap branch walking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntryStructure {
    pub id: String,
    pub parent_id: Option<String>,
    pub seq: u64,
    pub timestamp: u64,
    #[serde(rename = "type")]
    pub entry_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_type: Option<String>,
}

impl From<&Entry> for EntryStructure {
    fn from(entry: &Entry) -> Self {
        EntryStructure {
            id: entry.id.clone(),
            parent_id: entry.parent_id.clone(),
            seq: entry.seq,
            timestamp: entry.timestamp,
            entry_type: entry.entry_type().to_string(),
            custom_type: entry.custom_type().map(String::from),
        }
    }
}

// ---------------------------------------------------------------------------
// Usage ledger
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRow {
    pub id: String,
    pub seq: u64,
    pub usage: Usage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    pub adjustment: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Json>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionStats {
    pub message_count: u64,
    pub usage: Usage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResult {
    pub first_seq: u64,
    pub seqs: Vec<u64>,
    pub timestamp: u64,
    /// Session totals immediately after this commit was applied.
    pub stats: SessionStats,
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct BranchScan {
    pub stop_at_type: Option<&'static str>,
    pub stop_at_id: Option<String>,
    pub entry_type: Option<&'static str>,
    pub custom_type: Option<String>,
    pub oldest_first: bool,
    pub limit: Option<usize>,
    /// Only entries with seq strictly greater (oldest_first) / smaller (newest_first).
    pub cursor: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct StorageBranchScan {
    pub start: String,
    pub query: BranchScan,
}

#[derive(Debug, Clone, Default)]
pub struct EntryScan {
    pub entry_type: Option<&'static str>,
    pub custom_type: Option<String>,
    pub from_seq: Option<u64>,
    pub to_seq: Option<u64>,
    pub desc: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageScan {
    pub from_seq: Option<u64>,
    pub to_seq: Option<u64>,
    pub desc: bool,
    pub limit: Option<usize>,
}

// ---------------------------------------------------------------------------
// Storage contract
// ---------------------------------------------------------------------------

use super::commit::Write;
use super::values::{Addr, ListElement, ListReadOptions, StoredValue};

/// The backend contract: an atomic multi-write commit with monotonic seq;
/// everything else is a query. Synchronous by design (see module docs).
pub trait Storage: Send + Sync {
    fn commit(&self, writes: Vec<Write>) -> SessionResult<CommitResult>;

    fn get_entries(&self, ids: &[String]) -> SessionResult<HashMap<String, Entry>>;

    fn get_value(&self, address: &Addr) -> SessionResult<Option<StoredValue>>;

    fn scan_values(&self, prefix: &Addr) -> SessionResult<Vec<StoredValue>>;

    fn read_list(&self, address: &Addr, options: ListReadOptions) -> SessionResult<Vec<ListElement>>;

    fn scan_branch(&self, query: &StorageBranchScan) -> SessionResult<Vec<Entry>>;

    fn scan_branch_structure(&self, query: &StorageBranchScan) -> SessionResult<Vec<EntryStructure>>;

    fn scan_entries(&self, query: &EntryScan) -> SessionResult<Vec<Entry>>;

    fn scan_usage(&self, query: &UsageScan) -> SessionResult<Vec<UsageRow>>;

    fn get_stats(&self) -> SessionResult<SessionStats>;

    fn close(&self) -> SessionResult<()>;
}

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

pub const STORAGE_VERSION: u64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMetadata {
    pub id: String,
    pub created_at: u64,
    pub storage_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
}

pub trait IdGenerator: Send + Sync {
    fn next(&self) -> String;
}

/// uuidv7, like pi: time-ordered so entry ids sort chronologically.
#[derive(Default)]
pub struct UuidV7Generator;

impl IdGenerator for UuidV7Generator {
    fn next(&self) -> String {
        uuid::Uuid::now_v7().to_string()
    }
}

#[derive(Debug, Clone, Default)]
pub struct SessionCreateOptions {
    pub id: Option<String>,
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ForkOptions {
    /// Copy one path from a configured source lane: its ancestry (at or
    /// before the chosen entry), copied configuration, fresh idle lane state.
    Branch {
        branch: String,
        entry_id: Option<String>,
        /// Include the selected entry ("at", default) or stop at its parent ("before").
        before: bool,
        id: Option<String>,
    },
    /// Copy the whole tree and every branch tip. Operation/pending/result/
    /// usage state is excluded.
    Tree { id: Option<String> },
}

// ---------------------------------------------------------------------------
// Durable operation state (consumed by the M4 runtime)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaneConfiguration {
    pub provider: String,
    pub model_id: String,
    pub thinking_level: ThinkingLevel,
    pub active_tool_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaneState {
    pub current_operation_id: Option<String>,
    pub last_operation_id: Option<String>,
    pub inbox: Vec<InboxItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperationIntent {
    Run { prompt_entry_ids: Vec<String> },
    Compaction { #[serde(default, skip_serializing_if = "Option::is_none")] custom_instructions: Option<String> },
    Navigation {
        target_id: Option<String>,
        summarize: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Control {
    Running,
    CancelRequested { requested_at: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OperationMeta {
    pub operation_id: String,
    pub lane: String,
    pub source_tip_id: Option<String>,
    pub started_at: u64,
    pub intent: OperationIntent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OperationError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Json>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Completed,
    Declined,
    Aborted,
    Failed,
}

/// Immutable lane-lived observation record written by one terminal transaction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OperationResultRecord {
    pub operation_id: String,
    pub kind: String,
    pub status: TerminalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<OperationError>,
    pub from_tip_id: Option<String>,
    pub tip_id: Option<String>,
    pub started_at: u64,
    pub ended_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InboxItemKind {
    Steer,
    FollowUp,
    NextRun,
    Write,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InboxItem {
    pub entry_id: String,
    pub kind: InboxItemKind,
}

/// Curated serializable provider-request options snapshotted per turn
/// (pi `AgentHarnessStreamOptions`; mapped onto harness `StreamOptions`
/// by the runtime).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct HarnessStreamOptionsSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retry_delay_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Json>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_retention: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred: Option<bool>,
    /// Provider credential and generation ceiling. Volatile bridge inputs —
    /// never write these into durable operation state; they ride the
    /// in-memory runtime config only (upstream resolves credentials outside
    /// the snapshot entirely).
    #[serde(skip)]
    pub api_key: Option<String>,
    #[serde(skip)]
    pub max_tokens: Option<u64>,
    #[serde(skip)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizedRetryPolicy {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
    pub max_agent_delay_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum QueueMode {
    All,
    OneAtATime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ToolExecutionMode {
    Sequential,
    Parallel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSettings {
    pub compaction: CompactionSettings,
    pub steering_mode: QueueMode,
    pub follow_up_mode: QueueMode,
    pub tool_execution: ToolExecutionMode,
}

impl Default for RunSettings {
    fn default() -> Self {
        RunSettings {
            compaction: CompactionSettings::default(),
            steering_mode: QueueMode::All,
            follow_up_mode: QueueMode::All,
            tool_execution: ToolExecutionMode::Sequential,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Continuation {
    NeedAssistant { overflow_recovery_used: bool },
    MayFinish { include_final_assistant: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CheckpointData {
    pub continuation: Continuation,
    pub trigger_entry_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GenerationContext {
    pub step_id: String,
    pub trigger_entry_id: String,
    pub configuration: LaneConfiguration,
    pub stream_options: HarnessStreamOptionsSnapshot,
    pub retry_policy: NormalizedRetryPolicy,
    pub overflow_recovery_used: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Planned,
    EffectPending,
    OutcomeReady,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    /// Zero-based index in the assistant message's complete content array.
    pub source_index: usize,
    pub result_entry_id: String,
    pub status: ToolCallStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminate: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolBatch {
    pub assistant_entry_id: String,
    pub configuration: LaneConfiguration,
    pub turn_id: String,
    pub calls: Vec<ToolCall>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ResultBoundary {
    ResumeCheckpoint { resume_after: CheckpointData },
    Finish,
    CommitNavigation { target_id: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] label: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SummaryTask {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_instructions: Option<String>,
    pub boundary: ResultBoundary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SummaryContext {
    pub result_entry_id: String,
    pub configuration: LaneConfiguration,
    pub stream_options: HarnessStreamOptionsSnapshot,
    pub retry_policy: NormalizedRetryPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PendingEntry {
    Message { payload: AgentMessage },
    Custom { custom_type: String, #[serde(default, skip_serializing_if = "Option::is_none")] payload: Option<Json> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DurableFileOperations {
    pub read: Vec<String>,
    pub written: Vec<String>,
    pub edited: Vec<String>,
}

/// Durable structural (compaction / branch-summary) preparation so a crash
/// mid-compaction resumes without recomputing — or re-billing — it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DurableStructuralPreparation {
    Compaction {
        messages_to_summarize: Vec<AgentMessage>,
        turn_prefix_messages: Vec<AgentMessage>,
        retained_tail: Vec<AgentMessage>,
        is_split_turn: bool,
        tokens_before: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        previous_summary: Option<String>,
        file_ops: DurableFileOperations,
        settings: CompactionSettings,
    },
    BranchSummary {
        messages: Vec<AgentMessage>,
        file_ops: DurableFileOperations,
        total_tokens: u64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetryWaitKind {
    Assistant,
    Summary,
}

/// Shared backoff data for retry-wait leaves.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetryWait {
    pub next_attempt: u32,
    pub not_before: u64,
    pub error_message: String,
}

/// Uniform scope carried by every operation leaf.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OperationScope {
    pub control: Control,
    pub settings: RunSettings,
    pub latest_assistant_entry_id: Option<String>,
}

/// Flat durable operation state: exactly 13 family-neutral dispatcher
/// leaves (pi session/types.ts). Cancellation stays orthogonal via
/// `scope.control`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "at")]
pub enum OperationState {
    #[serde(rename = "starting")]
    Starting { scope: OperationScope },
    #[serde(rename = "checkpoint")]
    Checkpoint { scope: OperationScope, checkpoint: CheckpointData },
    #[serde(rename = "assistant.ready")]
    AssistantReady { scope: OperationScope, generation: GenerationContext, next_attempt: u32 },
    #[serde(rename = "assistant.effect_pending")]
    AssistantEffectPending {
        scope: OperationScope,
        generation: GenerationContext,
        attempt: u32,
        response_entry_id: String,
        usage_id: String,
        intended_output_limit: u64,
        context_window: u64,
    },
    #[serde(rename = "assistant.retry_wait")]
    AssistantRetryWait { scope: OperationScope, generation: GenerationContext, retry: RetryWait },
    #[serde(rename = "tools")]
    Tools { scope: OperationScope, batch: ToolBatch },
    #[serde(rename = "deferred.suspended")]
    DeferredSuspended {
        scope: OperationScope,
        step_id: String,
        source_entry_id: String,
        poll: u32,
        configuration: LaneConfiguration,
        stream_options: HarnessStreamOptionsSnapshot,
    },
    #[serde(rename = "deferred.effect_pending")]
    DeferredEffectPending {
        scope: OperationScope,
        step_id: String,
        source_entry_id: String,
        poll: u32,
        configuration: LaneConfiguration,
        stream_options: HarnessStreamOptionsSnapshot,
        response_entry_id: String,
        usage_id: String,
    },
    #[serde(rename = "summary.deciding")]
    SummaryDeciding { scope: OperationScope, task: SummaryTask },
    #[serde(rename = "summary.ready")]
    SummaryReady { scope: OperationScope, task: SummaryTask, summary: SummaryContext, next_attempt: u32 },
    #[serde(rename = "summary.effect_pending")]
    SummaryEffectPending {
        scope: OperationScope,
        task: SummaryTask,
        summary: SummaryContext,
        attempt: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request: Option<GenerationRequestRef>,
        usage_ids: Vec<String>,
    },
    #[serde(rename = "summary.retry_wait")]
    SummaryRetryWait { scope: OperationScope, task: SummaryTask, summary: SummaryContext, retry: RetryWait },
    #[serde(rename = "navigation.ready_to_commit")]
    NavigationReadyToCommit {
        scope: OperationScope,
        /// Unsummarized navigation may target the branch root (None).
        target_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GenerationRequestRef {
    pub index: u64,
    pub usage_id: String,
}

impl OperationState {
    pub fn scope(&self) -> &OperationScope {
        match self {
            OperationState::Starting { scope }
            | OperationState::Checkpoint { scope, .. }
            | OperationState::AssistantReady { scope, .. }
            | OperationState::AssistantEffectPending { scope, .. }
            | OperationState::AssistantRetryWait { scope, .. }
            | OperationState::Tools { scope, .. }
            | OperationState::DeferredSuspended { scope, .. }
            | OperationState::DeferredEffectPending { scope, .. }
            | OperationState::SummaryDeciding { scope, .. }
            | OperationState::SummaryReady { scope, .. }
            | OperationState::SummaryEffectPending { scope, .. }
            | OperationState::SummaryRetryWait { scope, .. }
            | OperationState::NavigationReadyToCommit { scope, .. } => scope,
        }
    }

    pub fn at(&self) -> &'static str {
        match self {
            OperationState::Starting { .. } => "starting",
            OperationState::Checkpoint { .. } => "checkpoint",
            OperationState::AssistantReady { .. } => "assistant.ready",
            OperationState::AssistantEffectPending { .. } => "assistant.effect_pending",
            OperationState::AssistantRetryWait { .. } => "assistant.retry_wait",
            OperationState::Tools { .. } => "tools",
            OperationState::DeferredSuspended { .. } => "deferred.suspended",
            OperationState::DeferredEffectPending { .. } => "deferred.effect_pending",
            OperationState::SummaryDeciding { .. } => "summary.deciding",
            OperationState::SummaryReady { .. } => "summary.ready",
            OperationState::SummaryEffectPending { .. } => "summary.effect_pending",
            OperationState::SummaryRetryWait { .. } => "summary.retry_wait",
            OperationState::NavigationReadyToCommit { .. } => "navigation.ready_to_commit",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Operation {
    pub meta: OperationMeta,
    pub state: OperationState,
}
