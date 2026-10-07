//! Port of pi `harness/runtime/drive/tools.ts` — executing, recovering,
//! staging, and source-ordering one durable tool batch.
//!
//! Every call walks planned → effect_pending (args persisted) → execution
//! through the gate → outcome_ready (result staged) → completed (entry
//! committed by placement). Recovery of an `effect_pending` call either
//! re-executes (`replay: safe`) or synthesizes the canonical
//! "interrupted, outcome unknown" result (`replay: never`).

use std::sync::Arc;

use serde_json::Value as Json;

use crate::harness::agent_types::AgentToolResult;
use crate::harness::session::commit::Write;
use crate::harness::session::types::{
    Control, OperationState, SessionError, SessionResult, ToolBatch, ToolCall, ToolCallStatus,
};
use crate::harness::session::values::{
    delete_value, operation_tool_args, operation_tool_memo_prefix, pending_tool_output, set_value,
};
use crate::harness::types::{ToolCall as LlmToolCall, ToolResultMessage, UserContent};

use super::super::events::HarnessEvent;
use super::super::hooks::{AfterToolEvent, BeforeToolEvent, HookContext};
use super::super::lane::{ContinueOutcome, Lane, OperationCommandFor};
use super::super::tool_exec::{
    apply_before_tool_decision, create_tool_result_message, execute_tool_call, finalize_tool_call, prepare_tool_call,
    ClearedToolCall, ImmediateToolOutcome, ReplayPolicy, RuntimeTool, ToolInvocationCapability,
};
use super::super::types::{CommitDecision, Drive, ProcedureResult};
use super::tool_placement::{
    materialize_ready, read_tool_batch_source, staged_result_write, tool_call_for, with_tool_batch, ToolBatchSource,
};

const INTERRUPTION_MARKER: &str = "[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

/// One settled tool outcome heading for staging.
struct ToolOutcome {
    tool_call: LlmToolCall,
    message: ToolResultMessage,
    terminate: bool,
}

fn synthetic_message(
    tool_call: &LlmToolCall,
    content: Vec<UserContent>,
    details: Option<Json>,
    usage: Option<crate::harness::types::Usage>,
) -> ToolResultMessage {
    ToolResultMessage {
        tool_call_id: tool_call.id.clone(),
        tool_name: tool_call.name.clone(),
        content,
        details,
        usage,
        is_error: true,
        timestamp: crate::harness::session::session::now_ms() as i64,
    }
}

fn aborted_outcome(tool_call: &LlmToolCall) -> ToolOutcome {
    ToolOutcome {
        tool_call: tool_call.clone(),
        message: synthetic_message(
            tool_call,
            vec![UserContent::Text(crate::harness::types::TextContent {
                text: "Tool execution was cancelled before completion.".into(),
                text_signature: None,
            })],
            None,
            None,
        ),
        terminate: false,
    }
}

fn interrupted_outcome(tool_call: &LlmToolCall, checkpoint: Option<AgentToolResult>) -> ToolOutcome {
    let mut content = checkpoint.as_ref().map(|c| c.content.clone()).unwrap_or_default();
    content.push(UserContent::Text(crate::harness::types::TextContent {
        text: INTERRUPTION_MARKER.into(),
        text_signature: None,
    }));
    ToolOutcome {
        tool_call: tool_call.clone(),
        message: synthetic_message(
            tool_call,
            content,
            checkpoint.as_ref().and_then(|c| (!c.details.is_null()).then(|| c.details.clone())),
            checkpoint.and_then(|c| c.usage.clone()),
        ),
        terminate: false,
    }
}

fn truncated_outcome(tool_call: &LlmToolCall) -> ToolOutcome {
    ToolOutcome {
        tool_call: tool_call.clone(),
        message: synthetic_message(
            tool_call,
            vec![UserContent::Text(crate::harness::types::TextContent {
                text: format!(
                    "Tool call {:?} was not executed because the assistant response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.",
                    tool_call.name
                ),
                text_signature: None,
            })],
            None,
            None,
        ),
        terminate: false,
    }
}

fn outcome_from_immediate(tool_call: &LlmToolCall, immediate: ImmediateToolOutcome) -> ToolOutcome {
    ToolOutcome {
        tool_call: tool_call.clone(),
        message: synthetic_tool_message(&immediate.result, tool_call, immediate.is_error),
        terminate: immediate.terminate,
    }
}

fn synthetic_tool_message(
    result: &AgentToolResult,
    tool_call: &LlmToolCall,
    is_error: bool,
) -> ToolResultMessage {
    ToolResultMessage {
        tool_call_id: tool_call.id.clone(),
        tool_name: tool_call.name.clone(),
        content: result.content.clone(),
        details: (!result.details.is_null()).then(|| result.details.clone()),
        usage: result.usage.clone(),
        is_error,
        timestamp: crate::harness::session::session::now_ms() as i64,
    }
}

fn replace_call(batch: &ToolBatch, replacement: ToolCall) -> ToolBatch {
    let calls = batch
        .calls
        .iter()
        .map(|call| {
            if call.source_index == replacement.source_index && call.result_entry_id == replacement.result_entry_id {
                replacement.clone()
            } else {
                call.clone()
            }
        })
        .collect();
    ToolBatch { calls, ..batch.clone() }
}

/// Publish the durable effect intent: persist arguments, mark the call
/// `effect_pending`, emit `tool_start` (pi `publishToolIntent`).
async fn publish_tool_intent(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    planned: &ToolCall,
    tool_call: &LlmToolCall,
    args: &Json,
    replay: ReplayPolicy,
    recovery: bool,
) -> SessionResult<Option<ToolCall>> {
    let operation_id = drive.operation_id.clone();
    let lane_name = lane.name.clone();
    let effect_pending = ToolCall {
        status: ToolCallStatus::EffectPending,
        source_index: planned.source_index,
        result_entry_id: planned.result_entry_id.clone(),
        replay: Some(match replay {
            ReplayPolicy::Safe => "safe".into(),
            ReplayPolicy::Never => "never".into(),
        }),
        terminate: None,
    };
    let planned_clone = planned.clone();
    let effect_for_materialize = effect_pending.clone();
    let turn_id = current_turn_id(lane);
    let event_tool_call = tool_call.clone();
    let event_args = args.clone();
    let outcome = lane
        .continue_operation(move |_state, current, _meta, _mutator| {
            let OperationState::Tools { scope, batch } = current else {
                return Err(SessionError::Invariant("publish_tool_intent on a non-tools operation".into()));
            };
            let args_address = operation_tool_args(&operation_id, &batch.turn_id, planned_clone.source_index);
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes: vec![Write::Value(set_value(&args_address, args.clone()))],
                    materialize: Box::new(move |_| ()),
                    events: Some(Box::new(move |_| {
                        vec![HarnessEvent::ToolStart {
                            lane: lane_name.clone(),
                            run_id: operation_id.clone(),
                            turn_id: turn_id.clone(),
                            tool_call_id: event_tool_call.id.clone(),
                            tool_name: event_tool_call.name.clone(),
                            args: event_args.clone(),
                            recovery: recovery.then_some(true),
                        }]
                    })),
                },
                operation_state: with_tool_batch(scope, replace_call(batch, effect_pending.clone())),
                lane: None,
            })
        })
        .await;
    match outcome {
        Ok(ContinueOutcome::CancelRequested) => Ok(None),
        Ok(ContinueOutcome::Result(())) => Ok(Some(effect_for_materialize)),
        Err(error) => Err(SessionError::Other(error.to_string())),
    }
}

/// Stage one settled outcome: pending-entry message + outcome_ready status
/// + `tool_end` (pi `publishToolOutcome`).
async fn publish_tool_outcome(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    call: &ToolCall,
    tool_call: &LlmToolCall,
    finalized: ToolOutcome,
    recovery: bool,
) -> SessionResult<()> {
    let operation_id = drive.operation_id.clone();
    let lane_name = lane.name.clone();
    let result_entry_id = call.result_entry_id.clone();
    let turn_id = current_turn_id(lane);
    let durable_terminate = matches!(
        lane.operation_snapshot().map(|op| op.state.scope().control.clone()),
        Some(Control::Running)
    ) && finalized.terminate;
    let staged = finalized.message.clone();
    let emit_start = call.status == ToolCallStatus::Planned;
    let args_for_start = tool_call.arguments.clone();
    let start_tool_call = tool_call.clone();
    let end_tool_call = tool_call.clone();
    let end_message = finalized.message.clone();
    let call_for_state = call.clone();

    lane.settle_operation(move |_state, current, _meta, mutator| {
            let OperationState::Tools { scope, batch } = current else {
                return Err(SessionError::Invariant("publish_tool_outcome on a non-tools operation".into()));
            };
            let memos = mutator.scan_values(&operation_tool_memo_prefix(
                &operation_id,
                Some(&result_entry_id),
            ))?;
            let outcome_call = ToolCall {
                status: ToolCallStatus::OutcomeReady,
                source_index: call_for_state.source_index,
                result_entry_id: call_for_state.result_entry_id.clone(),
                replay: call_for_state.replay.clone(),
                terminate: durable_terminate.then_some(true),
            };
            let mut writes = vec![
                staged_result_write(&result_entry_id, &staged)?,
                Write::Value(delete_value(&pending_tool_output(&operation_id, &result_entry_id))),
            ];
            for stored in memos {
                writes.push(Write::Value(delete_value(&stored.address)));
            }
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes,
                    materialize: Box::new(|_| ()),
                    events: Some(Box::new(move |_| {
                        let mut events = Vec::new();
                        if emit_start {
                            events.push(HarnessEvent::ToolStart {
                                lane: lane_name.clone(),
                                run_id: operation_id.clone(),
                                turn_id: turn_id.clone(),
                                tool_call_id: start_tool_call.id.clone(),
                                tool_name: start_tool_call.name.clone(),
                                args: args_for_start.clone(),
                                recovery: recovery.then_some(true),
                            });
                        }
                        events.push(HarnessEvent::ToolEnd {
                            lane: lane_name.clone(),
                            run_id: operation_id.clone(),
                            turn_id: turn_id.clone(),
                            tool_call_id: end_tool_call.id.clone(),
                            tool_name: end_tool_call.name.clone(),
                            result: crate::harness::runtime::tool_exec::tool_result_from_message(
                                &end_message,
                                durable_terminate,
                            ),
                            is_error: end_message.is_error,
                            terminate: durable_terminate,
                            recovery: recovery.then_some(true),
                        });
                        events
                    })),
                },
                operation_state: with_tool_batch(scope, replace_call(batch, outcome_call)),
                lane: None,
            })
        })
        .await
        .map_err(|error| SessionError::Other(error.to_string()))
}

/// Read back persisted arguments and drop the staged progress snapshot
/// (pi `clearReplayCheckpoint`); emits the recovery `tool_start`.
async fn clear_replay_checkpoint(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    batch: &ToolBatch,
    call: &ToolCall,
    tool_call: &LlmToolCall,
) -> SessionResult<Json> {
    let operation_id = drive.operation_id.clone();
    let lane_name = lane.name.clone();
    let args_address = operation_tool_args(&operation_id, &batch.turn_id, call.source_index);
    let result_entry_id = call.result_entry_id.clone();
    let turn_id = batch.turn_id.clone();
    let event_tool_call = tool_call.clone();
    lane.command(move |state, mutator| {
            let Some(stored) = mutator.get_value(&args_address)? else {
                return Err(SessionError::Invariant(format!(
                    "Tool call {} is missing persisted arguments",
                    result_entry_id
                )));
            };
            let args = stored.value.clone();
            let event_args = stored.value.clone();
            Ok(super::super::types::LaneCommand::Commit {
                decision: CommitDecision {
                    writes: vec![Write::Value(delete_value(&pending_tool_output(&operation_id, &result_entry_id)))],
                    materialize: Box::new(move |_| args.clone()),
                    events: Some(Box::new(move |_| {
                        vec![HarnessEvent::ToolStart {
                            lane: lane_name,
                            run_id: operation_id,
                            turn_id,
                            tool_call_id: event_tool_call.id.clone(),
                            tool_name: event_tool_call.name.clone(),
                            args: event_args,
                            recovery: Some(true),
                        }]
                    })),
                },
                next: lane_next_state(state),
            })
        })
        .await
        .map_err(|error| SessionError::Other(error.to_string()))
}

fn lane_next_state(state: &super::super::types::RuntimeLaneState) -> super::super::types::RuntimeLaneState {
    state.clone()
}

/// Read the durable progress snapshot of one in-flight call.
async fn read_checkpoint(lane: &Arc<Lane>, drive: &Arc<Drive>, call: &ToolCall) -> SessionResult<Option<AgentToolResult>> {
    let address = pending_tool_output(&drive.operation_id, &call.result_entry_id);
    lane.read(move |_state, mutator| {
        Ok(mutator
            .get_value(&address)?
            .and_then(|stored| serde_json::from_value::<AgentToolResult>(stored.value).ok()))
    })
    .await
    .map_err(|error| SessionError::Other(error.to_string()))
}

fn current_turn_id(lane: &Arc<Lane>) -> String {
    lane.operation_snapshot()
        .map(|operation| match operation.state {
            OperationState::Tools { ref batch, .. } => batch.turn_id.clone(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

/// Execute one cleared call through the gate, patch through after_tool
/// (pi `performToolInvocation`).
async fn perform_tool_invocation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    effect_pending: &ToolCall,
    cleared: ClearedToolCall,
    recovery: bool,
) -> SessionResult<ToolOutcome> {
    let (capability, _active) =
        ToolInvocationCapability::new(Arc::clone(lane), drive.operation_id.clone(), effect_pending.result_entry_id.clone());
    let update_turn_id = current_turn_id(lane);

    let lane_for_update = Arc::clone(lane);
    let drive_for_update = Arc::clone(drive);
    let call_for_update = effect_pending.clone();
    let tool_call_for_update = cleared.tool_call.clone();
    let recovery_for_update = recovery;
    let update_turn_id_arc: Arc<String> = Arc::new(update_turn_id);
    let update: Arc<dyn Fn(&AgentToolResult, bool) + Send + Sync> = Arc::new(
        move |partial: &AgentToolResult, checkpoint: bool| {
            let lane = Arc::clone(&lane_for_update);
            let drive = Arc::clone(&drive_for_update);
            let call = call_for_update.clone();
            let tool_call = tool_call_for_update.clone();
            let partial = partial.clone();
            let recovery = recovery_for_update;
            let update_turn_id = (*update_turn_id_arc).clone();
            tokio::spawn(async move {
                if checkpoint {
                    let address = pending_tool_output(&drive.operation_id, &call.result_entry_id);
                    let json = serde_json::to_value(&partial).expect("tool snapshot serializes");
                    let _ = lane
                        .command(move |state, _| {
                            let owns = state.operation.as_ref().is_some_and(|op| {
                                matches!(op.state, OperationState::Tools { .. })
                                    && state_tool_call_is_pending(&op.state, &call.result_entry_id)
                            });
                            if !owns {
                                return Ok(super::super::types::LaneCommand::Return { result: () });
                            }
                            Ok(super::super::types::LaneCommand::Commit {
                                decision: CommitDecision {
                                    writes: vec![Write::Value(set_value(&address, json))],
                                    materialize: Box::new(|_| ()),
                                    events: None,
                                },
                                next: state.clone(),
                            })
                        })
                        .await;
                }
                lane.emit_public(HarnessEvent::ToolUpdate {
                    lane: lane.name.clone(),
                    run_id: drive.operation_id.clone(),
                    turn_id: update_turn_id.clone(),
                    tool_call_id: tool_call.id.clone(),
                    tool_name: tool_call.name.clone(),
                    partial_result: partial,
                    recovery: recovery.then_some(true),
                });
            });
        },
    );

    let executed = execute_tool_call(&cleared, &drive.gate, update, capability).await?;

    // after_tool may patch the settled output (fail-open on gate aborts).
    let patch = lane
        .hooks
        .run_after_tool_with_gate(
            &HookContext { lane: lane.name.clone(), run_id: drive.operation_id.clone() },
            &AfterToolEvent {
                tool_call_id: cleared.tool_call.id.clone(),
                tool_name: cleared.tool_call.name.clone(),
                args: cleared.args.clone(),
                content: serde_json::to_value(&executed.result.content).unwrap_or(Json::Null),
                details: (!executed.result.details.is_null()).then(|| executed.result.details.clone()),
                is_error: executed.is_error,
                usage: executed.result.usage.clone(),
            },
            &drive.gate,
        )
        .ok()
        .flatten();

    let finalized = finalize_tool_call(&cleared, executed, patch.as_ref());
    Ok(ToolOutcome {
        tool_call: finalized.tool_call.clone(),
        message: create_tool_result_message(&finalized),
        terminate: finalized.terminate,
    })
}

fn state_tool_call_is_pending(state: &OperationState, result_entry_id: &str) -> bool {
    match state {
        OperationState::Tools { batch, .. } => batch
            .calls
            .iter()
            .any(|call| call.result_entry_id == result_entry_id && call.status == ToolCallStatus::EffectPending),
        _ => false,
    }
}

/// Resolve + gate the call through before_tool (pi
/// `prepareToolInvocation`).
async fn prepare_tool_invocation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    sources: &ToolBatchSource,
    call: &ToolCall,
    tools: &[Arc<RuntimeTool>],
) -> SessionResult<Result<ClearedToolCall, ToolOutcome>> {
    let tool_call = tool_call_for(sources, call)?.clone();
    if sources.assistant.stop_reason == crate::harness::types::StopReason::Length {
        return Ok(Err(truncated_outcome(&tool_call)));
    }
    let prepared = match prepare_tool_call(&tool_call, tools) {
        Ok(prepared) => prepared,
        Err(immediate) => return Ok(Err(outcome_from_immediate(&tool_call, immediate))),
    };

    let decision = lane
        .hooks
        .run_before_tool_with_gate(
            &HookContext { lane: lane.name.clone(), run_id: drive.operation_id.clone() },
            &BeforeToolEvent {
                tool_call_id: tool_call.id.clone(),
                tool_name: tool_call.name.clone(),
                args: prepared.args.clone(),
            },
            &drive.gate,
        )
        .map_err(|error| SessionError::Other(error.to_string()))?;

    Ok(match apply_before_tool_decision(prepared, Some(decision).as_ref()) {
        Ok(cleared) => Ok(cleared),
        Err(immediate) => Err(outcome_from_immediate(&tool_call, immediate)),
    })
}

async fn start_tool_invocation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    sources: &ToolBatchSource,
    call: &ToolCall,
    tools: &[Arc<RuntimeTool>],
    recovery: bool,
) -> SessionResult<()> {
    match prepare_tool_invocation(lane, drive, sources, call, tools).await? {
        Err(outcome) => {
            let tool_call = outcome.tool_call.clone();
            publish_tool_outcome(lane, drive, call, &tool_call, outcome, recovery).await?;
            Ok(())
        }
        Ok(cleared) => {
            let replay = cleared.tool.replay;
            let effect_pending = publish_tool_intent(
                lane,
                drive,
                call,
                &cleared.tool_call.clone(),
                &cleared.args.clone(),
                replay,
                recovery,
            )
            .await?;
            let Some(effect_pending) = effect_pending else {
                let aborted = aborted_outcome(&cleared.tool_call);
                publish_tool_outcome(lane, drive, call, &cleared.tool_call, aborted, recovery).await?;
                return Ok(());
            };
            let tool_call = cleared.tool_call.clone();
            let outcome = perform_tool_invocation(lane, drive, &effect_pending, cleared, recovery).await?;
            publish_tool_outcome(lane, drive, &effect_pending, &tool_call, outcome, recovery).await?;
            Ok(())
        }
    }
}

async fn recover_tool_invocation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    sources: &ToolBatchSource,
    call: &ToolCall,
    tools: &[Arc<RuntimeTool>],
    cancelled: bool,
) -> SessionResult<()> {
    let tool_call = tool_call_for(sources, call)?.clone();
    let tool = tools.iter().find(|tool| tool.declaration.name == tool_call.name);
    let call_replay_safe = call.replay.as_deref() == Some("safe");
    let tool_replay_safe = tool.map(|tool| tool.replay == ReplayPolicy::Safe).unwrap_or(false);
    if !cancelled && call_replay_safe && tool_replay_safe {
        let args = clear_replay_checkpoint(lane, drive, &current_batch(lane).expect("tools batch"), call, &tool_call).await?;
        let tool = tool.expect("replay-safe tool resolved above");
        let cleared = ClearedToolCall { tool_call: tool_call.clone(), tool: Arc::clone(tool), args };
        let outcome = perform_tool_invocation(lane, drive, call, cleared, true).await?;
        publish_tool_outcome(lane, drive, call, &tool_call, outcome, true).await?;
        return Ok(());
    }
    let checkpoint = read_checkpoint(lane, drive, call).await?;
    let outcome = interrupted_outcome(&tool_call, checkpoint);
    publish_tool_outcome(lane, drive, call, &tool_call, outcome, true).await?;
    Ok(())
}

fn current_batch(lane: &Arc<Lane>) -> Option<ToolBatch> {
    lane.operation_snapshot().and_then(|operation| match operation.state {
        OperationState::Tools { batch, .. } => Some(batch),
        _ => None,
    })
}

/// Sequential execution: one call at a time, materializing staged
/// outcomes between invocations (pi `runSequential`).
async fn run_sequential(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    sources: &ToolBatchSource,
    tools: Option<&[Arc<RuntimeTool>]>,
    recovery: bool,
) -> SessionResult<ProcedureResult> {
    let Some(batch) = current_batch(lane) else { return Ok(ProcedureResult::Continue) };
    for transition in 0..=(batch.calls.len() * 2 + 1) {
        materialize_ready(lane, drive, sources, recovery).await?;
        let Some(operation) = lane.operation_snapshot() else {
            return Ok(ProcedureResult::Continue);
        };
        let OperationState::Tools { scope: run_scope, batch: current } = operation.state else {
            return Ok(ProcedureResult::Continue);
        };
        let Some(call) = current.calls.iter().find(|call| call.status != ToolCallStatus::Completed) else {
            return Err(SessionError::Invariant(
                "Tool batch remained open after every call completed".into(),
            ));
        };
        if call.status == ToolCallStatus::OutcomeReady {
            return Err(SessionError::Invariant("Ready tool outcome was not materialized".into()));
        }
        let cancelled = matches!(run_scope.control, Control::CancelRequested { .. });

        if cancelled {
            let tool_call = tool_call_for(sources, call)?.clone();
            let outcome = if call.status == ToolCallStatus::Planned {
                aborted_outcome(&tool_call)
            } else {
                let checkpoint = read_checkpoint(lane, drive, call).await?;
                interrupted_outcome(&tool_call, checkpoint)
            };
            publish_tool_outcome(lane, drive, call, &tool_call, outcome, recovery).await?;
            continue;
        }

        let Some(tools) = tools else {
            return Err(SessionError::Invariant("Running tool batch is missing execution context".into()));
        };
        if call.status == ToolCallStatus::Planned {
            start_tool_invocation(lane, drive, sources, call, tools, recovery).await?;
        } else {
            recover_tool_invocation(lane, drive, sources, call, tools, false).await?;
        }
        let _ = transition;
    }
    Err(SessionError::Invariant(
        "Sequential tool batch exceeded its bounded transition count".into(),
    ))
}

/// Parallel execution: every open call runs concurrently; staged outcomes
/// materialize as invocations settle (pi `runParallel`).
async fn run_parallel(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    sources: &ToolBatchSource,
    tools: &[Arc<RuntimeTool>],
    recovery: bool,
) -> SessionResult<ProcedureResult> {
    let Some(batch) = current_batch(lane) else { return Ok(ProcedureResult::Continue) };
    let mut jobs = Vec::new();
    for call in &batch.calls {
        if matches!(call.status, ToolCallStatus::Completed | ToolCallStatus::OutcomeReady) {
            continue;
        }
        let cancelled = matches!(
            lane.operation_snapshot().map(|op| op.state.scope().control.clone()),
            Some(Control::CancelRequested { .. })
        );
        let lane = Arc::clone(lane);
        let drive = Arc::clone(drive);
        let sources = sources.clone();
        let call = call.clone();
        let tools = tools.to_vec();
        let job = tokio::spawn(async move {
            if call.status == ToolCallStatus::Planned {
                start_tool_invocation(&lane, &drive, &sources, &call, &tools, recovery).await
            } else {
                recover_tool_invocation(&lane, &drive, &sources, &call, &tools, cancelled).await
            }
        });
        jobs.push(job);
    }
    for job in jobs {
        job.await
            .map_err(|error| SessionError::Other(format!("tool job panicked: {error}")))??;
        materialize_ready(lane, drive, sources, recovery).await?;
    }
    materialize_ready(lane, drive, sources, recovery).await?;
    Ok(ProcedureResult::Continue)
}

/// Execute, recover, stage, and source-order one complete durable tool
/// batch (pi `runTools`).
pub async fn run_tools(lane: &Arc<Lane>, drive: &Arc<Drive>) -> SessionResult<ProcedureResult> {
    let Some(operation) = lane.operation_snapshot() else {
        return Ok(ProcedureResult::Continue);
    };
    let OperationState::Tools { scope: run_scope, batch } = operation.state else {
        return Ok(ProcedureResult::Continue);
    };
    let recovery = batch
        .calls
        .iter()
        .any(|call| matches!(call.status, ToolCallStatus::EffectPending | ToolCallStatus::OutcomeReady));
    if recovery {
        lane.emit_public(HarnessEvent::TurnStart {
            lane: lane.name.clone(),
            run_id: drive.operation_id.clone(),
            turn_id: batch.turn_id.clone(),
            recovery: Some(true),
        });
    }

    let sources = read_tool_batch_source(lane, drive, &batch).await?;
    materialize_ready(lane, drive, &sources, recovery).await?;

    let Some(operation) = lane.operation_snapshot() else {
        return Ok(ProcedureResult::Continue);
    };
    let OperationState::Tools { scope: current_scope, .. } = operation.state else {
        return Ok(ProcedureResult::Continue);
    };
    if matches!(current_scope.control, Control::CancelRequested { .. }) {
        return run_sequential(lane, drive, &sources, None, recovery).await;
    }

    let config = lane.read_config();
    let active: std::collections::HashSet<&String> = batch.configuration.active_tool_names.iter().collect();
    let tools: Vec<Arc<RuntimeTool>> = config
        .tools
        .iter()
        .filter(|tool| active.contains(&tool.declaration.name))
        .cloned()
        .collect();
    let sequential = matches!(
        run_scope.settings.tool_execution,
        crate::harness::session::types::ToolExecutionMode::Sequential
    );
    if sequential {
        run_sequential(lane, drive, &sources, Some(&tools), recovery).await
    } else {
        run_parallel(lane, drive, &sources, &tools, recovery).await
    }
}
