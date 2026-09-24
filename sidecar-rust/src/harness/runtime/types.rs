//! Port of pi `harness/runtime/types.ts` — drive-pass plumbing and the
//! planner decision vocabulary.
//!
//! Deviations from pi: `Context` threading dropped (single-process; the
//! gate's `AbortSignal` carries cancellation), deferred/background
//! generation is excluded (zWork never uses provider-side async
//! generation), and TS's closure-typed `materialize` decisions become
//! boxed `FnOnce`s.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::harness::compaction::CompactionSettings;
use crate::harness::prompt_templates::PromptTemplate;
use crate::harness::session::commit::Write;
use crate::harness::session::types::{
    CommitResult, HarnessStreamOptionsSnapshot, InboxItem, LaneConfiguration, NormalizedRetryPolicy, Operation,
    OperationResultRecord, OperationState, QueueMode, ToolExecutionMode,
};
use crate::harness::skills::Skill;

use super::effect_gate::SharedGate;

/// pi-ai `DEFAULT_MAX_AGENT_RETRY_DELAY_MS`.
pub const DEFAULT_MAX_AGENT_RETRY_DELAY_MS: u64 = 60_000;

/// Resolves a (provider, model id) pair to the live model record.
pub type ModelSource =
    Arc<dyn Fn(&str, &str) -> Option<crate::harness::types::Model> + Send + Sync>;

/// Serializable identity of one provider model (pi `ModelIdentity`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ModelIdentity {
    pub provider: String,
    pub model_id: String,
}

/// Serializable snapshot of the harness retry policy (pi-ai `RetryPolicy`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicySnapshot {
    pub enabled: bool,
    pub max_retries: u32,
    pub base_delay_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_agent_delay_ms: Option<u64>,
}

impl RetryPolicySnapshot {
    /// Drive-machine retry parameters (pi `normalizedRetryPolicy`): disabled
    /// means a single attempt; the agent-side delay cap defaults to 60s.
    pub fn normalized(&self) -> NormalizedRetryPolicy {
        NormalizedRetryPolicy {
            max_attempts: if self.enabled { self.max_retries.saturating_add(1) } else { 1 },
            base_delay_ms: self.base_delay_ms,
            max_agent_delay_ms: self.max_agent_delay_ms.unwrap_or(DEFAULT_MAX_AGENT_RETRY_DELAY_MS),
        }
    }
}

/// Static resources exposed to prompts and hooks (pi `Resources`).
#[derive(Clone, Default)]
pub struct Resources {
    pub skills: Arc<Vec<Skill>>,
    pub prompt_templates: Arc<Vec<PromptTemplate>>,
}

impl std::fmt::Debug for Resources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Resources")
            .field("skills", &self.skills.len())
            .field("prompt_templates", &self.prompt_templates.len())
            .finish()
    }
}

/// Process-local harness configuration consulted by lane procedures
/// (pi runtime `Config<TContext>`). Tools join when the tool procedures
/// land; providers already live in the harness.
#[derive(Clone)]
pub struct RuntimeConfig {
    pub stream_options: HarnessStreamOptionsSnapshot,
    pub retry_policy: RetryPolicySnapshot,
    pub compaction: CompactionSettings,
    pub steering_mode: QueueMode,
    pub follow_up_mode: QueueMode,
    pub tool_execution: ToolExecutionMode,
    pub system_prompt: Option<String>,
    pub entry_projectors: Arc<BTreeMap<String, crate::harness::session::context::EntryProjector>>,
    pub resources: Resources,
    /// Context window of the configured model (pi reads the model
    /// registry; the facade supplies the resolved window here).
    pub context_window: Option<u64>,
    /// Resolves a lane's configured model identity (pi `lane.models`).
    pub model_source: Option<ModelSource>,
    /// Provider streaming entry point (pi `lane.models.streamSimple`).
    pub stream: Option<crate::harness::agent_types::StreamFn>,
    /// Tool declarations available to lanes (pi `config.tools`; the tool
    /// procedures attach executors alongside).
    pub tool_declarations: Arc<Vec<crate::harness::types::Tool>>,
}

impl std::fmt::Debug for RuntimeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeConfig")
            .field("stream_options", &self.stream_options)
            .field("retry_policy", &self.retry_policy)
            .field("compaction", &self.compaction)
            .field("steering_mode", &self.steering_mode)
            .field("follow_up_mode", &self.follow_up_mode)
            .field("tool_execution", &self.tool_execution)
            .field("system_prompt", &self.system_prompt)
            .field("entry_projectors", &self.entry_projectors.keys().collect::<Vec<_>>())
            .field("resources", &self.resources)
            .finish()
    }
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        RuntimeConfig {
            stream_options: Default::default(),
            retry_policy: Default::default(),
            compaction: CompactionSettings::default(),
            steering_mode: QueueMode::All,
            follow_up_mode: QueueMode::All,
            tool_execution: ToolExecutionMode::Sequential,
            system_prompt: None,
            entry_projectors: Arc::new(BTreeMap::new()),
            resources: Default::default(),
            context_window: None,
            model_source: None,
            stream: None,
            tool_declarations: Arc::new(Vec::new()),
        }
    }
}

/// Terminal outcome of one drive pass (pi `DriveOutcome`; the `deferred`
/// variant is excluded with the deferred-generation feature).
#[derive(Debug, Clone)]
pub enum DriveOutcome {
    Settled { outcome: OperationResultRecord },
    WaitingRetry { operation_id: String, not_before: u64 },
    /// The drive pass faulted (pi rejects the completion promise).
    Failed { code: String, message: String },
}

/// One installed process-local drive pass over an operation (pi `Drive`).
/// The lane settles or fails the completion; the gate serializes effect
/// admission; `close_signal` fires when the owning harness closes.
pub struct Drive {
    pub operation_id: String,
    /// True when the host wants to own retry wake scheduling.
    pub wait_for_retry: bool,
    pub gate: SharedGate,
    pub close_signal: crate::harness::types::AbortSignal,
    completion: tokio::sync::watch::Sender<Option<DriveOutcome>>,
}

impl Drive {
    pub fn new(operation_id: impl Into<String>, wait_for_retry: bool) -> (Arc<Drive>, tokio::sync::watch::Receiver<Option<DriveOutcome>>) {
        let (tx, rx) = tokio::sync::watch::channel(None);
        let drive = Arc::new(Drive {
            operation_id: operation_id.into(),
            wait_for_retry,
            gate: super::effect_gate::SharedGate::new(super::effect_gate::EffectGate::new()),
            close_signal: crate::harness::types::AbortSignal::new(),
            completion: tx,
        });
        (drive, rx)
    }

    /// Build a drive without an external completion receiver (the claim
    /// loop installs it; observers subscribe later).
    pub fn standalone(operation_id: impl Into<String>, wait_for_retry: bool) -> Drive {
        let (tx, _rx) = tokio::sync::watch::channel(None);
        Drive {
            operation_id: operation_id.into(),
            wait_for_retry,
            gate: super::effect_gate::SharedGate::new(super::effect_gate::EffectGate::new()),
            close_signal: crate::harness::types::AbortSignal::new(),
            completion: tx,
        }
    }

    pub fn settle(&self, outcome: DriveOutcome) {
        let _ = self.completion.send(Some(outcome));
    }

    /// Subscribe to the completion of this pass (pi `Drive.completion`).
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<Option<DriveOutcome>> {
        self.completion.subscribe()
    }

    /// Close the gate and fail the completion (pi `closeGate`).
    pub fn close_gate(&self, error: String) {
        self.gate.close(error.clone());
        if !self.close_signal.is_aborted() {
            self.close_signal.abort();
        }
        let _ = self.completion.send(Some(DriveOutcome::Failed { code: "closed".into(), message: error }));
    }

    /// Fail the completion after an unexpected procedure error (pi
    /// `drive.fail`).
    pub fn fail(&self, message: String) {
        let _ = self.completion.send(Some(DriveOutcome::Failed { code: "fault".into(), message }));
    }
}

/// Result of one dispatcher procedure step (pi `ProcedureResult`).
#[derive(Debug, Clone)]
pub enum ProcedureResult {
    Continue,
    Waiting { outcome: DriveOutcome },
    Settled { outcome: OperationResultRecord },
}

/// The current durable state owned by one lane (pi runtime `LaneState` —
/// distinct from the session store's inbox-state value `pi.lane.state`).
#[derive(Debug, Clone)]
pub struct RuntimeLaneState {
    pub tip_id: Option<String>,
    pub configuration: LaneConfiguration,
    pub inbox: Vec<InboxItem>,
    pub last_operation_id: Option<String>,
    pub operation: Option<Operation>,
}

/// Patch applied to lane projection fields when a decision commits.
#[derive(Debug, Default, Clone)]
pub struct LanePatch {
    pub tip_id: Option<Option<String>>,
    pub inbox: Option<Vec<InboxItem>>,
}

/// An effect-free decision made on a lane's serialized mutation line
/// (pi `CommitDecision`). `materialize` maps the commit result to the
/// caller's value once the writes are durable; `events` derives harness
/// events from storage-assigned commit metadata (seq/timestamp).
pub struct CommitDecision<TResult> {
    pub writes: Vec<Write>,
    pub materialize: Box<dyn FnOnce(CommitResult) -> TResult + Send>,
    pub events: Option<Box<dyn FnOnce(&CommitResult) -> Vec<super::events::HarnessEvent> + Send>>,
}

impl<TResult> CommitDecision<TResult> {
    /// Decision with no harness events.
    pub fn quiet(
        writes: Vec<Write>,
        materialize: Box<dyn FnOnce(CommitResult) -> TResult + Send>,
    ) -> Self {
        CommitDecision { writes, materialize, events: None }
    }
}

/// One lane command (pi `LaneCommand`).
pub enum LaneCommand<TResult> {
    Commit {
        decision: CommitDecision<TResult>,
        next: RuntimeLaneState,
    },
    Return {
        result: TResult,
    },
    Reject {
        error: String,
    },
}

/// One durable operation transition (pi `OperationCommand`): either a
/// commit that advances `operation_state` (optionally patching lane
/// projection fields), a terminal finish with its result record, or a
/// plain return.
pub enum OperationCommand<TResult> {
    Commit {
        decision: CommitDecision<TResult>,
        operation_state: OperationState,
        lane: Option<LanePatch>,
    },
    Finish {
        writes: Vec<Write>,
        record: OperationResultRecord,
        lane: Option<LanePatch>,
        materialize: Box<dyn FnOnce(CommitResult) -> TResult + Send>,
        events: Option<Box<dyn FnOnce(&CommitResult) -> Vec<super::events::HarnessEvent> + Send>>,
    },
    Return {
        result: TResult,
    },
}
