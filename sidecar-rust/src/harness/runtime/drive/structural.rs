//! Structural procedures (pi `drive/structural.ts`) — threshold pieces
//! first. The summary generation / navigation commit procedures land with
//! the durable-compaction unit (M6); the threshold detection and the
//! durable preparation conversion are what the checkpoint needs today.

use std::sync::Arc;

use crate::harness::compaction::{prepare_compaction, should_compact, CompactionPreparation};
use crate::harness::session::context::build_session_context;
use crate::harness::session::types::{
    CheckpointData, DurableFileOperations, DurableStructuralPreparation, OperationScope, SessionError, SessionResult,
};

use super::super::lane::{ContinueOutcome, Lane};
use super::super::types::Drive;
use super::boundary::read_bounded_entries;

/// Prepare threshold compaction only when no newer compaction already
/// guards this trigger (pi `prepareCompactionThreshold`). `context_window`
/// comes from the harness model catalog (pi reads `lane.models`).
pub async fn prepare_compaction_threshold(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    scope: &OperationScope,
    checkpoint: &CheckpointData,
    context_window: Option<u64>,
) -> SessionResult<ContinueOutcome<Option<(String, DurableStructuralPreparation)>>> {
    let settings = scope.settings.compaction;
    if !settings.enabled {
        return Ok(ContinueOutcome::Result(None));
    }
    let Some(context_window) = context_window else {
        return Ok(ContinueOutcome::Result(None));
    };

    let entries = match read_bounded_entries(lane, drive).await? {
        ContinueOutcome::CancelRequested => return Ok(ContinueOutcome::CancelRequested),
        ContinueOutcome::Result(entries) => entries,
    };

    let trigger_index = entries.iter().position(|entry| entry.id == checkpoint.trigger_entry_id);
    let newest_compaction_index = entries.iter().rposition(|entry| entry.entry_type() == "compaction");
    if let (Some(trigger), Some(compaction)) = (trigger_index, newest_compaction_index) {
        if compaction >= trigger {
            return Ok(ContinueOutcome::Result(None));
        }
    }
    let Some(_trigger_index) = trigger_index else {
        return Err(SessionError::Invariant(format!(
            "Checkpoint trigger {} is missing from its branch",
            checkpoint.trigger_entry_id
        )));
    };

    let projectors = lane.read_config().entry_projectors;
    let messages = build_session_context(&entries, &projectors)?;
    let Some(prepared) = prepare_compaction(&messages, settings) else {
        return Ok(ContinueOutcome::Result(None));
    };
    if !should_compact(prepared.tokens_before, context_window, &settings) {
        return Ok(ContinueOutcome::Result(None));
    }

    Ok(ContinueOutcome::Result(Some((
        lane.session.next_id(),
        durable_compaction_preparation(&prepared, &messages[prepared.first_kept_index..]),
    ))))
}

/// Convert one compaction preparation to its durable form (pi
/// `durableCompactionPreparation`): a crash mid-compaction resumes without
/// recomputing — or re-billing — it.
pub fn durable_compaction_preparation(
    prepared: &CompactionPreparation,
    retained_tail: &[crate::harness::agent_types::AgentMessage],
) -> DurableStructuralPreparation {
    DurableStructuralPreparation::Compaction {
        messages_to_summarize: prepared.messages_to_summarize.clone(),
        turn_prefix_messages: prepared.turn_prefix_messages.clone(),
        retained_tail: retained_tail.to_vec(),
        is_split_turn: prepared.is_split_turn,
        tokens_before: prepared.tokens_before,
        previous_summary: prepared.previous_summary.clone(),
        file_ops: DurableFileOperations {
            read: prepared.file_ops.read.iter().cloned().collect(),
            written: prepared.file_ops.written.iter().cloned().collect(),
            edited: prepared.file_ops.edited.iter().cloned().collect(),
        },
        settings: prepared.settings,
    }
}

/// Prepare one overflow compaction before the response settlement
/// transaction (pi `prepareOverflowCompaction`). Skipped when overflow
/// recovery already ran for this generation.
pub async fn prepare_overflow_compaction(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    scope: &OperationScope,
    generation_trigger_entry_id: &str,
    overflow_recovery_used: bool,
) -> SessionResult<Option<(String, DurableStructuralPreparation)>> {
    if overflow_recovery_used {
        return Ok(None);
    }
    let settings = scope.settings.compaction;
    if !settings.enabled {
        return Ok(None);
    }
    let entries = match read_bounded_entries(lane, drive).await? {
        ContinueOutcome::CancelRequested => return Ok(None),
        ContinueOutcome::Result(entries) => entries,
    };
    let _ = generation_trigger_entry_id;
    let projectors = lane.read_config().entry_projectors;
    let messages = build_session_context(&entries, &projectors)?;
    let Some(prepared) = prepare_compaction(&messages, settings) else {
        return Ok(None);
    };
    Ok(Some((
        lane.session.next_id(),
        durable_compaction_preparation(&prepared, &messages[prepared.first_kept_index..]),
    )))
}
