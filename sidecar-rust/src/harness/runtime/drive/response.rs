//! Port of pi `harness/runtime/drive/response.ts` — classification and
//! atomic settlement of one assistant generation response.
//!
//! One transaction turns the streamed response into: an entry + usage row
//! + tip move, plus the next durable state (tools / checkpoint /
//! retry-wait / deferred suspension / structural overflow handoff / failed
//! record). Deferred provider generation is excluded from zWork's port:
//! a provider `deferred` stop settles as an invalid-handle failure.

use std::sync::Arc;

use crate::harness::agent_types::AgentMessage;
use crate::harness::overflow::{is_context_overflow, is_recoverable_length};
use crate::harness::retry::{is_retryable_assistant_error, policy_retry_delay_ms, retry_not_before};
use crate::harness::session::commit::{insert_entry, insert_usage, NewEntry, UsageRowNoSeq, Write};
use crate::harness::session::types::{
    CheckpointData, Continuation, Control, EntryBody, GenerationContext, LaneConfiguration, OperationError,
    OperationResultRecord, OperationScope, OperationState, SessionError, SessionResult, SummaryTask, TerminalStatus,
    ToolBatch, ToolCall, ToolCallStatus,
};
use crate::harness::session::values::{branch_tip, delete_list, operation_preparation, pending_assistant_frames, set_value};
use crate::harness::types::{AssistantMessage, AssistantContent, StopReason};

use super::super::events::{HarnessEvent, StructuralReason};
use super::super::lane::{Lane, OperationCommandFor};
use super::super::terminal::{operation_cleanup_writes, operation_result_record};
use super::super::types::{CommitDecision, Drive, LanePatch, ProcedureResult};
use super::structural::prepare_overflow_compaction;

/// Publish a non-retryable request-configuration failure before reserving
/// response ids (pi `publishConfigurationFailure`).
pub async fn publish_configuration_failure(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    error: OperationError,
) -> SessionResult<ProcedureResult> {
    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let outcome = lane
        .continue_operation(move |state, current, meta, mutator| {
            let Some(tip_id) = state.tip_id.clone() else {
                return Err(SessionError::Invariant("Failed run has no branch tip".into()));
            };
            let record = operation_result_record(meta, TerminalStatus::Failed, Some(tip_id.clone()), Some(error.clone()))?;
            let cleanup = operation_cleanup_writes(mutator, &operation_id, current)?;
            let run_record = record.clone();
            let events_record = record.clone();
            let from_tip = meta.source_tip_id.clone();
            let events_lane = lane_name.clone();
            let events_run = operation_id.clone();
            Ok(OperationCommandFor::Finish {
                writes: cleanup,
                record,
                lane: None,
                materialize: Box::new(move |_| ProcedureResult::Settled { outcome: run_record }),
                events: Some(Box::new(move |_| {
                    vec![HarnessEvent::RunEnd {
                        lane: events_lane,
                        run_id: events_run,
                        status: TerminalStatus::Failed,
                        from_tip_id: from_tip,
                        tip_id: Some(tip_id.clone()),
                        ended_at: events_record.ended_at,
                        error: Some(events_record.error.clone().unwrap_or_else(|| error.clone())),
                        recovery: None,
                    }]
                })),
            })
        })
        .await;

    map_continue(outcome)
}

fn map_continue(
    outcome: Result<super::super::lane::ContinueOutcome<ProcedureResult>, crate::harness::runtime::lane::LaneError>,
) -> SessionResult<ProcedureResult> {
    match outcome {
        Ok(super::super::lane::ContinueOutcome::CancelRequested) => Ok(ProcedureResult::Continue),
        Ok(super::super::lane::ContinueOutcome::Result(result)) => Ok(result),
        Err(error) => Err(SessionError::Other(error.to_string())),
    }
}

fn uuid_v7_timestamp(id: &str) -> SessionResult<u64> {
    if id.len() < 13 {
        return Err(SessionError::Invariant(format!("Invalid reserved UUIDv7 {id}")));
    }
    let hex = format!("{}{}", &id[0..8], &id[9..13]);
    u64::from_str_radix(&hex, 16).map_err(|_| SessionError::Invariant(format!("Invalid reserved UUIDv7 {id}")))
}

fn provider_error(source: &str, message: &AssistantMessage) -> OperationError {
    OperationError {
        code: "assistant_error".into(),
        message: message
            .error_message
            .clone()
            .unwrap_or_else(|| format!("{source} request ended with {}", stop_reason_name(&message.stop_reason))),
        details: None,
    }
}

fn stop_reason_name(reason: &StopReason) -> &'static str {
    reason.as_str()
}

fn normalize_error(message: &AssistantMessage, error_message: String) -> AssistantMessage {
    let mut next = message.clone();
    next.stop_reason = StopReason::Error;
    next.error_message = Some(error_message);
    next
}

fn normalize_aborted(source: &str, message: &AssistantMessage) -> AssistantMessage {
    let mut next = message.clone();
    next.stop_reason = StopReason::Aborted;
    next.error_message = Some(
        message
            .error_message
            .clone()
            .unwrap_or_else(|| format!("{source} request was cancelled")),
    );
    next
}

/// The durable intent of one in-flight generation (the
/// `assistant.effect_pending` leaves, minus the run-wide scope).
pub struct ResponseIntent {
    pub generation: GenerationContext,
    pub attempt: u32,
    pub response_entry_id: String,
    pub usage_id: String,
    pub intended_output_limit: u64,
    pub context_window: u64,
}

/// Classify and atomically settle one assistant-generation response (pi
/// `publishResponse`).
pub async fn publish_response(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    intent: &ResponseIntent,
    response: AssistantMessage,
    recovery: bool,
) -> SessionResult<ProcedureResult> {
    let overflow = is_context_overflow(&response, Some(intent.context_window))
        || is_recoverable_length(&response, intent.intended_output_limit);
    let live_scope = lane.operation_snapshot().map(|operation| operation.state.scope().clone());
    let overflow_preparation = if overflow && !intent.generation.overflow_recovery_used {
        match live_scope {
            Some(scope) => {
                prepare_overflow_compaction(
                    lane,
                    drive,
                    &scope,
                    &intent.generation.trigger_entry_id,
                    intent.generation.overflow_recovery_used,
                )
                .await?
            }
            None => None,
        }
    } else {
        None
    };

    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let response_entry_id = intent.response_entry_id.clone();
    let usage_id = intent.usage_id.clone();
    let intent_for_plan = ResponseIntent {
        generation: intent.generation.clone(),
        attempt: intent.attempt,
        response_entry_id: intent.response_entry_id.clone(),
        usage_id: intent.usage_id.clone(),
        intended_output_limit: intent.intended_output_limit,
        context_window: intent.context_window,
    };
    let overflow_prep = overflow_preparation.clone();
    let is_recovery = recovery;

    let outcome = lane
        .settle_operation(move |state, current, meta, mutator| {
            let source = "assistant";
            let configuration: LaneConfiguration = match current {
                OperationState::AssistantEffectPending { generation, .. } => generation.configuration.clone(),
                _ => return Err(SessionError::Invariant("publish_response on a non-assistant operation".into())),
            };
            let turn_id = match current {
                OperationState::AssistantEffectPending { generation, .. } => generation.step_id.clone(),
                _ => String::new(),
            };
            let scope = OperationScope {
                control: current.scope().control.clone(),
                settings: current.scope().settings.clone(),
                latest_assistant_entry_id: Some(response_entry_id.clone()),
            };
            let mut committed = response.clone();
            let mut settled: Option<OperationState> = None;
            let mut failure: Option<OperationError> = None;

            if matches!(current.scope().control, Control::CancelRequested { .. }) {
                committed = normalize_aborted(source, &response);
                settled = Some(OperationState::Checkpoint {
                    scope: scope.clone(),
                    checkpoint: CheckpointData {
                        continuation: Continuation::MayFinish { include_final_assistant: true },
                        trigger_entry_id: response_entry_id.clone(),
                    },
                });
            } else if response.stop_reason == StopReason::Aborted {
                return Err(SessionError::Invariant(
                    "Assistant response is aborted while durable control is running".into(),
                ));
            } else if overflow {
                committed = normalize_error(
                    &response,
                    response
                        .error_message
                        .clone()
                        .unwrap_or_else(|| "Assistant request exceeded the context window".into()),
                );
                if intent_for_plan.generation.overflow_recovery_used || overflow_prep.is_none() {
                    failure = Some(provider_error(source, &committed));
                } else if let Some((task_id, preparation)) = &overflow_prep {
                    settled = Some(OperationState::SummaryDeciding {
                        scope: scope.clone(),
                        task: SummaryTask {
                            task_id: task_id.clone(),
                            reason: Some("overflow".into()),
                            custom_instructions: None,
                            boundary: crate::harness::session::types::ResultBoundary::ResumeCheckpoint {
                                resume_after: CheckpointData {
                                    continuation: Continuation::NeedAssistant { overflow_recovery_used: true },
                                    trigger_entry_id: intent_for_plan.generation.trigger_entry_id.clone(),
                                },
                            },
                        },
                    });
                    let _ = preparation;
                }
            } else if response.stop_reason == StopReason::Deferred {
                // Deferred provider generation is excluded from this port;
                // treat the handle as invalid.
                committed = normalize_error(&response, "Provider returned an invalid deferred handle".into());
                failure = Some(provider_error(source, &committed));
            } else if response.stop_reason == StopReason::Error {
                let retryable = is_recovery || is_retryable_assistant_error(&response);
                if retryable && intent_for_plan.attempt < intent_for_plan.generation.retry_policy.max_attempts {
                    settled = Some(OperationState::AssistantRetryWait {
                        scope: scope.clone(),
                        generation: intent_for_plan.generation.clone(),
                        retry: crate::harness::session::types::RetryWait {
                            next_attempt: intent_for_plan.attempt + 1,
                            not_before: retry_not_before(
                                intent_for_plan.generation.retry_policy.base_delay_ms,
                                intent_for_plan.generation.retry_policy.max_agent_delay_ms,
                                intent_for_plan.attempt,
                            ),
                            error_message: response
                                .error_message
                                .clone()
                                .unwrap_or_else(|| "Assistant request failed".into()),
                        },
                    });
                } else {
                    failure = Some(provider_error(source, &response));
                }
            } else {
                let calls: Vec<usize> = response
                    .content
                    .iter()
                    .enumerate()
                    .filter_map(|(index, content)| matches!(content, AssistantContent::ToolCall(_)).then_some(index))
                    .collect();
                if !calls.is_empty() {
                    uuid_v7_timestamp(&response_entry_id)?;
                    let planned: Vec<ToolCall> = calls
                        .into_iter()
                        .map(|source_index| ToolCall {
                            status: ToolCallStatus::Planned,
                            source_index,
                            result_entry_id: lane.session.next_id(),
                            replay: None,
                            terminate: None,
                        })
                        .collect();
                    settled = Some(OperationState::Tools {
                        scope: scope.clone(),
                        batch: ToolBatch {
                            assistant_entry_id: response_entry_id.clone(),
                            configuration,
                            turn_id: turn_id.clone(),
                            calls: planned,
                        },
                    });
                } else if response.stop_reason == StopReason::ToolUse {
                    committed = normalize_error(&response, "Provider reported tool use without any tool calls".into());
                    failure = Some(provider_error(source, &committed));
                } else {
                    settled = Some(OperationState::Checkpoint {
                        scope: scope.clone(),
                        checkpoint: CheckpointData {
                            continuation: Continuation::MayFinish { include_final_assistant: true },
                            trigger_entry_id: response_entry_id.clone(),
                        },
                    });
                }
            }

            let response_entry = NewEntry {
                id: response_entry_id.clone(),
                parent_id: state.tip_id.clone(),
                body: EntryBody::Message {
                    message: AgentMessage::Llm(crate::harness::types::Message::Assistant(committed.clone())),
                    terminate: None,
                },
            };
            let usage_row = UsageRowNoSeq {
                id: usage_id.clone(),
                usage: committed.usage.clone(),
                entry_id: Some(response_entry_id.clone()),
                adjustment: false,
                details: None,
            };
            if settled.is_none() && failure.is_none() {
                return Err(SessionError::Invariant("Response settlement has no durable disposition".into()));
            }
            let record: Option<OperationResultRecord> = failure
                .as_ref()
                .map(|error| operation_result_record(meta, TerminalStatus::Failed, Some(response_entry_id.clone()), Some(error.clone())))
                .transpose()?;
            let cleanup = if record.is_some() {
                operation_cleanup_writes(mutator, &operation_id, current)?
            } else {
                Vec::new()
            };
            let mut writes: Vec<Write> = vec![
                insert_entry(response_entry.clone()),
                insert_usage(usage_row.clone()),
                Write::Value(set_value(&branch_tip(&lane_name), serde_json::Value::String(response_entry_id.clone()))),
            ];
            if record.is_none() {
                writes.push(Write::List(delete_list(&pending_assistant_frames(
                    &operation_id,
                    &response_entry_id,
                ))));
            } else {
                writes.extend(cleanup);
            }
            if matches!(&settled, Some(OperationState::SummaryDeciding { .. })) {
                if let Some((task_id, preparation)) = &overflow_prep {
                    let json = serde_json::to_value(preparation).map_err(|e| SessionError::Storage(e.to_string()))?;
                    writes.push(Write::Value(set_value(
                        &operation_preparation(&operation_id, task_id),
                        json,
                    )));
                }
            }

            let events_lane = lane_name.clone();
            let events_run = operation_id.clone();
            let events = {
                let committed = committed.clone();
                let usage_row = usage_row.clone();
                let record = record.clone();
                let settled_at = settled.as_ref().map(|state| state.at());
                let retry_wait = match &settled {
                    Some(OperationState::AssistantRetryWait { retry, .. }) => Some(retry.clone()),
                    _ => None,
                };
                let attempt = intent_for_plan.attempt;
                let max_attempts = intent_for_plan.generation.retry_policy.max_attempts;
                let base_delay = intent_for_plan.generation.retry_policy.base_delay_ms;
                let max_delay = intent_for_plan.generation.retry_policy.max_agent_delay_ms;
                let turn_id = turn_id.clone();
                let from_tip = meta.source_tip_id.clone();
                let response_entry_id = response_entry_id.clone();
                move |commit: &crate::harness::session::types::CommitResult| -> Vec<HarnessEvent> {
                    let entry = crate::harness::session::commit::materialize_committed_entry(
                        &response_entry,
                        commit.seqs.first().copied().unwrap_or(0),
                        commit.timestamp,
                    );
                    let mut batch = vec![
                        HarnessEvent::EntryAdded { lane: events_lane.clone(), entry, recovery: None },
                        HarnessEvent::Usage {
                            row: crate::harness::session::types::UsageRow {
                                id: usage_row.id.clone(),
                                seq: commit.seqs.get(1).copied().unwrap_or(0),
                                usage: usage_row.usage.clone(),
                                entry_id: usage_row.entry_id.clone(),
                                adjustment: usage_row.adjustment,
                                details: usage_row.details.clone(),
                            },
                            totals: commit.stats.usage.clone(),
                            recovery: None,
                        },
                    ];
                    if !is_recovery && attempt > 1 && settled_at != Some("assistant.retry_wait") {
                        let success = committed.stop_reason != StopReason::Error
                            && committed.stop_reason != StopReason::Aborted;
                        batch.push(HarnessEvent::RetryEnd {
                            lane: events_lane.clone(),
                            run_id: events_run.clone(),
                            step: turn_id.clone(),
                            attempt,
                            success,
                            final_error: if success { None } else { committed.error_message.clone() },
                            recovery: None,
                        });
                    }
                    if !is_recovery && settled_at == Some("assistant.retry_wait") {
                        if let Some(retry) = &retry_wait {
                            batch.push(HarnessEvent::RetryScheduled {
                                lane: events_lane.clone(),
                                run_id: events_run.clone(),
                                step: turn_id.clone(),
                                attempt: retry.next_attempt,
                                max_attempts,
                                delay_ms: policy_retry_delay_ms(base_delay, max_delay, attempt),
                                not_before: retry.not_before,
                                error_message: retry.error_message.clone(),
                                recovery: None,
                            });
                        }
                    }
                    if !is_recovery && settled_at != Some("tools") && settled_at != Some("assistant.retry_wait") {
                        batch.push(HarnessEvent::TurnEnd {
                            lane: events_lane.clone(),
                            run_id: events_run.clone(),
                            turn_id: turn_id.clone(),
                            message: AgentMessage::Llm(crate::harness::types::Message::Assistant(committed.clone())),
                            tool_results: Vec::new(),
                            recovery: None,
                        });
                    }
                    if settled_at == Some("summary.deciding") {
                        batch.push(HarnessEvent::CompactionStart {
                            lane: events_lane.clone(),
                            run_id: events_run.clone(),
                            reason: StructuralReason::Overflow,
                            started_at: commit.timestamp,
                            recovery: None,
                        });
                    }
                    if let Some(record) = &record {
                        batch.push(HarnessEvent::RunEnd {
                            lane: events_lane.clone(),
                            run_id: events_run.clone(),
                            status: TerminalStatus::Failed,
                            from_tip_id: from_tip.clone(),
                            tip_id: Some(response_entry_id.clone()),
                            ended_at: record.ended_at,
                            error: record.error.clone(),
                            recovery: None,
                        });
                    }
                    batch
                }
            };

            if let Some(record) = record {
                let run_record = record.clone();
                let tip = response_entry_id.clone();
                return Ok(OperationCommandFor::Finish {
                    writes,
                    record,
                    lane: Some(LanePatch { tip_id: Some(Some(tip)), inbox: None }),
                    materialize: Box::new(move |_| ProcedureResult::Settled { outcome: run_record.clone() }),
                    events: Some(Box::new(events)),
                });
            }
            let Some(settled) = settled else {
                return Err(SessionError::Invariant("Response settlement is missing its next state".into()));
            };
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes,
                    materialize: Box::new(|_| ProcedureResult::Continue),
                    events: Some(Box::new(events)),
                },
                operation_state: settled,
                lane: Some(LanePatch { tip_id: Some(Some(response_entry_id.clone())), inbox: None }),
            })
        })
        .await;

    match outcome {
        Ok(result) => Ok(result),
        Err(error) => Err(SessionError::Other(error.to_string())),
    }
}
