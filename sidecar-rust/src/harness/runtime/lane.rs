//! Port of pi `harness/runtime/lane.ts` — the runtime implementation of one
//! configured lane.
//!
//! A lane pairs an authoritative in-memory projection
//! ([`RuntimeLaneState`]) with the session's durable values. Every
//! effect-free decision runs as a [`Lane::command`] on the session's
//! serialized mutation line: the planner sees owned state plus a read-only
//! reader, commits at most once, and materializes its caller result from
//! storage-assigned metadata.
//!
//! Deviations from pi, all deliberate:
//! - Landed here: the command core, `settle_operation`/`continue_operation`,
//!   run acceptance (prompt / skill / prompt_template), unsummarized
//!   navigation acceptance, queueing, usage, abort requests, configuration,
//!   idle coordination, seal. The drive claim loop, compaction acceptance,
//!   and summarized navigation arrive with their procedure modules (drive
//!   machine / structural), which own those code paths upstream.
//! - Events are delivered through an unbounded channel instead of awaited
//!   listener callbacks (single-process sidecar; the bridge drains).
//! - Planners are synchronous; provider and tool effects happen after
//!   `command` returns, admitted through the effect gate.

use std::sync::{Arc, Mutex, RwLock};

use serde_json::Value as Json;

use crate::harness::agent_types::AgentMessage;
use crate::harness::session::commit::{insert_entry, insert_usage, NewEntry, UsageRowNoSeq, Write};
use crate::harness::session::session::{now_ms, Session, SessionMutator};
use crate::harness::session::types::{
    BranchScan, Control, Entry, EntryBody, InboxItem, InboxItemKind, LaneConfiguration, LaneState, Operation,
    OperationIntent, OperationMeta, OperationResultRecord, OperationState, PendingEntry, RunSettings, SessionError,
    SessionResult, StorageBranchScan,
};
use crate::harness::session::values::{
    branch_tip, delete_value, lane_config, lane_state as lane_state_value, operation_meta as operation_meta_value,
    operation_result as operation_result_value, operation_state as operation_state_value, pending_entry, set_value,
};
use crate::harness::types::Usage;

use super::events::{HarnessEvent, LaneQueuedItem};
use super::transcript::{chain_entries, read_lane_queues};
use super::types::{CommitDecision, DriveOutcome, LaneCommand, RuntimeConfig, RuntimeLaneState};

/// Caller-facing lane errors (pi `result.ts` tags surfaced by the facade).
#[derive(Debug, thiserror::Error)]
pub enum LaneError {
    #[error("lane {lane:?} already has an active operation {operation_id:?}")]
    LaneBusy { lane: String, operation_id: String },
    #[error("invalid message: {reason}")]
    InvalidMessage { lane: String, reason: &'static str },
    #[error("unknown skill: {0}")]
    UnknownSkill(String),
    #[error("unknown prompt template: {0}")]
    UnknownTemplate(String),
    #[error("invalid navigation: {reason}")]
    InvalidNavigation { lane: String, reason: &'static str },
    #[error("unknown target: {0}")]
    UnknownTarget(String),
    #[error("no active operation on lane {0:?}")]
    NoActiveOperation(String),
    #[error("operation {expected:?} does not own lane {lane:?}")]
    OperationMismatch { lane: String, expected: String },
    #[error("lane {0:?} is closed: {1}")]
    Closed(String, String),
    #[error("{0}")]
    Other(String),
    #[error(transparent)]
    Session(#[from] SessionError),
}

pub type LaneResult<T> = Result<T, LaneError>;

/// What a run request carries into acceptance.
#[derive(Debug, Clone)]
pub enum RunRequest {
    /// Already-shaped prompt messages (text, images, or structured parts).
    Prompt { messages: Vec<AgentMessage> },
    Skill { name: String, additional_instructions: Option<String> },
    PromptTemplate { name: String, args: Vec<String> },
}

/// Successful operation admission.
#[derive(Debug, Clone)]
pub struct OperationAdmission {
    pub operation_id: String,
    pub kind: &'static str,
    pub started_at: u64,
}

/// Result of a `continue_operation` planner: cancellation short-circuits.
#[derive(Debug, Clone)]
pub enum ContinueOutcome<T> {
    CancelRequested,
    Result(T),
}

/// One queued input offered to the lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueKind {
    Steer,
    FollowUp,
    NextRun,
}

impl QueueKind {
    fn as_inbox_kind(self) -> InboxItemKind {
        match self {
            QueueKind::Steer => InboxItemKind::Steer,
            QueueKind::FollowUp => InboxItemKind::FollowUp,
            QueueKind::NextRun => InboxItemKind::NextRun,
        }
    }
}

/// Navigation acceptance input (unsummarized moves; summarized navigation
/// arrives with the structural procedures).
#[derive(Debug, Clone)]
pub struct NavigationRequest {
    pub target_id: Option<String>,
    pub label: Option<String>,
}

/// Outcome of cancelling a queued item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelledQueued {
    Cancelled,
    AlreadyConsumed,
    NotFound,
}

#[derive(Debug, Clone)]
pub struct AbortRequest {
    pub newly_requested: bool,
    pub steer: Vec<AgentMessage>,
    pub follow_up: Vec<AgentMessage>,
}

/// Operation command as planned inside `settle_operation`.
pub type OperationCommandFor<T> = super::types::OperationCommand<T>;

struct LaneInner {
    state: RuntimeLaneState,
    active_drive: Option<Arc<super::types::Drive>>,
    closed_error: Option<String>,
    /// Set while an idle callback owns the lane; commands wait it out.
    idle_owner: Option<Arc<tokio::sync::Notify>>,
}

/// Shared lane handle. The session mutation line serializes commands; the
/// inner mutex is only taken inside a command (never the reverse order).
pub struct Lane {
    pub name: String,
    pub session: Session,
    pub hooks: Arc<super::hooks::HookRegistry>,
    config: Arc<RwLock<RuntimeConfig>>,
    event_tx: tokio::sync::mpsc::UnboundedSender<HarnessEvent>,
    state_change: tokio::sync::watch::Sender<u64>,
    inner: Mutex<LaneInner>,
}

/// Durable values backing one lane, as read at open/restore time.
#[derive(Debug, Clone, Default)]
pub struct LaneSnapshotState {
    pub configuration: Option<LaneConfiguration>,
    pub tip_id: Option<String>,
    pub lane_state: LaneState,
    pub operation: Option<Operation>,
}

impl LaneInner {
    fn closed_error_ref(&self) -> &Option<String> {
        &self.closed_error
    }
}

fn durable_lane_state(
    state: &RuntimeLaneState,
    current_operation_id: Option<String>,
    inbox: Vec<InboxItem>,
    last_operation_id: Option<String>,
) -> LaneState {
    LaneState {
        current_operation_id,
        last_operation_id: last_operation_id.or_else(|| state.last_operation_id.clone()),
        inbox,
    }
}

fn lane_state_write(lane: &str, state: LaneState) -> SessionResult<Write> {
    let json = serde_json::to_value(&state).map_err(|e| SessionError::Storage(e.to_string()))?;
    Ok(Write::Value(set_value(&lane_state_value(lane), json)))
}

fn operation_state_write(operation_id: &str, state: &OperationState) -> SessionResult<Write> {
    let json = serde_json::to_value(state).map_err(|e| SessionError::Storage(e.to_string()))?;
    Ok(Write::Value(set_value(&operation_state_value(operation_id), json)))
}

fn pending_entry_write(entry_id: &str, pending: &PendingEntry) -> NewEntry {
    match pending {
        PendingEntry::Message { payload } => NewEntry {
            id: entry_id.to_string(),
            parent_id: None,
            body: EntryBody::Message { message: payload.clone(), terminate: None },
        },
        PendingEntry::Custom { custom_type, payload } => NewEntry {
            id: entry_id.to_string(),
            parent_id: None,
            body: EntryBody::Custom { custom_type: custom_type.clone(), data: payload.clone() },
        },
    }
}

fn decode_pending(
    stored: &crate::harness::session::values::StoredValue,
) -> SessionResult<PendingEntry> {
    serde_json::from_value(stored.value.clone())
        .map_err(|e| SessionError::Storage(format!("pending entry decode failed: {e}")))
}

fn select_accepted_inbox(
    inbox: &[InboxItem],
    steering_all: bool,
    follow_up_all: bool,
) -> (Vec<InboxItem>, Vec<InboxItem>) {
    let mut steer_taken = false;
    let mut follow_up_taken = false;
    let mut selected = Vec::new();
    let mut remainder = Vec::new();
    for item in inbox {
        let eligible = item.kind == InboxItemKind::Write
            || item.kind == InboxItemKind::NextRun
            || (item.kind == InboxItemKind::Steer && (steering_all || !steer_taken))
            || (item.kind == InboxItemKind::FollowUp && (follow_up_all || !follow_up_taken));
        if eligible {
            selected.push(item.clone());
            match item.kind {
                InboxItemKind::Steer => steer_taken = true,
                InboxItemKind::FollowUp => follow_up_taken = true,
                _ => {}
            }
        } else {
            remainder.push(item.clone());
        }
    }
    (selected, remainder)
}

fn run_settings(config: &RuntimeConfig) -> RunSettings {
    RunSettings {
        compaction: config.compaction,
        steering_mode: config.steering_mode.clone(),
        follow_up_mode: config.follow_up_mode.clone(),
        tool_execution: config.tool_execution.clone(),
    }
}

fn is_pending_assistant(message: &AgentMessage) -> bool {
    matches!(message, AgentMessage::Llm(crate::harness::types::Message::Assistant(am)) if am.stop_reason == crate::harness::types::StopReason::Pending)
}

impl Lane {
    /// Assemble a lane from its durable snapshot (values read by
    /// [`Lane::read_snapshot`]).
    pub fn new(
        name: impl Into<String>,
        session: Session,
        hooks: Arc<super::hooks::HookRegistry>,
        config: Arc<RwLock<RuntimeConfig>>,
        snapshot: LaneSnapshotState,
        event_tx: tokio::sync::mpsc::UnboundedSender<HarnessEvent>,
    ) -> LaneResult<Arc<Lane>> {
        let configuration = snapshot.configuration.unwrap_or(LaneConfiguration {
            provider: String::new(),
            model_id: String::new(),
            thinking_level: crate::harness::types::ThinkingLevel::Minimal,
            active_tool_names: Vec::new(),
        });
        let (state_change_tx, _) = tokio::sync::watch::channel(0);
        Ok(Arc::new(Lane {
            name: name.into(),
            session,
            hooks,
            config,
            event_tx,
            state_change: state_change_tx,
            inner: Mutex::new(LaneInner {
                state: RuntimeLaneState {
                    tip_id: snapshot.tip_id,
                    configuration,
                    inbox: snapshot.lane_state.inbox,
                    last_operation_id: snapshot.lane_state.last_operation_id,
                    operation: snapshot.operation,
                },
                active_drive: None,
                closed_error: None,
                idle_owner: None,
            }),
        }))
    }

    /// Read the durable values backing one lane.
    pub fn read_snapshot(session: &Session, lane: &str) -> SessionResult<LaneSnapshotState> {
        let configuration = session
            .get_value_raw(&lane_config(lane))?
            .map(|stored| serde_json::from_value::<LaneConfiguration>(stored.value))
            .transpose()
            .map_err(|e| SessionError::Storage(format!("lane config decode failed: {e}")))?;
        let tip_id = session
            .get_value_raw(&branch_tip(lane))?
            .and_then(|stored| stored.value.as_str().map(String::from));
        let lane_state = session
            .get_value_raw(&lane_state_value(lane))?
            .map(|stored| serde_json::from_value::<LaneState>(stored.value))
            .transpose()
            .map_err(|e| SessionError::Storage(format!("lane state decode failed: {e}")))?
            .unwrap_or_default();
        let operation = match &lane_state.current_operation_id {
            Some(operation_id) => {
                let meta = session
                    .get_value_raw(&operation_meta_value(operation_id))?
                    .map(|stored| stored.value)
                    .ok_or_else(|| {
                        SessionError::Invariant(format!(
                            "lane {lane:?} has current operation {operation_id:?} without meta"
                        ))
                    })?;
                let state = session
                    .get_value_raw(&operation_state_value(operation_id))?
                    .map(|stored| stored.value)
                    .ok_or_else(|| {
                        SessionError::Invariant(format!(
                            "lane {lane:?} has current operation {operation_id:?} without state"
                        ))
                    })?;
                Some(Operation {
                    meta: serde_json::from_value(meta)
                        .map_err(|e| SessionError::Storage(format!("operation meta decode failed: {e}")))?,
                    state: serde_json::from_value(state)
                        .map_err(|e| SessionError::Storage(format!("operation state decode failed: {e}")))?,
                })
            }
            None => None,
        };
        Ok(LaneSnapshotState { configuration, tip_id, lane_state, operation })
    }

    // -- projection access --

    pub fn read_config(&self) -> RuntimeConfig {
        self.config.read().unwrap().clone()
    }

    pub fn config_handle(&self) -> Arc<RwLock<RuntimeConfig>> {
        Arc::clone(&self.config)
    }

    pub fn tip_id(&self) -> LaneResult<Option<String>> {
        self.assert_open()?;
        Ok(self.inner.lock().unwrap().state.tip_id.clone())
    }

    pub fn current_operation_id(&self) -> LaneResult<Option<String>> {
        self.assert_open()?;
        Ok(self
            .inner
            .lock()
            .unwrap()
            .state
            .operation
            .as_ref()
            .map(|operation| operation.meta.operation_id.clone()))
    }

    pub async fn get_result(&self, operation_id: &str) -> LaneResult<Option<OperationResultRecord>> {
        self.assert_open()?;
        match self.session.get_value_raw(&operation_result_value(operation_id))? {
            Some(stored) => Ok(Some(
                serde_json::from_value(stored.value)
                    .map_err(|e| SessionError::Storage(format!("operation result decode failed: {e}")))?,
            )),
            None => Ok(None),
        }
    }

    fn emit(&self, events: Vec<HarnessEvent>) {
        for event in events {
            let _ = self.event_tx.send(event);
        }
    }

    /// Emit one runtime event (drive procedures stream assistant progress
    /// through the same channel the lane commands use).
    pub(crate) fn emit_public(&self, event: HarnessEvent) {
        let _ = self.event_tx.send(event);
    }

    fn signal_state_change(&self) {
        self.state_change.send_modify(|generation| *generation += 1);
    }

    fn assert_open(&self) -> LaneResult<()> {
        match self.inner.lock().unwrap().closed_error_ref() {
            None => Ok(()),
            Some(error) => Err(LaneError::Closed(self.name.clone(), error.clone())),
        }
    }

    pub fn closed_error(&self) -> Option<String> {
        self.inner.lock().unwrap().closed_error.clone()
    }

    /// The current operation, if this lane owns one (pi `lane.state.operation`).
    pub fn operation_snapshot(&self) -> Option<Operation> {
        self.inner.lock().unwrap().state.operation.clone()
    }

    /// Resolved context window of the configured model (pi reads
    /// `lane.models`; the facade publishes the window into the config).
    pub fn context_window(&self) -> Option<u64> {
        self.read_config().context_window
    }

    // -- command core --

    /// Run one effect-free command on this lane's serialized mutation line
    /// (pi `Lane.command`). The planner receives owned state plus the
    /// session reader and chooses exactly one outcome: commit (at most
    /// once), return, or reject. Lane state publishes only on commit;
    /// commit-derived events are emitted after the writes are durable.
    pub async fn command<T, F>(&self, plan: F) -> LaneResult<T>
    where
        T: 'static,
        F: FnOnce(&RuntimeLaneState, &mut SessionMutator<'_>) -> SessionResult<LaneCommand<T>>,
    {
        let mut plan = Some(plan);
        loop {
            self.assert_open()?;

            // Wait out an idle callback claim before queueing onto the line.
            {
                let owner = self.inner.lock().unwrap().idle_owner.clone();
                if let Some(owner) = owner {
                    let mut generation = self.state_change.subscribe();
                    tokio::select! {
                        _ = owner.notified() => {},
                        _ = generation.changed() => {},
                    }
                    self.assert_open()?;
                    continue;
                }
            }

            enum Outcome<T> {
                Returned(T, Vec<HarnessEvent>),
                Blocked,
            }

            let outcome: SessionResult<Outcome<T>> = self
                .session
                .mutate(|mutator| {
                    {
                        let inner = self.inner.lock().unwrap();
                        if inner.idle_owner.is_some() {
                            return Ok(Outcome::Blocked);
                        }
                        if let Some(error) = inner.closed_error.clone() {
                            return Err(SessionError::Other(error));
                        }
                    }
                    // Past the gate the planner runs at most once per command.
                    let plan = plan.take().expect("planner consumed on a blocked path");
                    let state = self.inner.lock().unwrap().state.clone();

                    let decision = plan(&state, mutator)?;
                    match decision {
                        LaneCommand::Return { result } => Ok(Outcome::Returned(result, Vec::new())),
                        LaneCommand::Reject { error } => Err(SessionError::Other(error)),
                        LaneCommand::Commit { decision, next } => {
                            let commit = mutator.commit(decision.writes)?;
                            let result = (decision.materialize)(commit.clone());
                            let events = decision.events.map(|derive| derive(&commit)).unwrap_or_default();
                            {
                                let mut inner = self.inner.lock().unwrap();
                                inner.state = next;
                            }
                            self.signal_state_change();
                            Ok(Outcome::Returned(result, events))
                        }
                    }
                })
                .await;

            match outcome {
                Ok(Outcome::Returned(result, events)) => {
                    self.emit(events);
                    return Ok(result);
                }
                Ok(Outcome::Blocked) => continue,
                Err(error) => {
                    if let Some(closed) = self.closed_error() {
                        return Err(LaneError::Closed(self.name.clone(), closed));
                    }
                    return Err(error.into());
                }
            }
        }
    }

    /// Read-only variant of [`Lane::command`] (pi `readLane`).
    pub async fn read<T, F>(&self, read: F) -> LaneResult<T>
    where
        T: 'static,
        F: FnOnce(&RuntimeLaneState, &SessionMutator<'_>) -> SessionResult<T>,
    {
        self.command(move |state, mutator| Ok(LaneCommand::Return { result: read(state, mutator)? }))
            .await
    }

    // -- operation commands --

    /// Run a command against the current operation even after cancellation
    /// was requested (pi `settleOperation`): used to settle admitted
    /// effects and finish operations. The drive continuation remains the
    /// sole top-level state writer.
    pub async fn settle_operation<T, F>(&self, plan: F) -> LaneResult<T>
    where
        T: 'static,
        F: FnOnce(&RuntimeLaneState, &OperationState, &OperationMeta, &mut SessionMutator<'_>) -> SessionResult<OperationCommandFor<T>>,
    {
        let lane_name = self.name.clone();
        self.command(move |state, mutator| {
            let operation = state.operation.clone().ok_or_else(|| {
                SessionError::Invariant(format!("settle_operation on lane {lane_name:?} without an operation"))
            })?;
            let decision = plan(state, &operation.state, &operation.meta, mutator)?;
            let operation_id = operation.meta.operation_id.clone();
            match decision {
                OperationCommandFor::Return { result } => Ok(LaneCommand::Return { result }),
                OperationCommandFor::Commit { decision, operation_state, lane } => {
                    let next_inbox = lane.as_ref().and_then(|patch| patch.inbox.clone());
                    let next_tip = lane
                        .as_ref()
                        .and_then(|patch| patch.tip_id.clone())
                        .unwrap_or_else(|| state.tip_id.clone());
                    let mut writes = decision.writes;
                    writes.push(operation_state_write(&operation_id, &operation_state)?);
                    if let Some(inbox) = &next_inbox {
                        writes.push(lane_state_write(
                            &lane_name,
                            durable_lane_state(state, Some(operation_id.clone()), inbox.clone(), None),
                        )?);
                    }
                    let next = RuntimeLaneState {
                        tip_id: next_tip,
                        configuration: state.configuration.clone(),
                        inbox: next_inbox.unwrap_or_else(|| state.inbox.clone()),
                        last_operation_id: state.last_operation_id.clone(),
                        operation: Some(Operation { meta: operation.meta, state: operation_state }),
                    };
                    Ok(LaneCommand::Commit {
                        decision: CommitDecision {
                            writes,
                            materialize: decision.materialize,
                            events: decision.events,
                        },
                        next,
                    })
                }
                OperationCommandFor::Finish { writes, record, lane, materialize, events } => {
                    let inbox = lane
                        .as_ref()
                        .and_then(|patch| patch.inbox.clone())
                        .unwrap_or_else(|| state.inbox.clone());
                    let next_tip = lane
                        .as_ref()
                        .and_then(|patch| patch.tip_id.clone())
                        .unwrap_or_else(|| state.tip_id.clone());
                    let mut writes = writes;
                    let record_json =
                        serde_json::to_value(&record).map_err(|e| SessionError::Storage(e.to_string()))?;
                    writes.push(Write::Value(set_value(&operation_result_value(&operation_id), record_json)));
                    writes.push(lane_state_write(
                        &lane_name,
                        durable_lane_state(state, None, inbox.clone(), Some(operation_id.clone())),
                    )?);
                    let next = RuntimeLaneState {
                        tip_id: next_tip,
                        configuration: state.configuration.clone(),
                        inbox,
                        last_operation_id: Some(operation_id),
                        operation: None,
                    };
                    Ok(LaneCommand::Commit {
                        decision: CommitDecision { writes, materialize, events },
                        next,
                    })
                }
            }
        })
        .await
    }

    /// Run an ordinary operation command only while durable control is
    /// `running` (pi `continueOperation`): once cancellation is requested
    /// the planner is not invoked.
    pub async fn continue_operation<T, F>(&self, plan: F) -> LaneResult<ContinueOutcome<T>>
    where
        T: 'static,
        F: FnOnce(&RuntimeLaneState, &OperationState, &OperationMeta, &mut SessionMutator<'_>) -> SessionResult<OperationCommandFor<T>>,
    {
        self.settle_operation(move |state, current, meta, mutator| {
            if matches!(current.scope().control, Control::CancelRequested { .. }) {
                return Ok(OperationCommandFor::Return { result: ContinueOutcome::CancelRequested });
            }
            let decision = plan(state, current, meta, mutator)?;
            Ok(match decision {
                OperationCommandFor::Return { result } => OperationCommandFor::Return {
                    result: ContinueOutcome::Result(result),
                },
                OperationCommandFor::Commit { decision, operation_state, lane } => OperationCommandFor::Commit {
                    decision: CommitDecision {
                        writes: decision.writes,
                        materialize: Box::new(move |commit| ContinueOutcome::Result((decision.materialize)(commit))),
                        events: decision.events,
                    },
                    operation_state,
                    lane,
                },
                OperationCommandFor::Finish { writes, record, lane, materialize, events } => {
                    OperationCommandFor::Finish {
                        writes,
                        record,
                        lane,
                        materialize: Box::new(move |commit| ContinueOutcome::Result(materialize(commit))),
                        events,
                    }
                }
            })
        })
        .await
    }

    // -- acceptance --

    /// Accept a run request: validate, capture eligible queued input,
    /// commit the prompt entries, and install the `starting` operation
    /// (pi `acceptRun`). Emits `run_start`, the prompt entry lifecycle
    /// events, and (when input was captured) a `queue_update`.
    pub async fn accept(&self, request: RunRequest) -> LaneResult<OperationAdmission> {
        self.assert_open()?;
        let started_at = now_ms();
        let operation_id = self.session.next_id();

        let messages = self.prompt_messages(&request)?;
        for message in &messages {
            if is_pending_assistant(message) {
                return Err(LaneError::InvalidMessage { lane: self.name.clone(), reason: "pending_assistant" });
            }
        }
        let prompt: Vec<(String, AgentMessage)> =
            messages.into_iter().map(|message| (self.session.next_id(), message)).collect();

        let lane_name = self.name.clone();
        let operation_id_for_plan = operation_id.clone();
        let prompt_for_plan = prompt;
        self.command(move |state, mutator| {
            if let Some(operation) = &state.operation {
                return Ok(LaneCommand::Return {
                    result: Err(LaneError::LaneBusy {
                        lane: lane_name.clone(),
                        operation_id: operation.meta.operation_id.clone(),
                    }),
                });
            }

            let config = self.read_config();
            let steering_all = matches!(config.steering_mode, crate::harness::session::types::QueueMode::All);
            let follow_up_all = matches!(config.follow_up_mode, crate::harness::session::types::QueueMode::All);
            let (selected_items, inbox) = select_accepted_inbox(&state.inbox, steering_all, follow_up_all);

            let mut captured: Vec<(InboxItem, PendingEntry)> = Vec::new();
            for item in &selected_items {
                let stored = mutator.get_value(&pending_entry(&item.entry_id))?.ok_or_else(|| {
                    SessionError::Invariant(format!(
                        "Pending {:?} entry {} is missing its payload",
                        item.kind, item.entry_id
                    ))
                })?;
                let pending = decode_pending(&stored)?;
                if item.kind != InboxItemKind::Write {
                    if let PendingEntry::Custom { .. } = &pending {
                        return Err(SessionError::Invariant(format!(
                            "Queued {:?} entry {} is not a message",
                            item.kind, item.entry_id
                        )));
                    }
                }
                if let PendingEntry::Message { payload } = &pending {
                    if is_pending_assistant(payload) {
                        return Err(SessionError::Invariant(format!(
                            "Pending {:?} entry {} contains a pending assistant",
                            item.kind, item.entry_id
                        )));
                    }
                }
                captured.push((item.clone(), pending));
            }

            let has_captured_conversation = selected_items.iter().any(|item| item.kind != InboxItemKind::Write);
            if prompt_for_plan.is_empty() && !has_captured_conversation {
                return Ok(LaneCommand::Return {
                    result: Err(LaneError::InvalidMessage { lane: lane_name.clone(), reason: "empty" }),
                });
            }

            let mut new_entries: Vec<NewEntry> = captured
                .iter()
                .map(|(item, pending)| pending_entry_write(&item.entry_id, pending))
                .collect();
            new_entries.extend(prompt_for_plan.iter().map(|(id, message)| NewEntry {
                id: id.clone(),
                parent_id: None,
                body: EntryBody::Message { message: message.clone(), terminate: None },
            }));
            let entries = chain_entries(state.tip_id.clone(), new_entries);
            let parent_id = entries
                .last()
                .map(|entry| entry.id.clone())
                .ok_or_else(|| SessionError::Invariant("Run acceptance produced no trigger entry".into()))?;

            let meta = OperationMeta {
                operation_id: operation_id_for_plan.clone(),
                lane: lane_name.clone(),
                source_tip_id: state.tip_id.clone(),
                started_at,
                intent: OperationIntent::Run {
                    prompt_entry_ids: prompt_for_plan.iter().map(|(id, _)| id.clone()).collect(),
                },
            };
            let operation_state = OperationState::Starting {
                scope: crate::harness::session::types::OperationScope {
                    control: Control::Running,
                    settings: run_settings(&config),
                    latest_assistant_entry_id: None,
                },
            };
            let remaining_queues = read_lane_queues(mutator, &inbox)?;

            let mut writes: Vec<Write> = entries.iter().cloned().map(insert_entry).collect();
            for item in &selected_items {
                writes.push(Write::Value(delete_value(&pending_entry(&item.entry_id))));
            }
            writes.push(Write::Value(set_value(&branch_tip(&lane_name), Json::String(parent_id.clone()))));
            let meta_json =
                serde_json::to_value(&meta).map_err(|e| SessionError::Storage(e.to_string()))?;
            writes.push(Write::Value(set_value(&operation_meta_value(&operation_id_for_plan), meta_json)));
            writes.push(operation_state_write(&operation_id_for_plan, &operation_state)?);
            writes.push(lane_state_write(
                &lane_name,
                durable_lane_state(state, Some(operation_id_for_plan.clone()), inbox.clone(), None),
            )?);

            let next = RuntimeLaneState {
                tip_id: Some(parent_id),
                configuration: state.configuration.clone(),
                inbox,
                last_operation_id: state.last_operation_id.clone(),
                operation: Some(Operation { meta: meta.clone(), state: operation_state }),
            };

            let run_started_at = started_at;
            let events_lane = lane_name.clone();
            let events_operation_id = operation_id_for_plan.clone();
            let captured_count = selected_items.len();
            let admission = operation_id_for_plan.clone();
            Ok(LaneCommand::Commit {
                decision: CommitDecision {
                    writes,
                    materialize: Box::new(move |_| {
                        Ok(OperationAdmission { operation_id: admission, kind: "run", started_at: run_started_at })
                    }),
                    events: Some(Box::new(move |commit| {
                        let mut events = vec![HarnessEvent::RunStart {
                            lane: events_lane.clone(),
                            run_id: events_operation_id.clone(),
                            started_at: run_started_at,
                            recovery: None,
                        }];
                        events.extend(super::transcript::committed_entry_events(
                            &entries,
                            commit,
                            &events_lane,
                            Some(&events_operation_id),
                            0,
                        ));
                        if captured_count > 0 {
                            events.push(HarnessEvent::QueueUpdate {
                                lane: events_lane.clone(),
                                queues: remaining_queues,
                                recovery: None,
                            });
                        }
                        events
                    })),
                },
                next,
            })
        })
        .await?
    }

    fn prompt_messages(&self, request: &RunRequest) -> LaneResult<Vec<AgentMessage>> {
        let config = self.read_config();
        match request {
            RunRequest::Prompt { messages } => Ok(messages.clone()),
            RunRequest::Skill { name, additional_instructions } => {
                let skill = config
                    .resources
                    .skills
                    .iter()
                    .find(|skill| &skill.name == name)
                    .ok_or_else(|| LaneError::UnknownSkill(name.clone()))?;
                let content = std::fs::read_to_string(&skill.file_path)
                    .map_err(|e| LaneError::Other(format!("skill {name:?} could not be read: {e}")))?;
                Ok(vec![AgentMessage::user_text(crate::harness::skills::format_skill_invocation(
                    skill,
                    &content,
                    additional_instructions.as_deref(),
                ))])
            }
            RunRequest::PromptTemplate { name, args } => {
                let template = config
                    .resources
                    .prompt_templates
                    .iter()
                    .find(|template| &template.name == name)
                    .ok_or_else(|| LaneError::UnknownTemplate(name.clone()))?;
                let content =
                    crate::harness::prompt_templates::format_prompt_template_invocation(template, args);
                if content.is_empty() {
                    Ok(Vec::new())
                } else {
                    Ok(vec![AgentMessage::user_text(content)])
                }
            }
        }
    }

    /// Accept an unsummarized tree navigation (pi `acceptNavigation` for
    /// `summarize: false`): installs `navigation.ready_to_commit`.
    pub async fn accept_navigation(&self, request: NavigationRequest) -> LaneResult<OperationAdmission> {
        self.assert_open()?;
        let started_at = now_ms();
        let operation_id = self.session.next_id();

        let lane_name = self.name.clone();
        let target_id = request.target_id.clone();
        let label = request.label.clone();
        let operation_id_for_plan = operation_id.clone();
        self.command(move |state, mutator| {
            if let Some(operation) = &state.operation {
                return Ok(LaneCommand::Return {
                    result: Err(LaneError::LaneBusy {
                        lane: lane_name.clone(),
                        operation_id: operation.meta.operation_id.clone(),
                    }),
                });
            }
            if target_id.as_ref() == state.tip_id.as_ref() {
                return Ok(LaneCommand::Return {
                    result: Err(LaneError::InvalidNavigation { lane: lane_name.clone(), reason: "current_tip" }),
                });
            }
            if target_id.is_none() && label.is_some() {
                return Ok(LaneCommand::Return {
                    result: Err(LaneError::InvalidNavigation { lane: lane_name.clone(), reason: "root_label" }),
                });
            }
            if let Some(target) = &target_id {
                if !mutator.has_entry(target)? {
                    return Ok(LaneCommand::Return {
                        result: Err(LaneError::UnknownTarget(target.clone())),
                    });
                }
            }

            let meta = OperationMeta {
                operation_id: operation_id_for_plan.clone(),
                lane: lane_name.clone(),
                source_tip_id: state.tip_id.clone(),
                started_at,
                intent: OperationIntent::Navigation {
                    target_id: target_id.clone(),
                    summarize: false,
                    label: label.clone(),
                    custom_instructions: None,
                },
            };
            let operation_state = OperationState::NavigationReadyToCommit {
                scope: crate::harness::session::types::OperationScope {
                    control: Control::Running,
                    settings: run_settings(&self.read_config()),
                    latest_assistant_entry_id: None,
                },
                target_id: target_id.clone(),
                label: label.clone(),
            };

            let meta_json =
                serde_json::to_value(&meta).map_err(|e| SessionError::Storage(e.to_string()))?;
            let writes = vec![
                Write::Value(set_value(&operation_meta_value(&operation_id_for_plan), meta_json)),
                operation_state_write(&operation_id_for_plan, &operation_state)?,
                lane_state_write(
                    &lane_name,
                    durable_lane_state(state, Some(operation_id_for_plan.clone()), state.inbox.clone(), None),
                )?,
            ];

            let next = RuntimeLaneState {
                tip_id: state.tip_id.clone(),
                configuration: state.configuration.clone(),
                inbox: state.inbox.clone(),
                last_operation_id: state.last_operation_id.clone(),
                operation: Some(Operation { meta: meta.clone(), state: operation_state }),
            };
            let events_lane = lane_name.clone();
            let events_operation_id = operation_id_for_plan.clone();
            let events_target = target_id.clone();
            let admission = operation_id_for_plan.clone();
            Ok(LaneCommand::Commit {
                decision: CommitDecision {
                    writes,
                    materialize: Box::new(move |_| {
                        Ok(OperationAdmission { operation_id: admission, kind: "navigation", started_at })
                    }),
                    events: Some(Box::new(move |_| {
                        vec![HarnessEvent::NavigationStart {
                            lane: events_lane,
                            run_id: events_operation_id,
                            target_id: events_target,
                            started_at,
                            recovery: None,
                        }]
                    })),
                },
                next,
            })
        })
        .await?
    }

    // -- queueing --

    /// Queue a steer / follow-up / next-run message (pi `enqueue`). The
    /// payload lands in a pending-entry value; the inbox records its id.
    pub async fn enqueue(&self, kind: QueueKind, message: AgentMessage) -> LaneResult<String> {
        self.assert_open()?;
        if is_pending_assistant(&message) {
            return Err(LaneError::InvalidMessage { lane: self.name.clone(), reason: "pending_assistant" });
        }
        let entry_id = self.session.next_id();
        let lane_name = self.name.clone();
        let inbox_kind = kind.as_inbox_kind();
        let queued_message = message;
        let queued_entry_id = entry_id.clone();
        self.command(move |state, mutator| {
            let mut inbox = state.inbox.clone();
            inbox.push(InboxItem { entry_id: entry_id.clone(), kind: inbox_kind });
            let mut queues = read_lane_queues(mutator, &state.inbox)?;
            queues.push(LaneQueuedItem::Message {
                entry_id: queued_entry_id.clone(),
                kind: inbox_kind,
                message: queued_message.clone(),
            });
            let pending = serde_json::to_value(PendingEntry::Message { payload: queued_message.clone() })
                .map_err(|e| SessionError::Storage(e.to_string()))?;
            let current = state.operation.as_ref().map(|operation| operation.meta.operation_id.clone());
            Ok(LaneCommand::Commit {
                decision: CommitDecision {
                    writes: vec![
                        Write::Value(set_value(&pending_entry(&entry_id), pending)),
                        lane_state_write(&lane_name, durable_lane_state(state, current, inbox.clone(), None))?,
                    ],
                    materialize: Box::new(move |_| entry_id.clone()),
                    events: Some(Box::new(move |_| {
                        vec![HarnessEvent::QueueUpdate {
                            lane: lane_name.clone(),
                            queues,
                            recovery: None,
                        }]
                    })),
                },
                next: RuntimeLaneState {
                    tip_id: state.tip_id.clone(),
                    configuration: state.configuration.clone(),
                    inbox,
                    last_operation_id: state.last_operation_id.clone(),
                    operation: state.operation.clone(),
                },
            })
        })
        .await
    }

    /// Cancel one queued item (pi `cancelQueued`).
    pub async fn cancel_queued(&self, entry_id: &str) -> LaneResult<CancelledQueued> {
        self.assert_open()?;
        let lane_name = self.name.clone();
        let target = entry_id.to_string();
        self.command(move |state, mutator| {
            let queued = state.inbox.iter().find(|item| item.entry_id == target).cloned();
            let Some(queued) = queued else {
                let consumed = mutator.has_entry(&target)?;
                return Ok(LaneCommand::Return {
                    result: Ok(if consumed { CancelledQueued::AlreadyConsumed } else { CancelledQueued::NotFound }),
                });
            };
            if mutator.get_value(&pending_entry(&target))?.is_none() {
                return Err(SessionError::Invariant(format!(
                    "Queued {:?} entry {target} is missing its payload",
                    queued.kind
                )));
            }
            let inbox: Vec<InboxItem> =
                state.inbox.iter().filter(|item| item.entry_id != target).cloned().collect();
            let queues = read_lane_queues(mutator, &inbox)?;
            let current = state.operation.as_ref().map(|operation| operation.meta.operation_id.clone());
            Ok(LaneCommand::Commit {
                decision: CommitDecision {
                    writes: vec![
                        Write::Value(delete_value(&pending_entry(&target))),
                        lane_state_write(&lane_name, durable_lane_state(state, current, inbox.clone(), None))?,
                    ],
                    materialize: Box::new(|_| Ok(CancelledQueued::Cancelled)),
                    events: Some(Box::new(move |_| {
                        vec![HarnessEvent::QueueUpdate { lane: lane_name.clone(), queues, recovery: None }]
                    })),
                },
                next: RuntimeLaneState {
                    tip_id: state.tip_id.clone(),
                    configuration: state.configuration.clone(),
                    inbox,
                    last_operation_id: state.last_operation_id.clone(),
                    operation: state.operation.clone(),
                },
            })
        })
        .await?
    }

    // -- usage --

    /// Record one adjustment usage row (pi `recordUsage`). Emits a `usage`
    /// event carrying the row (with storage-assigned seq) and totals.
    pub async fn record_usage(
        &self,
        usage: Usage,
        entry_id: Option<String>,
        details: Option<Json>,
    ) -> LaneResult<String> {
        self.assert_open()?;
        let usage_id = self.session.next_id();
        let row = UsageRowNoSeq {
            id: usage_id.clone(),
            usage: usage.clone(),
            entry_id: entry_id.clone(),
            adjustment: true,
            details: details.clone(),
        };
        let events_usage = usage.clone();
        let usage_id_out = usage_id.clone();
        self.command(move |state, _mutator| {
            let materialize_id = usage_id.clone();
            let events_id = usage_id.clone();
            Ok(LaneCommand::Commit {
                decision: CommitDecision {
                    writes: vec![insert_usage(row)],
                    materialize: Box::new(move |_| materialize_id.clone()),
                    events: Some(Box::new(move |commit| {
                        vec![HarnessEvent::Usage {
                            row: crate::harness::session::types::UsageRow {
                                id: events_id.clone(),
                                seq: commit.seqs.first().copied().unwrap_or(0),
                                usage: events_usage,
                                entry_id,
                                adjustment: true,
                                details,
                            },
                            totals: commit.stats.usage.clone(),
                            recovery: None,
                        }]
                    })),
                },
                next: state.clone(),
            })
        })
        .await?;
        Ok(usage_id_out)
    }

    // -- aborts --

    /// Durable cancellation primitive (pi `requestOperationAbort`): flips
    /// control to `cancel_requested`, returns queued steer/follow-up
    /// messages to the caller, keeps write items in the inbox, and pulls
    /// the active drive's effect gate into aborting. Emits
    /// `operation_abort` (plus `queue_update` when items were returned).
    pub async fn request_operation_abort(&self, operation_id: &str) -> LaneResult<AbortRequest> {
        self.assert_open()?;

        let lane_name = self.name.clone();
        let target = operation_id.to_string();
        let outcome = self
            .command(move |state, mutator| {
                let Some(operation) = &state.operation else {
                    return Ok(LaneCommand::Return {
                        result: Err(LaneError::OperationMismatch { lane: lane_name.clone(), expected: target.clone() }),
                    });
                };
                if operation.meta.operation_id != target {
                    return Ok(LaneCommand::Return {
                        result: Err(LaneError::OperationMismatch { lane: lane_name.clone(), expected: target.clone() }),
                    });
                }
                if matches!(operation.state.scope().control, Control::CancelRequested { .. }) {
                    return Ok(LaneCommand::Return {
                        result: Ok(AbortRequest { newly_requested: false, steer: Vec::new(), follow_up: Vec::new() }),
                    });
                }

                let removed: Vec<InboxItem> = state
                    .inbox
                    .iter()
                    .filter(|item| matches!(item.kind, InboxItemKind::Steer | InboxItemKind::FollowUp))
                    .cloned()
                    .collect();
                let mut steer = Vec::new();
                let mut follow_up = Vec::new();
                for item in &removed {
                    let stored = mutator.get_value(&pending_entry(&item.entry_id))?.ok_or_else(|| {
                        SessionError::Invariant(format!(
                            "Pending {:?} entry {} is missing its message",
                            item.kind, item.entry_id
                        ))
                    })?;
                    match decode_pending(&stored)? {
                        PendingEntry::Message { payload } => {
                            if item.kind == InboxItemKind::Steer {
                                steer.push(payload);
                            } else {
                                follow_up.push(payload);
                            }
                        }
                        PendingEntry::Custom { .. } => {
                            return Err(SessionError::Invariant(format!(
                                "Pending {:?} entry {} is not a message",
                                item.kind, item.entry_id
                            )))
                        }
                    }
                }
                let removed_ids: Vec<String> = removed.iter().map(|item| item.entry_id.clone()).collect();
                let inbox: Vec<InboxItem> = state
                    .inbox
                    .iter()
                    .filter(|item| !removed_ids.contains(&item.entry_id))
                    .cloned()
                    .collect();
                let queues = read_lane_queues(mutator, &inbox)?;

                let mut operation_state = operation.state.clone();
                let requested_at = now_ms();
                match &mut operation_state {
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
                    | OperationState::NavigationReadyToCommit { scope, .. } => {
                        scope.control = Control::CancelRequested { requested_at };
                    }
                }

                let mut writes: Vec<Write> = removed
                    .iter()
                    .map(|item| Write::Value(delete_value(&pending_entry(&item.entry_id))))
                    .collect();
                writes.push(operation_state_write(&target, &operation_state)?);
                writes.push(lane_state_write(
                    &lane_name,
                    durable_lane_state(state, Some(target.clone()), inbox.clone(), None),
                )?);

                let next = RuntimeLaneState {
                    tip_id: state.tip_id.clone(),
                    configuration: state.configuration.clone(),
                    inbox,
                    last_operation_id: state.last_operation_id.clone(),
                    operation: Some(Operation { meta: operation.meta.clone(), state: operation_state }),
                };
                let result = Ok(AbortRequest { newly_requested: true, steer, follow_up });
                let event_removed = !removed.is_empty();
                Ok(LaneCommand::Commit {
                    decision: CommitDecision {
                        writes,
                        materialize: Box::new(move |_| result),
                        events: Some(Box::new(move |_| {
                            let mut events = Vec::new();
                            if event_removed {
                                events.push(HarnessEvent::QueueUpdate {
                                    lane: lane_name.clone(),
                                    queues,
                                    recovery: None,
                                });
                            }
                            events
                        })),
                    },
                    next,
                })
            })
            .await??;

        // Pull the active drive's admission gate once the marker is durable.
        let active = self.inner.lock().unwrap().active_drive.clone();
        if let Some(drive) = active {
            if drive.operation_id == operation_id {
                drive.gate.begin_abort();
                drive.gate.signal_abort();
            }
        }
        Ok(outcome)
    }

    // -- append & query --

    /// Append a message entry outside any operation, capturing queued
    /// write items first (pi `appendMessage`).
    pub async fn append_message(&self, message: AgentMessage) -> LaneResult<String> {
        self.append(PendingEntry::Message { payload: message }).await
    }

    pub async fn append_custom_entry(&self, custom_type: &str, data: Option<Json>) -> LaneResult<String> {
        self.append(PendingEntry::Custom { custom_type: custom_type.to_string(), payload: data }).await
    }

    async fn append(&self, pending: PendingEntry) -> LaneResult<String> {
        self.assert_open()?;
        if let PendingEntry::Message { payload } = &pending {
            if is_pending_assistant(payload) {
                return Err(SessionError::PendingAssistantMessage.into());
            }
        }
        let id = self.session.next_id();
        let lane_name = self.name.clone();
        let pending_for_plan = pending;
        let id_for_plan = id.clone();
        self.command(move |state, mutator| {
            if state.operation.is_none() {
                let queued: Vec<InboxItem> = state
                    .inbox
                    .iter()
                    .filter(|item| item.kind == InboxItemKind::Write)
                    .cloned()
                    .collect();
                let mut captured = Vec::new();
                for item in &queued {
                    let stored = mutator.get_value(&pending_entry(&item.entry_id))?.ok_or_else(|| {
                        SessionError::Invariant(format!("Pending write {} is missing its payload", item.entry_id))
                    })?;
                    captured.push(pending_entry_write(&item.entry_id, &decode_pending(&stored)?));
                }
                let inbox: Vec<InboxItem> = state
                    .inbox
                    .iter()
                    .filter(|item| item.kind != InboxItemKind::Write)
                    .cloned()
                    .collect();
                let mut new_entries = captured;
                new_entries.push(pending_entry_write(&id_for_plan, &pending_for_plan));
                let entries = chain_entries(state.tip_id.clone(), new_entries);

                let mut writes: Vec<Write> = entries.iter().cloned().map(insert_entry).collect();
                for item in &queued {
                    writes.push(Write::Value(delete_value(&pending_entry(&item.entry_id))));
                }
                writes.push(Write::Value(set_value(&branch_tip(&lane_name), Json::String(id_for_plan.clone()))));
                writes.push(lane_state_write(&lane_name, durable_lane_state(state, None, inbox.clone(), None))?);

                let next = RuntimeLaneState {
                    tip_id: Some(id_for_plan.clone()),
                    configuration: state.configuration.clone(),
                    inbox,
                    last_operation_id: state.last_operation_id.clone(),
                    operation: None,
                };
                let out = id_for_plan.clone();
                let events_entries = entries;
                return Ok(LaneCommand::Commit {
                    decision: CommitDecision {
                        writes,
                        materialize: Box::new(move |_| out.clone()),
                        events: Some(Box::new(move |commit| {
                            super::transcript::committed_entry_events(&events_entries, commit, &lane_name, None, 0)
                        })),
                    },
                    next,
                });
            }

            // While an operation owns the lane the append queues as a write.
            let mut inbox = state.inbox.clone();
            inbox.push(InboxItem { entry_id: id_for_plan.clone(), kind: InboxItemKind::Write });
            let pending_json =
                serde_json::to_value(&pending_for_plan).map_err(|e| SessionError::Storage(e.to_string()))?;
            let current = state.operation.as_ref().map(|operation| operation.meta.operation_id.clone());
            let next = RuntimeLaneState {
                tip_id: state.tip_id.clone(),
                configuration: state.configuration.clone(),
                inbox: inbox.clone(),
                last_operation_id: state.last_operation_id.clone(),
                operation: state.operation.clone(),
            };
            let out = id_for_plan.clone();
            Ok(LaneCommand::Commit {
                decision: CommitDecision {
                    writes: vec![
                        Write::Value(set_value(&pending_entry(&id_for_plan), pending_json)),
                        lane_state_write(&lane_name, durable_lane_state(state, current, inbox, None))?,
                    ],
                    materialize: Box::new(move |_| out.clone()),
                    events: None,
                },
                next,
            })
        })
        .await
    }

    /// Scan the lane's branch path (pi `findEntries`).
    pub fn find_entries(&self, query: BranchScan) -> LaneResult<Vec<Entry>> {
        self.assert_open()?;
        let tip = self.inner.lock().unwrap().state.tip_id.clone();
        let Some(start) = tip else {
            return Ok(Vec::new());
        };
        Ok(self.session.scan_branch(&StorageBranchScan { start, query })?)
    }

    pub fn find_entry(&self, mut query: BranchScan) -> LaneResult<Option<Entry>> {
        query.limit = Some(1);
        Ok(self.find_entries(query)?.into_iter().next())
    }

    // -- configuration --

    pub fn configuration(&self) -> LaneConfiguration {
        self.inner.lock().unwrap().state.configuration.clone()
    }

    pub async fn set_model(&self, provider: &str, model_id: &str) -> LaneResult<()> {
        self.set_configuration(|config| LaneConfiguration {
            provider: provider.into(),
            model_id: model_id.into(),
            ..config
        })
        .await
    }

    pub async fn set_thinking_level(&self, level: crate::harness::types::ThinkingLevel) -> LaneResult<()> {
        self.set_configuration(|config| LaneConfiguration { thinking_level: level, ..config }).await
    }

    pub async fn set_active_tools(&self, names: Vec<String>) -> LaneResult<()> {
        self.set_configuration(|config| LaneConfiguration { active_tool_names: names, ..config }).await
    }

    async fn set_configuration<F>(&self, update: F) -> LaneResult<()>
    where
        F: FnOnce(LaneConfiguration) -> LaneConfiguration,
    {
        self.assert_open()?;
        let lane_name = self.name.clone();
        self.command(move |state, _mutator| {
            let previous = state.configuration.clone();
            let configuration = update(previous);
            let config_json =
                serde_json::to_value(&configuration).map_err(|e| SessionError::Storage(e.to_string()))?;
            let next = RuntimeLaneState {
                tip_id: state.tip_id.clone(),
                configuration: configuration.clone(),
                inbox: state.inbox.clone(),
                last_operation_id: state.last_operation_id.clone(),
                operation: state.operation.clone(),
            };
            let event_config = configuration.clone();
            Ok(LaneCommand::Commit {
                decision: CommitDecision {
                    writes: vec![Write::Value(set_value(&lane_config(&lane_name), config_json))],
                    materialize: Box::new(|_| ()),
                    events: Some(Box::new(move |_| {
                        vec![HarnessEvent::ConfigUpdateLane {
                            lane: lane_name.clone(),
                            property: super::events::ConfigUpdateProperty::Model {
                                value: super::types::ModelIdentity {
                                    provider: event_config.provider.clone(),
                                    model_id: event_config.model_id.clone(),
                                },
                                previous: serde_json::json!({}),
                            },
                            recovery: None,
                        }]
                    })),
                },
                next,
            })
        })
        .await
    }

    /// Drive one operation through its durable procedures (pi
    /// `Lane.drive`): claim install/observe/occupied/settled under the
    /// mutation line, run the dispatcher on a fresh pass, and await its
    /// completion. A second caller for the same operation observes the
    /// installed pass.
    pub async fn drive(self: &Arc<Self>, operation_id: &str, wait_for_retry: bool) -> LaneResult<DriveOutcome> {
        enum DriveClaim {
            Observe { drive: Arc<super::types::Drive>, installed: bool },
            Occupied { drive: Arc<super::types::Drive> },
            Settled { record: OperationResultRecord },
            Mismatch,
        }

        loop {
            self.assert_open()?;
            let target = operation_id.to_string();
            let claim = self
                .command(move |state, mutator| {
                    let matches_current =
                        state.operation.as_ref().is_some_and(|operation| operation.meta.operation_id == target);
                    if matches_current {
                        let active = self.inner.lock().unwrap().active_drive.clone();
                        let decision = match active {
                            None => {
                                let drive = Arc::new(super::types::Drive::standalone(target.clone(), wait_for_retry));
                                self.inner.lock().unwrap().active_drive = Some(Arc::clone(&drive));
                                self.signal_state_change();
                                DriveClaim::Observe { drive, installed: true }
                            }
                            Some(drive) if drive.operation_id == target => {
                                DriveClaim::Observe { drive, installed: false }
                            }
                            Some(drive) => DriveClaim::Occupied { drive },
                        };
                        return Ok(LaneCommand::Return { result: decision });
                    }
                    match mutator.get_value(&operation_result_value(&target))? {
                        Some(stored) => {
                            let record = serde_json::from_value(stored.value).map_err(|e| {
                                SessionError::Storage(format!("operation result decode failed: {e}"))
                            })?;
                            Ok(LaneCommand::Return { result: DriveClaim::Settled { record } })
                        }
                        None => Ok(LaneCommand::Return { result: DriveClaim::Mismatch }),
                    }
                })
                .await?;

            match claim {
                DriveClaim::Settled { record } => return Ok(DriveOutcome::Settled { outcome: record }),
                DriveClaim::Mismatch => {
                    return Err(LaneError::OperationMismatch { lane: self.name.clone(), expected: operation_id.into() })
                }
                DriveClaim::Occupied { drive } => {
                    self.await_completion(&drive).await?;
                    continue;
                }
                DriveClaim::Observe { drive, installed } => {
                    if installed {
                        let lane = Arc::clone(self);
                        let task_drive = Arc::clone(&drive);
                        tokio::spawn(async move {
                            let outcome = super::drive::drive_operation(&lane, &task_drive).await;
                            lane.clear_drive(&task_drive);
                            task_drive.settle(outcome);
                        });
                    }
                    return self.await_completion(&drive).await;
                }
            }
        }
    }

    async fn await_completion(&self, drive: &Arc<super::types::Drive>) -> LaneResult<DriveOutcome> {
        let mut completion = drive.subscribe();
        loop {
            if let Some(outcome) = completion.borrow().clone() {
                return Ok(outcome);
            }
            if completion.changed().await.is_err() {
                return Err(LaneError::Closed(self.name.clone(), "drive completion dropped".into()));
            }
        }
    }

    // -- idle coordination & sealing --

    /// Wait until no operation is installed and no drive pass is active
    /// (pi `waitForIdle`).
    pub async fn wait_for_idle(&self) -> LaneResult<()> {
        loop {
            self.assert_open()?;
            let waiter = {
                let inner = self.inner.lock().unwrap();
                if inner.state.operation.is_none() && inner.active_drive.is_none() {
                    return Ok(());
                }
                inner.active_drive.clone()
            };
            let mut generation = self.state_change.subscribe();
            if waiter.is_none() {
                // Re-check under the subscription to avoid a missed wake.
                let quiet = {
                    let inner = self.inner.lock().unwrap();
                    inner.state.operation.is_none() && inner.active_drive.is_none()
                };
                if quiet {
                    return Ok(());
                }
            }
            generation
                .changed()
                .await
                .map_err(|_| LaneError::Closed(self.name.clone(), "lane closed".into()))?;
        }
    }

    /// Claim exclusive idle access for one callback (pi `runWhenIdle`):
    /// commands block until the callback completes.
    pub async fn run_when_idle<F, Fut>(&self, callback: F) -> LaneResult<()>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        loop {
            self.assert_open()?;
            let claim = {
                let mut inner = self.inner.lock().unwrap();
                if inner.state.operation.is_some() || inner.active_drive.is_some() {
                    None
                } else if inner.idle_owner.is_some() {
                    None
                } else {
                    let notify = Arc::new(tokio::sync::Notify::new());
                    inner.idle_owner = Some(Arc::clone(&notify));
                    Some(notify)
                }
            };
            match claim {
                Some(owner) => {
                    self.signal_state_change();
                    callback().await;
                    {
                        let mut inner = self.inner.lock().unwrap();
                        let released =
                            matches!(&inner.idle_owner, Some(current) if Arc::ptr_eq(current, &owner));
                        if released {
                            inner.idle_owner = None;
                        }
                    }
                    owner.notify_waiters();
                    self.signal_state_change();
                    return Ok(());
                }
                None => {
                    let mut generation = self.state_change.subscribe();
                    generation
                        .changed()
                        .await
                        .map_err(|_| LaneError::Closed(self.name.clone(), "lane closed".into()))?;
                }
            }
        }
    }

    /// Seal the lane: no further commands; the active drive's gate closes
    /// (pi `seal`).
    pub async fn seal(&self, error: String) {
        let active_drive = {
            let mut inner = self.inner.lock().unwrap();
            if inner.closed_error.is_none() {
                inner.closed_error = Some(error.clone());
            }
            inner.active_drive.clone()
        };
        if let Some(drive) = active_drive {
            drive.close_gate(error);
        }
        self.signal_state_change();
    }

    // -- drive install/observe support (used by the drive claim loop) --

    pub(crate) fn active_drive(&self) -> Option<Arc<super::types::Drive>> {
        self.inner.lock().unwrap().active_drive.clone()
    }

    pub(crate) fn install_drive(&self, drive: Arc<super::types::Drive>) {
        let previous = {
            let mut inner = self.inner.lock().unwrap();
            std::mem::replace(&mut inner.active_drive, Some(drive))
        };
        let _ = previous;
        self.signal_state_change();
    }

    pub(crate) fn clear_drive(&self, drive: &Arc<super::types::Drive>) {
        let cleared = {
            let mut inner = self.inner.lock().unwrap();
            matches!(&inner.active_drive, Some(current) if Arc::ptr_eq(current, drive))
                && inner.active_drive.take().is_some()
        };
        if cleared {
            self.signal_state_change();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::session::memory::MemoryStorage;
    use crate::harness::session::values::operation_state as operation_state_addr;
    use crate::harness::session::SessionMetadata;
    use crate::harness::session::types::TerminalStatus;

    struct TestLane {
        lane: Arc<Lane>,
        events: tokio::sync::mpsc::UnboundedReceiver<HarnessEvent>,
    }

    fn test_config() -> Arc<RwLock<RuntimeConfig>> {
        Arc::new(RwLock::new(RuntimeConfig::default()))
    }

    fn test_lane() -> TestLane {
        let session = Session::new(
            SessionMetadata { id: "s".into(), created_at: 0, storage_version: 1, cwd: None, parent_session_id: None },
            Arc::new(MemoryStorage::new()),
        );
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let lane = Lane::new(
            "main",
            session,
            Arc::new(super::super::hooks::HookRegistry::new()),
            test_config(),
            LaneSnapshotState::default(),
            tx,
        )
        .unwrap();
        TestLane { lane, events: rx }
    }

    fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<HarnessEvent>) -> Vec<HarnessEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    async fn accept_prompt(lane: &Lane, text: &str) -> OperationAdmission {
        lane.accept(RunRequest::Prompt { messages: vec![AgentMessage::user_text(text)] }).await.unwrap()
    }

    async fn finish_operation(lane: &Lane, status: TerminalStatus) -> OperationResultRecord {
        let operation_id = lane.current_operation_id().unwrap().unwrap();
        let record = crate::harness::session::types::OperationResultRecord {
            operation_id: operation_id.clone(),
            kind: "run".into(),
            status,
            error: None,
            from_tip_id: None,
            tip_id: lane.tip_id().unwrap(),
            started_at: 1,
            ended_at: 2,
        };
        lane.settle_operation(move |_state, _current, meta, _mutator| {
            Ok(OperationCommandFor::Finish {
                writes: Vec::new(),
                record: crate::harness::session::types::OperationResultRecord {
                    operation_id: meta.operation_id.clone(),
                    kind: "run".into(),
                    status,
                    error: None,
                    from_tip_id: meta.source_tip_id.clone(),
                    tip_id: None,
                    started_at: meta.started_at,
                    ended_at: 3,
                },
                lane: None,
                materialize: Box::new(|_| ()),
                events: None,
            })
        })
        .await
        .unwrap();
        record
    }

    #[tokio::test]
    async fn accept_installs_starting_operation_and_emits_events() {
        let TestLane { lane, mut events } = test_lane();
        let admission = accept_prompt(&lane, "hello").await;
        assert_eq!(admission.kind, "run");

        let tip = lane.tip_id().unwrap().unwrap();
        let entries = lane.find_entries(BranchScan::default()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, tip);
        assert_eq!(entries[0].as_message().unwrap().role(), "user");

        let state_json = lane
            .session
            .get_value_raw(&operation_state_addr(&admission.operation_id))
            .unwrap()
            .unwrap()
            .value;
        assert_eq!(state_json["at"], "starting");
        assert_eq!(state_json["scope"]["control"]["status"], "running");
        assert_eq!(
            lane.session
                .get_value_raw(&crate::harness::session::values::lane_state("main"))
                .unwrap()
                .unwrap()
                .value["currentOperationId"],
            serde_json::json!(admission.operation_id)
        );

        let fired = drain(&mut events);
        let types: Vec<&str> = fired.iter().map(|event| event.event_type()).collect();
        assert_eq!(types, ["run_start", "message_start", "message_end", "entry_added"]);

        // A second run cannot be accepted while the operation is open.
        let busy = lane.accept(RunRequest::Prompt { messages: vec![AgentMessage::user_text("again")] }).await.unwrap_err();
        assert!(matches!(busy, LaneError::LaneBusy { .. }));
    }

    #[tokio::test]
    async fn empty_prompts_are_rejected() {
        let TestLane { lane, .. } = test_lane();
        let error = lane.accept(RunRequest::Prompt { messages: vec![] }).await.unwrap_err();
        assert!(matches!(error, LaneError::InvalidMessage { reason: "empty", .. }));
    }

    #[tokio::test]
    async fn accept_captures_queued_input_in_order() {
        let TestLane { lane, .. } = test_lane();
        let steer_id = lane.enqueue(QueueKind::Steer, AgentMessage::user_text("steer")).await.unwrap();
        let _follow_up = lane.enqueue(QueueKind::FollowUp, AgentMessage::user_text("later")).await.unwrap();
        let admission = accept_prompt(&lane, "go").await;

        // Both queued items are captured ahead of the fresh prompt (queue
        // modes are `all` in the default config).
        let entries = lane.find_entries(BranchScan { oldest_first: true, ..Default::default() }).unwrap();
        let texts: Vec<&str> = entries.iter().filter_map(|entry| entry.as_message().map(|m| m.role())).collect();
        assert_eq!(texts, ["user", "user", "user"]);
        assert_eq!(entries[0].id, steer_id);
        assert!(lane.inner.lock().unwrap().state.inbox.is_empty());
        let _ = admission;
    }

    #[tokio::test]
    async fn continue_operation_short_circuits_after_cancel_but_settle_runs() {
        let TestLane { lane, .. } = test_lane();
        accept_prompt(&lane, "work").await;

        lane.request_operation_abort(lane.current_operation_id().unwrap().unwrap().as_str())
            .await
            .unwrap();

        let outcome: ContinueOutcome<()> = lane
            .continue_operation(|_state, _current, _meta, _mutator| {
                panic!("continue planner must not run after cancellation");
            })
            .await
            .unwrap();
        assert!(matches!(outcome, ContinueOutcome::CancelRequested));

        // settle_operation still reaches its planner for reconciliation.
        lane.settle_operation(|_state, _current, _meta, _mutator| {
            Ok(OperationCommandFor::Return { result: () })
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn finish_records_result_and_idles_the_lane() {
        let TestLane { lane, .. } = test_lane();
        let admission = accept_prompt(&lane, "work").await;
        finish_operation(&lane, TerminalStatus::Completed).await;

        assert!(lane.current_operation_id().unwrap().is_none());
        let record = lane.get_result(&admission.operation_id).await.unwrap().unwrap();
        assert_eq!(record.status, TerminalStatus::Completed);
        assert_eq!(record.kind, "run");

        let lane_state = lane
            .session
            .get_value_raw(&crate::harness::session::values::lane_state("main"))
            .unwrap()
            .unwrap()
            .value;
        assert_eq!(lane_state["currentOperationId"], serde_json::json!(null));
        assert_eq!(lane_state["lastOperationId"], serde_json::json!(admission.operation_id));

        // The lane accepts new work again.
        accept_prompt(&lane, "next").await;
    }

    #[tokio::test]
    async fn abort_returns_steer_and_follow_up_keeps_writes() {
        let TestLane { lane, .. } = test_lane();
        accept_prompt(&lane, "work").await;
        let _steer = lane.enqueue(QueueKind::Steer, AgentMessage::user_text("redirect")).await.unwrap();
        let _follow_up = lane.enqueue(QueueKind::FollowUp, AgentMessage::user_text("after")).await.unwrap();
        let write_id = lane.append_custom_entry("todo", Some(serde_json::json!({"n": 1}))).await.unwrap();

        // Appends during an operation queue as writes.
        assert!(lane.tip_id().unwrap().is_some());
        let inbox = lane.inner.lock().unwrap().state.inbox.clone();
        assert_eq!(inbox.len(), 3);

        let abort = lane
            .request_operation_abort(lane.current_operation_id().unwrap().unwrap().as_str())
            .await
            .unwrap();
        assert!(abort.newly_requested);
        assert_eq!(abort.steer.len(), 1);
        assert_eq!(abort.follow_up.len(), 1);

        let inbox = lane.inner.lock().unwrap().state.inbox.clone();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].entry_id, write_id);
        assert_eq!(inbox[0].kind, InboxItemKind::Write);

        let state_json = lane
            .session
            .get_value_raw(&operation_state_addr(lane.current_operation_id().unwrap().unwrap().as_str()))
            .unwrap()
            .unwrap()
            .value;
        assert_eq!(state_json["scope"]["control"]["status"], "cancel_requested");

        // Idempotent: a second abort request reports not-new.
        let again = lane
            .request_operation_abort(lane.current_operation_id().unwrap().unwrap().as_str())
            .await
            .unwrap();
        assert!(!again.newly_requested);
    }

    #[tokio::test]
    async fn append_captures_queued_writes_once_idle() {
        let TestLane { lane, .. } = test_lane();
        accept_prompt(&lane, "work").await;
        let queued = lane.append_message(AgentMessage::user_text("note")).await.unwrap();

        // Still operating: the append waits in the inbox.
        let entries = lane.find_entries(BranchScan::default()).unwrap();
        assert_eq!(entries.len(), 1);

        finish_operation(&lane, TerminalStatus::Completed).await;
        let after = lane.append_message(AgentMessage::user_text("final")).await.unwrap();

        let entries = lane.find_entries(BranchScan { oldest_first: true, ..Default::default() }).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[1].id, queued);
        assert_eq!(entries[2].id, after);
        assert_eq!(entries[2].parent_id.as_deref(), Some(queued.as_str()));
        assert!(lane.inner.lock().unwrap().state.inbox.is_empty());
    }

    #[tokio::test]
    async fn cancel_queued_reports_consumed_and_missing() {
        let TestLane { lane, .. } = test_lane();
        let id = lane.enqueue(QueueKind::Steer, AgentMessage::user_text("x")).await.unwrap();
        assert_eq!(lane.cancel_queued(&id).await.unwrap(), CancelledQueued::Cancelled);
        assert_eq!(lane.cancel_queued(&id).await.unwrap(), CancelledQueued::NotFound);
        assert_eq!(lane.cancel_queued("never").await.unwrap(), CancelledQueued::NotFound);
    }

    #[tokio::test]
    async fn record_usage_writes_ledger_row_and_event() {
        let TestLane { lane, mut events } = test_lane();
        let usage = Usage { input: 10, output: 5, total_tokens: 15, ..Default::default() };
        lane.record_usage(usage.clone(), None, None).await.unwrap();

        let rows = lane
            .session
            .mutate(|mutator| mutator.scan_usage(&crate::harness::session::types::UsageScan::default()))
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].usage.input, 10);
        assert!(rows[0].adjustment);
        assert!(rows[0].seq > 0);

        let fired = drain(&mut events);
        assert_eq!(fired.len(), 1);
        match &fired[0] {
            HarnessEvent::Usage { row, totals, .. } => {
                assert_eq!(row.usage.input, 10);
                assert_eq!(totals.input, 10);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn navigation_acceptance_validates_targets() {
        let TestLane { lane, .. } = test_lane();
        let first = lane.append_message(AgentMessage::user_text("one")).await.unwrap();
        let tip = lane.append_message(AgentMessage::user_text("two")).await.unwrap();

        let admission = lane
            .accept_navigation(NavigationRequest { target_id: Some(first.clone()), label: None })
            .await
            .unwrap();
        assert_eq!(admission.kind, "navigation");
        let state_json = lane
            .session
            .get_value_raw(&operation_state_addr(&admission.operation_id))
            .unwrap()
            .unwrap()
            .value;
        assert_eq!(state_json["at"], "navigation.ready_to_commit");

        // While that operation is open, further navigation reports busy.
        assert!(matches!(
            lane.accept_navigation(NavigationRequest { target_id: Some(tip.clone()), label: None }).await,
            Err(LaneError::LaneBusy { .. })
        ));
        lane.settle_operation(|_state, _current, meta, _mutator| {
            Ok(OperationCommandFor::Finish {
                writes: Vec::new(),
                record: crate::harness::session::types::OperationResultRecord {
                    operation_id: meta.operation_id.clone(),
                    kind: "navigation".into(),
                    status: TerminalStatus::Declined,
                    error: None,
                    from_tip_id: meta.source_tip_id.clone(),
                    tip_id: None,
                    started_at: meta.started_at,
                    ended_at: 0,
                },
                lane: None,
                materialize: Box::new(|_| ()),
                events: None,
            })
        })
        .await
        .unwrap();

        // With the lane idle, the current tip, unknown entries, and labeled
        // roots are all rejected.
        assert!(matches!(
            lane.accept_navigation(NavigationRequest { target_id: Some(tip.clone()), label: None }).await,
            Err(LaneError::InvalidNavigation { reason: "current_tip", .. })
        ));
        assert!(matches!(
            lane.accept_navigation(NavigationRequest { target_id: Some("ghost".into()), label: None }).await,
            Err(LaneError::UnknownTarget(_))
        ));
        assert!(matches!(
            lane.accept_navigation(NavigationRequest { target_id: None, label: Some("root".into()) }).await,
            Err(LaneError::InvalidNavigation { reason: "root_label", .. })
        ));
    }

    #[tokio::test]
    async fn configuration_updates_persist_and_emit() {
        let TestLane { lane, mut events } = test_lane();
        lane.set_model("openai", "gpt-test").await.unwrap();
        assert_eq!(lane.configuration().model_id, "gpt-test");

        let stored = lane
            .session
            .get_value_raw(&crate::harness::session::values::lane_config("main"))
            .unwrap()
            .unwrap()
            .value;
        assert_eq!(stored["modelId"], "gpt-test");

        let fired = drain(&mut events);
        assert_eq!(fired[0].event_type(), "config_update");
    }

    #[tokio::test]
    async fn sealing_closes_the_lane() {
        let TestLane { lane, .. } = test_lane();
        lane.seal("harness fault".into()).await;
        assert!(matches!(lane.tip_id(), Err(LaneError::Closed(..))));
        assert!(matches!(
            lane.accept(RunRequest::Prompt { messages: vec![AgentMessage::user_text("x")] }).await,
            Err(LaneError::Closed(..))
        ));
    }

    #[tokio::test]
    async fn idle_claim_blocks_commands_until_released() {
        let TestLane { lane, .. } = test_lane();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();

        let owner_lane = Arc::clone(&lane);
        let idle = tokio::spawn(async move {
            owner_lane.run_when_idle(|| async move { release_rx.await.unwrap(); }).await
        });
        // Let the claim land.
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }

        let blocked_lane = Arc::clone(&lane);
        let mut command = tokio::spawn(async move { blocked_lane.append_message(AgentMessage::user_text("probe")).await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut command).await.is_err(),
            "command must wait for the idle claim"
        );

        release_tx.send(()).unwrap();
        idle.await.unwrap().unwrap();
        assert!(command.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn snapshot_round_trips_lane_state() {
        let TestLane { lane, .. } = test_lane();
        accept_prompt(&lane, "persisted").await;
        let snapshot = Lane::read_snapshot(&lane.session, "main").unwrap();
        assert!(snapshot.tip_id.is_some());
        assert!(snapshot.operation.is_some());
        assert_eq!(snapshot.operation.unwrap().state.at(), "starting");
    }
}
