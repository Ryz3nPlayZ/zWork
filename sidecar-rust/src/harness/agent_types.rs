//! Agent-level types.
//!
//! Port of pi-mono `packages/agent/src/types.ts`. The loop works on
//! [`AgentMessage`] (LLM messages plus app-defined custom messages) and only
//! narrows to `Message` at the provider boundary via `convert_to_llm`.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::{
    AbortSignal, AssistantMessage, AssistantMessageEventStream, Message, Model, StreamOptions,
    SystemMessage, Tool, ToolResultMessage, TranscriptContext, Usage, UserContent,
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
    /// One-line summary for the system prompt's tool list (pi `promptSnippet`).
    fn prompt_snippet(&self) -> Option<&str> {
        None
    }
    /// Usage guidelines for the system prompt (pi `promptGuidelines`).
    fn prompt_guidelines(&self) -> Vec<String> {
        Vec::new()
    }
}

pub type DynTool = Arc<dyn AgentTool>;


/// Provider stream function (`StreamFn`). Must never panic; failures are
/// encoded in the returned stream's final `Error` event.
pub type StreamFn = Arc<dyn Fn(Model, TranscriptContext, StreamOptions) -> AssistantMessageEventStream + Send + Sync>;
