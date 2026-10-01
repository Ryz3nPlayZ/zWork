//! Port of pi `harness/execution/tools.ts` — the tool execution layer:
//! argument preparation, before/after hook application, gated execution,
//! and the runtime tool contract (declarations plus replay policy and an
//! async executor).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value as Json;

use crate::harness::agent_types::AgentToolResult;
use crate::harness::types::{
    now_ms, Tool, ToolCall, ToolResultMessage, UserContent,
};
use crate::harness::validation::validate_tool_arguments;

use super::lane::Lane;

/// Whether re-executing this tool after a crash is sound (pi
/// `AgentHarnessTool.replay`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayPolicy {
    /// Idempotent tools re-execute from persisted arguments.
    Safe,
    /// Effectful tools never re-execute; recovery synthesizes an
    /// "interrupted, outcome unknown" result.
    Never,
}

/// One tool callable by lanes: declaration, replay policy, executor.
#[derive(Clone)]
pub struct RuntimeTool {
    pub declaration: Tool,
    pub replay: ReplayPolicy,
    pub execute: ExecuteFn,
}

impl std::fmt::Debug for RuntimeTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeTool")
            .field("name", &self.declaration.name)
            .field("replay", &self.replay)
            .finish()
    }
}

/// Live progress from a running tool: the partial result and whether it
/// should be checkpointed durably (pi `AgentHarnessToolUpdateCallback`).
pub type ToolUpdateCallback = Arc<dyn Fn(&AgentToolResult, bool) + Send + Sync>;

/// Memo capability for one invocation (pi `AgentHarnessToolInvocation`).
/// Access fails once the invocation no longer owns its durable effect.
#[derive(Clone)]
pub struct ToolInvocationCapability {
    lane: Arc<Lane>,
    operation_id: String,
    result_entry_id: String,
    active: Arc<AtomicBool>,
}

#[derive(Debug, thiserror::Error)]
#[error("tool invocation no longer owns its durable effect")]
pub struct ToolInvocationEnded;

impl ToolInvocationCapability {
    pub(crate) fn new(
        lane: Arc<Lane>,
        operation_id: String,
        result_entry_id: String,
    ) -> (Self, Arc<AtomicBool>) {
        let active = Arc::new(AtomicBool::new(true));
        (
            ToolInvocationCapability {
                lane,
                operation_id,
                result_entry_id,
                active: Arc::clone(&active),
            },
            active,
        )
    }

    pub fn invocation_id(&self) -> &str {
        &self.result_entry_id
    }

    fn validate_memo_name(name: &str) -> Result<(), String> {
        if name.is_empty() {
            return Err("Tool invocation memo name must not be empty".into());
        }
        if name.contains(':') {
            return Err("Tool invocation memo name must not contain ':'".into());
        }
        Ok(())
    }

    pub async fn get_memo(&self, name: &str) -> Result<Option<Json>, ToolMemoError> {
        Self::validate_memo_name(name).map_err(ToolMemoError::Invalid)?;
        if !self.active.load(Ordering::SeqCst) {
            return Err(ToolMemoError::Ended(ToolInvocationEnded));
        }
        let address = crate::harness::session::values::operation_tool_memo(
            &self.operation_id,
            &self.result_entry_id,
            name,
        );
        let operation_id = self.operation_id.clone();
        let result_entry_id = self.result_entry_id.clone();
        let stored = self
            .lane
            .command(move |state, mutator| {
                if !owns_effect_state(state, &operation_id, &result_entry_id) {
                    return Ok(super::types::LaneCommand::Return { result: None });
                }
                Ok(super::types::LaneCommand::Return {
                    result: mutator.get_value(&address)?.map(|stored| stored.value),
                })
            })
            .await?;
        Ok(stored)
    }

    pub async fn set_memo(&self, name: &str, value: Option<Json>) -> Result<(), ToolMemoError> {
        Self::validate_memo_name(name).map_err(ToolMemoError::Invalid)?;
        if !self.active.load(Ordering::SeqCst) {
            return Err(ToolMemoError::Ended(ToolInvocationEnded));
        }
        let address = crate::harness::session::values::operation_tool_memo(
            &self.operation_id,
            &self.result_entry_id,
            name,
        );
        let write = match value {
            Some(value) => crate::harness::session::commit::Write::Value(
                crate::harness::session::values::set_value(&address, value),
            ),
            None => crate::harness::session::commit::Write::Value(
                crate::harness::session::values::delete_value(&address),
            ),
        };
        let operation_id = self.operation_id.clone();
        let result_entry_id = self.result_entry_id.clone();
        self.lane
            .command(move |state, _| {
                if !owns_effect_state(state, &operation_id, &result_entry_id) {
                    return Ok(super::types::LaneCommand::Return { result: () });
                }
                Ok(super::types::LaneCommand::Commit {
                    decision: super::types::CommitDecision {
                        writes: vec![write],
                        materialize: Box::new(|_| ()),
                        events: None,
                    },
                    next: state.clone(),
                })
            })
            .await?;
        Ok(())
    }
}

/// True while this invocation's call is still `effect_pending` in the
/// owning tools batch.
fn owns_effect_state(state: &super::types::RuntimeLaneState, operation_id: &str, result_entry_id: &str) -> bool {
    let Some(operation) = &state.operation else { return false };
    if operation.meta.operation_id != operation_id {
        return false;
    }
    let crate::harness::session::types::OperationState::Tools { batch, .. } = &operation.state else {
        return false;
    };
    batch.calls.iter().any(|call| {
        call.result_entry_id == result_entry_id
            && call.status == crate::harness::session::types::ToolCallStatus::EffectPending
    })
}


#[derive(Debug, thiserror::Error)]
pub enum ToolMemoError {
    #[error(transparent)]
    Ended(#[from] ToolInvocationEnded),
    #[error(transparent)]
    Session(#[from] crate::harness::session::types::SessionError),
    #[error(transparent)]
    Lane(#[from] super::lane::LaneError),
    #[error("{0}")]
    Invalid(String),
}

/// Everything one tool execution receives.
pub struct ToolExecution {
    pub tool_call_id: String,
    pub args: Json,
    pub update: ToolUpdateCallback,
    pub invocation: ToolInvocationCapability,
    pub signal: crate::harness::types::AbortSignal,
}

impl ToolExecution {
    /// Report live progress; `checkpoint` also persists the partial.
    pub fn update(&self, partial: AgentToolResult, checkpoint: bool) {
        (self.update)(&partial, checkpoint);
    }
}

pub type ExecuteFn =
    Arc<dyn Fn(ToolExecution) -> BoxFuture<'static, Result<AgentToolResult, String>> + Send + Sync>;

/// A tool call whose tool exists and whose arguments passed validation.
pub struct PreparedToolCall {
    pub tool_call: ToolCall,
    pub tool: Arc<RuntimeTool>,
    pub args: Json,
}

/// Synthetic result produced without crossing the tool-effect boundary.
pub struct ImmediateToolOutcome {
    pub tool_call: ToolCall,
    pub result: AgentToolResult,
    pub is_error: bool,
    pub terminate: bool,
}

/// A prepared call cleared for durable intent publication and execution.
pub struct ClearedToolCall {
    pub tool_call: ToolCall,
    pub tool: Arc<RuntimeTool>,
    pub args: Json,
}

/// Raw phase-two tool output before after-tool patching.
pub struct ExecutedToolCall {
    pub result: AgentToolResult,
    pub is_error: bool,
}

/// Final tool output ready to become a durable tool-result message.
pub struct FinalizedToolCall {
    pub tool_call: ToolCall,
    pub result: AgentToolResult,
    pub is_error: bool,
    pub terminate: bool,
}

fn create_error_tool_result(message: impl Into<String>) -> AgentToolResult {
    AgentToolResult {
        content: vec![UserContent::Text(crate::harness::types::TextContent {
            text: message.into(),
            text_signature: None,
        })],
        details: Json::Null,
        usage: None,
        terminate: None,
    }
}

fn immediate_error(tool_call: &ToolCall, message: impl Into<String>, terminate: bool) -> ImmediateToolOutcome {
    ImmediateToolOutcome {
        tool_call: tool_call.clone(),
        result: create_error_tool_result(message),
        is_error: true,
        terminate,
    }
}

/// Resolve a tool and validate its arguments (pi `prepareToolCall`).
pub fn prepare_tool_call(call: &ToolCall, tools: &[Arc<RuntimeTool>]) -> Result<PreparedToolCall, ImmediateToolOutcome> {
    let Some(tool) = tools.iter().find(|candidate| candidate.declaration.name == call.name) else {
        return Err(immediate_error(call, format!("Tool {:?} is unavailable", call.name), false));
    };
    match validate_tool_arguments(&tool.declaration, call) {
        Ok(args) => Ok(PreparedToolCall { tool_call: call.clone(), tool: Arc::clone(tool), args }),
        Err(message) => Err(immediate_error(call, message, false)),
    }
}

/// Apply an explicit before-tool decision and revalidate replacement
/// arguments (pi `applyBeforeToolDecision`).
pub fn apply_before_tool_decision(
    prepared: PreparedToolCall,
    decision: Option<&super::hooks::BeforeToolResult>,
) -> Result<ClearedToolCall, ImmediateToolOutcome> {
    if let Some(decision) = decision {
        if let Some(block) = &decision.block {
            return Err(immediate_error(
                &prepared.tool_call,
                block.reason.clone(),
                block.terminate.unwrap_or(false),
            ));
        }
        if let Some(replacement) = &decision.args {
            let mut call = prepared.tool_call.clone();
            call.arguments = replacement.clone();
            return match validate_tool_arguments(&prepared.tool.declaration, &call) {
                Ok(args) => Ok(ClearedToolCall { tool_call: prepared.tool_call, tool: prepared.tool, args }),
                Err(message) => Err(immediate_error(&prepared.tool_call, message, false)),
            };
        }
    }
    Ok(ClearedToolCall {
        tool_call: prepared.tool_call,
        tool: prepared.tool,
        args: prepared.args,
    })
}

/// Execute one cleared external tool effect, converting expected tool
/// failures to error output (pi `executeToolCall`).
pub async fn execute_tool_call(
    call: &ClearedToolCall,
    gate: &super::effect_gate::SharedGate,
    update: ToolUpdateCallback,
    invocation: ToolInvocationCapability,
) -> Result<ExecutedToolCall, String> {
    // Admission is synchronous: an aborting gate refuses the effect.
    let execution = ToolExecution {
        tool_call_id: call.tool_call.id.clone(),
        args: call.args.clone(),
        update,
        invocation,
        signal: gate.signal().clone(),
    };
    let outcome = gate
        .admit(move || (call.tool.execute)(execution))
        .map_err(|error| error.to_string())?
        .await;
    Ok(match outcome {
        Ok(result) => ExecutedToolCall { result, is_error: false },
        Err(message) => ExecutedToolCall { result: create_error_tool_result(message), is_error: true },
    })
}

/// Apply an after-tool patch field by field (pi `finalizeToolCall`).
pub fn finalize_tool_call(
    call: &ClearedToolCall,
    executed: ExecutedToolCall,
    patch: Option<&super::hooks::AfterToolResult>,
) -> FinalizedToolCall {
    let mut result = executed.result;
    if let Some(patch) = patch {
        if let Some(content) = &patch.content {
            // The hook patch carries serialized content; pass it through as
            // structured text content.
            result.content = vec![UserContent::Text(crate::harness::types::TextContent {
                text: content.to_string(),
                text_signature: None,
            })];
        }
        if let Some(details) = &patch.details {
            result.details = details.clone();
        }
        if let Some(usage) = &patch.usage {
            result.usage = Some(usage.clone());
        }
        if let Some(terminate) = patch.terminate {
            result.terminate = Some(terminate);
        }
    }
    let is_error = patch.and_then(|patch| patch.is_error).unwrap_or(executed.is_error);
    let terminate = result.terminate.unwrap_or(false);
    FinalizedToolCall {
        tool_call: call.tool_call.clone(),
        result,
        is_error,
        terminate,
    }
}

/// Convert finalized tool output to the provider-facing transcript message
/// (pi `createToolResultMessage`).
pub fn create_tool_result_message(call: &FinalizedToolCall) -> ToolResultMessage {
    ToolResultMessage {
        tool_call_id: call.tool_call.id.clone(),
        tool_name: call.tool_call.name.clone(),
        content: call.result.content.clone(),
        details: (!call.result.details.is_null()).then(|| call.result.details.clone()),
        usage: call.result.usage.clone(),
        is_error: call.is_error,
        timestamp: now_ms(),
    }
}

/// Reconstruct the canonical tool result represented by a staged
/// transcript message (pi `toolResultFromMessage`).
pub fn tool_result_from_message(message: &ToolResultMessage, terminate: bool) -> AgentToolResult {
    AgentToolResult {
        content: message.content.clone(),
        details: message.details.clone().unwrap_or(Json::Null),
        usage: message.usage.clone(),
        terminate: terminate.then_some(true),
    }
}
