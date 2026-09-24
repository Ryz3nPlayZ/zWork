//! Port of pi `harness/runtime/drive/boundary.ts` — run-boundary planning:
//! which queued input becomes entries at this boundary, and whether the run
//! renews itself or finishes.
//!
//! One boundary commits at most once: selected inbox items become chained
//! entries, consumed payloads are dropped, the tip moves, and the operation
//! either re-arms generation (`assistant.ready` with the new trigger) or
//! settles through [`finish_run_boundary`].

use std::sync::Arc;

use crate::harness::agent_types::AgentMessage;
use crate::harness::session::commit::{insert_entry, NewEntry, Write};
use crate::harness::session::context::build_session_context;
use crate::harness::session::session::SessionMutator;
use crate::harness::session::types::{
    CommitResult, Continuation, Entry, GenerationContext, InboxItem, InboxItemKind, LaneConfiguration,
    NormalizedRetryPolicy, OperationScope, OperationState, PendingEntry, SessionError, SessionResult,
};
use crate::harness::session::values::{branch_tip, delete_value, pending_entry, set_value};

use super::super::effect_gate::GateError;
use super::super::events::{HarnessEvent, LaneQueuedItem};
use super::super::hooks::HookContext;
use super::super::lane::{ContinueOutcome, Lane, OperationCommandFor};
use super::super::terminal::{operation_cleanup_writes, operation_result_record};
use super::super::transcript::read_lane_queues;
use super::super::types::{CommitDecision, Drive, LanePatch, ProcedureResult, RuntimeLaneState};
use crate::harness::session::types::TerminalStatus;

/// The boundary planner's caller value when the checkpoint decides the run
/// may finish (pi `BoundaryFinishPending`).
#[derive(Debug, Clone)]
pub struct BoundaryFinishPending {
    pub entry_ids: Vec<String>,
}

/// One boundary's planned lane-owned input, before committing it
/// (pi `BoundaryPlacement`).
pub struct BoundaryPlacement {
    pub entries: Vec<NewEntry>,
    pub writes: Vec<Write>,
    pub tip_id: Option<String>,
    pub inbox: Vec<InboxItem>,
    pub trigger_entry_id: Option<String>,
    pub queues: Option<Vec<LaneQueuedItem>>,
}

/// Normalized retry parameters for generation contexts (pi
/// `normalizedRetryPolicy`).
pub fn normalized_retry_policy(lane: &Lane) -> NormalizedRetryPolicy {
    lane.read_config().retry_policy.normalized()
}

/// Build the `assistant.ready` state for a boundary trigger (pi
/// `assistantReadyAtBoundary`).
pub fn assistant_ready_at_boundary(
    lane: &Lane,
    configuration: &LaneConfiguration,
    scope: &OperationScope,
    trigger_entry_id: &str,
    overflow_recovery_used: bool,
) -> OperationState {
    OperationState::AssistantReady {
        scope: scope.clone(),
        generation: GenerationContext {
            step_id: lane.session.next_id(),
            trigger_entry_id: trigger_entry_id.to_string(),
            configuration: configuration.clone(),
            stream_options: lane.read_config().stream_options,
            retry_policy: normalized_retry_policy(lane),
            overflow_recovery_used,
        },
        next_attempt: 1,
    }
}

/// Select and materialize one boundary's lane-owned input without
/// committing it (pi `planBoundaryInbox`). Write items and
/// mode-eligible steers always go; follow-ups only when nothing that
/// projects onto the context was selected.
pub fn plan_boundary_inbox(
    lane: &Lane,
    state: &RuntimeLaneState,
    scope: &OperationScope,
    mutator: &mut SessionMutator<'_>,
    follow_up_when_no_trigger: bool,
) -> SessionResult<BoundaryPlacement> {
    let inbox = &state.inbox;
    let steer: Vec<&InboxItem> = inbox.iter().filter(|item| item.kind == InboxItemKind::Steer).collect();
    let selected_steer: Vec<&InboxItem> = if matches!(scope.settings.steering_mode, crate::harness::session::types::QueueMode::All) {
        steer
    } else {
        steer.into_iter().take(1).collect()
    };
    let mut selected: Vec<InboxItem> = inbox
        .iter()
        .filter(|item| {
            item.kind == InboxItemKind::Write
                || selected_steer
                    .iter()
                    .any(|candidate| candidate.entry_id == item.entry_id)
        })
        .cloned()
        .collect();

    let load = |items: &[InboxItem]| -> SessionResult<Vec<(InboxItem, PendingEntry)>> {
        items
            .iter()
            .map(|item| {
                let stored = mutator.get_value(&pending_entry(&item.entry_id))?.ok_or_else(|| {
                    SessionError::Invariant(format!(
                        "Pending {:?} entry {} is missing its payload",
                        item.kind, item.entry_id
                    ))
                })?;
                let pending: PendingEntry = serde_json::from_value(stored.value)
                    .map_err(|e| SessionError::Storage(format!("pending entry decode failed: {e}")))?;
                if item.kind != InboxItemKind::Write {
                    if let PendingEntry::Custom { .. } = &pending {
                        return Err(SessionError::Invariant(format!(
                            "Queued {:?} entry {} is not a message",
                            item.kind, item.entry_id
                        )));
                    }
                }
                Ok((item.clone(), pending))
            })
            .collect()
    };
    let mut pending = load(&selected)?;

    let projectors = lane.read_config().entry_projectors;
    let projects = |pending: &PendingEntry| -> bool {
        match pending {
            PendingEntry::Message { .. } => true,
            PendingEntry::Custom { custom_type, .. } => projectors.contains_key(custom_type),
        }
    };

    if follow_up_when_no_trigger && !pending.iter().any(|(_, value)| projects(value)) {
        let follow_up: Vec<&InboxItem> =
            inbox.iter().filter(|item| item.kind == InboxItemKind::FollowUp).collect();
        let selected_follow_up: Vec<&InboxItem> =
            if matches!(scope.settings.follow_up_mode, crate::harness::session::types::QueueMode::All) {
                follow_up
            } else {
                follow_up.into_iter().take(1).collect()
            };
        let mut merged: Vec<InboxItem> = selected;
        merged.extend(selected_follow_up.into_iter().cloned());
        // Restore inbox order (pi sorts by original index).
        merged.sort_by_key(|item| {
            inbox.iter().position(|candidate| candidate.entry_id == item.entry_id).unwrap_or(usize::MAX)
        });
        selected = merged;
        pending = load(&selected)?;
    }

    let mut parent_id = state.tip_id.clone();
    let mut trigger_entry_id: Option<String> = None;
    let mut entries: Vec<NewEntry> = Vec::with_capacity(pending.len());
    for (item, value) in &pending {
        let entry = match value {
            PendingEntry::Message { payload } => NewEntry {
                id: item.entry_id.clone(),
                parent_id: parent_id.clone(),
                body: crate::harness::session::types::EntryBody::Message {
                    message: payload.clone(),
                    terminate: None,
                },
            },
            PendingEntry::Custom { custom_type, payload } => NewEntry {
                id: item.entry_id.clone(),
                parent_id: parent_id.clone(),
                body: crate::harness::session::types::EntryBody::Custom {
                    custom_type: custom_type.clone(),
                    data: payload.clone(),
                },
            },
        };
        parent_id = Some(item.entry_id.clone());
        if projects(value) {
            trigger_entry_id = Some(item.entry_id.clone());
        }
        entries.push(entry);
    }

    let selected_ids: Vec<String> = selected.iter().map(|item| item.entry_id.clone()).collect();
    let inbox: Vec<InboxItem> = state
        .inbox
        .iter()
        .filter(|item| !selected_ids.contains(&item.entry_id))
        .cloned()
        .collect();
    let queues = if selected.is_empty() {
        None
    } else {
        Some(read_lane_queues(mutator, &inbox)?)
    };

    let mut writes: Vec<Write> = entries.iter().cloned().map(insert_entry).collect();
    for item in &selected {
        writes.push(Write::Value(delete_value(&pending_entry(&item.entry_id))));
    }
    if !entries.is_empty() {
        writes.push(Write::Value(set_value(
            &branch_tip(&lane.name),
            serde_json::Value::String(parent_id.clone().expect("chained entry tip")),
        )));
    }

    Ok(BoundaryPlacement { entries, writes, tip_id: parent_id, inbox, trigger_entry_id, queues })
}

/// Events for one committed boundary placement (pi
/// `boundaryPlacementEvents`): the placed entries' lifecycle events plus a
/// `queue_update` when input was consumed.
pub fn boundary_placement_events(
    entries: &[NewEntry],
    queues: Option<&Vec<LaneQueuedItem>>,
    commit: &CommitResult,
    first_write_index: usize,
    lane: &str,
    run_id: &str,
) -> Vec<HarnessEvent> {
    let mut events =
        super::super::transcript::committed_entry_events(entries, commit, lane, Some(run_id), first_write_index);
    if let Some(queues) = queues {
        events.push(HarnessEvent::QueueUpdate { lane: lane.into(), queues: queues.clone(), recovery: None });
    }
    events
}

/// Read the branch path back to the newest compaction (pi
/// `readBoundedEntries`) as an ordinary operation command.
pub async fn read_bounded_entries(
    lane: &Arc<Lane>,
    _drive: &Arc<Drive>,
) -> SessionResult<ContinueOutcome<Vec<Entry>>> {
    lane.continue_operation(|state, _current, _meta, mutator| {
        let Some(tip) = state.tip_id.clone() else {
            return Err(SessionError::Invariant("Run operation has no branch tip".into()));
        };
        let entries = mutator.scan_branch(&crate::harness::session::types::StorageBranchScan {
            start: tip,
            query: crate::harness::session::types::BranchScan {
                stop_at_type: Some("compaction"),
                oldest_first: false,
                ..Default::default()
            },
        })?;
        let mut oldest_first = entries;
        oldest_first.reverse();
        Ok(OperationCommandFor::Return { result: oldest_first })
    })
    .await
    .map_err(|error| match error {
        crate::harness::runtime::lane::LaneError::Session(error) => error,
        other => SessionError::Other(other.to_string()),
    })
}

/// The context messages for the bounded path (pi `readBoundedContext`).
pub async fn read_bounded_context(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
) -> SessionResult<ContinueOutcome<Vec<AgentMessage>>> {
    let entries = match read_bounded_entries(lane, drive).await? {
        ContinueOutcome::CancelRequested => return Ok(ContinueOutcome::CancelRequested),
        ContinueOutcome::Result(entries) => entries,
    };
    let projectors = lane.read_config().entry_projectors;
    Ok(ContinueOutcome::Result(build_session_context(&entries, &projectors)?))
}

/// Replan after `before_run_end` and commit either renewed work or the
/// terminal run result (pi `finishRunBoundary`).
pub async fn finish_run_boundary(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    _checkpoint_trigger_entry_id: &str,
    continuation: &Continuation,
    _scope: &OperationScope,
    planned_entry_ids: Vec<String>,
    pending_events: Vec<HarnessEvent>,
) -> SessionResult<ProcedureResult> {
    let context = match read_bounded_context(lane, drive).await? {
        ContinueOutcome::CancelRequested => return Ok(ProcedureResult::Continue),
        ContinueOutcome::Result(messages) => messages,
    };

    // before_run_end may offer a follow-up prompt (last one wins).
    let follow_up: Option<(String, AgentMessage)> = lane
        .hooks
        .run_before_run_end_with_gate(
            &HookContext { lane: lane.name.clone(), run_id: drive.operation_id.clone() },
            &super::super::hooks::BeforeRunEndEvent { messages: context },
            &drive.gate,
        )
        .map_err(gate_error_to_session)?
        .and_then(|result| result.follow_up.map(|text| {
            (
                lane.session.next_id(),
                AgentMessage::user_text(text),
            )
        }));

    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let follow_up_for_plan = follow_up.clone();
    let include_final_assistant = matches!(continuation, Continuation::MayFinish { include_final_assistant: true });
    let planned = planned_entry_ids.clone();
    let pending = pending_events.clone();

    let outcome = lane
        .continue_operation::<BoundaryFinish, _>(move |state, current, meta, mutator| {
            let placement = plan_boundary_inbox(lane, state, current.scope(), mutator, true)?;
            let scope = current.scope().clone();
            let configuration = state.configuration.clone();

            if let Some(trigger_entry_id) = &placement.trigger_entry_id {
                let placement_writes = placement.writes.clone();
                let entries_for_events = placement.entries.clone();
                let queues = placement.queues.clone();
                let events_lane = lane_name.clone();
                let events_run = operation_id.clone();
                let ready =
                    assistant_ready_at_boundary(lane, &configuration, &scope, trigger_entry_id, false);
                let patch = lane_patch(&placement);
                return Ok(OperationCommandFor::Commit {
                    decision: CommitDecision {
                        writes: placement_writes,
                        materialize: Box::new(|_| BoundaryFinish::Pending),
                        events: Some(Box::new(move |commit| {
                            let mut events = pending.clone();
                            events.extend(boundary_placement_events(
                                &entries_for_events,
                                queues.as_ref(),
                                commit,
                                0,
                                &events_lane,
                                &events_run,
                            ));
                            events
                        })),
                    },
                    operation_state: ready,
                    lane: Some(patch),
                });
            }

            let hook_plan_is_current = placement.entries.len() == planned.len()
                && placement
                    .entries
                    .iter()
                    .zip(planned.iter())
                    .all(|(entry, id)| &entry.id == id);

            if hook_plan_is_current {
                if let Some((follow_up_id, follow_up_message)) = &follow_up_for_plan {
                    let entry = NewEntry {
                        id: follow_up_id.clone(),
                        parent_id: placement.tip_id.clone(),
                        body: crate::harness::session::types::EntryBody::Message {
                            message: follow_up_message.clone(),
                            terminate: None,
                        },
                    };
                    let mut writes = placement.writes.clone();
                    writes.push(insert_entry(entry.clone()));
                    writes.push(Write::Value(set_value(
                        &branch_tip(&lane_name),
                        serde_json::Value::String(follow_up_id.clone()),
                    )));
                    let ready = assistant_ready_at_boundary(lane, &configuration, &scope, follow_up_id, false);
                    let lane_patch_tip = Some(follow_up_id.clone());
                    let inbox_patch = Some(placement.inbox.clone());
                    let entry_for_events = entry;
                    let events_lane = lane_name.clone();
                    let events_run = operation_id.clone();
                    let queued_events = pending.clone();
                    return Ok(OperationCommandFor::Commit {
                        decision: super::super::types::CommitDecision {
                            writes,
                            materialize: Box::new(|_| BoundaryFinish::Pending),
                            events: Some(Box::new(move |commit| {
                                let mut events = queued_events;
                                events.extend(super::super::transcript::entry_lifecycle_events(
                                    &crate::harness::session::commit::materialize_committed_entry(
                                        &entry_for_events,
                                        commit.seqs.first().copied().unwrap_or(0),
                                        commit.timestamp,
                                    ),
                                    &events_lane,
                                    Some(&events_run),
                                ));
                                events
                            })),
                        },
                        operation_state: ready,
                        lane: Some(LanePatch {
                            tip_id: Some(lane_patch_tip),
                            inbox: inbox_patch,
                        }),
                    });
                }
            }

            let Some(tip_id) = placement.tip_id.clone() else {
                return Err(SessionError::Invariant("Completed run has no tip".into()));
            };
            if include_final_assistant && scope.latest_assistant_entry_id.is_none() {
                return Err(SessionError::Invariant("Completed run is missing its final assistant".into()));
            }
            let record = operation_result_record(meta, TerminalStatus::Completed, Some(tip_id.clone()), None)?;
            let cleanup = operation_cleanup_writes(mutator, &operation_id, current)?;
            let lane_patch_tip = placement.tip_id.clone();
            let inbox_patch = Some(placement.inbox.clone());
            let run_record = record.clone();
            let from_tip = meta.source_tip_id.clone();
            let events_lane = lane_name.clone();
            let events_run = operation_id.clone();
            Ok(OperationCommandFor::Finish {
                writes: [placement.writes.clone(), cleanup].concat(),
                record: record.clone(),
                lane: Some(LanePatch {
                    tip_id: Some(lane_patch_tip),
                    inbox: inbox_patch,
                }),
                materialize: Box::new(move |_| BoundaryFinish::Settled { record: record.clone() }),
                events: Some(Box::new(move |commit| {
                    let _ = commit;
                    let mut events = pending;
                    events.push(HarnessEvent::RunEnd {
                        lane: events_lane,
                        run_id: events_run,
                        status: run_record.status,
                        from_tip_id: from_tip,
                        tip_id: run_record.tip_id.clone(),
                        ended_at: run_record.ended_at,
                        error: None,
                        recovery: None,
                    });
                    events
                })),
            })
        })
        .await;

    match outcome {
        Err(error) => Err(SessionError::Other(error.to_string())),
        Ok(ContinueOutcome::CancelRequested) => Ok(ProcedureResult::Continue),
        Ok(ContinueOutcome::Result(BoundaryFinish::Settled { record })) => {
            Ok(ProcedureResult::Settled { outcome: record })
        }
        Ok(ContinueOutcome::Result(BoundaryFinish::Pending)) => Ok(ProcedureResult::Continue),
    }
}

/// What the boundary planner told its caller (pi's `materialize` results).
#[derive(Debug, Clone)]
pub enum BoundaryFinish {
    /// A commit renewed generation (or queued a follow-up trigger).
    Pending,
    /// The terminal transaction finished the operation.
    Settled { record: crate::harness::session::types::OperationResultRecord },
}

fn lane_patch(placement: &BoundaryPlacement) -> crate::harness::runtime::types::LanePatch {
    crate::harness::runtime::types::LanePatch {
        tip_id: placement.tip_id.clone().map(Some),
        inbox: Some(placement.inbox.clone()),
    }
}

fn gate_error_to_session(error: GateError) -> SessionError {
    SessionError::Other(error.to_string())
}
