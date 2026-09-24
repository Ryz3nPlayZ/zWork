//! Port of pi `harness/runtime/drive.ts` — the drive dispatcher: one
//! installed pass walked through direct durable procedures until
//! settlement or a durable wait.
//!
//! Procedures land incrementally; unported leaves fail the pass with
//! `SliceNotImplemented` (pi's own pattern for staged slices) rather than
//! pretending progress. The no-progress invariant is enforced exactly as
//! upstream: a `continue` that leaves both state and control unchanged is
//! a session invariant violation.

pub mod boundary;
pub mod checkpoint;
pub mod structural;

use std::sync::Arc;

use crate::harness::session::types::{Control, OperationState, SessionError};

use super::drive::checkpoint::{run_checkpoint, start_run};
use super::lane::Lane;
use super::types::{Drive, DriveOutcome, ProcedureResult};

/// Expected internal control flow for not-yet-ported procedure slices
/// (pi `SliceNotImplemented`).
#[derive(Debug, thiserror::Error)]
#[error("{operation} is not implemented until its later AgentHarness slice")]
pub struct SliceNotImplemented {
    pub operation: &'static str,
}

fn current_operation(lane: &Lane, drive: &Drive) -> Result<crate::harness::session::types::Operation, SessionError> {
    lane.operation_snapshot().ok_or_else(|| {
        SessionError::Invariant(format!("Drive {} has no matching current operation", drive.operation_id))
    })
}

/// Drive one installed pass through direct durable procedures until
/// settlement or a durable wait (pi `driveOperation`).
pub async fn drive_operation(lane: &Arc<Lane>, drive: &Arc<Drive>) -> DriveOutcome {
    let result = drive_operation_inner(lane, drive).await;
    match result {
        Ok(outcome) => outcome,
        Err(error) => {
            let message = match error {
                SessionError::Invariant(message) => format!("session invariant violated: {message}"),
                other => other.to_string(),
            };
            DriveOutcome::Failed { code: "fault".into(), message }
        }
    }
}

async fn drive_operation_inner(lane: &Arc<Lane>, drive: &Arc<Drive>) -> Result<DriveOutcome, SessionError> {
    let mut operation = current_operation(lane, drive)?;
    if matches!(operation.state.scope().control, Control::Running) {
        // before_drive is fail-closed on gate admission; an abort requested
        // here routes the next iteration to reconciliation (pi awaits the
        // cancellation future — the durable marker carries the same signal).
        if let Err(error) = lane.hooks.run_before_drive_with_gate(
            &super::hooks::HookContext { lane: lane.name.clone(), run_id: drive.operation_id.clone() },
            &super::hooks::BeforeDriveEvent {
                operation: match operation.meta.intent {
                    crate::harness::session::types::OperationIntent::Run { .. } => {
                        super::hooks::OperationKind::Run
                    }
                    crate::harness::session::types::OperationIntent::Compaction { .. } => {
                        super::hooks::OperationKind::Compaction
                    }
                    crate::harness::session::types::OperationIntent::Navigation { .. } => {
                        super::hooks::OperationKind::Navigation
                    }
                },
            },
            &drive.gate,
        ) {
            match error {
                super::hooks::HookFailure::Gate(_) => {
                    // Abort/close raced admission: continue; the next
                    // iteration reads the durable control state.
                }
                super::hooks::HookFailure::Handler(message) => {
                    return Err(SessionError::Other(message));
                }
            }
        }
    }

    loop {
        operation = current_operation(lane, drive)?;
        let state = operation.state.clone();
        let result: ProcedureResult = if matches!(state.scope().control, Control::CancelRequested { .. }) {
            // Durable cancellation routes to reconcile, which settles
            // admitted effects and finishes the operation; it arrives with
            // the reconciliation slice.
            return Err(SessionError::Other(
                SliceNotImplemented { operation: "reconcile" }.to_string(),
            ));
        } else {
            match &state {
                OperationState::Starting { .. } => start_run(lane, drive).await?,
                OperationState::Checkpoint { checkpoint, scope, .. } => {
                    run_checkpoint(lane, drive, scope, checkpoint, lane.context_window()).await?
                }
                OperationState::AssistantReady { .. } | OperationState::AssistantRetryWait { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "generation" }.to_string(),
                    ));
                }
                OperationState::AssistantEffectPending { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "assistant recovery" }.to_string(),
                    ));
                }
                OperationState::Tools { .. } => {
                    return Err(SessionError::Other(SliceNotImplemented { operation: "tools" }.to_string()));
                }
                OperationState::DeferredSuspended { .. } | OperationState::DeferredEffectPending { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "deferred" }.to_string(),
                    ));
                }
                OperationState::SummaryDeciding { .. }
                | OperationState::SummaryReady { .. }
                | OperationState::SummaryEffectPending { .. }
                | OperationState::SummaryRetryWait { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "structural generation" }.to_string(),
                    ));
                }
                OperationState::NavigationReadyToCommit { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "navigation commit" }.to_string(),
                    ));
                }
            }
        };

        match result {
            ProcedureResult::Settled { outcome } => return Ok(DriveOutcome::Settled { outcome }),
            ProcedureResult::Waiting { outcome } => return Ok(outcome),
            ProcedureResult::Continue => {}
        }

        let next = current_operation(lane, drive)?.state;
        if next == state && !matches!(next.scope().control, Control::CancelRequested { .. }) {
            return Err(SessionError::Invariant(format!(
                "Drive procedure made no progress from {}",
                state.at()
            )));
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::agent_types::AgentMessage;
    use crate::harness::runtime::events::HarnessEvent;
    use crate::harness::runtime::hooks::HookRegistry;
    use crate::harness::runtime::lane::{Lane, LaneError, LaneSnapshotState, QueueKind, RunRequest};
    use crate::harness::runtime::types::RuntimeConfig;
    use crate::harness::session::memory::MemoryStorage;
    use crate::harness::session::session::Session;
    use crate::harness::session::types::{BranchScan, OperationState, SessionMetadata, TerminalStatus};
    use crate::harness::session::values::operation_state as operation_state_addr;
    use std::sync::{Arc, RwLock};

    fn test_lane() -> (Arc<Lane>, tokio::sync::mpsc::UnboundedReceiver<HarnessEvent>) {
        let session = Session::new(
            SessionMetadata { id: "s".into(), created_at: 0, storage_version: 1, cwd: None, parent_session_id: None },
            Arc::new(MemoryStorage::new()),
        );
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let lane = Lane::new(
            "main",
            session,
            Arc::new(HookRegistry::new()),
            Arc::new(RwLock::new(RuntimeConfig::default())),
            LaneSnapshotState::default(),
            tx,
        )
        .unwrap();
        (lane, rx)
    }

    async fn accept(lane: &Arc<Lane>, text: &str) -> String {
        lane.accept(RunRequest::Prompt { messages: vec![AgentMessage::user_text(text)] })
            .await
            .unwrap()
            .operation_id
    }

    fn durable_state(lane: &Arc<Lane>, operation_id: &str) -> OperationState {
        serde_json::from_value(
            lane.session
                .get_value_raw(&operation_state_addr(operation_id))
                .unwrap()
                .unwrap()
                .value,
        )
        .unwrap()
    }

    fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<HarnessEvent>) -> Vec<&'static str> {
        let mut types = Vec::new();
        while let Ok(event) = rx.try_recv() {
            types.push(event.event_type());
        }
        types
    }

    #[tokio::test]
    async fn drive_walks_starting_through_checkpoint_to_generation_slice() {
        let (lane, mut events) = test_lane();
        let operation_id = accept(&lane, "hello").await;

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match &outcome {
            DriveOutcome::Failed { message, .. } => assert!(message.contains("generation"), "{message}"),
            other => panic!("expected slice failure, got {other:?}"),
        }

        // The pass persisted its progress before hitting the unported slice.
        match durable_state(&lane, &operation_id) {
            OperationState::AssistantReady { generation, next_attempt, .. } => {
                let entries = lane.find_entries(BranchScan { oldest_first: true, ..Default::default() }).unwrap();
                assert_eq!(generation.trigger_entry_id, entries[0].id);
                assert_eq!(next_attempt, 1);
            }
            other => panic!("expected assistant.ready, got {}", other.at()),
        }
        assert!(drain(&mut events).contains(&"message_start"));
    }

    #[tokio::test]
    async fn steering_renews_generation_at_the_boundary() {
        let (lane, _events) = test_lane();
        let operation_id = accept(&lane, "work").await;
        let steer = lane.enqueue(QueueKind::Steer, AgentMessage::user_text("redirect")).await.unwrap();

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        assert!(matches!(outcome, DriveOutcome::Failed { .. }));

        match durable_state(&lane, &operation_id) {
            OperationState::AssistantReady { generation, .. } => {
                assert_eq!(generation.trigger_entry_id, steer);
            }
            other => panic!("expected assistant.ready, got {}", other.at()),
        }
        // The steer was consumed: the tree now holds prompt + steer.
        assert_eq!(lane.find_entries(BranchScan::default()).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn follow_ups_wait_for_a_triggerless_boundary() {
        let (lane, _events) = test_lane();
        let operation_id = accept(&lane, "work").await;
        let steer = lane.enqueue(QueueKind::Steer, AgentMessage::user_text("now")).await.unwrap();
        let follow_up = lane.enqueue(QueueKind::FollowUp, AgentMessage::user_text("later")).await.unwrap();

        lane.drive(&operation_id, false).await.unwrap();
        // The steer triggered generation; the follow-up stayed queued.
        match durable_state(&lane, &operation_id) {
            OperationState::AssistantReady { generation, .. } => assert_eq!(generation.trigger_entry_id, steer),
            other => panic!("expected assistant.ready, got {}", other.at()),
        }
        assert!(lane
            .find_entries(BranchScan::default())
            .unwrap()
            .iter()
            .all(|entry| entry.id != follow_up));
    }

    #[tokio::test]
    async fn empty_may_finish_boundary_settles_the_run() {
        let (lane, mut events) = test_lane();
        let operation_id = accept(&lane, "just this").await;

        // Force a may-finish checkpoint (what tool-free assistant
        // settlement produces upstream).
        let trigger = {
            let entries = lane.find_entries(BranchScan { oldest_first: true, ..Default::default() }).unwrap();
            entries[0].id.clone()
        };
        lane.settle_operation(|_state, _current, _meta, _mutator| {
            Ok(crate::harness::runtime::lane::OperationCommandFor::Commit {
                decision: super::super::types::CommitDecision {
                    writes: Vec::new(),
                    materialize: Box::new(|_| ()),
                    events: None,
                },
                operation_state: OperationState::Checkpoint {
                    scope: crate::harness::session::types::OperationScope {
                        control: crate::harness::session::types::Control::Running,
                        settings: crate::harness::session::types::RunSettings {
                            compaction: crate::harness::compaction::CompactionSettings::default(),
                            steering_mode: crate::harness::session::types::QueueMode::All,
                            follow_up_mode: crate::harness::session::types::QueueMode::All,
                            tool_execution: crate::harness::session::types::ToolExecutionMode::Sequential,
                        },
                        latest_assistant_entry_id: None,
                    },
                    checkpoint: crate::harness::session::types::CheckpointData {
                        continuation: crate::harness::session::types::Continuation::MayFinish {
                            include_final_assistant: false,
                        },
                        trigger_entry_id: trigger.clone(),
                    },
                },
                lane: None,
            })
        })
        .await
        .unwrap();
                let outcome = lane.drive(&operation_id, false).await.unwrap();
        match outcome {
            DriveOutcome::Settled { outcome } => {
                assert_eq!(outcome.status, TerminalStatus::Completed);
                assert_eq!(outcome.kind, "run");
            }
            other => panic!("expected settlement, got {other:?}"),
        }
        assert!(lane.operation_snapshot().is_none());
        let types = drain(&mut events);
        assert!(types.contains(&"run_end"));

        // Re-driving a settled operation replays its record.
        let again = lane.drive(&operation_id, false).await.unwrap();
        assert!(matches!(again, DriveOutcome::Settled { .. }));
    }

    #[tokio::test]
    async fn drive_rejects_unknown_operations() {
        let (lane, _events) = test_lane();
        let error = lane.drive("ghost", false).await.unwrap_err();
        assert!(matches!(error, LaneError::OperationMismatch { .. }));
    }

    #[tokio::test]
    async fn cancellation_routes_to_reconcile_slice() {
        let (lane, _events) = test_lane();
        let operation_id = accept(&lane, "work").await;
        lane.request_operation_abort(&operation_id).await.unwrap();

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match outcome {
            DriveOutcome::Failed { message, .. } => assert!(message.contains("reconcile"), "{message}"),
            other => panic!("expected reconcile slice failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn threshold_hands_off_to_summary_deciding() {
        let (lane, mut events) = test_lane();
        {
            let handle = lane.config_handle();
            let mut config = handle.write().unwrap();
            config.context_window = Some(60);
            config.compaction = crate::harness::compaction::CompactionSettings {
                enabled: true,
                reserve_tokens: 50,
                keep_recent_tokens: 10,
            };
        }
        // Seed enough history that a cut point exists below the window.
        lane.append_message(AgentMessage::user_text("a fairly long opening turn of conversation"))
            .await
            .unwrap();
        lane.append_message(AgentMessage::user_text("and a second turn with more text to summarize"))
            .await
            .unwrap();
        let operation_id = accept(&lane, "now run").await;

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        assert!(matches!(outcome, DriveOutcome::Failed { .. }));

        match durable_state(&lane, &operation_id) {
            OperationState::SummaryDeciding { task, .. } => {
                assert_eq!(task.reason.as_deref(), Some("threshold"));
            }
            other => panic!("expected summary.deciding, got {}", other.at()),
        }
        assert!(drain(&mut events).contains(&"compaction_start"));
    }

    fn meta_used() -> &'static str {
        ""
    }
}
