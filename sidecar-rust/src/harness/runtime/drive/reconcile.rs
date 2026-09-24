//! Ports of pi `drive/recovery.ts` + `drive/reconcile.ts` +
//! `commitNavigation` — settling orphaned assistant effects without
//! another provider call, reconciling cancelled durable operations, and
//! committing unsummarized tree navigation.
//!
//! Deferred-generation cancellation is excluded with the deferred feature
//! (the deferred states never install in this port).

use std::sync::Arc;

use crate::harness::agent_types::AgentMessage;
use crate::harness::assistant_frame::reduce_assistant_message_frames;
use crate::harness::session::commit::Write;
use crate::harness::session::types::{
    Control, LaneConfiguration, OperationState, SessionError, SessionResult, TerminalStatus,
};
use crate::harness::session::values::{branch_tip, entry_label, set_value};
use crate::harness::types::{Api, AssistantMessage, Message, StopReason, Usage};

use super::super::events::{HarnessEvent, StructuralOutcome};
use super::super::lane::{ContinueOutcome, Lane, OperationCommandFor};
use super::super::progress::read_assistant_frames;
use super::super::terminal::{operation_cleanup_writes, operation_result_record};
use super::super::types::{Drive, ProcedureResult};
use super::response::{publish_response, ResponseIntent};
use super::tools::run_tools;

const INTERRUPTED_WARNING: &str = "Assistant request was interrupted. The preceding content is the latest committed partial; newer live output may be missing and the external outcome is unknown.";

fn interrupted_assistant_message(
    identity: &LaneConfiguration,
    partial: Option<AssistantMessage>,
) -> AssistantMessage {
    match partial {
        None => AssistantMessage {
            content: Vec::new(),
            api: Api::AnthropicMessages,
            provider: identity.provider.clone(),
            model: identity.model_id.clone(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: StopReason::Error,
            error_message: Some(INTERRUPTED_WARNING.into()),
            raw_stop_reason: None,
            end_turn: None,
            timestamp: crate::harness::session::session::now_ms() as i64,
        },
        Some(mut partial) => {
            partial.usage = Usage::default();
            partial.stop_reason = StopReason::Error;
            partial.error_message = Some(INTERRUPTED_WARNING.into());
            partial
        }
    }
}

fn emit_recovered(lane: &Arc<Lane>, drive: &Arc<Drive>, message: &AssistantMessage, response_entry_id: &str) {
    lane.emit_public(HarnessEvent::MessageStart {
        lane: lane.name.clone(),
        run_id: Some(drive.operation_id.clone()),
        message: AgentMessage::Llm(Message::Assistant(message.clone())),
        recovery: Some(true),
    });
    lane.emit_public(HarnessEvent::MessageEnd {
        lane: lane.name.clone(),
        run_id: Some(drive.operation_id.clone()),
        message: AgentMessage::Llm(Message::Assistant(message.clone())),
        entry_id: Some(response_entry_id.to_string()),
        recovery: Some(true),
    });
}

fn intent_from_effect(
    generation: &crate::harness::session::types::GenerationContext,
    attempt: u32,
    response_entry_id: &str,
    usage_id: &str,
    intended_output_limit: u64,
    context_window: u64,
) -> ResponseIntent {
    ResponseIntent {
        generation: generation.clone(),
        attempt,
        response_entry_id: response_entry_id.to_string(),
        usage_id: usage_id.to_string(),
        intended_output_limit,
        context_window,
    }
}

/// Settle an orphaned assistant request from its bounded committed frame
/// prefix without another provider call (pi `recoverAssistantGeneration`).
pub async fn recover_assistant_generation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    generation: &crate::harness::session::types::GenerationContext,
    attempt: u32,
    response_entry_id: &str,
    usage_id: &str,
    intended_output_limit: u64,
    context_window: u64,
) -> SessionResult<ProcedureResult> {
    let operation_id = drive.operation_id.clone();
    let entry_id = response_entry_id.to_string();
    let frames = lane
        .continue_operation(move |_state, _current, _meta, mutator| {
            let frames = read_assistant_frames(mutator, &operation_id, &entry_id)?;
            Ok(OperationCommandFor::Return { result: frames })
        })
        .await;
    let frames = match frames {
        Ok(ContinueOutcome::CancelRequested) => return Ok(ProcedureResult::Continue),
        Ok(ContinueOutcome::Result(frames)) => frames,
        Err(error) => return Err(SessionError::Other(error.to_string())),
    };

    let message = interrupted_assistant_message(
        &generation.configuration,
        reduce_assistant_message_frames(&frames).map_err(|e| SessionError::Invariant(e))?,
    );
    emit_recovered(lane, drive, &message, response_entry_id);
    let intent = intent_from_effect(generation, attempt, response_entry_id, usage_id, intended_output_limit, context_window);
    publish_response(lane, drive, &intent, message, true).await
}

/// Synthetically settle one cancelled orphaned assistant effect under its
/// reserved ids (pi `recoverCancelledAssistantEffect`).
pub async fn recover_cancelled_assistant_effect(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    intent: &ResponseIntent,
) -> SessionResult<ProcedureResult> {
    let operation_id = drive.operation_id.clone();
    let entry_id = intent.response_entry_id.clone();
    let frames = lane
        .settle_operation(move |_state, _current, _meta, mutator| {
            let frames = read_assistant_frames(mutator, &operation_id, &entry_id)?;
            Ok(OperationCommandFor::Return { result: frames })
        })
        .await;
    let frames = frames.map_err(|error| SessionError::Other(error.to_string()))?;

    let message = interrupted_assistant_message(
        &intent.generation.configuration,
        reduce_assistant_message_frames(&frames).map_err(SessionError::Invariant)?,
    );
    emit_recovered(lane, drive, &message, &intent.response_entry_id);
    publish_response(lane, drive, intent, message, true).await
}

/// Publish the terminal aborted record for a cancelled operation (pi
/// `publishAbortedTerminal`).
async fn publish_aborted_terminal(lane: &Arc<Lane>, drive: &Arc<Drive>) -> SessionResult<ProcedureResult> {
    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let outcome = lane
        .settle_operation(move |state, current, meta, mutator| {
            if !matches!(current.scope().control, Control::CancelRequested { .. }) {
                return Err(SessionError::Invariant(
                    "Cancellation reconciliation requires cancelled durable control".into(),
                ));
            }
            let record =
                operation_result_record(meta, TerminalStatus::Aborted, state.tip_id.clone(), None)?;
            let cleanup = operation_cleanup_writes(mutator, &operation_id, current)?;
            let mut events = Vec::new();
            match &meta.intent {
                crate::harness::session::types::OperationIntent::Run { .. } => {
                    if let OperationState::SummaryDeciding { task, .. }
                    | OperationState::SummaryReady { task, .. }
                    | OperationState::SummaryEffectPending { task, .. }
                    | OperationState::SummaryRetryWait { task, .. } = current
                    {
                        let reason = task
                            .reason
                            .as_deref()
                            .and_then(|reason| match reason {
                                "manual" => Some(super::super::events::StructuralReason::Manual),
                                "threshold" => Some(super::super::events::StructuralReason::Threshold),
                                "overflow" => Some(super::super::events::StructuralReason::Overflow),
                                _ => None,
                            })
                            .unwrap_or(super::super::events::StructuralReason::Manual);
                        events.push(HarnessEvent::CompactionEnd {
                            lane: lane_name.clone(),
                            run_id: operation_id.clone(),
                            reason,
                            outcome: StructuralOutcome::Aborted,
                            ended_at: record.ended_at,
                            recovery: None,
                        });
                    }
                    events.push(HarnessEvent::RunEnd {
                        lane: lane_name.clone(),
                        run_id: operation_id.clone(),
                        status: TerminalStatus::Aborted,
                        from_tip_id: meta.source_tip_id.clone(),
                        tip_id: state.tip_id.clone(),
                        ended_at: record.ended_at,
                        error: None,
                        recovery: None,
                    });
                }
                crate::harness::session::types::OperationIntent::Compaction { .. } => {
                    events.push(HarnessEvent::CompactionEnd {
                        lane: lane_name.clone(),
                        run_id: operation_id.clone(),
                        reason: super::super::events::StructuralReason::Manual,
                        outcome: StructuralOutcome::Aborted,
                        ended_at: record.ended_at,
                        recovery: None,
                    });
                }
                crate::harness::session::types::OperationIntent::Navigation { .. } => {
                    events.push(HarnessEvent::NavigationEnd {
                        lane: lane_name.clone(),
                        run_id: operation_id.clone(),
                        from_tip_id: meta.source_tip_id.clone(),
                        tip_id: state.tip_id.clone(),
                        outcome: StructuralOutcome::Aborted,
                        ended_at: record.ended_at,
                        recovery: None,
                    });
                }
            }
            let run_record = record.clone();
            Ok(OperationCommandFor::Finish {
                writes: cleanup,
                record,
                lane: None,
                materialize: Box::new(move |_| ProcedureResult::Settled { outcome: run_record }),
                events: Some(Box::new(move |_| events)),
            })
        })
        .await;
    outcome.map_err(|error| SessionError::Other(error.to_string()))
}

/// Advance one cancelled durable leaf without starting new ordinary work
/// (pi `reconcileOperation`).
pub async fn reconcile_operation(lane: &Arc<Lane>, drive: &Arc<Drive>) -> SessionResult<ProcedureResult> {
    let Some(operation) = lane.operation_snapshot() else {
        return Err(SessionError::Invariant(format!(
            "Drive {} has no matching operation to reconcile",
            drive.operation_id
        )));
    };
    if operation.meta.operation_id != drive.operation_id {
        return Err(SessionError::Invariant(format!(
            "Drive {} has no matching operation to reconcile",
            drive.operation_id
        )));
    }
    if !matches!(operation.state.scope().control, Control::CancelRequested { .. }) {
        return Err(SessionError::Invariant(format!(
            "Operation {} is not cancelled",
            drive.operation_id
        )));
    }
    // Pull the gate into aborting so late admissions refuse effects.
    drive.gate.begin_abort();
    drive.gate.signal_abort();

    match &operation.state {
        OperationState::AssistantEffectPending { scope: _, generation, attempt, response_entry_id, usage_id, intended_output_limit, context_window } => {
            let intent = intent_from_effect(generation, *attempt, response_entry_id, usage_id, *intended_output_limit, *context_window);
            recover_cancelled_assistant_effect(lane, drive, &intent).await
        }
        OperationState::Tools { .. } => run_tools(lane, drive).await,
        OperationState::DeferredSuspended { .. } | OperationState::DeferredEffectPending { .. } => {
            // Deferred generation is excluded from this port; reconcile to
            // the aborted terminal.
            publish_aborted_terminal(lane, drive).await
        }
        OperationState::Starting { .. }
        | OperationState::Checkpoint { .. }
        | OperationState::AssistantReady { .. }
        | OperationState::AssistantRetryWait { .. }
        | OperationState::SummaryDeciding { .. }
        | OperationState::SummaryReady { .. }
        | OperationState::SummaryEffectPending { .. }
        | OperationState::SummaryRetryWait { .. }
        | OperationState::NavigationReadyToCommit { .. } => publish_aborted_terminal(lane, drive).await,
    }
}

/// Atomically move an unsummarized navigation and finish its operation
/// (pi `commitNavigation`).
pub async fn commit_navigation(lane: &Arc<Lane>, drive: &Arc<Drive>) -> SessionResult<ProcedureResult> {
    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let outcome = lane
        .continue_operation(move |_state, current, meta, mutator| {
            let OperationState::NavigationReadyToCommit { target_id, label, .. } = current else {
                return Err(SessionError::Invariant("commit_navigation on a non-navigation operation".into()));
            };
            if let Some(target) = target_id {
                if !mutator.has_entry(target)? {
                    return Err(SessionError::Invariant(format!("Navigation target {target} is missing")));
                }
            }
            if target_id.as_ref() == meta.source_tip_id.as_ref() {
                return Err(SessionError::Invariant(
                    "Navigation target must differ from its source tip".into(),
                ));
            }
            if target_id.is_none() && label.is_some() {
                return Err(SessionError::Invariant("Root navigation cannot set a label".into()));
            }
            let mut writes: Vec<Write> = vec![Write::Value(set_value(
                &branch_tip(&lane_name),
                target_id.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
            ))];
            if let (Some(label), Some(target)) = (label, target_id) {
                writes.push(Write::Value(set_value(&entry_label(target), serde_json::Value::String(label.clone()))));
            }
            let cleanup = operation_cleanup_writes(mutator, &operation_id, current)?;
            let record = operation_result_record(meta, TerminalStatus::Completed, target_id.clone(), None)?;
            let run_record = record.clone();
            let record_end = record.ended_at;
            let from_tip = meta.source_tip_id.clone();
            let tip = target_id.clone();
            Ok(OperationCommandFor::Finish {
                writes: [writes, cleanup].concat(),
                record,
                lane: Some(super::super::types::LanePatch { tip_id: Some(target_id.clone()), inbox: None }),
                materialize: Box::new(move |_| ProcedureResult::Settled { outcome: run_record }),
                events: Some(Box::new(move |_| {
                    vec![HarnessEvent::NavigationEnd {
                        lane: lane_name.clone(),
                        run_id: operation_id.clone(),
                        from_tip_id: from_tip.clone(),
                        tip_id: tip.clone(),
                        outcome: StructuralOutcome::Completed { entry_id: None },
                        ended_at: record_end,
                        recovery: None,
                    }]
                })),
            })
        })
        .await;
    match outcome {
        Ok(ContinueOutcome::CancelRequested) => Ok(ProcedureResult::Continue),
        Ok(ContinueOutcome::Result(result)) => Ok(result),
        Err(error) => Err(SessionError::Other(error.to_string())),
    }
}
