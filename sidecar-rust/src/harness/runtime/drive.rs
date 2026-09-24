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
pub mod response;
pub mod structural;
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
            // Durable cancellation routes to reconcile, which settles
            // admitted effects and finishes the operation; it arrives with
            // the reconciliation slice.
            return Err(SessionError::Other(
                SliceNotImplemented { operation: "reconcile" }.to_string(),
            ));
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
                OperationState::AssistantEffectPending { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "assistant recovery" }.to_string(),
                    ));
                }
                OperationState::Tools { .. } => super::drive::tools::run_tools(lane, drive).await?,
                OperationState::DeferredSuspended { .. } | OperationState::DeferredEffectPending { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "deferred" }.to_string(),
                    ));
                }
                OperationState::SummaryDeciding { .. }
                | OperationState::SummaryReady { .. }
                | OperationState::SummaryEffectPending { .. }
                | OperationState::SummaryRetryWait { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "structural generation" }.to_string(),
                    ));
                }
                OperationState::NavigationReadyToCommit { .. } => {
                    return Err(SessionError::Other(
                        SliceNotImplemented { operation: "navigation commit" }.to_string(),
                    ));
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
    use crate::harness::session::types::{BranchScan, OperationState, SessionMetadata, TerminalStatus, ToolCallStatus};
    use crate::harness::session::values::operation_state as operation_state_addr;
    use std::sync::{Arc, RwLock};

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
        let steer = lane.enqueue(QueueKind::Steer, AgentMessage::user_text("redirect")).await.unwrap();

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
        let steer = lane.enqueue(QueueKind::Steer, AgentMessage::user_text("now")).await.unwrap();
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
    async fn cancellation_routes_to_reconcile_slice() {
        let (lane, _events) = test_lane();
        let operation_id = accept(&lane, "work").await;
        lane.request_operation_abort(&operation_id).await.unwrap();

        let outcome = lane.drive(&operation_id, false).await.unwrap();
        match outcome {
            DriveOutcome::Failed { message, .. } => assert!(message.contains("reconcile"), "{message}"),
            other => panic!("expected reconcile slice failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn threshold_hands_off_to_summary_deciding() {
        let (lane, mut events) = test_lane();
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
        assert!(matches!(outcome, DriveOutcome::Failed { .. }));

        match durable_state(&lane, &operation_id) {
            OperationState::SummaryDeciding { task, .. } => {
                assert_eq!(task.reason.as_deref(), Some("threshold"));
            }
            other => panic!("expected summary.deciding, got {}", other.at()),
        }
        assert!(drain(&mut events).contains(&"compaction_start"));
    }

    fn meta_used() -> &'static str {
        ""
    }
}
