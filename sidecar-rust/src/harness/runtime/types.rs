//! Port of pi `harness/runtime/types.ts` — drive-pass plumbing and the
//! planner decision vocabulary.
//!
//! Deviations from pi: `Context` threading dropped (single-process; the
//! gate's `AbortSignal` carries cancellation), deferred/background
//! generation is excluded (zWork never uses provider-side async
//! generation), and TS's closure-typed `materialize` decisions become
//! boxed `FnOnce`s.

use std::sync::Arc;

use crate::harness::session::commit::Write;
use crate::harness::session::types::{
    CommitResult, InboxItem, LaneConfiguration, Operation, OperationResultRecord, OperationState,
};

use super::effect_gate::SharedGate;

/// Terminal outcome of one drive pass (pi `DriveOutcome`; the `deferred`
/// variant is excluded with the deferred-generation feature).
#[derive(Debug, Clone)]
pub enum DriveOutcome {
    Settled { outcome: OperationResultRecord },
    WaitingRetry { operation_id: String, not_before: u64 },
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

    pub fn settle(&self, outcome: DriveOutcome) {
        let _ = self.completion.send(Some(outcome));
    }

    /// Close the gate and fail the completion (pi `closeGate`).
    pub fn close_gate(&self, error: String) {
        self.gate.close(error);
        if !self.close_signal.is_aborted() {
            self.close_signal.abort();
        }
        let _ = self.completion.send(Some(DriveOutcome::WaitingRetry {
            operation_id: self.operation_id.clone(),
            not_before: u64::MAX, // sentinel: never retry after close
        }));
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
/// caller's value once the writes are durable.
pub struct CommitDecision<TResult> {
    pub writes: Vec<Write>,
    pub materialize: Box<dyn FnOnce(CommitResult) -> TResult + Send>,
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
    },
    Return {
        result: TResult,
    },
}
