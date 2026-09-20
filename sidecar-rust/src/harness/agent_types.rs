//! Agent-level types.
//!
//! Port of pi-mono `packages/agent/src/types.ts`. The loop works on
//! [`AgentMessage`] (LLM messages plus app-defined custom messages) and only
//! narrows to `Message` at the provider boundary via `convert_to_llm`.

use std::collections::HashSet;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::{
    AbortSignal, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message, Model, StreamOptions,
    SystemMessage, ThinkingLevel, Tool, ToolCall, ToolResultMessage, TranscriptContext, Usage, UserContent,
    UserMessageContent,
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/// App-defined message that lives in the transcript but is not an LLM
/// message by itself. `convert_to_llm` decides whether (and how) the model
/// sees it. pi-coding-agent uses this for `bashExecution`, compaction
/// summaries and extension messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename = "custom", rename_all = "camelCase")]
pub struct CustomMessage {
    pub custom_type: String,
    pub content: UserMessageContent,
    /// Whether UIs should render it.
    #[serde(default)]
    pub display: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub timestamp: i64,
}

/// Union of LLM messages and custom messages (`AgentMessage`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentMessage {
    Llm(Message),
    Custom(CustomMessage),
}

impl AgentMessage {
    pub fn role(&self) -> &str {
        match self {
            AgentMessage::Llm(m) => m.role(),
            AgentMessage::Custom(_) => "custom",
        }
    }

    pub fn timestamp(&self) -> i64 {
        match self {
            AgentMessage::Llm(m) => m.timestamp(),
            AgentMessage::Custom(c) => c.timestamp,
        }
    }

    pub fn as_llm(&self) -> Option<&Message> {
        match self {
            AgentMessage::Llm(m) => Some(m),
            AgentMessage::Custom(_) => None,
        }
    }

    pub fn as_system(&self) -> Option<&SystemMessage> {
        self.as_llm().and_then(Message::as_system)
    }

    pub fn as_assistant(&self) -> Option<&AssistantMessage> {
        self.as_llm().and_then(Message::as_assistant)
    }

    pub fn is_system(&self) -> bool {
        matches!(self, AgentMessage::Llm(Message::System(_)))
    }

    pub fn is_assistant(&self) -> bool {
        matches!(self, AgentMessage::Llm(Message::Assistant(_)))
    }

    pub fn user_text(text: impl Into<String>) -> Self {
        AgentMessage::Llm(Message::user_text(text))
    }

    pub fn user_blocks(blocks: Vec<UserContent>) -> Self {
        AgentMessage::Llm(Message::user_blocks(blocks))
    }
}

impl From<Message> for AgentMessage {
    fn from(m: Message) -> Self {
        AgentMessage::Llm(m)
    }
}

impl From<AssistantMessage> for AgentMessage {
    fn from(m: AssistantMessage) -> Self {
        AgentMessage::Llm(Message::Assistant(m))
    }
}

impl From<ToolResultMessage> for AgentMessage {
    fn from(m: ToolResultMessage) -> Self {
        AgentMessage::Llm(Message::ToolResult(m))
    }
}

impl From<SystemMessage> for AgentMessage {
    fn from(m: SystemMessage) -> Self {
        AgentMessage::Llm(Message::System(m))
    }
}

/// Default `convertToLlm`: keep LLM messages, drop custom ones.
pub fn default_convert_to_llm(messages: &[AgentMessage]) -> Vec<Message> {
    messages.iter().filter_map(|m| m.as_llm().cloned()).collect()
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ToolExecutionMode {
    Sequential,
    #[default]
    Parallel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum QueueMode {
    All,
    #[default]
    OneAtATime,
}

/// Recovery policy for an effect whose durable intent exists but whose
/// outcome is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReplayPolicy {
    #[default]
    Never,
    Safe,
}

/// Final or partial result produced by a tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResult {
    /// Text or image content returned to the model.
    pub content: Vec<UserContent>,
    /// Arbitrary structured details for logs or UI rendering.
    #[serde(default)]
    pub details: Value,
    /// Usage from the tool execution itself; not counted against the main
    /// LLM context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Hint that the agent should stop after the current tool batch. Only
    /// honoured when every result in the batch sets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminate: Option<bool>,
}

impl AgentToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![UserContent::text(text)],
            details: Value::Object(Default::default()),
            usage: None,
            terminate: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self::text(message)
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    pub fn text_content(&self) -> String {
        self.content
            .iter()
            .filter_map(|c| match c {
                UserContent::Text(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Callback used by tools to stream partial execution updates. Calls made
/// after `execute` settles are ignored.
pub type AgentToolUpdateCallback = Arc<dyn Fn(AgentToolResult) + Send + Sync>;

pub type ToolFuture<'a> = BoxFuture<'a, Result<AgentToolResult, String>>;

/// Tool definition used by the agent runtime (`AgentTool`).
pub trait AgentTool: Send + Sync {
    fn name(&self) -> &str;
    /// Human-readable label for UI display.
    fn label(&self) -> &str {
        self.name()
    }
    fn description(&self) -> &str;
    /// JSON schema for the arguments object.
    fn parameters(&self) -> Value;
    /// Compatibility shim for raw tool-call arguments before validation.
    fn prepare_arguments(&self, args: Value) -> Result<Value, String> {
        Ok(args)
    }
    /// Execute the tool call. Return `Err` on failure instead of encoding
    /// errors in `content`.
    fn execute<'a>(
        &'a self,
        tool_call_id: &'a str,
        params: Value,
        signal: Option<&'a AbortSignal>,
        on_update: AgentToolUpdateCallback,
    ) -> ToolFuture<'a>;
    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Never
    }
    /// Per-tool execution mode override.
    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        None
    }
    /// Model-facing declaration.
    fn declaration(&self) -> Tool {
        Tool {
            name: self.name().to_string(),
            description: self.description().to_string(),
            parameters: self.parameters(),
        }
    }
}

pub type DynTool = Arc<dyn AgentTool>;

/// Context snapshot passed into the low-level agent loop.
#[derive(Clone, Default)]
pub struct AgentContext {
    /// Transcript visible to the model.
    pub messages: Vec<AgentMessage>,
    /// Tools available for execution in this run.
    pub tools: Vec<DynTool>,
}

impl AgentContext {
    pub fn find_tool(&self, name: &str) -> Option<&DynTool> {
        self.tools.iter().find(|t| t.name() == name)
    }

    pub fn declarations(&self) -> Vec<Tool> {
        self.tools.iter().map(|t| t.declaration()).collect()
    }
}

impl std::fmt::Debug for AgentContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentContext")
            .field("messages", &self.messages.len())
            .field("tools", &self.tools.iter().map(|t| t.name().to_string()).collect::<Vec<_>>())
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/// Result of `before_tool_call`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BeforeToolCallResult {
    /// Prevent execution; the loop emits an error tool result instead.
    pub block: bool,
    /// Text shown in that error result.
    pub reason: Option<String>,
    /// Participates in the batch early-termination rule when blocked.
    pub terminate: Option<bool>,
}

/// Partial override returned from `after_tool_call`. Field-by-field merge;
/// `None` keeps the executed value.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AfterToolCallResult {
    pub content: Option<Vec<UserContent>>,
    pub details: Option<Value>,
    pub is_error: Option<bool>,
    pub usage: Option<Usage>,
    pub terminate: Option<bool>,
}

pub struct BeforeToolCallContext<'a> {
    pub assistant_message: &'a AssistantMessage,
    pub tool_call: &'a ToolCall,
    /// Validated tool arguments.
    pub args: &'a Value,
    pub context: &'a AgentContext,
}

pub struct AfterToolCallContext<'a> {
    pub assistant_message: &'a AssistantMessage,
    pub tool_call: &'a ToolCall,
    pub args: &'a Value,
    /// Executed result before overrides.
    pub result: &'a AgentToolResult,
    pub is_error: bool,
    pub context: &'a AgentContext,
}

/// Context passed to `should_stop_after_turn` / `prepare_next_turn`.
pub struct TurnContext<'a> {
    /// The assistant message that completed the turn.
    pub message: &'a AssistantMessage,
    pub tool_results: &'a [ToolResultMessage],
    /// Context after the turn's assistant message and tool results were appended.
    pub context: &'a AgentContext,
    /// Messages this loop invocation will return if it exits here.
    pub new_messages: &'a [AgentMessage],
}

/// Replacement runtime state applied before the next provider request.
#[derive(Default)]
pub struct AgentLoopTurnUpdate {
    pub context: Option<AgentContext>,
    /// Messages to append before the next request, with normal lifecycle events.
    pub messages: Option<Vec<AgentMessage>>,
    pub model: Option<Model>,
    pub thinking_level: Option<ThinkingLevel>,
}

/// Loop callbacks (`AgentLoopConfig` function members). Every method has a
/// no-op default; implementations must not panic — return a safe fallback.
pub trait AgentHooks: Send + Sync {
    /// Convert the transcript to LLM messages before each request.
    fn convert_to_llm(&self, messages: &[AgentMessage]) -> Vec<Message> {
        default_convert_to_llm(messages)
    }

    /// Transform applied before `convert_to_llm` (pruning, injection, compaction).
    fn transform_context<'a>(
        &'a self,
        messages: Vec<AgentMessage>,
        _signal: Option<&'a AbortSignal>,
    ) -> BoxFuture<'a, Vec<AgentMessage>> {
        Box::pin(async move { messages })
    }

    /// Resolve an API key per request (short-lived tokens).
    fn get_api_key<'a>(&'a self, _provider: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }

    fn should_stop_after_turn<'a>(&'a self, _ctx: TurnContext<'a>, _signal: Option<&'a AbortSignal>) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }

    fn prepare_next_turn<'a>(
        &'a self,
        _ctx: TurnContext<'a>,
        _signal: Option<&'a AbortSignal>,
    ) -> BoxFuture<'a, Option<AgentLoopTurnUpdate>> {
        Box::pin(async { None })
    }

    fn before_tool_call<'a>(
        &'a self,
        _ctx: BeforeToolCallContext<'a>,
        _signal: Option<&'a AbortSignal>,
    ) -> BoxFuture<'a, Option<BeforeToolCallResult>> {
        Box::pin(async { None })
    }

    fn after_tool_call<'a>(
        &'a self,
        _ctx: AfterToolCallContext<'a>,
        _signal: Option<&'a AbortSignal>,
    ) -> BoxFuture<'a, Option<AfterToolCallResult>> {
        Box::pin(async { None })
    }
}

/// Hooks that do nothing.
pub struct NoHooks;
impl AgentHooks for NoHooks {}

/// Source of queued messages (steering / follow-up).
pub type MessageSource = Arc<dyn Fn() -> BoxFuture<'static, Vec<AgentMessage>> + Send + Sync>;

/// Provider stream function (`StreamFn`). Must never panic; failures are
/// encoded in the returned stream's final `Error` event.
pub type StreamFn = Arc<dyn Fn(Model, TranscriptContext, StreamOptions) -> AssistantMessageEventStream + Send + Sync>;

/// Configuration for one loop invocation (`AgentLoopConfig`).
#[derive(Clone)]
pub struct AgentLoopConfig {
    pub model: Model,
    /// Base provider options. `signal` is ignored; the loop passes its own.
    pub stream_options: StreamOptions,
    pub tool_execution: ToolExecutionMode,
    pub hooks: Arc<dyn AgentHooks>,
    pub get_steering_messages: Option<MessageSource>,
    pub get_follow_up_messages: Option<MessageSource>,
}

impl AgentLoopConfig {
    pub fn new(model: Model) -> Self {
        Self {
            model,
            stream_options: StreamOptions::default(),
            tool_execution: ToolExecutionMode::Parallel,
            hooks: Arc::new(NoHooks),
            get_steering_messages: None,
            get_follow_up_messages: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Events emitted by the agent for UI updates. `AgentEnd` is always last.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    AgentStart,
    AgentEnd {
        messages: Vec<AgentMessage>,
    },
    /// One assistant response plus its tool calls/results.
    TurnStart,
    TurnEnd {
        message: AgentMessage,
        #[serde(rename = "toolResults")]
        tool_results: Vec<ToolResultMessage>,
    },
    MessageStart {
        message: AgentMessage,
    },
    /// Only for assistant messages during streaming.
    MessageUpdate {
        message: AgentMessage,
        #[serde(rename = "assistantMessageEvent")]
        assistant_message_event: AssistantMessageEvent,
    },
    MessageEnd {
        message: AgentMessage,
    },
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
    },
    ToolExecutionUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
        #[serde(rename = "partialResult")]
        partial_result: AgentToolResult,
    },
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        result: AgentToolResult,
        #[serde(rename = "isError")]
        is_error: bool,
    },
}

impl AgentEvent {
    pub fn kind(&self) -> &'static str {
        match self {
            AgentEvent::AgentStart => "agent_start",
            AgentEvent::AgentEnd { .. } => "agent_end",
            AgentEvent::TurnStart => "turn_start",
            AgentEvent::TurnEnd { .. } => "turn_end",
            AgentEvent::MessageStart { .. } => "message_start",
            AgentEvent::MessageUpdate { .. } => "message_update",
            AgentEvent::MessageEnd { .. } => "message_end",
            AgentEvent::ToolExecutionStart { .. } => "tool_execution_start",
            AgentEvent::ToolExecutionUpdate { .. } => "tool_execution_update",
            AgentEvent::ToolExecutionEnd { .. } => "tool_execution_end",
        }
    }
}

/// Event sink awaited by the loop for every event (`AgentEventSink`).
pub type AgentEventSink = Arc<dyn Fn(AgentEvent) -> BoxFuture<'static, ()> + Send + Sync>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Public agent state (`AgentState`).
#[derive(Clone)]
pub struct AgentState {
    pub model: Model,
    pub thinking_level: ThinkingLevel,
    pub tools: Vec<DynTool>,
    /// Transcript; system messages carry the prompt and tool declarations.
    pub messages: Vec<AgentMessage>,
    pub is_streaming: bool,
    pub streaming_message: Option<AgentMessage>,
    pub pending_tool_calls: HashSet<String>,
    pub error_message: Option<String>,
}

impl AgentState {
    /// Current system prompt, replayed from the transcript's system messages.
    pub fn system_prompt(&self) -> String {
        let llm = default_convert_to_llm(&self.messages);
        super::transcript::get_current_system_prompt(&llm)
    }
}

impl std::fmt::Debug for AgentState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentState")
            .field("model", &self.model.id)
            .field("thinking_level", &self.thinking_level)
            .field("tools", &self.tools.iter().map(|t| t.name().to_string()).collect::<Vec<_>>())
            .field("messages", &self.messages.len())
            .field("is_streaming", &self.is_streaming)
            .field("pending_tool_calls", &self.pending_tool_calls)
            .field("error_message", &self.error_message)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_message_round_trips_custom_and_llm() {
        let custom = AgentMessage::Custom(CustomMessage {
            custom_type: "bashExecution".into(),
            content: UserMessageContent::Text("ls".into()),
            display: true,
            details: None,
            timestamp: 1,
        });
        let json = serde_json::to_value(&custom).unwrap();
        assert_eq!(json["role"], "custom");
        assert_eq!(json["customType"], "bashExecution");
        let back: AgentMessage = serde_json::from_value(json).unwrap();
        assert_eq!(back, custom);

        let user = AgentMessage::user_text("hi");
        let json = serde_json::to_value(&user).unwrap();
        assert_eq!(json["role"], "user");
        let back: AgentMessage = serde_json::from_value(json).unwrap();
        assert!(matches!(back, AgentMessage::Llm(Message::User(_))));
    }

    #[test]
    fn event_serializes_with_snake_case_type() {
        let ev = AgentEvent::ToolExecutionStart {
            tool_call_id: "1".into(),
            tool_name: "read".into(),
            args: serde_json::json!({}),
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "tool_execution_start");
        assert_eq!(json["toolCallId"], "1");
    }
}
