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
pub mod generation;
pub mod reconcile;
pub mod response;
pub mod structural;
pub mod structural_generation;
pub mod tool_placement;
pub mod tools;

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
            super::drive::reconcile::reconcile_operation(lane, drive).await?
        } else {
            match &state {
                OperationState::Starting { .. } => start_run(lane, drive).await?,
                OperationState::Checkpoint { checkpoint, scope, .. } => {
                    run_checkpoint(lane, drive, scope, checkpoint, lane.context_window()).await?
                }
                OperationState::AssistantReady { generation, next_attempt, .. } => {
                    super::drive::generation::run_generation(lane, drive, generation, *next_attempt).await?
                }
                OperationState::AssistantRetryWait { generation, retry, .. } => {
                    super::drive::generation::run_retry_wait(lane, drive, retry, generation).await?
                }
                OperationState::AssistantEffectPending {
                    scope: _,
                    generation,
                    attempt,
                    response_entry_id,
                    usage_id,
                    intended_output_limit,
                    context_window,
                } => {
                    super::drive::reconcile::recover_assistant_generation(
                        lane,
                        drive,
                        generation,
                        *attempt,
                        response_entry_id,
                        usage_id,
                        *intended_output_limit,
                        *context_window,
                    )
                    .await?
                }
                OperationState::Tools { .. } => super::drive::tools::run_tools(lane, drive).await?,
                OperationState::DeferredSuspended { .. } | OperationState::DeferredEffectPending { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "deferred" }.to_string(),
                    ));
                }
                OperationState::SummaryDeciding { scope, task, .. } => {
                    super::drive::structural_generation::run_structural_decision(lane, drive, scope, task).await?
                }
                OperationState::SummaryReady { scope, task, summary, next_attempt, .. } => {
                    super::drive::structural_generation::run_structural_generation(
                        lane,
                        drive,
                        scope,
                        task,
                        summary,
                        *next_attempt,
                    )
                    .await?
                }
                OperationState::SummaryEffectPending {
                    scope,
                    task,
                    summary,
                    attempt,
                    ..
                } => {
                    super::drive::structural_generation::recover_structural_generation(
                        lane,
                        drive,
                        scope,
                        task,
                        summary,
                        *attempt,
                    )
                    .await?
                }
                OperationState::SummaryRetryWait { scope, task, summary, retry, .. } => {
                    super::drive::structural_generation::run_structural_retry_wait(
                        lane,
                        drive,
                        scope,
                        task,
                        summary,
                        retry,
                    )
                    .await?
                }
                OperationState::NavigationReadyToCommit { .. } => {
                    super::drive::reconcile::commit_navigation(lane, drive).await?
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

    fn scripted_model() -> crate::harness::types::Model {
        crate::harness::types::Model {
            id: "scripted".into(),
            name: "scripted".into(),
            api: crate::harness::types::Api::AnthropicMessages,
            provider: "test".into(),
            base_url: String::new(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            cost: Default::default(),
            prompt_cache: None,
            context_window: 200_000,
            max_tokens: 8_192,
            headers: None,
            compat: None,
        }
    }

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

    /// Install a model source + stream that replays one scripted assistant
    /// response and point the lane configuration at it.
    async fn install_scripted_stream(lane: &Arc<Lane>, response_text: &'static str) {
        use crate::harness::types::{AssistantContent, TextContent};
        let model = crate::harness::types::Model {
            id: "scripted".into(),
            name: "scripted".into(),
            api: crate::harness::types::Api::AnthropicMessages,
            provider: "test".into(),
            base_url: String::new(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            cost: Default::default(),
            prompt_cache: None,
            context_window: 200_000,
            max_tokens: 8_192,
            headers: None,
            compat: None,
        };
        lane.set_model("test", "scripted").await.unwrap();
        let handle = lane.config_handle();
        let mut config = handle.write().unwrap();
        let source_model = model.clone();
        config.context_window = Some(model.context_window);
        config.model_source = Some(Arc::new(move |provider: &str, model_id: &str| {
            (provider == "test" && model_id == "scripted").then(|| source_model.clone())
        }));
        config.stream = Some(Arc::new(move |model, _ctx, _opts| {
            let (tx, rx) = tokio::sync::mpsc::channel(16);
            tokio::spawn(async move {
                use crate::harness::types::{AssistantMessage, AssistantMessageEvent, StopReason, Usage};
                let partial_empty = AssistantMessage::pending(&model);
                let _ = tx.send(AssistantMessageEvent::Start { partial: partial_empty.clone() }).await;
                let mut partial = AssistantMessage::pending(&model);
                partial.content = vec![AssistantContent::Text(TextContent { text: String::new(), text_signature: None })];
                let _ = tx
                    .send(AssistantMessageEvent::TextStart { content_index: 0, partial: partial.clone() })
                    .await;
                let block = TextContent { text: response_text.to_string(), text_signature: None };
                partial.content = vec![AssistantContent::Text(block)];
                let _ = tx
                    .send(AssistantMessageEvent::TextDelta {
                        content_index: 0,
                        delta: response_text.to_string(),
                        partial: partial.clone(),
                    })
                    .await;
                let _ = tx
                    .send(AssistantMessageEvent::TextEnd {
                        content_index: 0,
                        content: response_text.to_string(),
                        partial: partial.clone(),
                    })
                    .await;
                let mut done = partial;
                done.stop_reason = StopReason::Stop;
                done.usage = Usage { input: 3, output: 2, total_tokens: 5, ..Default::default() };
                let _ = tx
                    .send(AssistantMessageEvent::Done { reason: StopReason::Stop, message: done })
                    .await;
            });
            rx
        }));
    }

    /// Scripted stream that settles as a retryable provider error.
    async fn install_error_stream(lane: &Arc<Lane>, error_message: &'static str) {
        use crate::harness::types::{AssistantMessage, AssistantMessageEvent, StopReason};
        let model = crate::harness::types::Model {
            id: "scripted".into(),
            name: "scripted".into(),
            api: crate::harness::types::Api::AnthropicMessages,
            provider: "test".into(),
            base_url: String::new(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            cost: Default::default(),
            prompt_cache: None,
            context_window: 200_000,
            max_tokens: 8_192,
            headers: None,
            compat: None,
        };
        lane.set_model("test", "scripted").await.unwrap();
        let handle = lane.config_handle();
        let mut config = handle.write().unwrap();
        let source_model = model.clone();
        config.context_window = Some(model.context_window);
        config.model_source = Some(Arc::new(move |provider: &str, model_id: &str| {
            (provider == "test" && model_id == "scripted").then(|| source_model.clone())
        }));
        config.stream = Some(Arc::new(move |model, _ctx, _opts| {
            let (tx, rx) = tokio::sync::mpsc::channel(16);
            tokio::spawn(async move {
                let mut failed = AssistantMessage::pending(&model);
                failed.stop_reason = StopReason::Error;
                failed.error_message = Some(error_message.to_string());
                let _ = tx
                    .send(AssistantMessageEvent::Error { reason: StopReason::Error, error: failed })
                    .await;
            });
            rx
        }));
    }

    /// Scripted stream that settles with one tool call on the first
    /// response and plain text afterwards.
    async fn install_tool_call_stream(lane: &Arc<Lane>, tool_name: &'static str) {
        use crate::harness::types::{AssistantContent, AssistantMessage, AssistantMessageEvent, StopReason, TextContent, ToolCall};
        let model = crate::harness::types::Model {
            id: "scripted".into(),
            name: "scripted".into(),
            api: crate::harness::types::Api::AnthropicMessages,
            provider: "test".into(),
            base_url: String::new(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            cost: Default::default(),
            prompt_cache: None,
            context_window: 200_000,
            max_tokens: 8_192,
            headers: None,
            compat: None,
        };
        lane.set_model("test", "scripted").await.unwrap();
        let handle = lane.config_handle();
        let mut config = handle.write().unwrap();
        let source_model = model.clone();
        config.context_window = Some(model.context_window);
        config.model_source = Some(Arc::new(move |provider: &str, model_id: &str| {
            (provider == "test" && model_id == "scripted").then(|| source_model.clone())
        }));
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        config.stream = Some(Arc::new(move |model, _ctx, _opts| {
            let (tx, rx) = tokio::sync::mpsc::channel(16);
            let calls = Arc::clone(&calls);
            tokio::spawn(async move {
                let mut done = AssistantMessage::pending(&model);
                if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    done.content = vec![
                        AssistantContent::Text(TextContent { text: "running".into(), text_signature: None }),
                        AssistantContent::ToolCall(ToolCall {
                            id: "call-1".into(),
                            name: tool_name.to_string(),
                            arguments: serde_json::json!({"cmd": "ls"}),
                            thought_signature: None,
                            namespace: None,
                        }),
                    ];
                    done.stop_reason = StopReason::ToolUse;
                } else {
                    done.content = vec![AssistantContent::Text(TextContent {
                        text: "all finished".into(),
                        text_signature: None,
                    })];
                    done.stop_reason = StopReason::Stop;
                }
                let _ = tx
                    .send(AssistantMessageEvent::Done { reason: done.stop_reason, message: done })
                    .await;
            });
            rx
        }));

        // An echo tool so the batch has a real executor.
        let echo = crate::harness::runtime::tool_exec::RuntimeTool {
            declaration: crate::harness::types::Tool {
                name: tool_name.to_string(),
                description: "echo".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {"cmd": {"type": "string"}},
                    "required": ["cmd"]
                }),
            },
            replay: crate::harness::runtime::tool_exec::ReplayPolicy::Safe,
            execute: Arc::new(|execution| {
                Box::pin(async move {
                    let cmd = execution.args.get("cmd").cloned().unwrap_or(serde_json::json!(""));
                    Ok(crate::harness::agent_types::AgentToolResult {
                        content: vec![crate::harness::types::UserContent::Text(
                            crate::harness::types::TextContent {
                                text: format!("echo: {cmd}"),
                                text_signature: None,
                            },
                        )],
                        details: serde_json::Value::Null,
                        usage: None,
                        terminate: None,
                    })
                })
            }),
        };
        config.tools = Arc::new(vec![Arc::new(echo)]);

        // The lane must declare the tool active for generation + execution.
        lane.set_active_tools(vec![tool_name.to_string()]).await.unwrap();
    }

    #[tokio::test]
    async fn missing_model_settles_as_configuration_failure() {
        let (lane, mut events) = test_lane();
        let operation_id = accept(&lane, "hello").await;

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match &outcome {
            DriveOutcome::Settled { outcome } => {
                assert_eq!(outcome.status, TerminalStatus::Failed);
                assert_eq!(outcome.error.as_ref().unwrap().code, "model_unavailable");
            }
            other => panic!("expected configuration failure, got {other:?}"),
        }
        assert!(lane.operation_snapshot().is_none());
        assert!(drain(&mut events).contains(&"run_end"));
    }

    #[tokio::test]
    async fn scripted_response_walks_the_full_run_to_completion() {
        let (lane, mut events) = test_lane();
        install_scripted_stream(&lane, "all done").await;
        let operation_id = accept(&lane, "hello").await;

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match &outcome {
            DriveOutcome::Settled { outcome } => assert_eq!(outcome.status, TerminalStatus::Completed),
            other => panic!("expected completed run, got {other:?}"),
        }

        // Prompt + assistant response entries, assistant as the new tip.
        let entries = lane.find_entries(BranchScan { oldest_first: true, ..Default::default() }).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[1].as_message().unwrap().is_assistant());
        let rows = lane
            .session
            .mutate(|mutator| mutator.scan_usage(&crate::harness::session::types::UsageScan::default()))
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].adjustment);

        let types = drain(&mut events);
        for expected in
            ["run_start", "turn_start", "message_start", "message_update", "message_end", "entry_added", "usage", "turn_end", "run_end"]
        {
            assert!(types.contains(&expected), "missing {expected} in {types:?}");
        }
    }

    #[tokio::test]
    async fn retryable_errors_wait_before_the_next_attempt() {
        let (lane, mut events) = test_lane();
        install_error_stream(&lane, "overloaded error, please retry (503)").await;
        lane.config_handle().write().unwrap().retry_policy = crate::harness::runtime::types::RetryPolicySnapshot {
            enabled: true,
            max_retries: 2,
            base_delay_ms: 10,
            max_agent_delay_ms: Some(100),
        };
        let operation_id = accept(&lane, "hello").await;

        // wait_for_retry = false surfaces the durable wait to the host.
        let outcome = lane.drive(&operation_id, false).await.unwrap();
        let not_before = match &outcome {
            DriveOutcome::WaitingRetry { not_before, .. } => *not_before,
            other => panic!("expected a durable retry wait, got {other:?}"),
        };
        assert!(not_before > 0);
        match durable_state(&lane, &operation_id) {
            OperationState::AssistantRetryWait { retry, .. } => {
                assert_eq!(retry.next_attempt, 2);
                assert_eq!(retry.not_before, not_before);
                assert!(retry.error_message.contains("overloaded"));
            }
            other => panic!("expected assistant.retry_wait, got {}", other.at()),
        }
        assert!(drain(&mut events).contains(&"retry_scheduled"));

        // A retryable quota error never retries: it fails the run.
        let (lane, _events) = test_lane();
        install_error_stream(&lane, "insufficient_quota: billing issue").await;
        let operation_id = accept(&lane, "hello").await;
        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match outcome {
            DriveOutcome::Settled { outcome } => assert_eq!(outcome.status, TerminalStatus::Failed),
            other => panic!("expected failed settle, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn tool_calls_execute_and_complete_the_run() {
        let (lane, mut events) = test_lane();
        install_tool_call_stream(&lane, "bash").await;
        let operation_id = accept(&lane, "run this").await;

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match &outcome {
            DriveOutcome::Settled { outcome } => assert_eq!(outcome.status, TerminalStatus::Completed),
            other => panic!("expected completed run, got {other:?}"),
        }

        // prompt → assistant(toolCall) → toolResult → final assistant.
        let entries = lane.find_entries(BranchScan { oldest_first: true, ..Default::default() }).unwrap();
        assert_eq!(entries.len(), 4, "{entries:?}");
        let roles: Vec<&str> = entries.iter().filter_map(|entry| entry.as_message().map(|m| m.role())).collect();
        assert_eq!(roles, ["user", "assistant", "toolResult", "assistant"]);
        let tool_result = entries[2].as_message().unwrap();
        assert!(tool_result.role() == "toolResult");

        let types = drain(&mut events);
        for expected in ["tool_start", "tool_end", "turn_end", "run_end"] {
            assert!(types.contains(&expected), "missing {expected} in {types:?}");
        }

        // Operation bookkeeping is cleaned up after settlement.
        let idle = lane.operation_snapshot();
        assert!(idle.is_none());
    }

    #[tokio::test]
    async fn steering_renews_generation_at_the_boundary() {
        let (lane, _events) = test_lane();
        let operation_id = accept(&lane, "work").await;
        let _steer = lane.enqueue(QueueKind::Steer, AgentMessage::user_text("redirect")).await.unwrap();

        // Without a model source the run settles as a configuration
        // failure — after the boundary consumed the steer.
        let outcome = lane.drive(&operation_id, false).await.unwrap();
        assert!(matches!(outcome, DriveOutcome::Settled { .. }));
        // The steer was consumed: the tree now holds prompt + steer.
        assert_eq!(lane.find_entries(BranchScan::default()).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn follow_ups_wait_for_a_triggerless_boundary() {
        let (lane, _events) = test_lane();
        let operation_id = accept(&lane, "work").await;
        let _steer = lane.enqueue(QueueKind::Steer, AgentMessage::user_text("now")).await.unwrap();
        let follow_up = lane.enqueue(QueueKind::FollowUp, AgentMessage::user_text("later")).await.unwrap();

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        assert!(matches!(outcome, DriveOutcome::Settled { .. }));
        // The steer entered the tree; the follow-up did not.
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
    async fn cancellation_reconciles_to_an_aborted_terminal() {
        let (lane, mut events) = test_lane();
        let operation_id = accept(&lane, "work").await;
        lane.enqueue(QueueKind::Steer, AgentMessage::user_text("wait")).await.unwrap();
        let abort = lane.request_operation_abort(&operation_id).await.unwrap();
        assert_eq!(abort.steer.len(), 1);
        assert_eq!(abort.steer[0].role(), "user");

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match &outcome {
            DriveOutcome::Settled { outcome } => assert_eq!(outcome.status, TerminalStatus::Aborted),
            other => panic!("expected aborted settle, got {other:?}"),
        }
        assert!(lane.operation_snapshot().is_none());
        assert!(drain(&mut events).contains(&"run_end"));
    }

    #[tokio::test]
    async fn cancelled_generation_settles_from_committed_frames() {
        let (lane, _events) = test_lane();
        let operation_id = accept(&lane, "work").await;

        // Simulate a crash mid-generation: install effect_pending state
        // with committed partial frames.
        let response_entry_id = lane.session.next_id();
        let usage_id = lane.session.next_id();
        let partial = crate::harness::types::AssistantMessage::pending(&scripted_model());
        use crate::harness::types::TextContent;
        let generation = crate::harness::session::types::GenerationContext {
            step_id: "step".into(),
            trigger_entry_id: "trigger".into(),
            configuration: lane.configuration(),
            stream_options: Default::default(),
            retry_policy: crate::harness::session::types::NormalizedRetryPolicy {
                max_attempts: 1,
                base_delay_ms: 1,
                max_agent_delay_ms: 10,
            },
            overflow_recovery_used: false,
        };
        let effect = OperationState::AssistantEffectPending {
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
            generation: generation.clone(),
            attempt: 1,
            response_entry_id: response_entry_id.clone(),
            usage_id: usage_id.clone(),
            intended_output_limit: 8_192,
            context_window: 200_000,
        };
        lane.settle_operation(move |_state, _current, _meta, _mutator| {
            Ok(crate::harness::runtime::lane::OperationCommandFor::Commit {
                decision: super::super::types::CommitDecision {
                    writes: Vec::new(),
                    materialize: Box::new(|_| ()),
                    events: None,
                },
                operation_state: effect,
                lane: None,
            })
        })
        .await
        .unwrap();

        // Committed partial frames for the interrupted assistant.
        let frame_address = crate::harness::session::values::pending_assistant_frames(&operation_id, &response_entry_id);
        let start_frame = serde_json::to_value(crate::harness::assistant_frame::AssistantMessageFrame::Start {
            partial: partial.clone(),
        })
        .unwrap();
        let text_frame = serde_json::to_value(crate::harness::assistant_frame::AssistantMessageFrame::TextStart {
            content_index: 0,
            content: TextContent { text: String::new(), text_signature: None },
        })
        .unwrap();
        let delta_frame = serde_json::to_value(crate::harness::assistant_frame::AssistantMessageFrame::TextDelta {
            content_index: 0,
            delta: "partial work".into(),
        })
        .unwrap();
        let op_for_frames = operation_id.clone();
        let entry_for_frames = response_entry_id.clone();
        lane.session
            .mutate(move |mutator| {
                mutator.commit(vec![
                    crate::harness::session::commit::Write::List(crate::harness::session::values::append_list(
                        &frame_address,
                        start_frame,
                    )),
                    crate::harness::session::commit::Write::List(crate::harness::session::values::append_list(
                        &frame_address.clone(),
                        text_frame,
                    )),
                    crate::harness::session::commit::Write::List(crate::harness::session::values::append_list(
                        &frame_address,
                        delta_frame,
                    )),
                ])?;
                let _ = (op_for_frames, entry_for_frames);
                Ok(())
            })
            .await
            .unwrap();

        // Cancel, then reconcile: the partial settles as an interrupted
        // assistant entry and the run finishes aborted.
        lane.request_operation_abort(&operation_id).await.unwrap();
        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match &outcome {
            DriveOutcome::Settled { outcome } => assert_eq!(outcome.status, TerminalStatus::Aborted),
            other => panic!("expected aborted settle, got {other:?}"),
        }
        let entries = lane.find_entries(BranchScan { oldest_first: true, ..Default::default() }).unwrap();
        let assistant = entries
            .iter()
            .find(|entry| entry.id == response_entry_id)
            .expect("interrupted assistant entry committed");
        let message = assistant.as_message().unwrap();
        assert!(message.is_assistant());
    }

    #[tokio::test]
    async fn navigation_commits_the_tip_move() {
        let (lane, mut events) = test_lane();
        let first = lane.append_message(AgentMessage::user_text("one")).await.unwrap();
        let _second = lane.append_message(AgentMessage::user_text("two")).await.unwrap();

        let admission = lane
            .accept_navigation(crate::harness::runtime::lane::NavigationRequest {
                target_id: Some(first.clone()),
                label: Some("the good one".into()),
            })
            .await
            .unwrap();
        let outcome = lane.drive(&admission.operation_id, false).await.unwrap();
        match &outcome {
            DriveOutcome::Settled { outcome } => assert_eq!(outcome.status, TerminalStatus::Completed),
            other => panic!("expected completed navigation, got {other:?}"),
        }
        assert_eq!(lane.tip_id().unwrap().as_deref(), Some(first.as_str()));
        assert_eq!(
            lane.session.get_label(&first).unwrap().as_deref(),
            Some("the good one")
        );
        assert!(drain(&mut events).contains(&"navigation_end"));
    }

    #[tokio::test]
    async fn threshold_compaction_commits_and_completes() {
        let (lane, mut events) = test_lane();
        install_scripted_stream(&lane, "a concise summary of the conversation").await;
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
        match &outcome {
            DriveOutcome::Settled { outcome } => assert_eq!(outcome.status, TerminalStatus::Completed),
            other => panic!("expected completed run, got {other:?}"),
        }

        // The compaction entry is a first-class branch entry and the tip
        // chains through it.
        let entries = lane.find_entries(BranchScan { oldest_first: true, ..Default::default() }).unwrap();
        let compaction = entries
            .iter()
            .find(|entry| entry.entry_type() == "compaction")
            .expect("compaction entry committed");
        assert!(compaction.parent_id.is_some());
        let tip = lane.tip_id().unwrap().expect("run leaves a tip");
        let mut cursor = Some(tip);
        let mut chains_through_compaction = false;
        while let Some(id) = cursor {
            if id == compaction.id {
                chains_through_compaction = true;
                break;
            }
            cursor = entries.iter().find(|entry| entry.id == id).and_then(|entry| entry.parent_id.clone());
        }
        assert!(chains_through_compaction, "tip must chain through the compaction entry");

        let event_types = drain(&mut events);
        assert!(event_types.contains(&"compaction_start"));
        assert!(event_types.contains(&"compaction_end"));
    }

    #[tokio::test]
    async fn staged_summary_recovers_without_re_billing() {
        let (lane, _events) = test_lane();
        install_scripted_stream(&lane, "the final answer").await;
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            // Wrap the configured stream with a call counter: recovery must
            // make ZERO summarizer calls (the staged result applies), then
            // exactly one assistant call continues the run.
            let handle = lane.config_handle();
            let mut config = handle.write().unwrap();
            let inner = config.stream.clone().unwrap();
            let calls = calls.clone();
            config.stream = Some(Arc::new(move |model, ctx, opts| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                inner(model, ctx, opts)
            }));
        }

        let operation_id = accept(&lane, "work").await;

        // Simulate a crash after the summarizer billed but before the
        // effect: summary.effect_pending state + durable preparation +
        // staged result (pi recoverStructuralGeneration).
        let task_id = lane.session.next_id();
        let result_entry_id = lane.session.next_id();
        let preparation = crate::harness::session::types::DurableStructuralPreparation::Compaction {
            messages_to_summarize: vec![AgentMessage::user_text("old conversation worth summarizing")],
            turn_prefix_messages: vec![],
            retained_tail: vec![],
            is_split_turn: false,
            tokens_before: 100,
            previous_summary: None,
            file_ops: Default::default(),
            settings: crate::harness::compaction::CompactionSettings::default(),
        };
        let effect = {
            let boundary_trigger = "trigger".to_string();
            OperationState::SummaryEffectPending {
                scope: test_scope(),
                task: crate::harness::session::types::SummaryTask {
                    task_id: task_id.clone(),
                    reason: Some("threshold".into()),
                    custom_instructions: None,
                    boundary: crate::harness::session::types::ResultBoundary::ResumeCheckpoint {
                        resume_after: crate::harness::session::types::CheckpointData {
                            continuation: crate::harness::session::types::Continuation::NeedAssistant {
                                overflow_recovery_used: false,
                            },
                            trigger_entry_id: boundary_trigger,
                        },
                    },
                },
                summary: crate::harness::session::types::SummaryContext {
                    result_entry_id: result_entry_id.clone(),
                    configuration: lane.configuration(),
                    stream_options: Default::default(),
                    retry_policy: crate::harness::session::types::NormalizedRetryPolicy {
                        max_attempts: 1,
                        base_delay_ms: 1,
                        max_agent_delay_ms: 10,
                    },
                },
                attempt: 1,
                request: None,
                usage_ids: vec![],
            }
        };
        let prep_addr = crate::harness::session::values::operation_preparation(&operation_id, &task_id);
        let prep_json = serde_json::to_value(&preparation).unwrap();
        let staged_addr = crate::harness::session::values::summary_result(&task_id);
        let staged_usage = serde_json::to_value(crate::harness::types::Usage {
            input: 1,
            output: 1,
            total_tokens: 2,
            ..Default::default()
        })
        .unwrap();
        let staged_json = serde_json::json!({ "text": "recovered summary", "usage": staged_usage });
        lane.settle_operation(move |_state, _current, _meta, _mutator| {
            Ok(crate::harness::runtime::lane::OperationCommandFor::Commit {
                decision: super::super::types::CommitDecision {
                    writes: Vec::new(),
                    materialize: Box::new(|_| ()),
                    events: None,
                },
                operation_state: effect,
                lane: None,
            })
        })
        .await
        .unwrap();
        lane.session
            .mutate(move |mutator| {
                mutator.commit(vec![
                    crate::harness::session::commit::Write::Value(crate::harness::session::values::set_value(
                        &prep_addr,
                        prep_json,
                    )),
                    crate::harness::session::commit::Write::Value(crate::harness::session::values::set_value(
                        &staged_addr,
                        staged_json,
                    )),
                ])?;
                Ok(())
            })
            .await
            .unwrap();

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match &outcome {
            DriveOutcome::Settled { outcome } => assert_eq!(outcome.status, TerminalStatus::Completed),
            other => panic!("expected completed run after recovery, got {other:?}"),
        }

        // Zero summarizer calls: the staged result applied durably.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let entries = lane.find_entries(BranchScan { oldest_first: true, ..Default::default() }).unwrap();
        let compaction = entries
            .iter()
            .find(|entry| entry.id == result_entry_id)
            .expect("compaction entry committed from the staged result");
        match &compaction.body {
            crate::harness::session::types::EntryBody::Compaction { summary, .. } => {
                assert_eq!(summary, "recovered summary");
            }
            other => panic!("expected a compaction entry, got {other:?}"),
        }
    }

    fn test_scope() -> crate::harness::session::types::OperationScope {
        crate::harness::session::types::OperationScope {
            control: crate::harness::session::types::Control::Running,
            settings: crate::harness::session::types::RunSettings {
                compaction: crate::harness::compaction::CompactionSettings::default(),
                steering_mode: crate::harness::session::types::QueueMode::All,
                follow_up_mode: crate::harness::session::types::QueueMode::All,
                tool_execution: crate::harness::session::types::ToolExecutionMode::Sequential,
            },
            latest_assistant_entry_id: None,
        }
    }

    fn meta_used() -> &'static str {
        ""
    }
}

#[cfg(test)]
mod retry_key_probe {
    use super::super::lane::{Lane, RunRequest};
    use super::super::types::{DriveOutcome, RuntimeConfig};
    use crate::harness::session::memory::MemoryStorage;
    use crate::harness::session::session::Session;
    use crate::harness::session::SessionMetadata;
    use crate::harness::types::{AssistantMessage, AssistantMessageEvent, StopReason};
    use std::sync::Mutex;

    #[tokio::test]
    async fn retry_preserves_stream_options_api_key() {
        let session = Session::new(
            SessionMetadata { id: "s".into(), created_at: 0, storage_version: 1, cwd: None, parent_session_id: None },
            std::sync::Arc::new(MemoryStorage::new()),
        );
        let (bus, event_tx) = super::super::harness::HarnessEventBus::new();
        let hooks = std::sync::Arc::new(super::super::hooks::HookRegistry::new());
        let config = std::sync::Arc::new(std::sync::RwLock::new(RuntimeConfig::default()));
        let lane = Lane::new(
            "main",
            session,
            hooks,
            config,
            super::super::lane::LaneSnapshotState::default(),
            event_tx,
        )
        .unwrap();
        drop(bus);

        let model = crate::harness::types::Model {
            id: "m".into(),
            name: "m".into(),
            api: crate::harness::types::Api::OpenAICompletions,
            provider: "p".into(),
            base_url: String::new(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            cost: Default::default(),
            prompt_cache: None,
            context_window: 100_000,
            max_tokens: 1000,
            headers: None,
            compat: None,
        };
        let seen_keys: std::sync::Arc<Mutex<Vec<Option<String>>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
        let source_model = model.clone();
        {
            let handle = lane.config_handle();
            let mut config = handle.write().unwrap();
            config.context_window = Some(model.context_window);
            let sm = source_model.clone();
            config.model_source = Some(std::sync::Arc::new(move |p: &str, m: &str| {
                (p == "p" && m == "m").then(|| sm.clone())
            }));
            let seen = seen_keys.clone();
            config.stream_options.api_key = Some("sk-live".into());
            config.stream_options.max_retries = Some(1);
            config.retry_policy = super::super::types::RetryPolicySnapshot {
                enabled: true,
                max_retries: 1,
                ..Default::default()
            };
            config.stream = Some(std::sync::Arc::new(
                move |model: crate::harness::types::Model, _ctx: crate::harness::types::TranscriptContext, opts: crate::harness::types::StreamOptions| {
                seen.lock().unwrap().push(opts.api_key.clone());
                let (tx, rx) = tokio::sync::mpsc::channel(16);
                let first = seen.lock().unwrap().len() == 1;
                tokio::spawn(async move {
                    if first {
                        // Retryable provider failure on attempt 1.
                        let mut err = AssistantMessage::pending(&model);
                        err.stop_reason = StopReason::Error;
                        err.error_message = Some("429 rate limited: slow down".into());
                        let _ = tx.send(AssistantMessageEvent::Done { reason: StopReason::Error, message: err }).await;
                    } else {
                        let mut done = AssistantMessage::pending(&model);
                        done.stop_reason = StopReason::Stop;
                        let _ = tx.send(AssistantMessageEvent::Done { reason: StopReason::Stop, message: done }).await;
                    }
                });
                rx
            }) as crate::harness::agent_types::StreamFn);
        }
        lane.set_model("p", "m").await.unwrap();

        let admission = lane
            .accept(RunRequest::Prompt { messages: vec![crate::harness::agent_types::AgentMessage::user_text("hi")] })
            .await
            .unwrap();
        let outcome = lane.drive(&admission.operation_id, true).await.unwrap();
        assert!(matches!(outcome, DriveOutcome::Settled { .. }), "outcome: {outcome:?}");
        let seen = seen_keys.lock().unwrap().clone();
        assert_eq!(seen, vec![Some("sk-live".into()), Some("sk-live".into())], "api key must survive the retry: {seen:?}");
    }
}
