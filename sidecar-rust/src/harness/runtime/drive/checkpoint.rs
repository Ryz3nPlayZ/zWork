//! Port of pi `harness/runtime/drive/checkpoint.ts` — `start_run` and
//! `run_checkpoint`: the two procedures that turn a starting operation
//! into its first boundary, and advance one boundary with at most one
//! commit.

use std::sync::Arc;

use crate::harness::session::commit::insert_entry;
use crate::harness::session::commit::NewEntry;
use crate::harness::session::types::{
    CheckpointData, Continuation, EntryBody, OperationScope, OperationState, SessionError, SessionResult,
};
use crate::harness::session::values::{branch_tip, set_value};

use super::super::events::HarnessEvent;
use super::super::hooks::{BeforeRunEvent, HookContext};
use super::super::lane::{ContinueOutcome, Lane, OperationCommandFor};
use super::super::types::{CommitDecision, Drive, LanePatch, ProcedureResult};
use super::boundary::{
    assistant_ready_at_boundary, boundary_placement_events, finish_run_boundary, plan_boundary_inbox,
    BoundaryFinishPending,
};
use super::structural::prepare_compaction_threshold;

/// Consume `before_run` and commit the initial checkpoint (pi `startRun`).
pub async fn start_run(lane: &Arc<Lane>, drive: &Arc<Drive>) -> SessionResult<ProcedureResult> {
    // Resolve the prompt messages from the intent's entry ids.
    let prompt = lane
        .continue_operation(|_state, current, meta, mutator| {
            let OperationState::Starting { .. } = current else {
                return Err(SessionError::Invariant("start_run on a non-starting operation".into()));
            };
            let crate::harness::session::types::OperationIntent::Run { prompt_entry_ids } = &meta.intent else {
                return Err(SessionError::Invariant("Run operation has non-run intent".into()));
            };
            let mut messages = Vec::with_capacity(prompt_entry_ids.len());
            for id in prompt_entry_ids {
                let entries = mutator.get_entries(std::slice::from_ref(id))?;
                let Some(entry) = entries.into_iter().next() else {
                    return Err(SessionError::Invariant(format!("Run prompt entry {id} is missing its message")));
                };
                let Some(message) = entry.as_message() else {
                    return Err(SessionError::Invariant(format!("Run prompt entry {id} is missing its message")));
                };
                messages.push(message.clone());
            }
            Ok(OperationCommandFor::Return { result: messages })
        })
        .await;
    let prompt = match prompt {
        Ok(ContinueOutcome::CancelRequested) => return Ok(ProcedureResult::Continue),
        Ok(ContinueOutcome::Result(messages)) => messages,
        Err(error) => return Err(SessionError::Other(error.to_string())),
    };

    // before_run may inject messages ahead of the prompt.
    let hook = lane
        .hooks
        .run_before_run_with_gate(
            &HookContext { lane: lane.name.clone(), run_id: drive.operation_id.clone() },
            &BeforeRunEvent { prompt: prompt.clone(), resources: lane.read_config().resources },
            &drive.gate,
        )
        .map_err(|error| SessionError::Other(error.to_string()))?;
    let injected = hook.map(|result| result.messages).unwrap_or_default();
    for message in &injected {
        if matches!(message, crate::harness::agent_types::AgentMessage::Llm(crate::harness::types::Message::Assistant(am)) if am.stop_reason == crate::harness::types::StopReason::Pending)
        {
            return Err(SessionError::Invariant("before_run returned a pending assistant message".into()));
        }
    }
    let reserved: Vec<(String, crate::harness::agent_types::AgentMessage)> =
        injected.into_iter().map(|message| (lane.session.next_id(), message)).collect();

    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let outcome = lane
        .continue_operation(move |state, current, _meta, _mutator| {
            let scope = current.scope().clone();
            let mut parent = state.tip_id.clone();
            let mut entries: Vec<NewEntry> = Vec::with_capacity(reserved.len());
            for (id, message) in &reserved {
                entries.push(NewEntry {
                    id: id.clone(),
                    parent_id: parent.clone(),
                    body: EntryBody::Message { message: message.clone(), terminate: None },
                });
                parent = Some(id.clone());
            }
            let trigger_entry_id = entries.last().map(|entry| entry.id.clone()).or_else(|| state.tip_id.clone());
            let Some(trigger_entry_id) = trigger_entry_id else {
                return Err(SessionError::Invariant("Run start has no trigger entry".into()));
            };
            let next_state = OperationState::Checkpoint {
                scope: scope.clone(),
                checkpoint: CheckpointData {
                    continuation: Continuation::NeedAssistant { overflow_recovery_used: false },
                    trigger_entry_id: trigger_entry_id.clone(),
                },
            };
            let mut writes: Vec<crate::harness::session::commit::Write> =
                entries.iter().cloned().map(insert_entry).collect();
            if !entries.is_empty() {
                writes.push(crate::harness::session::commit::Write::Value(set_value(
                    &branch_tip(&lane_name),
                    serde_json::Value::String(trigger_entry_id.clone()),
                )));
            }
            let entries_for_events = entries;
            let events_lane = lane_name.clone();
            let events_run = operation_id.clone();
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes,
                    materialize: Box::new(|_| ()),
                    events: Some(Box::new(move |commit| {
                        super::super::transcript::committed_entry_events(
                            &entries_for_events,
                            commit,
                            &events_lane,
                            Some(&events_run),
                            0,
                        )
                    })),
                },
                operation_state: next_state,
                lane: Some(LanePatch { tip_id: Some(Some(trigger_entry_id)), inbox: None }),
            })
        })
        .await;

    match outcome {
        Ok(ContinueOutcome::CancelRequested) => Ok(ProcedureResult::Continue),
        Ok(ContinueOutcome::Result(())) => Ok(ProcedureResult::Continue),
        Err(error) => Err(SessionError::Other(error.to_string())),
    }
}

/// Advance one durable run boundary with at most one commit (pi
/// `runCheckpoint`): consume eligible input, detect the compaction
/// threshold, and either re-arm generation, hand off to the structural
/// summary, or finish the run.
pub async fn run_checkpoint(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    scope: &OperationScope,
    checkpoint: &CheckpointData,
    context_window: Option<u64>,
) -> SessionResult<ProcedureResult> {
    let threshold = match prepare_compaction_threshold(lane, drive, scope, checkpoint, context_window).await? {
        ContinueOutcome::CancelRequested => return Ok(ProcedureResult::Continue),
        ContinueOutcome::Result(value) => value,
    };

    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let threshold_for_plan = threshold.clone();
    let trigger_for_finish = checkpoint.trigger_entry_id.clone();
    let continuation = checkpoint.continuation.clone();
    let scope_for_finish = scope.clone();

    let planned: Result<ContinueOutcome<Option<BoundaryFinishPending>>, _> = lane
        .continue_operation(move |state, current, _meta, mutator| {
            let scope = current.scope().clone();
            let follow_up_when_no_trigger =
                threshold_for_plan.is_none() && matches!(current_checkpoint(current).continuation, Continuation::MayFinish { .. });
            let placement = plan_boundary_inbox(lane, state, &scope, mutator, follow_up_when_no_trigger)?;

            if let Some(trigger_entry_id) = &placement.trigger_entry_id {
                let ready = assistant_ready_at_boundary(
                    lane,
                    &state.configuration,
                    &scope,
                    trigger_entry_id,
                    false,
                );
                let writes = placement.writes.clone();
                let entries_for_events = placement.entries.clone();
                let queues = placement.queues.clone();
                let patch = LanePatch {
                    tip_id: placement.tip_id.clone().map(Some),
                    inbox: Some(placement.inbox.clone()),
                };
                let events_lane = lane_name.clone();
                let events_run = operation_id.clone();
                return Ok(OperationCommandFor::Commit {
                    decision: CommitDecision {
                        writes,
                        materialize: Box::new(|_| None),
                        events: Some(Box::new(move |commit| {
                            boundary_placement_events(
                                &entries_for_events,
                                queues.as_ref(),
                                commit,
                                0,
                                &events_lane,
                                &events_run,
                            )
                        })),
                    },
                    operation_state: ready,
                    lane: Some(patch),
                });
            }

            if let Some((task_id, preparation)) = &threshold_for_plan {
                let task = crate::harness::session::types::SummaryTask {
                    task_id: task_id.clone(),
                    reason: Some("threshold".into()),
                    custom_instructions: None,
                    boundary: crate::harness::session::types::ResultBoundary::ResumeCheckpoint {
                        resume_after: CheckpointData {
                            continuation: current_checkpoint(current).continuation.clone(),
                            trigger_entry_id: current_checkpoint(current).trigger_entry_id.clone(),
                        },
                    },
                };
                let preparation_json = serde_json::to_value(preparation)
                    .map_err(|e| SessionError::Storage(e.to_string()))?;
                let mut writes = placement.writes.clone();
                writes.push(crate::harness::session::commit::Write::Value(set_value(
                    &crate::harness::session::values::operation_preparation(&operation_id, task_id),
                    preparation_json,
                )));
                let structural = OperationState::SummaryDeciding { scope: scope.clone(), task };
                let started_at = crate::harness::session::session::now_ms();
                let events_lane = lane_name.clone();
                let events_run = operation_id.clone();
                let patch = LanePatch {
                    tip_id: placement.tip_id.clone().map(Some),
                    inbox: Some(placement.inbox.clone()),
                };
                return Ok(OperationCommandFor::Commit {
                    decision: CommitDecision {
                        writes,
                        materialize: Box::new(|_| None),
                        events: Some(Box::new(move |commit| {
                            let mut events: Vec<HarnessEvent> = Vec::new();
                            let _ = commit;
                            events.push(HarnessEvent::CompactionStart {
                                lane: events_lane,
                                run_id: events_run,
                                reason: super::super::events::StructuralReason::Threshold,
                                started_at,
                                recovery: None,
                            });
                            events
                        })),
                    },
                    operation_state: structural,
                    lane: Some(patch),
                });
            }

            let continuation = current_checkpoint(current).continuation.clone();
            if matches!(continuation, Continuation::NeedAssistant { .. }) {
                let Continuation::NeedAssistant { overflow_recovery_used } = continuation else {
                    unreachable!()
                };
                let ready = assistant_ready_at_boundary(
                    lane,
                    &state.configuration,
                    &scope,
                    &current_checkpoint(current).trigger_entry_id,
                    overflow_recovery_used,
                );
                let writes = placement.writes.clone();
                let entries_for_events = placement.entries.clone();
                let queues = placement.queues.clone();
                let patch = LanePatch {
                    tip_id: placement.tip_id.clone().map(Some),
                    inbox: Some(placement.inbox.clone()),
                };
                let events_lane = lane_name.clone();
                let events_run = operation_id.clone();
                return Ok(OperationCommandFor::Commit {
                    decision: CommitDecision {
                        writes,
                        materialize: Box::new(|_| None),
                        events: Some(Box::new(move |commit| {
                            boundary_placement_events(
                                &entries_for_events,
                                queues.as_ref(),
                                commit,
                                0,
                                &events_lane,
                                &events_run,
                            )
                        })),
                    },
                    operation_state: ready,
                    lane: Some(patch),
                });
            }

            Ok(OperationCommandFor::Return {
                result: Some(BoundaryFinishPending {
                    entry_ids: placement.entries.iter().map(|entry| entry.id.clone()).collect(),
                }),
            })
        })
        .await;

    let pending = match planned {
        Ok(ContinueOutcome::CancelRequested) => return Ok(ProcedureResult::Continue),
        Ok(ContinueOutcome::Result(Some(BoundaryFinishPending { entry_ids }))) => entry_ids,
        Ok(ContinueOutcome::Result(None)) => return Ok(ProcedureResult::Continue),
        Err(error) => return Err(SessionError::Other(error.to_string())),
    };

    if !matches!(continuation, Continuation::MayFinish { .. }) {
        return Err(SessionError::Invariant("Checkpoint finish mediation requires a finish continuation".into()));
    }
    finish_run_boundary(lane, drive, &trigger_for_finish, &continuation, &scope_for_finish, pending, Vec::new()).await
}

fn current_checkpoint(state: &OperationState) -> &CheckpointData {
    match state {
        OperationState::Checkpoint { checkpoint, .. } => checkpoint,
        _ => unreachable!("run_checkpoint invoked on a non-checkpoint operation"),
    }
}
