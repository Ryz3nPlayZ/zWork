//! Port of pi `harness/runtime/drive/terminal.ts` — the mechanical
//! operation-owned suffix every terminal transaction commits, and the
//! immutable observation record it leaves behind.

use std::collections::HashSet;

use crate::harness::session::commit::Write;
use crate::harness::session::session::{now_ms, SessionMutator};
use crate::harness::session::types::{
    OperationError, OperationMeta, OperationResultRecord, OperationState, SessionError, SessionResult, TerminalStatus,
    ToolCallStatus,
};
use crate::harness::session::values::{
    delete_list, delete_value, operation_meta, operation_preparation_prefix,
    operation_state as operation_state_value, operation_tool_args_prefix, operation_tool_memo_prefix,
    pending_assistant_frames, pending_entry, pending_tool_output_prefix,
};

/// Build the mechanical operation-owned suffix used by an owning
/// procedure's terminal transaction: drop operation bookkeeping (meta,
/// state, tool args/memos, preparations, staged tool outputs, pending
/// assistant frames, staged-but-unwritten tool results).
pub fn operation_cleanup_writes(
    reader: &SessionMutator<'_>,
    operation_id: &str,
    state: &OperationState,
) -> SessionResult<Vec<Write>> {
    let tool_arguments = reader.scan_values(&operation_tool_args_prefix(operation_id, None))?;
    let tool_memos = reader.scan_values(&operation_tool_memo_prefix(operation_id, None))?;
    let preparations = reader.scan_values(&operation_preparation_prefix(operation_id))?;
    let tool_outputs = reader.scan_values(&pending_tool_output_prefix(operation_id))?;

    let mut pending_ids: HashSet<String> = HashSet::new();
    if let OperationState::Tools { batch, .. } = state {
        for call in &batch.calls {
            if call.status == ToolCallStatus::OutcomeReady {
                pending_ids.insert(call.result_entry_id.clone());
            }
        }
    }

    let mut writes = vec![
        Write::Value(delete_value(&operation_meta(operation_id))),
        Write::Value(delete_value(&operation_state_value(operation_id))),
    ];
    for stored in tool_arguments.iter().chain(&tool_memos).chain(&preparations).chain(&tool_outputs) {
        writes.push(Write::Value(delete_value(&stored.address)));
    }
    if let OperationState::AssistantEffectPending { response_entry_id, .. } = state {
        writes.push(Write::List(delete_list(&pending_assistant_frames(operation_id, response_entry_id))));
    }
    for id in pending_ids {
        writes.push(Write::Value(delete_value(&pending_entry(&id))));
    }
    Ok(writes)
}

/// Construct the immutable observation record for one terminal decision.
/// Only a failed operation may carry an error.
pub fn operation_result_record(
    meta: &OperationMeta,
    status: TerminalStatus,
    tip_id: Option<String>,
    error: Option<OperationError>,
) -> SessionResult<OperationResultRecord> {
    if (status == TerminalStatus::Failed) != error.is_some() {
        return Err(SessionError::Invariant(
            "only a failed operation result may carry an error".into(),
        ));
    }
    Ok(OperationResultRecord {
        operation_id: meta.operation_id.clone(),
        kind: match meta.intent {
            crate::harness::session::types::OperationIntent::Run { .. } => "run",
            crate::harness::session::types::OperationIntent::Compaction { .. } => "compaction",
            crate::harness::session::types::OperationIntent::Navigation { .. } => "navigation",
        }
        .to_string(),
        status,
        error,
        from_tip_id: meta.source_tip_id.clone(),
        tip_id,
        started_at: meta.started_at,
        ended_at: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::session::memory::MemoryStorage;
    use crate::harness::session::session::Session;
    use crate::harness::session::types::{
        OperationIntent, OperationScope, QueueMode, RunSettings, ToolExecutionMode,
    };

    fn meta() -> OperationMeta {
        OperationMeta {
            operation_id: "op1".into(),
            lane: "main".into(),
            source_tip_id: None,
            started_at: 1,
            intent: OperationIntent::Run { prompt_entry_ids: vec![] },
        }
    }

    #[test]
    fn failed_status_and_error_are_paired() {
        let m = meta();
        assert!(operation_result_record(&m, TerminalStatus::Completed, None, Some(OperationError {
            code: "x".into(),
            message: "boom".into(),
            details: None,
        })).is_err());
        assert!(operation_result_record(&m, TerminalStatus::Failed, None, None).is_err());

        let record = operation_result_record(&m, TerminalStatus::Failed, Some("tip".into()), Some(OperationError {
            code: "x".into(),
            message: "boom".into(),
            details: None,
        }))
        .unwrap();
        assert_eq!(record.status, TerminalStatus::Failed);
        assert_eq!(record.kind, "run");
        assert_eq!(record.tip_id.as_deref(), Some("tip"));
        assert!(record.ended_at >= record.started_at);
    }

    #[tokio::test]
    async fn cleanup_writes_drop_operation_bookkeeping() {
        let session = Session::new(
            crate::harness::session::types::SessionMetadata {
                id: "s".into(),
                created_at: 0,
                storage_version: 1,
                cwd: None,
                parent_session_id: None,
            },
            std::sync::Arc::new(MemoryStorage::new()),
        );

        // Seed operation bookkeeping across every namespace cleanup covers.
        let tool_args = crate::harness::session::values::operation_tool_args("op1", "turn1", 0);
        let memo = crate::harness::session::values::operation_tool_memo("op1", "inv1", "bash");
        let prep = crate::harness::session::values::operation_preparation("op1", "task1");
        let staged_output = crate::harness::session::values::pending_tool_output("op1", "inv1");
        let staged_result = crate::harness::session::values::pending_entry("res1");
        let state_value = crate::harness::session::values::operation_state("op1");
        session
            .mutate(move |mutator| {
                use crate::harness::session::values::set_value;
                use crate::harness::session::values::operation_meta;
                mutator.commit(vec![
                    crate::harness::session::commit::Write::Value(set_value(&tool_args, serde_json::json!({}))),
                    crate::harness::session::commit::Write::Value(set_value(&memo, serde_json::json!("m"))),
                    crate::harness::session::commit::Write::Value(set_value(&prep, serde_json::json!("p"))),
                    crate::harness::session::commit::Write::Value(set_value(&staged_output, serde_json::json!("o"))),
                    crate::harness::session::commit::Write::Value(set_value(&staged_result, serde_json::json!("r"))),
                    crate::harness::session::commit::Write::Value(set_value(&state_value, serde_json::json!("s"))),
                    crate::harness::session::commit::Write::Value(set_value(&operation_meta("op1"), serde_json::json!("meta"))),
                ])?;
                Ok(())
            })
            .await
            .unwrap();

        let state = OperationState::Tools {
            scope: OperationScope {
                control: crate::harness::session::types::Control::Running,
                settings: RunSettings {
                    compaction: crate::harness::compaction::CompactionSettings::default(),
                    steering_mode: QueueMode::All,
                    follow_up_mode: QueueMode::All,
                    tool_execution: ToolExecutionMode::Sequential,
                },
                latest_assistant_entry_id: None,
            },
            batch: crate::harness::session::types::ToolBatch {
                assistant_entry_id: "a".into(),
                configuration: crate::harness::session::types::LaneConfiguration {
                    provider: "p".into(),
                    model_id: "m".into(),
                    thinking_level: crate::harness::types::ThinkingLevel::Medium,
                    active_tool_names: vec![],
                },
                turn_id: "turn1".into(),
                calls: vec![crate::harness::session::types::ToolCall {
                    source_index: 0,
                    result_entry_id: "res1".into(),
                    status: ToolCallStatus::OutcomeReady,
                    replay: None,
                    terminate: None,
                }],
            },
        };

        let writes = session
            .mutate(|mutator| operation_cleanup_writes(mutator, "op1", &state))
            .await
            .unwrap();
        session
            .mutate(move |mutator| mutator.commit(writes).map(|_| ()))
            .await
            .unwrap();

        assert!(session
            .mutate(|mutator| Ok(mutator
                .get_value(&crate::harness::session::values::operation_tool_args("op1", "turn1", 0))?
                .is_none()
                && mutator.get_value(&crate::harness::session::values::pending_entry("res1"))?.is_none()
                && mutator.get_value(&crate::harness::session::values::operation_state("op1"))?.is_none()))
            .await
            .unwrap());
    }
}
