//! Port of pi `harness/runtime/drive/tool-placement.ts` — turning staged
//! tool outcomes into transcript entries in source order, and moving the
//! batch to its checkpoint when every call has landed.

use std::sync::Arc;

use serde_json::Value as Json;

use crate::harness::agent_types::AgentMessage;
use crate::harness::session::commit::{insert_entry, insert_usage, NewEntry, UsageRowNoSeq, Write};
use crate::harness::session::types::{
    CheckpointData, Continuation, EntryBody, OperationState, SessionError, SessionResult, ToolBatch, ToolCall,
    ToolCallStatus,
};
use crate::harness::session::values::{branch_tip, delete_value, operation_tool_args_prefix, pending_entry, set_value};
use crate::harness::types::{AssistantContent, AssistantMessage, Message, ToolCall as LlmToolCall, ToolResultMessage};

use super::super::events::HarnessEvent;
use super::super::lane::{Lane, OperationCommandFor};
use super::super::types::{CommitDecision, Drive, LanePatch};

/// The assistant message backing one batch plus its resolved tool-call
/// blocks (pi `ToolBatchSource`).
#[derive(Clone)]
pub struct ToolBatchSource {
    pub assistant: AssistantMessage,
    pub calls: std::collections::HashMap<usize, LlmToolCall>,
}

pub async fn read_tool_batch_source(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    batch: &ToolBatch,
) -> SessionResult<ToolBatchSource> {
    let assistant_entry_id = batch.assistant_entry_id.clone();
    let calls = batch.calls.clone();
    let _ = drive;
    lane.read(move |_state, mutator| {
        let entries = mutator.get_entries(std::slice::from_ref(&assistant_entry_id))?;
        let Some(entry) = entries.into_iter().next() else {
            return Err(SessionError::Invariant("Tool batch assistant entry is invalid".into()));
        };
        let Some(AgentMessage::Llm(Message::Assistant(assistant))) = entry_body_message(&entry) else {
            return Err(SessionError::Invariant("Tool batch assistant entry is invalid".into()));
        };
        let mut source_calls = std::collections::HashMap::new();
        for call in &calls {
            let Some(AssistantContent::ToolCall(block)) = assistant.content.get(call.source_index) else {
                return Err(SessionError::Invariant(format!(
                    "Tool call source index {} does not name a tool-call block",
                    call.source_index
                )));
            };
            source_calls.insert(call.source_index, block.clone());
        }
        Ok(ToolBatchSource { assistant: assistant.clone(), calls: source_calls })
    })
    .await
    .map_err(|error| match error {
        crate::harness::runtime::lane::LaneError::Session(error) => error,
        other => SessionError::Other(other.to_string()),
    })
}

fn entry_body_message(entry: &crate::harness::session::types::Entry) -> Option<&AgentMessage> {
    entry.as_message()
}

pub fn tool_call_for<'a>(sources: &'a ToolBatchSource, call: &ToolCall) -> SessionResult<&'a LlmToolCall> {
    sources
        .calls
        .get(&call.source_index)
        .ok_or_else(|| SessionError::Invariant(format!("Tool call source index {} is invalid", call.source_index)))
}

pub fn with_tool_batch(scope: &crate::harness::session::types::OperationScope, batch: ToolBatch) -> OperationState {
    OperationState::Tools { scope: scope.clone(), batch }
}

/// Staged outcomes ready to become entries, in source order.
pub struct PlacementRead {
    pub items: Vec<(ToolCall, ToolResultMessage)>,
    pub turn_results: Option<Vec<ToolResultMessage>>,
}

fn is_tool_result_message(message: &AgentMessage) -> Option<&ToolResultMessage> {
    match message {
        AgentMessage::Llm(Message::ToolResult(result)) => Some(result),
        _ => None,
    }
}

async fn read_placement(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    sources: &ToolBatchSource,
) -> SessionResult<Option<PlacementRead>> {
    let operation_id = drive.operation_id.clone();
    let source_calls = sources.calls.clone();
    lane.read(move |state, mutator| {
        let Some(operation) = &state.operation else { return Ok(None) };
        let OperationState::Tools { batch: current, .. } = &operation.state else {
            return Ok(None);
        };
        let Some(mut first) = current.calls.iter().position(|call| call.status != ToolCallStatus::Completed) else {
            return Ok(None);
        };
        let mut ready: Vec<ToolCall> = Vec::new();
        while first < current.calls.len() {
            let call = &current.calls[first];
            if call.status != ToolCallStatus::OutcomeReady {
                break;
            }
            ready.push(call.clone());
            first += 1;
        }
        if ready.is_empty() {
            return Ok(None);
        }

        let mut items = Vec::with_capacity(ready.len());
        for call in &ready {
            let Some(stored) = mutator.get_value(&pending_entry(&call.result_entry_id))? else {
                return Err(SessionError::Invariant(format!(
                    "Tool call {} is missing its staged result",
                    call.result_entry_id
                )));
            };
            let pending: crate::harness::session::types::PendingEntry = serde_json::from_value(stored.value)
                .map_err(|e| SessionError::Storage(format!("staged result decode failed: {e}")))?;
            let crate::harness::session::types::PendingEntry::Message { payload } = pending else {
                return Err(SessionError::Invariant(format!(
                    "Tool call {} is missing its staged result",
                    call.result_entry_id
                )));
            };
            let Some(result) = is_tool_result_message(&payload) else {
                return Err(SessionError::Invariant(format!(
                    "Tool call {} is missing its staged result",
                    call.result_entry_id
                )));
            };
            let source = source_calls
                .get(&call.source_index)
                .ok_or_else(|| SessionError::Invariant(format!("Tool call source index {} is invalid", call.source_index)))?;
            if result.tool_call_id != source.id || result.tool_name != source.name {
                return Err(SessionError::Invariant(format!(
                    "Tool call {} has a mismatched staged result",
                    call.result_entry_id
                )));
            }
            items.push((call.clone(), result.clone()));
        }

        let mut turn_results = None;
        if first == current.calls.len() {
            let placed_ids: Vec<String> = current
                .calls
                .iter()
                .filter(|call| call.status == ToolCallStatus::Completed)
                .map(|call| call.result_entry_id.clone())
                .collect();
            let placed = mutator.get_entries(&placed_ids)?;
            let staged: std::collections::HashMap<String, ToolResultMessage> =
                items.iter().map(|(call, message)| (call.result_entry_id.clone(), message.clone())).collect();
            let mut results = Vec::with_capacity(current.calls.len());
            for call in &current.calls {
                let message = staged.get(&call.result_entry_id).cloned().or_else(|| {
                    placed
                        .iter()
                        .find(|entry| entry.id == call.result_entry_id)
                        .and_then(|entry| entry.as_message())
                        .and_then(is_tool_result_message)
                        .cloned()
                });
                let Some(message) = message else {
                    return Err(SessionError::Invariant(format!(
                        "Completed tool call {} is missing its result entry",
                        call.result_entry_id
                    )));
                };
                results.push(message);
            }
            turn_results = Some(results);
        }
        let _ = operation_id;
        Ok(Some(PlacementRead { items, turn_results }))
    })
    .await
    .map_err(|error| match error {
        crate::harness::runtime::lane::LaneError::Session(error) => error,
        other => SessionError::Other(other.to_string()),
    })
}

/// Stage one tool outcome as a pending-entry message (pi
/// `publishToolOutcome`'s write half).
pub fn staged_result_write(result_entry_id: &str, message: &ToolResultMessage) -> SessionResult<Write> {
    let pending = serde_json::to_value(crate::harness::session::types::PendingEntry::Message {
        payload: AgentMessage::Llm(Message::ToolResult(message.clone())),
    })
    .map_err(|e| SessionError::Storage(e.to_string()))?;
    Ok(Write::Value(set_value(&pending_entry(result_entry_id), pending)))
}

/// Commit staged outcomes as transcript entries in source order (pi
/// `commitPlacement`). Returns `true` when the whole batch completed.
async fn commit_placement(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    read: PlacementRead,
) -> SessionResult<bool> {
    let usage_ids: Vec<Option<String>> = read
        .items
        .iter()
        .map(|(_, message)| message.usage.as_ref().map(|_| lane.session.next_id()))
        .collect();

    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    // Captured while the state is still `tools`.
    let turn_id = lane
        .operation_snapshot()
        .map(|operation| match operation.state {
            OperationState::Tools { ref batch, .. } => batch.turn_id.clone(),
            _ => String::new(),
        })
        .unwrap_or_default();

    let outcome = lane
        .settle_operation(move |state, current, _meta, mutator| {
            let OperationState::Tools { batch: current_batch, .. } = current else {
                return Err(SessionError::Invariant("commit_placement on a non-tools operation".into()));
            };
            let mut writes: Vec<Write> = Vec::new();
            let mut event_entries: Vec<(NewEntry, usize)> = Vec::new();
            let mut event_usage: Vec<(UsageRowNoSeq, usize)> = Vec::new();
            let mut parent_id = state.tip_id.clone();
            for (index, (call, message)) in read.items.iter().enumerate() {
                let entry = NewEntry {
                    id: call.result_entry_id.clone(),
                    parent_id: parent_id.clone(),
                    body: EntryBody::Message {
                        message: AgentMessage::Llm(Message::ToolResult(message.clone())),
                        terminate: call.terminate,
                    },
                };
                event_entries.push((entry.clone(), writes.len()));
                writes.push(insert_entry(entry));
                writes.push(Write::Value(delete_value(&pending_entry(&call.result_entry_id))));
                if let (Some(usage_id), Some(usage)) = (&usage_ids[index], &message.usage) {
                    let row = UsageRowNoSeq {
                        id: usage_id.clone(),
                        usage: usage.clone(),
                        entry_id: Some(call.result_entry_id.clone()),
                        adjustment: false,
                        details: None,
                    };
                    event_usage.push((row.clone(), writes.len()));
                    writes.push(insert_usage(row));
                }
                parent_id = Some(call.result_entry_id.clone());
            }

            let completed_calls: Vec<ToolCall> = current_batch
                .calls
                .iter()
                .map(|call| {
                    match read.items.iter().find(|(candidate, _)| {
                        candidate.source_index == call.source_index
                            && candidate.result_entry_id == call.result_entry_id
                    }) {
                        Some((staged, _)) => ToolCall {
                            status: ToolCallStatus::Completed,
                            source_index: call.source_index,
                            result_entry_id: call.result_entry_id.clone(),
                            replay: call.replay.clone(),
                            terminate: staged.terminate,
                        },
                        None => call.clone(),
                    }
                })
                .collect();
            let complete = completed_calls
                .iter()
                .all(|call| call.status == ToolCallStatus::Completed);
            let all_terminate = complete
                && completed_calls
                    .iter()
                    .all(|call| call.terminate.unwrap_or(false));
            let Some(tip) = parent_id.clone() else {
                return Err(SessionError::Invariant("Tool placement has no tip".into()));
            };
            writes.push(Write::Value(set_value(&branch_tip(&lane_name), Json::String(tip.clone()))));

            let scope = current.scope().clone();
            let next_state = if complete {
                let args = mutator.scan_values(&operation_tool_args_prefix(&operation_id, Some(&turn_id)))?;
                for stored in args {
                    writes.push(Write::Value(delete_value(&stored.address)));
                }
                OperationState::Checkpoint {
                    scope,
                    checkpoint: CheckpointData {
                        continuation: if all_terminate {
                            Continuation::MayFinish { include_final_assistant: false }
                        } else {
                            Continuation::NeedAssistant { overflow_recovery_used: false }
                        },
                        trigger_entry_id: tip.clone(),
                    },
                }
            } else {
                with_tool_batch(
                    &scope,
                    ToolBatch { calls: completed_calls, ..current_batch.clone() },
                )
            };

            let events_entries = event_entries;
            let events_usage = event_usage;
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes,
                    materialize: Box::new(move |_| complete),
                    events: Some(Box::new(move |commit| {
                        let mut events = Vec::new();
                        for (entry, seq_index) in &events_entries {
                            events.push(HarnessEvent::EntryAdded {
                                lane: lane_name.clone(),
                                entry: crate::harness::session::commit::materialize_committed_entry(
                                    entry,
                                    commit.seqs.get(*seq_index).copied().unwrap_or(0),
                                    commit.timestamp,
                                ),
                                recovery: None,
                            });
                            if let Some((row, usage_index)) =
                                events_usage.iter().find(|(candidate, _)| candidate.entry_id == Some(entry.id.clone()))
                            {
                                events.push(HarnessEvent::Usage {
                                    row: crate::harness::session::types::UsageRow {
                                        id: row.id.clone(),
                                        seq: commit.seqs.get(*usage_index).copied().unwrap_or(0),
                                        usage: row.usage.clone(),
                                        entry_id: row.entry_id.clone(),
                                        adjustment: row.adjustment,
                                        details: row.details.clone(),
                                    },
                                    totals: commit.stats.usage.clone(),
                                    recovery: None,
                                });
                            }
                        }
                        events
                    })),
                },
                operation_state: next_state,
                lane: Some(LanePatch { tip_id: Some(Some(tip)), inbox: None }),
            })
        })
        .await;

    outcome.map_err(|error| SessionError::Other(error.to_string()))
}

/// Materialize staged outcomes in source order; on batch completion emit
/// the turn-end observation (pi `materializeReady`).
pub async fn materialize_ready(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    sources: &ToolBatchSource,
    recovery: bool,
) -> SessionResult<()> {
    let Some(read) = read_placement(lane, drive, sources).await? else {
        return Ok(());
    };
    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    for (call, message) in &read.items {
        lane.emit_public(HarnessEvent::MessageStart {
            lane: lane_name.clone(),
            run_id: Some(operation_id.clone()),
            message: AgentMessage::Llm(Message::ToolResult(message.clone())),
            recovery: recovery.then_some(true),
        });
        lane.emit_public(HarnessEvent::MessageEnd {
            lane: lane_name.clone(),
            run_id: Some(operation_id.clone()),
            message: AgentMessage::Llm(Message::ToolResult(message.clone())),
            entry_id: Some(call.result_entry_id.clone()),
            recovery: recovery.then_some(true),
        });
    }
    let turn_id = materialize_turn_id(lane);
    let turn_results = read.turn_results.clone();
    let complete = commit_placement(lane, drive, read).await?;
    if complete {
        if let Some(turn_results) = turn_results {
            lane.emit_public(HarnessEvent::TurnEnd {
                lane: lane_name,
                run_id: operation_id,
                turn_id,
                message: AgentMessage::Llm(Message::Assistant(sources.assistant.clone())),
                tool_results: turn_results.into_iter().map(|m| AgentMessage::Llm(Message::ToolResult(m))).collect(),
                recovery: recovery.then_some(true),
            });
        }
    }
    Ok(())
}

fn materialize_turn_id(lane: &Arc<Lane>) -> String {
    lane.operation_snapshot()
        .map(|operation| match operation.state {
            OperationState::Tools { ref batch, .. } => batch.turn_id.clone(),
            _ => String::new(),
        })
        .unwrap_or_default()
}
