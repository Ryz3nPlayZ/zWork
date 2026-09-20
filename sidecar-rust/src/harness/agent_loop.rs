//! Low-level agent loop.
//!
//! Port of pi-mono `packages/agent/src/agent-loop.ts`. Works on
//! `AgentMessage` throughout and narrows to LLM `Message`s only at the
//! provider boundary. Emits every `AgentEvent` through an awaited sink so
//! callers can reduce state in order.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::future::join_all;
use tokio::sync::mpsc;

use super::agent_types::{
    AfterToolCallContext, AgentContext, AgentEvent, AgentEventSink, AgentLoopConfig, AgentMessage, AgentToolResult,
    AgentToolUpdateCallback, BeforeToolCallContext, DynTool, StreamFn, ToolExecutionMode, TurnContext,
};
use super::transcript::{get_current_tools, get_tool_state_changes, normalize_context, ToolStateChanges};
use super::types::{
    now_ms, AbortSignal, AssistantMessage, AssistantMessageEvent, Message, StopReason, SystemMessage, ThinkingLevel,
    ToolCall, ToolResultMessage,
};
use super::validation::validate_tool_arguments;

/// Snapshot of the last completed turn, fed to `should_stop_after_turn` and
/// `prepare_next_turn`.
struct CompletedTurn {
    message: AssistantMessage,
    tool_results: Vec<ToolResultMessage>,
}

/// Start an agent loop with new prompt messages. The prompts are added to
/// the context and events are emitted for them. Returns the messages this
/// invocation produced (prompts included).
pub async fn run_agent_loop(
    prompts: Vec<AgentMessage>,
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    signal: Option<AbortSignal>,
    stream_fn: StreamFn,
) -> Vec<AgentMessage> {
    let initial_messages = declare_tool_changes(&context, prompts);
    let mut new_messages: Vec<AgentMessage> = initial_messages.clone();
    let mut current = context;
    current.messages.extend(initial_messages.iter().cloned());

    emit(AgentEvent::AgentStart).await;
    emit(AgentEvent::TurnStart).await;
    for message in &initial_messages {
        emit(AgentEvent::MessageStart { message: message.clone() }).await;
        emit(AgentEvent::MessageEnd { message: message.clone() }).await;
    }

    run_loop(current, &mut new_messages, config, signal, &emit, &stream_fn).await;
    new_messages
}

/// Continue from the current context without adding a message (retries).
/// The last message must convert to a `user` or `toolResult` message.
pub async fn run_agent_loop_continue(
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    signal: Option<AbortSignal>,
    stream_fn: StreamFn,
) -> Result<Vec<AgentMessage>, String> {
    let Some(last) = context.messages.last() else {
        return Err("Cannot continue: no messages in context".into());
    };
    if last.is_assistant() {
        return Err("Cannot continue from message role: assistant".into());
    }
    let mut new_messages: Vec<AgentMessage> = Vec::new();
    emit(AgentEvent::AgentStart).await;
    emit(AgentEvent::TurnStart).await;
    run_loop(context, &mut new_messages, config, signal, &emit, &stream_fn).await;
    Ok(new_messages)
}

async fn poll(source: &Option<super::agent_types::MessageSource>) -> Vec<AgentMessage> {
    match source {
        Some(f) => f().await,
        None => Vec::new(),
    }
}

/// Main loop shared by prompt and continuation runs.
async fn run_loop(
    mut current: AgentContext,
    new_messages: &mut Vec<AgentMessage>,
    mut config: AgentLoopConfig,
    signal: Option<AbortSignal>,
    emit: &AgentEventSink,
    stream_fn: &StreamFn,
) {
    let mut last_completed_turn: Option<CompletedTurn> = None;
    // Steering queued while the user waited for the previous run.
    let mut pending: Vec<AgentMessage> = poll(&config.get_steering_messages).await;

    // Outer loop: continues when follow-ups arrive after the agent would stop.
    loop {
        let mut has_more_tool_calls = true;

        // Inner loop: tool calls and steering messages.
        while has_more_tool_calls || !pending.is_empty() {
            let mut prepared: Vec<AgentMessage> = Vec::new();
            if let Some(turn) = &last_completed_turn {
                let update = config
                    .hooks
                    .prepare_next_turn(
                        TurnContext {
                            message: &turn.message,
                            tool_results: &turn.tool_results,
                            context: &current,
                            new_messages,
                        },
                        signal.as_ref(),
                    )
                    .await;
                if let Some(update) = update {
                    if let Some(ctx) = update.context {
                        current = ctx;
                    }
                    prepared = update.messages.unwrap_or_default();
                    if let Some(m) = update.model {
                        config.model = m;
                    }
                    if let Some(level) = update.thinking_level {
                        config.stream_options.reasoning = if level == ThinkingLevel::Off { None } else { Some(level) };
                    }
                }
                // Preparation can be slow (compaction): pick up steering queued
                // meanwhile, but only if the earlier poll came back empty so
                // one-at-a-time mode never delivers two messages per turn.
                if pending.is_empty() {
                    pending = poll(&config.get_steering_messages).await;
                }
                emit(AgentEvent::TurnStart).await;
            }

            // Prepared and queued messages go in before the next response.
            let mut incoming = prepared;
            incoming.append(&mut pending);
            for message in declare_tool_changes(&current, incoming) {
                emit(AgentEvent::MessageStart { message: message.clone() }).await;
                emit(AgentEvent::MessageEnd { message: message.clone() }).await;
                current.messages.push(message.clone());
                new_messages.push(message);
            }

            let message = stream_assistant_response(&mut current, &config, signal.as_ref(), emit, stream_fn).await;
            new_messages.push(message.clone().into());

            if matches!(message.stop_reason, StopReason::Error | StopReason::Aborted) {
                emit(AgentEvent::TurnEnd { message: message.clone().into(), tool_results: Vec::new() }).await;
                emit(AgentEvent::AgentEnd { messages: new_messages.clone() }).await;
                return;
            }

            let tool_calls: Vec<ToolCall> = message.tool_calls().into_iter().cloned().collect();
            let mut tool_results: Vec<ToolResultMessage> = Vec::new();
            has_more_tool_calls = false;
            if !tool_calls.is_empty() {
                // A "length" stop means the output hit the token limit, so
                // every call may carry truncated arguments. Fail them all.
                let batch = if message.stop_reason == StopReason::Length {
                    fail_tool_calls_from_truncated_message(&tool_calls, emit).await
                } else {
                    execute_tool_calls(&current, &message, &tool_calls, &config, signal.as_ref(), emit).await
                };
                tool_results = batch.messages;
                has_more_tool_calls = !batch.terminate;
                for r in &tool_results {
                    current.messages.push(r.clone().into());
                    new_messages.push(r.clone().into());
                }
            }

            emit(AgentEvent::TurnEnd { message: message.clone().into(), tool_results: tool_results.clone() }).await;

            let stop = config
                .hooks
                .should_stop_after_turn(
                    TurnContext {
                        message: &message,
                        tool_results: &tool_results,
                        context: &current,
                        new_messages,
                    },
                    signal.as_ref(),
                )
                .await;
            last_completed_turn = Some(CompletedTurn { message, tool_results });
            if stop {
                emit(AgentEvent::AgentEnd { messages: new_messages.clone() }).await;
                return;
            }

            pending = poll(&config.get_steering_messages).await;
        }

        // Agent would stop here. Check for follow-ups.
        let follow_ups = poll(&config.get_follow_up_messages).await;
        if !follow_ups.is_empty() {
            pending = follow_ups;
            continue;
        }
        break;
    }

    emit(AgentEvent::AgentEnd { messages: new_messages.clone() }).await;
}

// ---------------------------------------------------------------------------
// Tool loadout declarations
// ---------------------------------------------------------------------------

/// Declare tool loadout changes to the model.
///
/// `context.tools` is what the runtime can execute; the transcript's system
/// messages declare what the model may call. Before each request the
/// difference becomes `tools_added` / `tools_removed` on a system message.
/// When a pending system message exists, its tool fields are replaced with
/// the delta between the committed transcript and the executable set so
/// replay always yields exactly `context.tools`. Otherwise a new system
/// message is inserted before the first non-system pending message.
fn declare_tool_changes(context: &AgentContext, pending: Vec<AgentMessage>) -> Vec<AgentMessage> {
    let system_index = pending.iter().rposition(|m| m.is_system());
    let pending_system: Option<SystemMessage> = system_index.and_then(|i| pending[i].as_system().cloned());

    let baseline: Vec<AgentMessage> = match (&pending_system, system_index) {
        (Some(sys), Some(idx)) => pending
            .iter()
            .enumerate()
            .map(|(i, m)| if i == idx { with_tool_changes(sys, &ToolStateChanges::default()).into() } else { m.clone() })
            .collect(),
        _ => pending.clone(),
    };

    let mut committed: Vec<Message> = context.messages.iter().filter_map(|m| m.as_llm().cloned()).collect();
    committed.extend(baseline.iter().filter_map(|m| m.as_llm().cloned()));
    let changes = get_tool_state_changes(&get_current_tools(&committed), &context.declarations());
    let unchanged = changes.tools_added.is_empty() && changes.tools_removed.is_empty();

    if let (Some(sys), Some(idx)) = (&pending_system, system_index) {
        let declares_nothing =
            sys.tools_added.as_ref().map_or(true, |t| t.is_empty()) && sys.tools_removed.as_ref().map_or(true, |t| t.is_empty());
        // Keep the caller's message when it already declares no changes.
        if unchanged && declares_nothing {
            return pending;
        }
        return baseline
            .into_iter()
            .enumerate()
            .map(|(i, m)| if i == idx { with_tool_changes(sys, &changes).into() } else { m })
            .collect();
    }
    if unchanged {
        return pending;
    }
    let update: AgentMessage = with_tool_changes(
        &SystemMessage {
            content: String::new(),
            sections: None,
            tools_added: None,
            tools_removed: None,
            timestamp: now_ms(),
        },
        &changes,
    )
    .into();
    let insert_at = pending.iter().position(|m| !m.is_system()).unwrap_or(pending.len());
    let mut out = pending;
    out.insert(insert_at, update);
    out
}

/// Copy a system message with its tool fields replaced; empty lists omit the field.
fn with_tool_changes(message: &SystemMessage, changes: &ToolStateChanges) -> SystemMessage {
    SystemMessage {
        content: message.content.clone(),
        sections: message.sections.clone(),
        tools_added: if changes.tools_added.is_empty() { None } else { Some(changes.tools_added.clone()) },
        tools_removed: if changes.tools_removed.is_empty() { None } else { Some(changes.tools_removed.clone()) },
        timestamp: message.timestamp,
    }
}

// ---------------------------------------------------------------------------
// Assistant response
// ---------------------------------------------------------------------------

/// Stream one assistant response. This is where `AgentMessage`s become
/// `Message`s for the provider.
async fn stream_assistant_response(
    context: &mut AgentContext,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
    stream_fn: &StreamFn,
) -> AssistantMessage {
    let messages = config.hooks.transform_context(context.messages.clone(), signal).await;
    let llm_messages = config.hooks.convert_to_llm(&messages);
    let llm_context = normalize_context(None, None, llm_messages);

    // Resolve the API key per request (expiring tokens).
    let resolved_key = config
        .hooks
        .get_api_key(&config.model.provider)
        .await
        .filter(|k| !k.is_empty())
        .or_else(|| config.stream_options.api_key.clone());

    let mut options = config.stream_options.clone();
    options.api_key = resolved_key;
    options.signal = signal.cloned();

    let mut response = stream_fn(config.model.clone(), llm_context, options);

    let mut added_partial = false;
    let mut last_partial: Option<AssistantMessage> = None;
    while let Some(event) = response.recv().await {
        match event {
            AssistantMessageEvent::Start { partial } => {
                context.messages.push(partial.clone().into());
                added_partial = true;
                emit(AgentEvent::MessageStart { message: partial.clone().into() }).await;
                last_partial = Some(partial);
            }
            AssistantMessageEvent::Done { message, .. } | AssistantMessageEvent::Error { error: message, .. } => {
                return finish_assistant(context, message, added_partial, emit).await;
            }
            ev => {
                if last_partial.is_some() {
                    let partial = ev.partial().clone();
                    if let Some(slot) = context.messages.last_mut() {
                        *slot = partial.clone().into();
                    }
                    emit(AgentEvent::MessageUpdate { message: partial.clone().into(), assistant_message_event: ev }).await;
                    last_partial = Some(partial);
                }
            }
        }
    }

    // Stream closed without a terminal event: providers must not do this,
    // but never leave the loop without an assistant message.
    let mut message = last_partial.unwrap_or_else(|| AssistantMessage::pending(&config.model));
    message.stop_reason = if signal.map_or(false, |s| s.is_aborted()) { StopReason::Aborted } else { StopReason::Error };
    message.error_message = Some("Provider stream ended without a terminal event".into());
    finish_assistant(context, message, added_partial, emit).await
}

async fn finish_assistant(
    context: &mut AgentContext,
    message: AssistantMessage,
    added_partial: bool,
    emit: &AgentEventSink,
) -> AssistantMessage {
    let am: AgentMessage = message.clone().into();
    if added_partial {
        if let Some(slot) = context.messages.last_mut() {
            *slot = am.clone();
        }
    } else {
        context.messages.push(am.clone());
        emit(AgentEvent::MessageStart { message: am.clone() }).await;
    }
    emit(AgentEvent::MessageEnd { message: am }).await;
    message
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

struct ExecutedToolCallBatch {
    messages: Vec<ToolResultMessage>,
    terminate: bool,
}

struct FinalizedToolCall {
    tool_call: ToolCall,
    result: AgentToolResult,
    is_error: bool,
}

enum Preparation {
    Prepared { tool: DynTool, args: serde_json::Value },
    Immediate { result: AgentToolResult, is_error: bool },
}

/// Fail every tool call from a message truncated by the output token limit.
/// Streamed arguments are salvaged by a lenient parser, so they can validate
/// while being silently incomplete; none are safe to run.
async fn fail_tool_calls_from_truncated_message(tool_calls: &[ToolCall], emit: &AgentEventSink) -> ExecutedToolCallBatch {
    let mut messages = Vec::new();
    for tc in tool_calls {
        emit(AgentEvent::ToolExecutionStart {
            tool_call_id: tc.id.clone(),
            tool_name: tc.name.clone(),
            args: tc.arguments.clone(),
        })
        .await;
        let finalized = FinalizedToolCall {
            tool_call: tc.clone(),
            result: AgentToolResult::error(format!(
                "Tool call \"{}\" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.",
                tc.name
            )),
            is_error: true,
        };
        emit_tool_execution_end(&finalized, emit).await;
        let msg = create_tool_result_message(&finalized);
        emit_tool_result_message(&msg, emit).await;
        messages.push(msg);
    }
    ExecutedToolCallBatch { messages, terminate: false }
}

async fn execute_tool_calls(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tool_calls: &[ToolCall],
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
) -> ExecutedToolCallBatch {
    let has_sequential = tool_calls
        .iter()
        .any(|tc| context.find_tool(&tc.name).and_then(|t| t.execution_mode()) == Some(ToolExecutionMode::Sequential));
    if config.tool_execution == ToolExecutionMode::Sequential || has_sequential {
        execute_sequential(context, assistant, tool_calls, config, signal, emit).await
    } else {
        execute_parallel(context, assistant, tool_calls, config, signal, emit).await
    }
}

async fn execute_sequential(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tool_calls: &[ToolCall],
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
) -> ExecutedToolCallBatch {
    let mut finalized_calls: Vec<FinalizedToolCall> = Vec::new();
    let mut messages = Vec::new();

    for tc in tool_calls {
        emit(AgentEvent::ToolExecutionStart {
            tool_call_id: tc.id.clone(),
            tool_name: tc.name.clone(),
            args: tc.arguments.clone(),
        })
        .await;

        let finalized = match prepare_tool_call(context, assistant, tc, config, signal).await {
            Preparation::Immediate { result, is_error } => FinalizedToolCall { tool_call: tc.clone(), result, is_error },
            Preparation::Prepared { tool, args } => {
                let (result, is_error) = execute_prepared(&tool, tc, args.clone(), signal, emit).await;
                finalize_executed(context, assistant, tc, &args, result, is_error, config, signal).await
            }
        };

        emit_tool_execution_end(&finalized, emit).await;
        let msg = create_tool_result_message(&finalized);
        emit_tool_result_message(&msg, emit).await;
        finalized_calls.push(finalized);
        messages.push(msg);

        if signal.map_or(false, |s| s.is_aborted()) {
            break;
        }
    }

    let terminate = should_terminate(&finalized_calls);
    ExecutedToolCallBatch { messages, terminate }
}

async fn execute_parallel(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tool_calls: &[ToolCall],
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
) -> ExecutedToolCallBatch {
    enum Entry {
        Done(FinalizedToolCall),
        Run { tool: DynTool, tc: ToolCall, args: serde_json::Value },
    }
    let mut entries: Vec<Entry> = Vec::new();

    // Preflight sequentially, in assistant order.
    for tc in tool_calls {
        emit(AgentEvent::ToolExecutionStart {
            tool_call_id: tc.id.clone(),
            tool_name: tc.name.clone(),
            args: tc.arguments.clone(),
        })
        .await;
        match prepare_tool_call(context, assistant, tc, config, signal).await {
            Preparation::Immediate { result, is_error } => {
                let finalized = FinalizedToolCall { tool_call: tc.clone(), result, is_error };
                emit_tool_execution_end(&finalized, emit).await;
                entries.push(Entry::Done(finalized));
            }
            Preparation::Prepared { tool, args } => entries.push(Entry::Run { tool, tc: tc.clone(), args }),
        }
        if signal.map_or(false, |s| s.is_aborted()) {
            break;
        }
    }

    // Execute allowed tools concurrently; `tool_execution_end` lands in
    // completion order, tool-result messages later in source order.
    let futures = entries.into_iter().map(|entry| async move {
        match entry {
            Entry::Done(f) => f,
            Entry::Run { tool, tc, args } => {
                if signal.map_or(false, |s| s.is_aborted()) {
                    let finalized = FinalizedToolCall {
                        tool_call: tc,
                        result: AgentToolResult::error("Operation aborted"),
                        is_error: true,
                    };
                    emit_tool_execution_end(&finalized, emit).await;
                    return finalized;
                }
                let (result, is_error) = execute_prepared(&tool, &tc, args.clone(), signal, emit).await;
                let finalized = finalize_executed(context, assistant, &tc, &args, result, is_error, config, signal).await;
                emit_tool_execution_end(&finalized, emit).await;
                finalized
            }
        }
    });
    let ordered = join_all(futures).await;

    let mut messages = Vec::new();
    for finalized in &ordered {
        let msg = create_tool_result_message(finalized);
        emit_tool_result_message(&msg, emit).await;
        messages.push(msg);
    }
    let terminate = should_terminate(&ordered);
    ExecutedToolCallBatch { messages, terminate }
}

fn should_terminate(finalized: &[FinalizedToolCall]) -> bool {
    !finalized.is_empty() && finalized.iter().all(|f| f.result.terminate == Some(true))
}

async fn prepare_tool_call(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tc: &ToolCall,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
) -> Preparation {
    let Some(tool) = context.find_tool(&tc.name) else {
        return Preparation::Immediate {
            result: AgentToolResult::error(format!("Tool {} not found", tc.name)),
            is_error: true,
        };
    };
    let aborted = || Preparation::Immediate {
        result: AgentToolResult::error("Operation aborted"),
        is_error: true,
    };

    let prepared_args = match tool.prepare_arguments(tc.arguments.clone()) {
        Ok(a) => a,
        Err(e) => return Preparation::Immediate { result: AgentToolResult::error(e), is_error: true },
    };
    let prepared_call = ToolCall { arguments: prepared_args, ..tc.clone() };
    let validated = match validate_tool_arguments(&tool.declaration(), &prepared_call) {
        Ok(v) => v,
        Err(e) => return Preparation::Immediate { result: AgentToolResult::error(e), is_error: true },
    };

    let before = config
        .hooks
        .before_tool_call(
            BeforeToolCallContext { assistant_message: assistant, tool_call: tc, args: &validated, context },
            signal,
        )
        .await;
    if signal.map_or(false, |s| s.is_aborted()) {
        return aborted();
    }
    if let Some(b) = before {
        if b.block {
            let mut result = AgentToolResult::error(b.reason.unwrap_or_else(|| "Tool execution was blocked".into()));
            if b.terminate == Some(true) {
                result.terminate = Some(true);
            }
            return Preparation::Immediate { result, is_error: true };
        }
    }
    Preparation::Prepared { tool: tool.clone(), args: validated }
}

/// Run the tool, forwarding partial updates as `tool_execution_update`
/// events while it executes. Updates after completion are dropped.
async fn execute_prepared(
    tool: &DynTool,
    tc: &ToolCall,
    args: serde_json::Value,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
) -> (AgentToolResult, bool) {
    let (tx, mut rx) = mpsc::unbounded_channel::<AgentToolResult>();
    let accepting = Arc::new(AtomicBool::new(true));
    let on_update: AgentToolUpdateCallback = {
        let accepting = accepting.clone();
        Arc::new(move |partial| {
            if accepting.load(Ordering::SeqCst) {
                let _ = tx.send(partial);
            }
        })
    };

    let update_event = |partial: AgentToolResult| AgentEvent::ToolExecutionUpdate {
        tool_call_id: tc.id.clone(),
        tool_name: tc.name.clone(),
        args: tc.arguments.clone(),
        partial_result: partial,
    };

    let mut exec = tool.execute(&tc.id, args, signal, on_update.clone());
    let outcome = loop {
        tokio::select! {
            r = &mut exec => break r,
            Some(partial) = rx.recv() => emit(update_event(partial)).await,
        }
    };
    accepting.store(false, Ordering::SeqCst);
    drop(exec);
    drop(on_update);
    while let Ok(partial) = rx.try_recv() {
        emit(update_event(partial)).await;
    }

    match outcome {
        Ok(result) => (result, false),
        Err(e) => (AgentToolResult::error(e), true),
    }
}

#[allow(clippy::too_many_arguments)]
async fn finalize_executed(
    context: &AgentContext,
    assistant: &AssistantMessage,
    tc: &ToolCall,
    args: &serde_json::Value,
    mut result: AgentToolResult,
    mut is_error: bool,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
) -> FinalizedToolCall {
    let after = config
        .hooks
        .after_tool_call(
            AfterToolCallContext { assistant_message: assistant, tool_call: tc, args, result: &result, is_error, context },
            signal,
        )
        .await;
    if let Some(a) = after {
        if let Some(c) = a.content {
            result.content = c;
        }
        if let Some(d) = a.details {
            result.details = d;
        }
        if let Some(u) = a.usage {
            result.usage = Some(u);
        }
        if let Some(t) = a.terminate {
            result.terminate = Some(t);
        }
        if let Some(e) = a.is_error {
            is_error = e;
        }
    }
    FinalizedToolCall { tool_call: tc.clone(), result, is_error }
}

async fn emit_tool_execution_end(f: &FinalizedToolCall, emit: &AgentEventSink) {
    emit(AgentEvent::ToolExecutionEnd {
        tool_call_id: f.tool_call.id.clone(),
        tool_name: f.tool_call.name.clone(),
        result: f.result.clone(),
        is_error: f.is_error,
    })
    .await;
}

fn create_tool_result_message(f: &FinalizedToolCall) -> ToolResultMessage {
    ToolResultMessage {
        tool_call_id: f.tool_call.id.clone(),
        tool_name: f.tool_call.name.clone(),
        content: f.result.content.clone(),
        details: if f.result.details.is_null() { None } else { Some(f.result.details.clone()) },
        usage: f.result.usage.clone(),
        is_error: f.is_error,
        timestamp: now_ms(),
    }
}

async fn emit_tool_result_message(msg: &ToolResultMessage, emit: &AgentEventSink) {
    emit(AgentEvent::MessageStart { message: msg.clone().into() }).await;
    emit(AgentEvent::MessageEnd { message: msg.clone().into() }).await;
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Scripted stream function + recording sink shared by loop/agent tests.
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::harness::agent_types::ToolFuture;
    use crate::harness::types::{Api, AssistantContent, InputType, ModelCost, TextContent, Usage};

    pub fn model() -> crate::harness::types::Model {
        crate::harness::types::Model {
            id: "m".into(),
            name: "m".into(),
            api: Api::OpenAICompletions,
            provider: "p".into(),
            base_url: "https://x".into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![InputType::Text],
            cost: ModelCost::default(),
            prompt_cache: None,
            context_window: 100_000,
            max_tokens: 1000,
            headers: None,
            compat: None,
        }
    }

    /// One scripted assistant response.
    #[derive(Clone)]
    pub enum Script {
        Text(String),
        ToolCalls(Vec<(String, String, serde_json::Value)>),
        Error(String),
        /// Tool calls with a `length` stop.
        TruncatedToolCalls(Vec<(String, String, serde_json::Value)>),
    }

    fn assistant(model: &crate::harness::types::Model, content: Vec<AssistantContent>, stop: StopReason, err: Option<String>) -> AssistantMessage {
        AssistantMessage {
            content,
            api: model.api,
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: stop,
            error_message: err,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: now_ms(),
        }
    }

    /// Stream function that plays `scripts` in order, recording each request.
    pub fn scripted_stream(scripts: Vec<Script>, requests: Arc<Mutex<Vec<crate::harness::types::TranscriptContext>>>) -> StreamFn {
        let scripts = Arc::new(Mutex::new(scripts.into_iter()));
        Arc::new(move |model, ctx, _opts| {
            requests.lock().unwrap().push(ctx);
            let script = scripts.lock().unwrap().next().unwrap_or(Script::Error("script exhausted".into()));
            let (tx, rx) = mpsc::channel(64);
            tokio::spawn(async move {
                let pending = AssistantMessage::pending(&model);
                let _ = tx.send(AssistantMessageEvent::Start { partial: pending.clone() }).await;
                let truncated = matches!(script, Script::TruncatedToolCalls(_));
                match script {
                    Script::Text(t) => {
                        let mut p = pending.clone();
                        p.content.push(AssistantContent::Text(TextContent { text: String::new(), text_signature: None }));
                        let _ = tx.send(AssistantMessageEvent::TextStart { content_index: 0, partial: p.clone() }).await;
                        if let AssistantContent::Text(b) = &mut p.content[0] {
                            b.text = t.clone();
                        }
                        let _ = tx.send(AssistantMessageEvent::TextDelta { content_index: 0, delta: t.clone(), partial: p.clone() }).await;
                        let _ = tx.send(AssistantMessageEvent::TextEnd { content_index: 0, content: t, partial: p.clone() }).await;
                        let msg = assistant(&model, p.content, StopReason::Stop, None);
                        let _ = tx.send(AssistantMessageEvent::Done { reason: StopReason::Stop, message: msg }).await;
                    }
                    Script::ToolCalls(calls) | Script::TruncatedToolCalls(calls) => {
                        let stop = if truncated { StopReason::Length } else { StopReason::ToolUse };
                        let content = calls
                            .into_iter()
                            .map(|(id, name, args)| {
                                AssistantContent::ToolCall(ToolCall { id, name, arguments: args, thought_signature: None, namespace: None })
                            })
                            .collect();
                        let msg = assistant(&model, content, stop, None);
                        let _ = tx.send(AssistantMessageEvent::Done { reason: stop, message: msg }).await;
                    }
                    Script::Error(e) => {
                        let msg = assistant(&model, vec![], StopReason::Error, Some(e));
                        let _ = tx.send(AssistantMessageEvent::Error { reason: StopReason::Error, error: msg }).await;
                    }
                }
            });
            rx
        })
    }

    pub fn recording_sink() -> (AgentEventSink, Arc<Mutex<Vec<AgentEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let e2 = events.clone();
        let sink: AgentEventSink = Arc::new(move |ev| {
            e2.lock().unwrap().push(ev);
            Box::pin(async {})
        });
        (sink, events)
    }

    /// Echo tool: returns its `text` argument, streams one update first.
    pub struct EchoTool {
        pub mode: Option<ToolExecutionMode>,
        pub fail: bool,
    }

    impl crate::harness::agent_types::AgentTool for EchoTool {
        fn name(&self) -> &str {
            "echo"
        }
        fn description(&self) -> &str {
            "Echo text"
        }
        fn parameters(&self) -> serde_json::Value {
            json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"]})
        }
        fn execution_mode(&self) -> Option<ToolExecutionMode> {
            self.mode
        }
        fn execute<'a>(
            &'a self,
            _id: &'a str,
            params: serde_json::Value,
            _signal: Option<&'a AbortSignal>,
            on_update: AgentToolUpdateCallback,
        ) -> ToolFuture<'a> {
            let fail = self.fail;
            Box::pin(async move {
                on_update(AgentToolResult::text("working"));
                tokio::task::yield_now().await;
                if fail {
                    return Err("echo failed".into());
                }
                Ok(AgentToolResult::text(params["text"].as_str().unwrap_or("").to_string()))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::test_support::*;
    use super::*;
    use crate::harness::agent_types::{AgentHooks, AgentLoopTurnUpdate, AgentTool};

    fn kinds(events: &[AgentEvent]) -> Vec<&'static str> {
        events.iter().map(|e| e.kind()).collect()
    }

    #[tokio::test]
    async fn text_only_turn_emits_lifecycle() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(vec![Script::Text("hello".into())], requests.clone());
        let (sink, events) = recording_sink();
        let ctx = AgentContext { messages: vec![], tools: vec![] };
        let out = run_agent_loop(vec![AgentMessage::user_text("hi")], ctx, AgentLoopConfig::new(model()), sink, None, stream).await;
        assert_eq!(out.len(), 2);
        assert_eq!(
            kinds(&events.lock().unwrap()),
            vec![
                "agent_start",
                "turn_start",
                "message_start",
                "message_end",
                "message_start",
                "message_update",
                "message_update",
                "message_update",
                "message_end",
                "turn_end",
                "agent_end"
            ]
        );
        let req = &requests.lock().unwrap()[0];
        assert_eq!(req.messages.len(), 1);
    }

    #[tokio::test]
    async fn tool_calls_run_in_parallel_and_feed_next_turn() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(
            vec![
                Script::ToolCalls(vec![
                    ("a".into(), "echo".into(), json!({"text":"one"})),
                    ("b".into(), "echo".into(), json!({"text":"two"})),
                    ("c".into(), "missing".into(), json!({})),
                ]),
                Script::Text("done".into()),
            ],
            requests.clone(),
        );
        let (sink, events) = recording_sink();
        let ctx = AgentContext {
            messages: vec![],
            tools: vec![Arc::new(EchoTool { mode: None, fail: false })],
        };
        let out = run_agent_loop(vec![AgentMessage::user_text("go")], ctx, AgentLoopConfig::new(model()), sink, None, stream).await;
        // prompt + tool-declaring system message, assistant, 3 results, assistant
        assert_eq!(out.len(), 7);
        assert!(out[0].is_system(), "tool declaration inserted before the prompt");
        let results: Vec<&ToolResultMessage> = out
            .iter()
            .filter_map(|m| match m {
                AgentMessage::Llm(Message::ToolResult(t)) => Some(t),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].tool_call_id, "a");
        assert_eq!(results[0].text(), "one");
        assert_eq!(results[2].tool_call_id, "c");
        assert!(results[2].is_error);
        assert_eq!(results[2].text(), "Tool missing not found");

        let ev = events.lock().unwrap();
        let updates = ev.iter().filter(|e| matches!(e, AgentEvent::ToolExecutionUpdate { .. })).count();
        assert_eq!(updates, 2);
        let ends = ev.iter().filter(|e| matches!(e, AgentEvent::ToolExecutionEnd { .. })).count();
        assert_eq!(ends, 3);
        // Second request sees the tool results.
        let req = &requests.lock().unwrap()[1];
        assert!(req.messages.iter().any(|m| matches!(m, Message::ToolResult(_))));
    }

    #[tokio::test]
    async fn truncated_message_fails_all_tool_calls() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(
            vec![
                Script::TruncatedToolCalls(vec![("a".into(), "echo".into(), json!({"text":"one"}))]),
                Script::Text("ok".into()),
            ],
            requests,
        );
        let (sink, _events) = recording_sink();
        let ctx = AgentContext {
            messages: vec![],
            tools: vec![Arc::new(EchoTool { mode: None, fail: false })],
        };
        let out = run_agent_loop(vec![AgentMessage::user_text("go")], ctx, AgentLoopConfig::new(model()), sink, None, stream).await;
        let tr = out
            .iter()
            .find_map(|m| match m {
                AgentMessage::Llm(Message::ToolResult(t)) => Some(t),
                _ => None,
            })
            .unwrap();
        assert!(tr.is_error);
        assert!(tr.text().contains("output token limit"));
    }

    #[tokio::test]
    async fn tool_failure_and_validation_errors_become_error_results() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(
            vec![
                Script::ToolCalls(vec![
                    ("a".into(), "echo".into(), json!({"text":"x"})),
                    ("b".into(), "echo".into(), json!({"nope":1})),
                ]),
                Script::Text("ok".into()),
            ],
            requests,
        );
        let (sink, _events) = recording_sink();
        let ctx = AgentContext {
            messages: vec![],
            tools: vec![Arc::new(EchoTool { mode: Some(ToolExecutionMode::Sequential), fail: true })],
        };
        let out = run_agent_loop(vec![AgentMessage::user_text("go")], ctx, AgentLoopConfig::new(model()), sink, None, stream).await;
        let results: Vec<&ToolResultMessage> = out
            .iter()
            .filter_map(|m| match m {
                AgentMessage::Llm(Message::ToolResult(t)) => Some(t),
                _ => None,
            })
            .collect();
        assert_eq!(results[0].text(), "echo failed");
        assert!(results[0].is_error);
        assert!(results[1].text().contains("Validation failed"));
    }

    #[tokio::test]
    async fn error_stop_ends_run_without_tools() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(vec![Script::Error("boom".into())], requests);
        let (sink, events) = recording_sink();
        let out = run_agent_loop(
            vec![AgentMessage::user_text("go")],
            AgentContext::default(),
            AgentLoopConfig::new(model()),
            sink,
            None,
            stream,
        )
        .await;
        let a = out.last().unwrap().as_assistant().unwrap();
        assert_eq!(a.stop_reason, StopReason::Error);
        assert_eq!(a.error_message.as_deref(), Some("boom"));
        assert_eq!(kinds(&events.lock().unwrap()).last().copied(), Some("agent_end"));
    }

    struct BlockingHooks;
    impl AgentHooks for BlockingHooks {
        fn before_tool_call<'a>(
            &'a self,
            ctx: BeforeToolCallContext<'a>,
            _signal: Option<&'a AbortSignal>,
        ) -> futures_util::future::BoxFuture<'a, Option<crate::harness::agent_types::BeforeToolCallResult>> {
            let block = ctx.args["text"] == "bad";
            Box::pin(async move {
                block.then(|| crate::harness::agent_types::BeforeToolCallResult {
                    block: true,
                    reason: Some("nope".into()),
                    terminate: Some(true),
                })
            })
        }
        fn after_tool_call<'a>(
            &'a self,
            _ctx: AfterToolCallContext<'a>,
            _signal: Option<&'a AbortSignal>,
        ) -> futures_util::future::BoxFuture<'a, Option<crate::harness::agent_types::AfterToolCallResult>> {
            Box::pin(async {
                Some(crate::harness::agent_types::AfterToolCallResult {
                    details: Some(json!({"audited": true})),
                    ..Default::default()
                })
            })
        }
    }

    #[tokio::test]
    async fn hooks_block_and_terminate() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(
            vec![
                Script::ToolCalls(vec![("a".into(), "echo".into(), json!({"text":"bad"}))]),
                Script::Text("unreachable".into()),
            ],
            requests.clone(),
        );
        let (sink, _events) = recording_sink();
        let mut config = AgentLoopConfig::new(model());
        config.hooks = Arc::new(BlockingHooks);
        let ctx = AgentContext {
            messages: vec![],
            tools: vec![Arc::new(EchoTool { mode: None, fail: false })],
        };
        let out = run_agent_loop(vec![AgentMessage::user_text("go")], ctx, config, sink, None, stream).await;
        // Blocked + terminate → no second request.
        assert_eq!(requests.lock().unwrap().len(), 1);
        let tr = out
            .iter()
            .find_map(|m| match m {
                AgentMessage::Llm(Message::ToolResult(t)) => Some(t),
                _ => None,
            })
            .unwrap();
        assert_eq!(tr.text(), "nope");
    }

    #[tokio::test]
    async fn after_hook_overrides_details() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(
            vec![
                Script::ToolCalls(vec![("a".into(), "echo".into(), json!({"text":"fine"}))]),
                Script::Text("ok".into()),
            ],
            requests,
        );
        let (sink, _events) = recording_sink();
        let mut config = AgentLoopConfig::new(model());
        config.hooks = Arc::new(BlockingHooks);
        let ctx = AgentContext {
            messages: vec![],
            tools: vec![Arc::new(EchoTool { mode: None, fail: false })],
        };
        let out = run_agent_loop(vec![AgentMessage::user_text("go")], ctx, config, sink, None, stream).await;
        let tr = out
            .iter()
            .find_map(|m| match m {
                AgentMessage::Llm(Message::ToolResult(t)) => Some(t),
                _ => None,
            })
            .unwrap();
        assert_eq!(tr.details, Some(json!({"audited": true})));
    }

    struct StopAfterOne;
    impl AgentHooks for StopAfterOne {
        fn should_stop_after_turn<'a>(
            &'a self,
            _ctx: TurnContext<'a>,
            _signal: Option<&'a AbortSignal>,
        ) -> futures_util::future::BoxFuture<'a, bool> {
            Box::pin(async { true })
        }
    }

    #[tokio::test]
    async fn should_stop_after_turn_exits_before_steering() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(vec![Script::Text("a".into()), Script::Text("b".into())], requests.clone());
        let (sink, _events) = recording_sink();
        let mut config = AgentLoopConfig::new(model());
        config.hooks = Arc::new(StopAfterOne);
        let polled = Arc::new(Mutex::new(0));
        let p2 = polled.clone();
        config.get_follow_up_messages = Some(Arc::new(move || {
            *p2.lock().unwrap() += 1;
            Box::pin(async { vec![AgentMessage::user_text("more")] })
        }));
        run_agent_loop(vec![AgentMessage::user_text("go")], AgentContext::default(), config, sink, None, stream).await;
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(*polled.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn follow_ups_extend_the_run() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(vec![Script::Text("a".into()), Script::Text("b".into())], requests.clone());
        let (sink, events) = recording_sink();
        let mut config = AgentLoopConfig::new(model());
        let queue = Arc::new(Mutex::new(vec![AgentMessage::user_text("follow")]));
        config.get_follow_up_messages = Some(Arc::new(move || {
            let drained: Vec<_> = queue.lock().unwrap().drain(..).collect();
            Box::pin(async move { drained })
        }));
        let out = run_agent_loop(vec![AgentMessage::user_text("go")], AgentContext::default(), config, sink, None, stream).await;
        assert_eq!(requests.lock().unwrap().len(), 2);
        assert_eq!(out.len(), 4);
        let turn_starts = events.lock().unwrap().iter().filter(|e| matches!(e, AgentEvent::TurnStart)).count();
        assert_eq!(turn_starts, 2);
    }

    struct SwapModel;
    impl AgentHooks for SwapModel {
        fn prepare_next_turn<'a>(
            &'a self,
            _ctx: TurnContext<'a>,
            _signal: Option<&'a AbortSignal>,
        ) -> futures_util::future::BoxFuture<'a, Option<AgentLoopTurnUpdate>> {
            Box::pin(async {
                let mut m = model();
                m.id = "m2".into();
                Some(AgentLoopTurnUpdate {
                    model: Some(m),
                    messages: Some(vec![AgentMessage::user_text("injected")]),
                    ..Default::default()
                })
            })
        }
    }

    #[tokio::test]
    async fn prepare_next_turn_swaps_model_and_injects() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(
            vec![
                Script::ToolCalls(vec![("a".into(), "echo".into(), json!({"text":"x"}))]),
                Script::Text("ok".into()),
            ],
            requests.clone(),
        );
        let (sink, _events) = recording_sink();
        let mut config = AgentLoopConfig::new(model());
        config.hooks = Arc::new(SwapModel);
        let ctx = AgentContext {
            messages: vec![],
            tools: vec![Arc::new(EchoTool { mode: None, fail: false })],
        };
        let out = run_agent_loop(vec![AgentMessage::user_text("go")], ctx, config, sink, None, stream).await;
        let second = &requests.lock().unwrap()[1];
        assert!(second
            .messages
            .iter()
            .any(|m| matches!(m, Message::User(u) if u.content.text() == "injected")));
        let last = out.last().unwrap().as_assistant().unwrap();
        // Scripted stream echoes back the model it was given.
        assert_eq!(last.model, "m2");
    }

    #[tokio::test]
    async fn continue_rejects_assistant_tail() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(vec![], requests);
        let (sink, _events) = recording_sink();
        let mut ctx = AgentContext::default();
        ctx.messages.push(AssistantMessage::pending(&model()).into());
        let err = run_agent_loop_continue(ctx, AgentLoopConfig::new(model()), sink, None, stream).await.unwrap_err();
        assert!(err.contains("assistant"));
    }

    #[tokio::test]
    async fn tool_removal_is_declared() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(vec![Script::Text("ok".into())], requests.clone());
        let (sink, _events) = recording_sink();
        // Transcript declares `echo` but the runtime has no tools now.
        let sys = crate::harness::transcript::create_initial_system_message(
            Some("sys"),
            Some(&[EchoTool { mode: None, fail: false }.declaration()]),
        )
        .unwrap();
        let ctx = AgentContext { messages: vec![sys.into()], tools: vec![] };
        let out = run_agent_loop(vec![AgentMessage::user_text("go")], ctx, AgentLoopConfig::new(model()), sink, None, stream).await;
        let decl = out[0].as_system().unwrap();
        assert_eq!(decl.tools_removed.as_ref().unwrap()[0].name, "echo");
        let req = &requests.lock().unwrap()[0];
        assert!(get_current_tools(&req.messages).is_empty());
    }
}
