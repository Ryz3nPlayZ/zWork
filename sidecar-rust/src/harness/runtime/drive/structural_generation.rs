//! Port of pi `drive/structural.ts` generation half — the summary
//! procedures behind `summary.deciding | ready | effect_pending |
//! retry_wait`. Decision consumes the durable preparation (plus the
//! `before_compaction` hook), generation runs the summarizer through the
//! harness's configured stream with the result staged durably before the
//! effect (a crash after staging never re-bills), and the effect commits
//! the `CompactionEntry`, moves the branch tip, and resumes the run
//! boundary (`ResumeCheckpoint`) or settles (`Finish`).
//!
//! Navigation-boundary summary tasks do not route through these states in
//! zWork's runtime (navigation commits directly); a `BranchSummary`
//! preparation reaching here is an invariant.

use std::sync::Arc;

use crate::harness::agent_types::StreamFn;
use crate::harness::compaction::{generate_summary_with_usage, SummarizationOptions};
use crate::harness::retry::{is_retryable_assistant_error, retry_not_before};
use crate::harness::session::commit::{insert_entry, insert_usage, NewEntry, UsageRowNoSeq, Write};
use crate::harness::session::types::{
    DurableStructuralPreparation, EntryBody, GenerationRequestRef, OperationError, OperationScope, OperationState,
    SessionError, SessionResult, SummaryContext, SummaryTask, TerminalStatus,
};
use crate::harness::session::values::{branch_tip, operation_preparation, set_value, summary_result};
use crate::harness::types::Usage;

use super::super::events::{HarnessEvent, StructuralOutcome as EventOutcome, StructuralReason};
use super::super::lane::{ContinueOutcome, Lane, OperationCommandFor};
use super::super::terminal::{operation_cleanup_writes, operation_result_record};
use super::super::types::{CommitDecision, Drive, LanePatch, ProcedureResult};
use super::boundary::{assistant_ready_at_boundary, plan_boundary_inbox};

/// The staged summary result (written before the effect, read by
/// recovery so a crash between generation and effect never re-bills).
#[derive(serde::Serialize, serde::Deserialize)]
struct StagedSummary {
    text: String,
    usage: Usage,
}

/// What the structural effect commits.
#[derive(Clone)]
enum StructuralOutcome {
    /// Generated (or hook-provided) summary ready to commit.
    Completed { text: String, usage: Option<Usage> },
    Declined,
    Failed { error: OperationError },
}

fn structural_reason(task: &SummaryTask) -> StructuralReason {
    match task.reason.as_deref() {
        Some("threshold") => StructuralReason::Threshold,
        Some("overflow") => StructuralReason::Overflow,
        _ => StructuralReason::Manual,
    }
}

fn configuration_error(code: &str, message: String) -> OperationError {
    OperationError { code: code.to_string(), message, details: None }
}

async fn read_preparation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    task: &SummaryTask,
) -> SessionResult<DurableStructuralPreparation> {
    let address = operation_preparation(&drive.operation_id, &task.task_id);
    let missing = SessionError::Invariant(format!("Structural task {} has no durable preparation", task.task_id));
    let stored = lane
        .read(move |_, mutator| {
            mutator
                .get_value(&address)?
                .ok_or(missing)
        })
        .await
        .map_err(|e: crate::harness::runtime::lane::LaneError| SessionError::Other(e.to_string()))?;
    serde_json::from_value(stored.value)
        .map_err(|e| SessionError::Storage(format!("structural preparation decode failed: {e}")))
}

/// `summary.deciding` — consume the preparation and the `before_compaction`
/// hook, then publish `summary.ready` with the generation context (pi
/// `runStructuralDecision` + `publishStructuralReady`).
pub async fn run_structural_decision(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    scope: &OperationScope,
    task: &SummaryTask,
) -> SessionResult<ProcedureResult> {
    let preparation = read_preparation(lane, drive, task).await?;
    if !matches!(preparation, DurableStructuralPreparation::Compaction { .. }) {
        return Err(SessionError::Invariant(
            "Navigation-boundary summary tasks do not route through summary states".into(),
        ));
    }

    let hook = match lane.hooks.run_before_compaction_with_gate(
        &super::super::hooks::HookContext { lane: lane.name.clone(), run_id: drive.operation_id.clone() },
        &super::super::hooks::BeforeCompactionEvent {
            reason: structural_reason(task),
            preparation: serde_json::to_value(&preparation).unwrap_or(serde_json::Value::Null),
            custom_instructions: task.custom_instructions.clone(),
        },
        &drive.gate,
    ) {
        Ok(result) => result,
        // Abort raced admission: reconcile on the next iteration.
        Err(_gate) => return Ok(ProcedureResult::Continue),
    };
    if let Some(result) = hook {
        if result.decline {
            return publish_structural_outcome(lane, drive, scope, task, None, StructuralOutcome::Declined).await;
        }
        if let Some(compaction) = result.compaction {
            let text = compaction
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            return publish_structural_outcome(
                lane,
                drive,
                scope,
                task,
                None,
                StructuralOutcome::Completed { text, usage: None },
            )
            .await;
        }
    }

    let result_entry_id = lane.session.next_id();
    let outcome = lane
        .continue_operation(move |state, current, _meta, _mutator| {
            let (scope, task) = match current {
                OperationState::SummaryDeciding { scope, task } => (scope.clone(), task.clone()),
                other => {
                    return Err(SessionError::Invariant(format!("structural decision ran on {}", other.at())));
                }
            };
            let config = lane.read_config();
            let summary = SummaryContext {
                result_entry_id,
                configuration: state.configuration.clone(),
                stream_options: config.stream_options.clone(),
                retry_policy: config.retry_policy.normalized(),
            };
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes: Vec::new(),
                    materialize: structural_continue(),
                    events: None,
                },
                operation_state: OperationState::SummaryReady { scope, task, summary, next_attempt: 1 },
                lane: None,
            })
        })
        .await;
    structural_procedure_result(outcome).map(|result| result.unwrap_or(ProcedureResult::Continue))
}

/// `summary.ready` — publish the attempt intent, run the summarizer, stage
/// the result durably (pi `runStructuralGeneration`).
pub async fn run_structural_generation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    scope: &OperationScope,
    task: &SummaryTask,
    summary: &SummaryContext,
    next_attempt: u32,
) -> SessionResult<ProcedureResult> {
    // Attempt intent: effect_pending before any provider call. A crash
    // here (no staged result, no in-flight request marker) re-runs.
    let attempt = next_attempt;
    let outcome = lane
        .continue_operation(move |_state, current, _meta, _mutator| {
            let (scope, task, summary) = match current {
                OperationState::SummaryReady { scope, task, summary, .. } => {
                    (scope.clone(), task.clone(), summary.clone())
                }
                other => {
                    return Err(SessionError::Invariant(format!("structural generation ran on {}", other.at())));
                }
            };
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes: Vec::new(),
                    materialize: structural_continue(),
                    events: None,
                },
                operation_state: OperationState::SummaryEffectPending {
                    scope,
                    task,
                    summary,
                    attempt,
                    request: None,
                    usage_ids: Vec::new(),
                },
                lane: None,
            })
        })
        .await;
    match structural_procedure_result(outcome)? {
        Some(result) => return Ok(result),
        None => {}
    }
    execute_structural_generation(lane, drive, scope, task, summary, next_attempt).await
}

/// Resolve the model, publish the in-flight request marker, call the
/// summarizer, and stage the outcome. Shared by the ready path and by
/// recovery when no staged result exists.
async fn execute_structural_generation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    scope: &OperationScope,
    task: &SummaryTask,
    summary: &SummaryContext,
    attempt: u32,
) -> SessionResult<ProcedureResult> {
    let config = lane.read_config();
    let fail_outcome = |code: &str, message: String| {
        Some(StructuralOutcome::Failed { error: configuration_error(code, message) })
    };
    let Some(stream) = config.stream.clone() else {
        let outcome = fail_outcome("stream_unavailable", "No stream function configured".into());
        return publish_structural_outcome(lane, drive, scope, task, Some(summary), outcome.unwrap()).await;
    };
    let model = config
        .model_source
        .as_ref()
        .and_then(|source| source(&summary.configuration.provider, &summary.configuration.model_id));
    let Some(model) = model else {
        let outcome = fail_outcome(
            "model_unavailable",
            format!("No source for {}/{}", summary.configuration.provider, summary.configuration.model_id),
        );
        return publish_structural_outcome(lane, drive, scope, task, Some(summary), outcome.unwrap()).await;
    };
    let preparation = read_preparation(lane, drive, task).await?;
    let DurableStructuralPreparation::Compaction { messages_to_summarize, previous_summary, .. } = preparation
    else {
        return Err(SessionError::Invariant("Compaction task has invalid durable preparation".into()));
    };

    // In-flight request marker: crash mid-call recovers here and re-runs.
    let usage_id = lane.session.next_id();
    {
        let request = GenerationRequestRef { index: 0, usage_id: usage_id.clone() };
        let outcome = lane
            .continue_operation(move |_state, current, _meta, _mutator| {
                let next = match current {
                    OperationState::SummaryEffectPending { scope, task, summary, attempt, usage_ids, .. } => {
                        OperationState::SummaryEffectPending {
                            scope: scope.clone(),
                            task: task.clone(),
                            summary: summary.clone(),
                            attempt: *attempt,
                            request: Some(request),
                            usage_ids: usage_ids.clone(),
                        }
                    }
                    other => {
                        return Err(SessionError::Invariant(format!("nested request intent ran on {}", other.at())));
                    }
                };
                Ok(OperationCommandFor::Commit {
                    decision: CommitDecision {
                        writes: Vec::new(),
                        materialize: structural_continue(),
                        events: None,
                    },
                    operation_state: next,
                    lane: None,
                })
            })
            .await;
        match structural_procedure_result(outcome)? {
            Some(result) => return Ok(result),
            None => {}
        }
    }

    // Volatile credentials come from the live configuration, never from
    // the durable snapshot (serde-skipped by design).
    let volatile = config.stream_options.clone();
    let reserve = config.context_window.unwrap_or(model.context_window);
    let options = SummarizationOptions {
        api_key: volatile.api_key.clone(),
        headers: Default::default(),
        signal: None,
        thinking_level: None,
        session_id: volatile.session_id.clone(),
        max_retries: Some(0),
        max_retry_delay_ms: None,
    };
    let stream_fn: StreamFn = stream;
    let generated = generate_summary_with_usage(
        &messages_to_summarize,
        &model,
        reserve,
        task.custom_instructions.as_deref(),
        previous_summary.as_deref(),
        &options,
        &stream_fn,
    )
    .await;

    match generated {
        Ok(result) => {
            // Stage the result + usage durably; the effect never re-bills.
            let staged = StagedSummary { text: result.text, usage: result.usage.clone() };
            let staged_json = serde_json::to_value(&staged).map_err(|e| SessionError::Storage(e.to_string()))?;
            let row = UsageRowNoSeq {
                id: usage_id,
                usage: result.usage,
                entry_id: None,
                adjustment: false,
                details: None,
            };
            let outcome = lane
                .continue_operation(move |_state, current, _meta, _mutator| {
                    let next = match current {
                        OperationState::SummaryEffectPending { scope, task, summary, attempt, usage_ids, .. } => {
                            let mut usage_ids = usage_ids.clone();
                            usage_ids.push(row.id.clone());
                            OperationState::SummaryEffectPending {
                                scope: scope.clone(),
                                task: task.clone(),
                                summary: summary.clone(),
                                attempt: *attempt,
                                request: None,
                                usage_ids,
                            }
                        }
                        other => {
                            return Err(SessionError::Invariant(format!("nested outcome ran on {}", other.at())));
                        }
                    };
                    let task_id = match current {
                        OperationState::SummaryEffectPending { task, .. } => task.task_id.clone(),
                        _ => unreachable!(),
                    };
                    let row = row.clone();
                    let staged_json = staged_json.clone();
                    Ok(OperationCommandFor::Commit {
                        decision: CommitDecision {
                            writes: vec![
                                insert_usage(row.clone()),
                                Write::Value(set_value(&summary_result(&task_id), staged_json)),
                            ],
                            materialize: structural_continue(),
                            events: Some(Box::new(move |commit| {
                                vec![HarnessEvent::Usage {
                                    row: crate::harness::session::types::UsageRow {
                                        id: row.id.clone(),
                                        seq: commit.seqs.first().copied().unwrap_or(0),
                                        usage: row.usage.clone(),
                                        entry_id: None,
                                        adjustment: false,
                                        details: None,
                                    },
                                    totals: commit.stats.usage.clone(),
                                    recovery: None,
                                }]
                            })),
                        },
                        operation_state: next,
                        lane: None,
                    })
                })
                .await;
            match structural_procedure_result(outcome)? {
                Some(result) => return Ok(result),
                None => {}
            }
            publish_structural_outcome(
                lane,
                drive,
                scope,
                task,
                Some(summary),
                StructuralOutcome::Completed { text: staged.text, usage: Some(staged.usage) },
            )
            .await
        }
        Err(message) => {
            let mut probe = crate::harness::types::AssistantMessage::pending(&model);
            probe.stop_reason = crate::harness::types::StopReason::Error;
            probe.error_message = Some(message.clone());
            if is_retryable_assistant_error(&probe) && attempt < summary.retry_policy.max_attempts {
                let retry = crate::harness::session::types::RetryWait {
                    next_attempt: attempt + 1,
                    not_before: retry_not_before(
                        summary.retry_policy.base_delay_ms,
                        summary.retry_policy.max_agent_delay_ms,
                        attempt,
                    ),
                    error_message: message,
                };
                let outcome = lane
                    .continue_operation(move |_state, current, _meta, _mutator| {
                        let next = match current {
                            OperationState::SummaryEffectPending { scope, task, summary, .. } => {
                                OperationState::SummaryRetryWait {
                                    scope: scope.clone(),
                                    task: task.clone(),
                                    summary: summary.clone(),
                                    retry: retry.clone(),
                                }
                            }
                            other => {
                                return Err(SessionError::Invariant(format!("retry publish ran on {}", other.at())));
                            }
                        };
                        Ok(OperationCommandFor::Commit {
                            decision: CommitDecision {
                                writes: Vec::new(),
                                materialize: structural_continue(),
                                events: None,
                            },
                            operation_state: next,
                            lane: None,
                        })
                    })
                    .await;
                structural_procedure_result(outcome).map(|r| r.unwrap_or(ProcedureResult::Continue))
            } else {
                publish_structural_outcome(
                    lane,
                    drive,
                    scope,
                    task,
                    Some(summary),
                    StructuralOutcome::Failed {
                        error: OperationError { code: "summary_failed".into(), message, details: None },
                    },
                )
                .await
            }
        }
    }
}

/// `summary.effect_pending` — a staged result applies without another
/// provider call; otherwise the generation (re-)runs (pi
/// `recoverStructuralGeneration`).
pub async fn recover_structural_generation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    scope: &OperationScope,
    task: &SummaryTask,
    summary: &SummaryContext,
    attempt: u32,
) -> SessionResult<ProcedureResult> {
    let address = summary_result(&task.task_id);
    let staged = lane
        .read(move |_, mutator| mutator.get_value(&address))
        .await
        .map_err(|e: crate::harness::runtime::lane::LaneError| SessionError::Other(e.to_string()))?;
    if let Some(stored) = staged {
        let staged: StagedSummary = serde_json::from_value(stored.value)
            .map_err(|e| SessionError::Storage(format!("staged summary decode failed: {e}")))?;
        return publish_structural_outcome(
            lane,
            drive,
            scope,
            task,
            Some(summary),
            StructuralOutcome::Completed { text: staged.text, usage: Some(staged.usage) },
        )
        .await;
    }
    execute_structural_generation(lane, drive, scope, task, summary, attempt).await
}

/// `summary.retry_wait` — wait out the backoff, then republish ready (pi
/// `runStructuralRetryWait`).
pub async fn run_structural_retry_wait(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    _scope: &OperationScope,
    _task: &SummaryTask,
    _summary: &SummaryContext,
    retry: &crate::harness::session::types::RetryWait,
) -> SessionResult<ProcedureResult> {
    if (crate::harness::session::session::now_ms() as u64) < retry.not_before {
        if !drive.wait_for_retry {
            return Ok(ProcedureResult::Waiting {
                outcome: crate::harness::runtime::types::DriveOutcome::WaitingRetry {
                    operation_id: drive.operation_id.clone(),
                    not_before: retry.not_before,
                },
            });
        }
        let remaining = std::time::Duration::from_millis(
            retry.not_before.saturating_sub(crate::harness::session::session::now_ms() as u64),
        );
        tokio::time::sleep(remaining).await;
        if drive.gate.check().is_err() {
            return Ok(ProcedureResult::Continue);
        }
    }
    let next_attempt = retry.next_attempt;
    let outcome = lane
        .continue_operation(move |_state, current, _meta, _mutator| {
            let (scope, task, summary) = match current {
                OperationState::SummaryRetryWait { scope, task, summary, .. } => {
                    (scope.clone(), task.clone(), summary.clone())
                }
                other => {
                    return Err(SessionError::Invariant(format!("retry wait ran on {}", other.at())));
                }
            };
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes: Vec::new(),
                    materialize: structural_continue(),
                    events: None,
                },
                operation_state: OperationState::SummaryReady { scope, task, summary, next_attempt },
                lane: None,
            })
        })
        .await;
    structural_procedure_result(outcome).map(|r| r.unwrap_or(ProcedureResult::Continue))
}

fn structural_continue() -> Box<dyn FnOnce(crate::harness::session::types::CommitResult) -> ProcedureResult + Send> {
    Box::new(|_| ProcedureResult::Continue)
}

/// Map a lane continue outcome to a procedure result. `None` means the
/// command committed with `Continue` and the caller should proceed to the
/// next step in its own flow.
fn structural_procedure_result(
    outcome: Result<ContinueOutcome<ProcedureResult>, crate::harness::runtime::lane::LaneError>,
) -> SessionResult<Option<ProcedureResult>> {
    match outcome {
        Ok(ContinueOutcome::CancelRequested) => Ok(Some(ProcedureResult::Continue)),
        Ok(ContinueOutcome::Result(result)) => match result {
            ProcedureResult::Continue => Ok(None),
            other => Ok(Some(other)),
        },
        Err(error) => Err(SessionError::Other(error.to_string())),
    }
}

/// Boundary resumption (pi): a drained trigger or a needed assistant
/// resumes generation; otherwise the run continues its checkpoint.
fn boundary_resume_state(
    lane: &Lane,
    state: &crate::harness::runtime::types::RuntimeLaneState,
    scope: &OperationScope,
    resume_after: &crate::harness::session::types::CheckpointData,
    placement_trigger: Option<&str>,
) -> crate::harness::session::types::OperationState {
    let needs_assistant =
        matches!(resume_after.continuation, crate::harness::session::types::Continuation::NeedAssistant { .. });
    if placement_trigger.is_some() {
        return assistant_ready_at_boundary(lane, &state.configuration, scope, placement_trigger.unwrap(), false);
    }
    if needs_assistant {
        return assistant_ready_at_boundary(lane, &state.configuration, scope, &resume_after.trigger_entry_id, false);
    }
    OperationState::Checkpoint { scope: scope.clone(), checkpoint: resume_after.clone() }
}

fn compaction_end_event(
    lane: &str,
    run_id: &str,
    reason: StructuralReason,
    outcome: &StructuralOutcome,
    tip: Option<String>,
    ended_at: u64,
) -> HarnessEvent {
    HarnessEvent::CompactionEnd {
        lane: lane.to_string(),
        run_id: run_id.to_string(),
        reason,
        outcome: match outcome {
            StructuralOutcome::Completed { .. } => EventOutcome::Completed { entry_id: tip },
            StructuralOutcome::Declined => EventOutcome::Declined,
            StructuralOutcome::Failed { error } => EventOutcome::Failed { error: error.clone() },
        },
        ended_at,
        recovery: None,
    }
}

/// Commit the structural effect: the `CompactionEntry` (summary +
/// retained tail + tokens before), the branch-tip move, boundary
/// resumption or settlement, and the `compaction_end` event (pi
/// `publishStructuralOutcome`).
async fn publish_structural_outcome(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    _scope: &OperationScope,
    task: &SummaryTask,
    summary: Option<&SummaryContext>,
    outcome: StructuralOutcome,
) -> SessionResult<ProcedureResult> {
    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let reason = structural_reason(task);

    let outcome_result = lane
        .continue_operation(move |state, current, meta, mutator| {
            let scope = current.scope().clone();
            let mut writes: Vec<Write> = Vec::new();
            let mut terminal_tip_id = state.tip_id.clone();
            let mut next_state: Option<OperationState> = None;
            let mut record: Option<crate::harness::session::types::OperationResultRecord> = None;
            let mut lane_patch: Option<LanePatch> = None;

            match &outcome {
                StructuralOutcome::Completed { text, usage } => {
                    let summary_context = summary.expect("completed structural outcome carries its context");
                    let stored = mutator
                        .get_value(&operation_preparation(&operation_id, &task.task_id))?
                        .ok_or_else(|| {
                            SessionError::Invariant(format!("Structural task {} lost its preparation", task.task_id))
                        })?;
                    let preparation = serde_json::from_value::<DurableStructuralPreparation>(stored.value)
                        .map_err(|e| SessionError::Storage(format!("preparation decode failed: {e}")))?;
                    let DurableStructuralPreparation::Compaction { retained_tail, tokens_before, .. } = preparation
                    else {
                        return Err(SessionError::Invariant(
                            "Compaction task has invalid durable preparation".into(),
                        ));
                    };
                    let entry = NewEntry {
                        id: summary_context.result_entry_id.clone(),
                        parent_id: state.tip_id.clone(),
                        body: EntryBody::Compaction {
                            summary: text.clone(),
                            retained_tail,
                            tokens_before,
                            details: None,
                            usage: usage.clone(),
                            from_hook: false,
                        },
                    };
                    writes.push(insert_entry(entry));
                    writes.push(Write::Value(set_value(
                        &branch_tip(&lane_name),
                        serde_json::Value::String(summary_context.result_entry_id.clone()),
                    )));
                    terminal_tip_id = Some(summary_context.result_entry_id.clone());

                    match &task.boundary {
                        crate::harness::session::types::ResultBoundary::ResumeCheckpoint { resume_after } => {
                            // Plan the boundary inbox from the compaction
                            // entry: queued steering may become the next
                            // trigger, else the run resumes its checkpoint.
                            let placement = plan_boundary_inbox(
                                lane,
                                state,
                                &scope,
                                mutator,
                                false,
                                Some(summary_context.result_entry_id.as_str()),
                            )?;
                            writes.extend(placement.writes.clone());
                            next_state = Some(boundary_resume_state(
                                lane,
                                state,
                                &scope,
                                resume_after,
                                placement.trigger_entry_id.as_deref(),
                            ));
                            lane_patch = Some(LanePatch {
                                tip_id: placement.tip_id.clone().map(Some),
                                inbox: Some(placement.inbox.clone()),
                            });
                        }
                        crate::harness::session::types::ResultBoundary::Finish => {
                            writes.extend(operation_cleanup_writes(mutator, &operation_id, current)?);
                            record = Some(operation_result_record(
                                meta,
                                TerminalStatus::Completed,
                                terminal_tip_id.clone(),
                                None,
                            )?);
                            lane_patch = Some(LanePatch { tip_id: Some(terminal_tip_id.clone()), inbox: None });
                        }
                        crate::harness::session::types::ResultBoundary::CommitNavigation { .. } => {
                            return Err(SessionError::Invariant(
                                "Navigation boundary received a compaction result".into(),
                            ));
                        }
                    }
                }
                StructuralOutcome::Declined => match &task.boundary {
                    crate::harness::session::types::ResultBoundary::ResumeCheckpoint { resume_after } => {
                        // A declined threshold compaction resumes the run
                        // unchanged.
                        let placement = plan_boundary_inbox(lane, state, &scope, mutator, false, None)?;
                        writes.extend(placement.writes.clone());
                        next_state = Some(boundary_resume_state(
                            lane,
                            state,
                            &scope,
                            resume_after,
                            placement.trigger_entry_id.as_deref(),
                        ));
                        lane_patch = Some(LanePatch {
                            tip_id: placement.tip_id.clone().map(Some),
                            inbox: Some(placement.inbox.clone()),
                        });
                    }
                    _ => {
                        writes.extend(operation_cleanup_writes(mutator, &operation_id, current)?);
                        record = Some(operation_result_record(
                            meta,
                            TerminalStatus::Completed,
                            terminal_tip_id.clone(),
                            None,
                        )?);
                    }
                },
                StructuralOutcome::Failed { error } => {
                    writes.extend(operation_cleanup_writes(mutator, &operation_id, current)?);
                    record = Some(operation_result_record(
                        meta,
                        TerminalStatus::Failed,
                        terminal_tip_id.clone(),
                        Some(error.clone()),
                    )?);
                }
            }

            let outcome_for_events = outcome.clone();
            let outcome_for_commit = outcome.clone();
            if let Some(record) = record {
                let run_record = record.clone();
                let run_record_for_events = record.clone();
                let terminal_tip = terminal_tip_id.clone();
                return Ok(OperationCommandFor::Finish {
                    writes,
                    record,
                    lane: lane_patch,
                    materialize: Box::new(move |_| ProcedureResult::Settled { outcome: run_record }),
                    events: Some(Box::new(move |commit| {
                        vec![
                            compaction_end_event(
                                &lane_name,
                                &operation_id,
                                reason,
                                &outcome_for_events,
                                terminal_tip.clone(),
                                commit.timestamp,
                            ),
                            HarnessEvent::RunEnd {
                                lane: lane_name.clone(),
                                run_id: operation_id.clone(),
                                status: run_record_for_events.status,
                                from_tip_id: None,
                                tip_id: terminal_tip.clone(),
                                ended_at: run_record_for_events.ended_at,
                                error: run_record_for_events.error.clone(),
                                recovery: None,
                            },
                        ]
                    })),
                });
            }
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes,
                    materialize: structural_continue(),
                    events: Some(Box::new(move |commit| {
                        vec![compaction_end_event(
                            &lane_name,
                            &operation_id,
                            reason,
                            &outcome_for_commit,
                            terminal_tip_id.clone(),
                            commit.timestamp,
                        )]
                    })),
                },
                operation_state: next_state.expect("continuing outcome carries the next state"),
                lane: lane_patch,
            })
        })
        .await;

    match outcome_result {
        Ok(ContinueOutcome::CancelRequested) => Ok(ProcedureResult::Continue),
        Ok(ContinueOutcome::Result(result)) => Ok(result),
        Err(error) => Err(SessionError::Other(error.to_string())),
    }
}
