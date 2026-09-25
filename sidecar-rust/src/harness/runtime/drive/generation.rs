//! Port of pi `harness/runtime/drive/generation.ts` — one durable
//! assistant generation: prepare, publish the effect intent, stream with
//! durable frames, and settle through the response transaction.

use std::sync::Arc;

use crate::harness::agent_types::AgentMessage;
use crate::harness::assistant_frame::AssistantMessageFrameEncoder;
use crate::harness::session::types::{
    GenerationContext, LaneConfiguration, OperationError, OperationState, SessionError, SessionResult,
};
use crate::harness::transcript::normalize_context;
use crate::harness::types::{
    now_ms, AssistantMessage, AssistantMessageEvent, Message, Model, StopReason, StreamOptions, ThinkingLevel, Tool,
};

use super::super::events::HarnessEvent;
use super::super::hooks::{BeforeRequestEvent, HookContext, RequestStep};
use super::super::lane::{ContinueOutcome, Lane, OperationCommandFor};
use super::super::progress::open_frame_progress;
use super::super::types::{CommitDecision, Drive, DriveOutcome, ProcedureResult};
use super::boundary::read_bounded_context;
use super::response::{publish_configuration_failure, publish_response, ResponseIntent};

enum PreparedGeneration {
    Ready {
        model: Model,
        tools: Vec<Tool>,
        messages: Vec<AgentMessage>,
        system_prompt: String,
        stream_options: crate::harness::session::types::HarnessStreamOptionsSnapshot,
    },
    ConfigurationFailure(OperationError),
}

fn configuration_error(code: &str, details: serde_json::Value) -> OperationError {
    OperationError {
        code: code.into(),
        message: if code == "model_unavailable" {
            "The configured model is unavailable in this process".into()
        } else {
            "One or more configured tools are unavailable in this process".into()
        },
        details: Some(details),
    }
}

/// Advance one durable assistant retry wait according to this pass's
/// local wait policy (pi `runRetryWait`).
pub async fn run_retry_wait(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    retry: &crate::harness::session::types::RetryWait,
    generation: &GenerationContext,
) -> SessionResult<ProcedureResult> {
    if (now_ms() as u64) < retry.not_before {
        if !drive.wait_for_retry {
            return Ok(ProcedureResult::Waiting {
                outcome: DriveOutcome::WaitingRetry { operation_id: drive.operation_id.clone(), not_before: retry.not_before },
            });
        }
        // Gated sleep: an abort requested mid-wait surfaces as a gate
        // error; the durable control marker routes the next iteration to
        // reconciliation (pi awaits the cancellation future here).
        let remaining = std::time::Duration::from_millis(retry.not_before.saturating_sub(now_ms() as u64));
        tokio::time::sleep(remaining).await;
        if drive.gate.check().is_err() {
            return Ok(ProcedureResult::Continue);
        }
    }

    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let step_id = generation.step_id.clone();
    let next_attempt = retry.next_attempt;
    let outcome = lane
        .continue_operation(move |_state, current, _meta, _mutator| {
            let scope = current.scope().clone();
            let generation = match current {
                OperationState::AssistantRetryWait { generation, .. } => generation.clone(),
                _ => return Err(SessionError::Invariant("run_retry_wait on a non-waiting operation".into())),
            };
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes: Vec::new(),
                    materialize: Box::new(|_| ProcedureResult::Continue),
                    events: Some(Box::new(move |_| {
                        vec![HarnessEvent::RetryStart {
                            lane: lane_name,
                            run_id: operation_id,
                            step: step_id,
                            attempt: next_attempt,
                            recovery: None,
                        }]
                    })),
                },
                operation_state: OperationState::AssistantReady { scope, generation, next_attempt },
                lane: None,
            })
        })
        .await;

    match outcome {
        Ok(ContinueOutcome::CancelRequested) => Ok(ProcedureResult::Continue),
        Ok(ContinueOutcome::Result(result)) => Ok(result),
        Err(error) => Err(SessionError::Other(error.to_string())),
    }
}

/// Execute one ready assistant generation or advance its durable retry
/// wait (pi `runGeneration`).
pub async fn run_generation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    generation: &GenerationContext,
    next_attempt: u32,
) -> SessionResult<ProcedureResult> {
    let prepared = match prepare_generation(lane, drive, generation, next_attempt).await? {
        Some(prepared) => prepared,
        None => return Ok(ProcedureResult::Continue),
    };
    let (model, tools, messages, system_prompt, stream_options) = match prepared {
        PreparedGeneration::Ready { model, tools, messages, system_prompt, stream_options } => {
            (model, tools, messages, system_prompt, stream_options)
        }
        PreparedGeneration::ConfigurationFailure(error) => {
            return publish_configuration_failure(lane, drive, error).await;
        }
    };

    let intent = match publish_generation_intent(lane, drive, generation, next_attempt, &model).await? {
        Some(intent) => intent,
        None => return Ok(ProcedureResult::Continue),
    };
    let response = perform_generation(lane, drive, &intent, &model, &tools, &messages, &system_prompt, &stream_options).await?;
    publish_response(lane, drive, &intent, response, false).await
}

async fn prepare_generation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    generation: &GenerationContext,
    attempt: u32,
) -> SessionResult<Option<PreparedGeneration>> {
    let configuration: &LaneConfiguration = &generation.configuration;
    let config = lane.read_config();

    let Some(model_source) = &config.model_source else {
        return Ok(Some(PreparedGeneration::ConfigurationFailure(configuration_error(
            "model_unavailable",
            serde_json::json!({ "provider": configuration.provider, "modelId": configuration.model_id }),
        ))));
    };
    let Some(model) = model_source(&configuration.provider, &configuration.model_id) else {
        return Ok(Some(PreparedGeneration::ConfigurationFailure(configuration_error(
            "model_unavailable",
            serde_json::json!({ "provider": configuration.provider, "modelId": configuration.model_id }),
        ))));
    };

    let missing: Vec<String> = configuration
        .active_tool_names
        .iter()
        .filter(|name| !config.tools.iter().any(|tool| &tool.declaration.name == *name))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Ok(Some(PreparedGeneration::ConfigurationFailure(configuration_error(
            "configured_tools_unavailable",
            serde_json::json!({ "tools": missing }),
        ))));
    }
    let tools: Vec<Tool> = configuration
        .active_tool_names
        .iter()
        .filter_map(|name| {
            config
                .tools
                .iter()
                .find(|tool| &tool.declaration.name == name)
                .map(|tool| tool.declaration.clone())
        })
        .collect();

    let messages = match read_bounded_context(lane, drive).await? {
        ContinueOutcome::CancelRequested => return Ok(None),
        ContinueOutcome::Result(messages) => messages,
    };

    let system_prompt = config.system_prompt.clone().unwrap_or_default();

    // before_request may replace the stream options (fail-open).
    let stream_options = match lane.hooks.run_before_request_with_gate(
        &HookContext { lane: lane.name.clone(), run_id: drive.operation_id.clone() },
        &BeforeRequestEvent {
            model: super::super::types::ModelIdentity {
                provider: configuration.provider.clone(),
                model_id: configuration.model_id.clone(),
            },
            step: RequestStep::Assistant,
            attempt,
            stream_options: generation.stream_options.clone(),
        },
        &drive.gate,
    ) {
        Ok(Some(result)) => result.stream_options.unwrap_or_else(|| generation.stream_options.clone()),
        Ok(None) => generation.stream_options.clone(),
        Err(_) => return Ok(None), // abort raced admission; durable control routes next
    };

    Ok(Some(PreparedGeneration::Ready { model, tools, messages, system_prompt, stream_options }))
}

async fn publish_generation_intent(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    generation: &GenerationContext,
    attempt: u32,
    model: &Model,
) -> SessionResult<Option<ResponseIntent>> {
    let response_entry_id = lane.session.next_id();
    let usage_id = lane.session.next_id();
    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let turn_id = generation.step_id.clone();
    let emit_turn_start = attempt == 1;

    let intent = ResponseIntent {
        generation: generation.clone(),
        attempt,
        response_entry_id: response_entry_id.clone(),
        usage_id: usage_id.clone(),
        intended_output_limit: model.max_tokens,
        context_window: model.context_window,
    };

    let outcome = lane
        .continue_operation(move |_state, current, _meta, _mutator| {
            let scope = current.scope().clone();
            Ok(OperationCommandFor::Commit {
                decision: CommitDecision {
                    writes: Vec::new(),
                    materialize: Box::new(|_| ()),
                    events: Some(Box::new(move |_| {
                        emit_turn_start
                            .then(|| HarnessEvent::TurnStart {
                                lane: lane_name.clone(),
                                run_id: operation_id.clone(),
                                turn_id: turn_id.clone(),
                                recovery: None,
                            })
                            .into_iter()
                            .collect()
                    })),
                },
                operation_state: OperationState::AssistantEffectPending {
                    scope,
                    generation: generation.clone(),
                    attempt,
                    response_entry_id: response_entry_id.clone(),
                    usage_id,
                    intended_output_limit: model.max_tokens,
                    context_window: model.context_window,
                },
                lane: None,
            })
        })
        .await;

    match outcome {
        Ok(ContinueOutcome::CancelRequested) => Ok(None),
        Ok(ContinueOutcome::Result(())) => Ok(Some(intent)),
        Err(error) => Err(SessionError::Other(error.to_string())),
    }
}

fn stream_options_from(
    snapshot: &crate::harness::session::types::HarnessStreamOptionsSnapshot,
    volatile: &crate::harness::session::types::HarnessStreamOptionsSnapshot,
    thinking_level: ThinkingLevel,
    signal: crate::harness::types::AbortSignal,
) -> StreamOptions {
    // Durable knobs (retries, delays, cache hints, headers) come from the
    // operation's snapshot; credentials and generation ceilings are volatile
    // by contract — after a restart the deserialized snapshot no longer
    // carries them, so they always resolve from the live harness config.
    StreamOptions {
        api_key: volatile.api_key.clone(),
        headers: snapshot.headers.clone(),
        temperature: None,
        max_tokens: volatile.max_tokens,
        reasoning: (thinking_level != ThinkingLevel::Off).then_some(thinking_level),
        signal: Some(signal),
        max_retries: snapshot.max_retries.unwrap_or(0),
        max_retry_delay_ms: snapshot.max_retry_delay_ms,
        session_id: volatile.session_id.clone(),
        cache_retention: snapshot.cache_retention.clone(),
        sampling_params: None,
        on_payload: None,
    }
}

async fn perform_generation(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    intent: &ResponseIntent,
    model: &Model,
    tools: &[Tool],
    messages: &[AgentMessage],
    system_prompt: &str,
    stream_options: &crate::harness::session::types::HarnessStreamOptionsSnapshot,
) -> SessionResult<AssistantMessage> {
    let config = lane.read_config();
    let Some(stream) = config.stream else {
        return Err(SessionError::Other("no provider stream installed".into()));
    };

    let progress = open_frame_progress(lane, drive, &intent.response_entry_id);
    let mut encoder = AssistantMessageFrameEncoder::new();

    // Transform the context through the hook chain (fail-open), then
    // narrow to provider messages under the leading system message.
    let mut context_messages = messages.to_vec();
    let mut context_system_prompt = system_prompt.to_string();
    if let Ok(result) = lane.hooks.run_transform_context_with_gate(
        &HookContext { lane: lane.name.clone(), run_id: drive.operation_id.clone() },
        &super::super::hooks::TransformContextEvent {
            messages: context_messages.clone(),
            system_prompt: context_system_prompt.clone(),
        },
        &drive.gate,
    ) {
        if let Some(next) = result.messages {
            context_messages = next;
        }
        if let Some(next) = result.system_prompt {
            context_system_prompt = next;
        }
    }
    let llm_messages = crate::harness::messages::convert_to_llm(&context_messages);
    let transcript = normalize_context(
        (!context_system_prompt.is_empty()).then_some(context_system_prompt.as_str()),
        Some(tools),
        llm_messages,
    );

    let options = stream_options_from(
        stream_options,
        &lane.read_config().stream_options,
        intent.generation.configuration.thinking_level,
        drive.gate.signal().clone(),
    );

    // Effect admission: starting the provider request is the effect.
    let mut response_stream = drive
        .gate
        .admit(move || stream(model.clone(), transcript, options))
        .map_err(|_| SessionError::Other("generation aborted before admission".into()))?;

    let lane_name = lane.name.clone();
    let operation_id = drive.operation_id.clone();
    let response_entry_id = intent.response_entry_id.clone();
    let mut settled: Option<AssistantMessage> = None;
    while let Some(event) = response_stream.recv().await {
        match event {
            AssistantMessageEvent::Done { message, .. } | AssistantMessageEvent::Error { error: message, .. } => {
                lane.emit_public(HarnessEvent::MessageEnd {
                    lane: lane_name.clone(),
                    run_id: Some(operation_id.clone()),
                    message: AgentMessage::Llm(Message::Assistant(message.clone())),
                    entry_id: Some(response_entry_id.clone()),
                    recovery: None,
                });
                settled = Some(message);
                break;
            }
            AssistantMessageEvent::Start { partial } => {
                if let Ok(Some(frame)) = encoder.encode(&AssistantMessageEvent::Start { partial: partial.clone() }) {
                    progress.write(frame).await;
                }
                lane.emit_public(HarnessEvent::MessageStart {
                    lane: lane_name.clone(),
                    run_id: Some(operation_id.clone()),
                    message: AgentMessage::Llm(Message::Assistant(partial)),
                    recovery: None,
                });
            }
            other => {
                let partial = other.partial().clone();
                if let Ok(Some(frame)) = encoder.encode(&other) {
                    progress.write(frame).await;
                }
                lane.emit_public(HarnessEvent::MessageUpdate {
                    lane: lane_name.clone(),
                    run_id: operation_id.clone(),
                    message: AgentMessage::Llm(Message::Assistant(partial.clone())),
                    event: other,
                    frame: None,
                    recovery: None,
                });
            }
        }
    }

    let mut response = match settled {
        Some(message) => message,
        None => {
            // Providers must not end streams without a terminal event.
            let mut message = AssistantMessage::pending(model);
            message.stop_reason = if drive.gate.signal().is_aborted() { StopReason::Aborted } else { StopReason::Error };
            message.error_message = Some("Provider stream ended without a terminal event".into());
            message
        }
    };
    progress.seal();
    progress.drain().await;

    // after_response may rewrite the settled message (fail-open).
    if let Ok(result) = lane.hooks.run_after_response_with_gate(
        &HookContext { lane: lane.name.clone(), run_id: drive.operation_id.clone() },
        &super::super::hooks::AfterResponseEvent {
            status: None,
            headers: Vec::new(),
            message: AgentMessage::Llm(Message::Assistant(response.clone())),
        },
        &drive.gate,
    ) {
        response = match result.message {
            AgentMessage::Llm(Message::Assistant(am)) => am,
            other => {
                return Err(SessionError::Invariant(format!(
                    "after_response returned a non-assistant message: {}",
                    other.role()
                )))
            }
        };
    }

    Ok(response)
}
