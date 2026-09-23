//! Core message / tool / model / event types.
//!
//! Rust port of pi-mono `packages/ai/src/types.ts` and the agent-side types in
//! `packages/agent/src/types.ts`. Field names serialize as camelCase so the
//! JSON shapes match pi byte-for-byte (traces, session dumps, tests).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

/// Cooperative cancellation handle. Mirrors the `AbortSignal` the TS code
/// threads through every layer: cheap to clone, check with [`is_aborted`],
/// await with [`cancelled`].
///
/// [`is_aborted`]: AbortSignal::is_aborted
/// [`cancelled`]: AbortSignal::cancelled
#[derive(Clone, Default, Debug)]
pub struct AbortSignal {
    inner: Arc<AbortInner>,
}

#[derive(Default, Debug)]
struct AbortInner {
    flag: AtomicBool,
    notify: Notify,
}

impl AbortSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn abort(&self) {
        self.inner.flag.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_aborted(&self) -> bool {
        self.inner.flag.load(Ordering::SeqCst)
    }

    /// Resolves once [`abort`](AbortSignal::abort) is called. Resolves
    /// immediately if already aborted.
    pub async fn cancelled(&self) {
        if self.is_aborted() {
            return;
        }
        let notified = self.inner.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_aborted() {
            return;
        }
        notified.await;
    }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/// Wire protocol a model speaks. pi has more (responses, bedrock, gemini…);
/// zWork ships the two its gateway fronts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
pub enum Api {
    #[serde(rename = "openai-completions")]
    OpenAICompletions,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
}

impl Api {
    pub fn as_str(&self) -> &'static str {
        match self {
            Api::OpenAICompletions => "openai-completions",
            Api::AnthropicMessages => "anthropic-messages",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum InputType {
    Text,
    Image,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ThinkingLevel {
    pub const ALL: [ThinkingLevel; 7] = [
        ThinkingLevel::Off,
        ThinkingLevel::Minimal,
        ThinkingLevel::Low,
        ThinkingLevel::Medium,
        ThinkingLevel::High,
        ThinkingLevel::Xhigh,
        ThinkingLevel::Max,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            ThinkingLevel::Off => "off",
            ThinkingLevel::Minimal => "minimal",
            ThinkingLevel::Low => "low",
            ThinkingLevel::Medium => "medium",
            ThinkingLevel::High => "high",
            ThinkingLevel::Xhigh => "xhigh",
            ThinkingLevel::Max => "max",
        }
    }

    pub fn parse(s: &str) -> Option<ThinkingLevel> {
        Self::ALL.iter().copied().find(|l| l.as_str() == s)
    }
}

/// Per-million-token prices.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    /// Tiered pricing above an input-token threshold (Gemini/Anthropic long-context).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiers: Vec<ModelCostTier>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCostTier {
    pub input_tokens_above: u64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// Value a thinking level maps to on the wire. `None` (JSON `null`) means
/// "omit the field entirely for this level".
pub type ThinkingLevelMap = BTreeMap<String, Option<String>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaxTokensField {
    MaxTokens,
    MaxCompletionTokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThinkingFormat {
    Openai,
    Openrouter,
    Deepseek,
    Together,
    Baseten,
    Zai,
    Qwen,
    ChatTemplate,
    QwenChatTemplate,
    StringThinking,
    AntLing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheControlFormat {
    Anthropic,
}

/// Compatibility knobs for OpenAI-compatible endpoints. Every field is
/// optional: unset ones fall back to URL/provider auto-detection
/// (`providers::openai_completions::detect_compat`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAICompletionsCompat {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_store: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_developer_role: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning_effort: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_usage_in_streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_finish_reason: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens_field: Option<MaxTokensField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_tool_result_name: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_assistant_after_tool_result: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_thinking_as_text: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_reasoning_content_on_assistant_messages: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_format: Option<ThinkingFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_router_routing: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zai_tool_stream: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_strict_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_mid_convo_system_messages: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_mid_convo_tool_additions: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control_format: Option<CacheControlFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_session_affinity_headers: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_long_cache_retention: Option<bool>,

    // --- anthropic-messages only (pi `AnthropicMessagesCompat`) ---
    /// Adaptive thinking (`thinking: {type: "adaptive"}` + `output_config.effort`)
    /// instead of budget-based thinking. True for Claude 4.7+ / 5.x.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_adaptive_thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_eager_tool_input_streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_cache_control_on_tools: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_temperature: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_empty_signature: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_strict_tools: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub api: Api,
    pub provider: String,
    pub base_url: String,
    pub reasoning: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<ThinkingLevelMap>,
    pub input: Vec<InputType>,
    pub cost: ModelCost,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache: Option<bool>,
    pub context_window: u64,
    pub max_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<OpenAICompletionsCompat>,
}

impl Model {
    pub fn supports_images(&self) -> bool {
        self.input.contains(&InputType::Image)
    }

    /// `getSupportedThinkingLevels`: non-reasoning models only support "off";
    /// reasoning models support every level unless a `thinkingLevelMap`
    /// narrows it.
    pub fn supported_thinking_levels(&self) -> Vec<ThinkingLevel> {
        if !self.reasoning {
            return vec![ThinkingLevel::Off];
        }
        match &self.thinking_level_map {
            None => ThinkingLevel::ALL.to_vec(),
            Some(map) => {
                let mut out = vec![ThinkingLevel::Off];
                for l in ThinkingLevel::ALL.iter().skip(1) {
                    if map.contains_key(l.as_str()) {
                        out.push(*l);
                    }
                }
                out
            }
        }
    }

    /// `clampThinkingLevel`: snap a requested level to the nearest supported
    /// one (upwards first, then downwards).
    pub fn clamp_thinking_level(&self, level: ThinkingLevel) -> ThinkingLevel {
        let available = self.supported_thinking_levels();
        if available.contains(&level) {
            return level;
        }
        let idx = ThinkingLevel::ALL.iter().position(|l| *l == level).unwrap_or(0);
        for candidate in ThinkingLevel::ALL.iter().skip(idx) {
            if available.contains(candidate) {
                return *candidate;
            }
        }
        for candidate in ThinkingLevel::ALL.iter().take(idx).rev() {
            if available.contains(candidate) {
                return *candidate;
            }
        }
        available.first().copied().unwrap_or(ThinkingLevel::Off)
    }

    /// Wire value for a thinking level after applying `thinkingLevelMap`.
    /// `Some(None)` = explicitly mapped to null (omit); `None` = unmapped.
    pub fn mapped_thinking_level(&self, level: ThinkingLevel) -> Option<Option<String>> {
        self.thinking_level_map
            .as_ref()
            .and_then(|m| m.get(level.as_str()).cloned())
    }
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextContent {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingContent {
    pub thinking: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageContent {
    /// Base64 payload.
    pub data: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

/// User-visible input content: text or image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserContent {
    Text(TextContent),
    Image(ImageContent),
}

impl UserContent {
    pub fn text(s: impl Into<String>) -> Self {
        UserContent::Text(TextContent {
            text: s.into(),
            text_signature: None,
        })
    }
}

/// Assistant output content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AssistantContent {
    Text(TextContent),
    Thinking(ThinkingContent),
    ToolCall(ToolCall),
}

impl AssistantContent {
    pub fn as_text(&self) -> Option<&TextContent> {
        match self {
            AssistantContent::Text(t) => Some(t),
            _ => None,
        }
    }
    pub fn as_thinking(&self) -> Option<&ThinkingContent> {
        match self {
            AssistantContent::Thinking(t) => Some(t),
            _ => None,
        }
    }
    pub fn as_tool_call(&self) -> Option<&ToolCall> {
        match self {
            AssistantContent::ToolCall(t) => Some(t),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/// `string | (Text|Image)[]` in TS. Kept as an enum so serialized transcripts
/// stay identical to pi's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserMessageContent {
    Text(String),
    Blocks(Vec<UserContent>),
}

impl UserMessageContent {
    pub fn text(&self) -> String {
        match self {
            UserMessageContent::Text(s) => s.clone(),
            UserMessageContent::Blocks(b) => b
                .iter()
                .filter_map(|c| match c {
                    UserContent::Text(t) => Some(t.text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMessage {
    pub content: String,
    /// Named sections patched by later system messages (`null` removes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<BTreeMap<String, Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_added: Option<Vec<Tool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_removed: Option<Vec<ToolReference>>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub content: UserMessageContent,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Pending,
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
    Deferred,
}

impl StopReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            StopReason::Pending => "pending",
            StopReason::Stop => "stop",
            StopReason::Length => "length",
            StopReason::ToolUse => "toolUse",
            StopReason::Error => "error",
            StopReason::Aborted => "aborted",
            StopReason::Deferred => "deferred",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_1h: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
    pub total_tokens: u64,
    pub cost: UsageCost,
}

impl Usage {
    /// `emptyUsage` from pi `harness/utils/usage.ts`.
    pub fn empty() -> Usage {
        Usage::default()
    }

    /// `addUsage` from pi `harness/utils/usage.ts` — field-wise sum. The
    /// optional fields (`cache_write_1h`, `reasoning`) stay `None` only when
    /// both sides are `None`, so merging never invents a zero the provider
    /// never reported.
    pub fn add(&self, other: &Usage) -> Usage {
        let or_sum = |l: Option<u64>, r: Option<u64>| match (l, r) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        };
        Usage {
            input: self.input + other.input,
            output: self.output + other.output,
            cache_read: self.cache_read + other.cache_read,
            cache_write: self.cache_write + other.cache_write,
            cache_write_1h: or_sum(self.cache_write_1h, other.cache_write_1h),
            reasoning: or_sum(self.reasoning, other.reasoning),
            total_tokens: self.total_tokens + other.total_tokens,
            cost: UsageCost {
                input: self.cost.input + other.cost.input,
                output: self.cost.output + other.cost.output,
                cache_read: self.cost.cache_read + other.cost.cache_read,
                cache_write: self.cost.cache_write + other.cost.cache_write,
                total: self.cost.total + other.cost.total,
            },
        }
    }

    /// `calculateCost` from pi-ai `models.ts`.
    pub fn calculate_cost(&mut self, model: &Model) {
        let input_tokens = self.input + self.cache_read + self.cache_write;
        let mut rates = (
            model.cost.input,
            model.cost.output,
            model.cost.cache_read,
            model.cost.cache_write,
        );
        let mut matched: i128 = -1;
        for tier in &model.cost.tiers {
            if input_tokens > tier.input_tokens_above && (tier.input_tokens_above as i128) > matched {
                rates = (tier.input, tier.output, tier.cache_read, tier.cache_write);
                matched = tier.input_tokens_above as i128;
            }
        }
        let long_write = self.cache_write_1h.unwrap_or(0) as f64;
        let short_write = self.cache_write as f64 - long_write;
        self.cost.input = rates.0 / 1_000_000.0 * self.input as f64;
        self.cost.output = rates.1 / 1_000_000.0 * self.output as f64;
        self.cost.cache_read = rates.2 / 1_000_000.0 * self.cache_read as f64;
        self.cost.cache_write = (rates.3 * short_write + rates.0 * 2.0 * long_write) / 1_000_000.0;
        self.cost.total = self.cost.input + self.cost.output + self.cost.cache_read + self.cost.cache_write;
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub content: Vec<AssistantContent>,
    pub api: Api,
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    pub usage: Usage,
    pub stop_reason: StopReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_turn: Option<bool>,
    pub timestamp: i64,
}

impl AssistantMessage {
    pub fn pending(model: &Model) -> Self {
        AssistantMessage {
            content: Vec::new(),
            api: model.api,
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: StopReason::Pending,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: now_ms(),
        }
    }

    pub fn tool_calls(&self) -> Vec<&ToolCall> {
        self.content.iter().filter_map(|c| c.as_tool_call()).collect()
    }

    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|c| c.as_text().map(|t| t.text.as_str()))
            .collect::<Vec<_>>()
            .join("")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultMessage {
    pub tool_call_id: String,
    pub tool_name: String,
    pub content: Vec<UserContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    pub is_error: bool,
    pub timestamp: i64,
}

impl ToolResultMessage {
    pub fn text(&self) -> String {
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum Message {
    System(SystemMessage),
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
}

impl Message {
    pub fn role(&self) -> &'static str {
        match self {
            Message::System(_) => "system",
            Message::User(_) => "user",
            Message::Assistant(_) => "assistant",
            Message::ToolResult(_) => "toolResult",
        }
    }

    pub fn user_text(text: impl Into<String>) -> Self {
        Message::User(UserMessage {
            content: UserMessageContent::Text(text.into()),
            timestamp: now_ms(),
        })
    }

    pub fn user_blocks(blocks: Vec<UserContent>) -> Self {
        Message::User(UserMessage {
            content: UserMessageContent::Blocks(blocks),
            timestamp: now_ms(),
        })
    }

    pub fn as_user(&self) -> Option<&UserMessage> {
        match self {
            Message::User(m) => Some(m),
            _ => None,
        }
    }

    pub fn as_assistant(&self) -> Option<&AssistantMessage> {
        match self {
            Message::Assistant(m) => Some(m),
            _ => None,
        }
    }

    pub fn as_system(&self) -> Option<&SystemMessage> {
        match self {
            Message::System(m) => Some(m),
            _ => None,
        }
    }

    pub fn timestamp(&self) -> i64 {
        match self {
            Message::System(m) => m.timestamp,
            Message::User(m) => m.timestamp,
            Message::Assistant(m) => m.timestamp,
            Message::ToolResult(m) => m.timestamp,
        }
    }
}

/// Transcript whose system prompt and tools live in leading/mid system
/// messages (the output of `transcript::normalize_context`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TranscriptContext {
    pub messages: Vec<Message>,
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// JSON schema object for the arguments.
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolReference {
    pub name: String,
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

/// Events emitted by a provider stream. `partial` carries the in-progress
/// assistant message so consumers can render without replaying deltas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantMessageEvent {
    Start {
        partial: AssistantMessage,
    },
    TextStart {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        partial: AssistantMessage,
    },
    TextDelta {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    TextEnd {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        content: String,
        partial: AssistantMessage,
    },
    ThinkingStart {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        partial: AssistantMessage,
    },
    ThinkingDelta {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    ThinkingEnd {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        content: String,
        partial: AssistantMessage,
    },
    ToolcallStart {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        partial: AssistantMessage,
    },
    ToolcallDelta {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    ToolcallEnd {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        #[serde(rename = "toolCall")]
        tool_call: ToolCall,
        partial: AssistantMessage,
    },
    Done {
        reason: StopReason,
        message: AssistantMessage,
    },
    Error {
        reason: StopReason,
        error: AssistantMessage,
    },
}

impl AssistantMessageEvent {
    pub fn kind(&self) -> &'static str {
        match self {
            AssistantMessageEvent::Start { .. } => "start",
            AssistantMessageEvent::TextStart { .. } => "text_start",
            AssistantMessageEvent::TextDelta { .. } => "text_delta",
            AssistantMessageEvent::TextEnd { .. } => "text_end",
            AssistantMessageEvent::ThinkingStart { .. } => "thinking_start",
            AssistantMessageEvent::ThinkingDelta { .. } => "thinking_delta",
            AssistantMessageEvent::ThinkingEnd { .. } => "thinking_end",
            AssistantMessageEvent::ToolcallStart { .. } => "toolcall_start",
            AssistantMessageEvent::ToolcallDelta { .. } => "toolcall_delta",
            AssistantMessageEvent::ToolcallEnd { .. } => "toolcall_end",
            AssistantMessageEvent::Done { .. } => "done",
            AssistantMessageEvent::Error { .. } => "error",
        }
    }

    /// The partial/final assistant message carried by every event.
    pub fn partial(&self) -> &AssistantMessage {
        match self {
            AssistantMessageEvent::Start { partial }
            | AssistantMessageEvent::TextStart { partial, .. }
            | AssistantMessageEvent::TextDelta { partial, .. }
            | AssistantMessageEvent::TextEnd { partial, .. }
            | AssistantMessageEvent::ThinkingStart { partial, .. }
            | AssistantMessageEvent::ThinkingDelta { partial, .. }
            | AssistantMessageEvent::ThinkingEnd { partial, .. }
            | AssistantMessageEvent::ToolcallStart { partial, .. }
            | AssistantMessageEvent::ToolcallDelta { partial, .. }
            | AssistantMessageEvent::ToolcallEnd { partial, .. } => partial,
            AssistantMessageEvent::Done { message, .. } => message,
            AssistantMessageEvent::Error { error, .. } => error,
        }
    }
}

/// Receiver side of a provider stream. The last event is always `Done` or
/// `Error`; after it the channel closes.
pub type AssistantMessageEventStream = tokio::sync::mpsc::Receiver<AssistantMessageEvent>;

/// Options common to every provider (`SimpleStreamOptions`).
#[derive(Clone, Default)]
pub struct StreamOptions {
    pub api_key: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
    pub reasoning: Option<ThinkingLevel>,
    pub signal: Option<AbortSignal>,
    pub max_retries: u32,
    pub max_retry_delay_ms: Option<u64>,
    pub session_id: Option<String>,
    /// "none" | "short" | "long" — prompt cache retention hint.
    pub cache_retention: Option<String>,
    /// Extra keys merged into the request body last (pi `samplingParams`).
    pub sampling_params: Option<serde_json::Map<String, Value>>,
    /// Observability: called with the request body before sending.
    pub on_payload: Option<Arc<dyn Fn(&Value) + Send + Sync>>,
}

impl std::fmt::Debug for StreamOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamOptions")
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("headers", &self.headers.keys().collect::<Vec<_>>())
            .field("temperature", &self.temperature)
            .field("max_tokens", &self.max_tokens)
            .field("reasoning", &self.reasoning)
            .field("max_retries", &self.max_retries)
            .field("max_retry_delay_ms", &self.max_retry_delay_ms)
            .field("session_id", &self.session_id)
            .field("cache_retention", &self.cache_retention)
            .field("sampling_params", &self.sampling_params)
            .field("on_payload", &self.on_payload.is_some())
            .finish()
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_serializes_like_pi() {
        let m = Message::user_text("hi");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["role"], "user");
        assert_eq!(v["content"], "hi");

        let tr = Message::ToolResult(ToolResultMessage {
            tool_call_id: "c1".into(),
            tool_name: "read".into(),
            content: vec![UserContent::text("ok")],
            details: None,
            usage: None,
            is_error: false,
            timestamp: 1,
        });
        let v = serde_json::to_value(&tr).unwrap();
        assert_eq!(v["role"], "toolResult");
        assert_eq!(v["toolCallId"], "c1");
        assert_eq!(v["isError"], false);
        assert_eq!(v["content"][0]["type"], "text");

        let ac = AssistantContent::ToolCall(ToolCall {
            id: "1".into(),
            name: "x".into(),
            arguments: serde_json::json!({}),
            thought_signature: None,
            namespace: None,
        });
        assert_eq!(serde_json::to_value(&ac).unwrap()["type"], "toolCall");
    }

    #[test]
    fn stop_reason_round_trip() {
        let v = serde_json::to_value(StopReason::ToolUse).unwrap();
        assert_eq!(v, "toolUse");
        let s: StopReason = serde_json::from_value(v).unwrap();
        assert_eq!(s, StopReason::ToolUse);
    }

    #[test]
    fn clamp_thinking_level() {
        let mut m = Model {
            id: "m".into(),
            name: "m".into(),
            api: Api::OpenAICompletions,
            provider: "p".into(),
            base_url: "https://x".into(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![InputType::Text],
            cost: ModelCost::default(),
            prompt_cache: None,
            context_window: 100_000,
            max_tokens: 8_000,
            headers: None,
            compat: None,
        };
        assert_eq!(m.clamp_thinking_level(ThinkingLevel::Xhigh), ThinkingLevel::Xhigh);
        let mut map = ThinkingLevelMap::new();
        map.insert("low".into(), Some("low".into()));
        map.insert("high".into(), Some("high".into()));
        m.thinking_level_map = Some(map);
        assert_eq!(m.clamp_thinking_level(ThinkingLevel::Medium), ThinkingLevel::High);
        assert_eq!(m.clamp_thinking_level(ThinkingLevel::Max), ThinkingLevel::High);
        m.reasoning = false;
        assert_eq!(m.clamp_thinking_level(ThinkingLevel::High), ThinkingLevel::Off);
    }

    #[test]
    fn cost_calculation() {
        let m = Model {
            id: "m".into(),
            name: "m".into(),
            api: Api::OpenAICompletions,
            provider: "p".into(),
            base_url: "https://x".into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![InputType::Text],
            cost: ModelCost {
                input: 1.0,
                output: 2.0,
                cache_read: 0.1,
                cache_write: 1.25,
                tiers: vec![],
            },
            prompt_cache: None,
            context_window: 1,
            max_tokens: 1,
            headers: None,
            compat: None,
        };
        let mut u = Usage {
            input: 1_000_000,
            output: 500_000,
            cache_read: 1_000_000,
            cache_write: 0,
            ..Default::default()
        };
        u.calculate_cost(&m);
        assert!((u.cost.input - 1.0).abs() < 1e-9);
        assert!((u.cost.output - 1.0).abs() < 1e-9);
        assert!((u.cost.cache_read - 0.1).abs() < 1e-9);
        assert!((u.cost.total - 2.1).abs() < 1e-9);
    }

    #[tokio::test]
    async fn abort_signal_wakes_waiters() {
        let s = AbortSignal::new();
        let s2 = s.clone();
        let h = tokio::spawn(async move {
            s2.cancelled().await;
            true
        });
        tokio::task::yield_now().await;
        s.abort();
        assert!(h.await.unwrap());
        assert!(s.is_aborted());
    }
}
