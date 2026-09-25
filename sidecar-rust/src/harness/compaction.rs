//! Port of pi `core/compaction/{compaction.ts, utils.ts}`.
//!
//! pi runs compaction over a tree of session entries; zWork's harness keeps
//! a flat `Vec<AgentMessage>`, so the "compaction entry" becomes a
//! `compactionSummary` custom message (see [`crate::harness::messages`])
//! and entry indices become message indices. The algorithms — cut-point
//! search, split-turn handling, iterative summary updates, file-operation
//! tracking — are otherwise unchanged.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::harness::agent_types::{AgentMessage, StreamFn};
use crate::harness::messages::{
    compaction_summary_text, convert_to_llm, create_compaction_summary_message, is_compaction_summary,
};
use crate::harness::transcript::{get_current_system_message, normalize_context};
use crate::harness::types::{
    AbortSignal, AssistantContent, AssistantMessage, AssistantMessageEvent, Message, Model, StopReason, StreamOptions,
    ThinkingLevel, Usage, UserContent, UserMessageContent,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSettings {
    pub enabled: bool,
    /// Tokens kept free below the context window for the next response.
    pub reserve_tokens: u64,
    /// Approximate number of recent tokens preserved verbatim.
    pub keep_recent_tokens: u64,
}

impl Default for CompactionSettings {
    fn default() -> Self {
        DEFAULT_COMPACTION_SETTINGS
    }
}

pub const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = CompactionSettings {
    enabled: true,
    reserve_tokens: 16384,
    keep_recent_tokens: 20000,
};

// ---------------------------------------------------------------------------
// Token calculation
// ---------------------------------------------------------------------------

/// `calculateContextTokens`: native total when present, else the sum.
pub fn calculate_context_tokens(usage: &Usage) -> u64 {
    if usage.total_tokens > 0 {
        usage.total_tokens
    } else {
        usage.input + usage.output + usage.cache_read + usage.cache_write
    }
}

/// Usage of an assistant message, unless it was aborted/errored/empty.
fn assistant_usage(message: &AgentMessage) -> Option<&Usage> {
    let a = message.as_assistant()?;
    if matches!(a.stop_reason, StopReason::Aborted | StopReason::Error) {
        return None;
    }
    (calculate_context_tokens(&a.usage) > 0).then_some(&a.usage)
}

pub fn get_last_assistant_usage(messages: &[AgentMessage]) -> Option<&Usage> {
    messages.iter().rev().find_map(assistant_usage)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextUsageEstimate {
    pub tokens: u64,
    pub usage_tokens: u64,
    pub trailing_tokens: u64,
    pub last_usage_index: Option<usize>,
}

/// `estimateContextTokens`: last reported usage plus chars/4 for whatever
/// came after it; pure estimate when no usage is available.
pub fn estimate_context_tokens(messages: &[AgentMessage]) -> ContextUsageEstimate {
    let last = messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, m)| assistant_usage(m).map(|u| (i, u)));
    match last {
        None => {
            let tokens = messages.iter().map(estimate_tokens).sum();
            ContextUsageEstimate {
                tokens,
                usage_tokens: 0,
                trailing_tokens: tokens,
                last_usage_index: None,
            }
        }
        Some((idx, usage)) => {
            let usage_tokens = calculate_context_tokens(usage);
            let trailing_tokens = messages[idx + 1..].iter().map(estimate_tokens).sum();
            ContextUsageEstimate {
                tokens: usage_tokens + trailing_tokens,
                usage_tokens,
                trailing_tokens,
                last_usage_index: Some(idx),
            }
        }
    }
}

/// `shouldCompact`.
pub fn should_compact(context_tokens: u64, context_window: u64, settings: &CompactionSettings) -> bool {
    if !settings.enabled {
        return false;
    }
    context_tokens > context_window.saturating_sub(settings.reserve_tokens)
}

// ---------------------------------------------------------------------------
// Cut point detection
// ---------------------------------------------------------------------------

const ESTIMATED_IMAGE_CHARS: usize = 4800;

fn user_content_chars(content: &UserMessageContent) -> usize {
    match content {
        UserMessageContent::Text(t) => t.len(),
        UserMessageContent::Blocks(blocks) => blocks_chars(blocks),
    }
}

fn blocks_chars(blocks: &[UserContent]) -> usize {
    blocks
        .iter()
        .map(|b| match b {
            UserContent::Text(t) => t.text.len(),
            UserContent::Image(_) => ESTIMATED_IMAGE_CHARS,
        })
        .sum()
}

fn ceil_div4(chars: usize) -> u64 {
    ((chars + 3) / 4) as u64
}

/// `estimateTokens`: chars/4, conservative. System messages count as 0
/// (they are prompt state, not conversation).
pub fn estimate_tokens(message: &AgentMessage) -> u64 {
    match message {
        AgentMessage::Llm(Message::User(u)) => ceil_div4(user_content_chars(&u.content)),
        AgentMessage::Llm(Message::Assistant(a)) => {
            let chars: usize = a
                .content
                .iter()
                .map(|b| match b {
                    AssistantContent::Text(t) => t.text.len(),
                    AssistantContent::Thinking(t) => t.thinking.len(),
                    AssistantContent::ToolCall(c) => c.name.len() + c.arguments.to_string().len(),
                })
                .sum();
            ceil_div4(chars)
        }
        AgentMessage::Llm(Message::ToolResult(r)) => ceil_div4(blocks_chars(&r.content)),
        AgentMessage::Llm(Message::System(_)) => 0,
        AgentMessage::Custom(c) => {
            if let Some(summary) = compaction_summary_text(message) {
                ceil_div4(summary.len())
            } else {
                ceil_div4(user_content_chars(&c.content))
            }
        }
    }
}

/// Messages we may cut at: anything but tool results (which must follow
/// their tool call) and system messages (prompt state).
fn is_cut_point_message(message: &AgentMessage) -> bool {
    match message {
        AgentMessage::Llm(Message::User(_)) | AgentMessage::Llm(Message::Assistant(_)) => true,
        AgentMessage::Llm(Message::ToolResult(_)) | AgentMessage::Llm(Message::System(_)) => false,
        AgentMessage::Custom(_) => true,
    }
}

/// Messages that begin a turn (user-like input).
fn is_turn_start_message(message: &AgentMessage) -> bool {
    match message {
        AgentMessage::Llm(Message::User(_)) | AgentMessage::Custom(_) => true,
        _ => false,
    }
}

/// `findTurnStartIndex`: nearest turn start at or before `index`, not
/// before `start`.
pub fn find_turn_start_index(messages: &[AgentMessage], index: usize, start: usize) -> Option<usize> {
    (start..=index).rev().find(|&i| is_turn_start_message(&messages[i]))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CutPointResult {
    /// Index of the first message to keep.
    pub first_kept_index: usize,
    /// User-like message that starts the turn being split, when splitting.
    pub turn_start_index: Option<usize>,
    /// Whether the cut lands in the middle of a turn.
    pub is_split_turn: bool,
}

/// `findCutPoint`: walk backwards from newest accumulating estimated sizes;
/// cut at the closest valid cut point once `keep_recent_tokens` is reached.
/// Only considers `[start, end)`.
pub fn find_cut_point(messages: &[AgentMessage], start: usize, end: usize, keep_recent_tokens: u64) -> CutPointResult {
    let cut_points: Vec<usize> = (start..end)
        .filter(|&i| !is_compaction_summary(&messages[i]) && is_cut_point_message(&messages[i]))
        .collect();

    if cut_points.is_empty() {
        return CutPointResult {
            first_kept_index: start,
            turn_start_index: None,
            is_split_turn: false,
        };
    }

    let mut accumulated: u64 = 0;
    let mut cut_index = cut_points[0];
    for i in (start..end).rev() {
        let tokens = estimate_tokens(&messages[i]);
        if tokens == 0 {
            continue;
        }
        accumulated += tokens;
        if accumulated >= keep_recent_tokens {
            // Prefer the closest valid cut point at or after this message. If
            // trailing tool results alone exceed the budget, keep their
            // preceding assistant tool call instead of the first message.
            cut_index = cut_points
                .iter()
                .copied()
                .find(|&c| c >= i)
                .unwrap_or(*cut_points.last().unwrap());
            break;
        }
    }

    // pi also scans back over context-invisible metadata entries here; the
    // flat transcript has none, every message is context.

    let starts_turn = is_turn_start_message(&messages[cut_index]);
    let turn_start_index = if starts_turn {
        None
    } else {
        find_turn_start_index(messages, cut_index, start)
    };

    CutPointResult {
        first_kept_index: cut_index,
        is_split_turn: !starts_turn && turn_start_index.is_some(),
        turn_start_index,
    }
}

// ---------------------------------------------------------------------------
// File operation tracking
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileOperations {
    pub read: BTreeSet<String>,
    pub written: BTreeSet<String>,
    pub edited: BTreeSet<String>,
}

/// `extractFileOpsFromMessage`: read/write/edit tool calls with a string
/// `path` argument.
pub fn extract_file_ops_from_message(message: &AgentMessage, ops: &mut FileOperations) {
    let Some(a) = message.as_assistant() else { return };
    for block in &a.content {
        let AssistantContent::ToolCall(call) = block else { continue };
        let Some(path) = call.arguments.get("path").and_then(Value::as_str) else { continue };
        match call.name.as_str() {
            "read" => {
                ops.read.insert(path.to_string());
            }
            "write" => {
                ops.written.insert(path.to_string());
            }
            "edit" => {
                ops.edited.insert(path.to_string());
            }
            _ => {}
        }
    }
}

/// `computeFileLists`: read-only files vs modified files, both sorted.
pub fn compute_file_lists(ops: &FileOperations) -> (Vec<String>, Vec<String>) {
    let modified: BTreeSet<&String> = ops.edited.iter().chain(ops.written.iter()).collect();
    let read_files = ops.read.iter().filter(|f| !modified.contains(f)).cloned().collect();
    let modified_files = modified.into_iter().cloned().collect();
    (read_files, modified_files)
}

/// `formatFileOperations`: XML tags appended to the summary.
pub fn format_file_operations(read_files: &[String], modified_files: &[String]) -> String {
    let mut sections = Vec::new();
    if !read_files.is_empty() {
        sections.push(format!("<read-files>\n{}\n</read-files>", read_files.join("\n")));
    }
    if !modified_files.is_empty() {
        sections.push(format!("<modified-files>\n{}\n</modified-files>", modified_files.join("\n")));
    }
    if sections.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", sections.join("\n\n"))
    }
}

/// Seed file ops from a previous compaction summary's details.
fn extract_file_ops_from_details(details: Option<&Value>, ops: &mut FileOperations) {
    let Some(details) = details else { return };
    if let Some(read) = details.get("readFiles").and_then(Value::as_array) {
        ops.read.extend(read.iter().filter_map(Value::as_str).map(str::to_string));
    }
    if let Some(modified) = details.get("modifiedFiles").and_then(Value::as_array) {
        ops.edited.extend(modified.iter().filter_map(Value::as_str).map(str::to_string));
    }
}

// ---------------------------------------------------------------------------
// Message serialization
// ---------------------------------------------------------------------------

const TOOL_RESULT_MAX_CHARS: usize = 2000;

fn truncate_for_summary(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let kept: String = text.chars().take(max_chars).collect();
    let truncated = text.chars().count() - max_chars;
    format!("{kept}\n\n[... {truncated} more characters truncated]")
}

fn blocks_text(blocks: &[UserContent]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            UserContent::Text(t) => Some(t.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// `serializeConversation`: render messages as tagged text so the
/// summarizer treats them as data rather than a conversation to continue.
pub fn serialize_conversation(messages: &[Message]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for msg in messages {
        match msg {
            Message::User(u) => {
                let content = match &u.content {
                    UserMessageContent::Text(t) => t.clone(),
                    UserMessageContent::Blocks(b) => blocks_text(b),
                };
                if !content.is_empty() {
                    parts.push(format!("[User]: {content}"));
                }
            }
            Message::Assistant(a) => {
                let mut thinking: Vec<&str> = Vec::new();
                let mut tool_calls: Vec<String> = Vec::new();
                let mut has_text = false;
                for block in &a.content {
                    match block {
                        AssistantContent::Thinking(t) => thinking.push(&t.thinking),
                        AssistantContent::ToolCall(c) => {
                            let args = match &c.arguments {
                                Value::Object(map) => map
                                    .iter()
                                    .map(|(k, v)| format!("{k}={v}"))
                                    .collect::<Vec<_>>()
                                    .join(", "),
                                other => other.to_string(),
                            };
                            tool_calls.push(format!("{}({args})", c.name));
                        }
                        AssistantContent::Text(_) => has_text = true,
                    }
                }
                if !thinking.is_empty() {
                    parts.push(format!("[Assistant thinking]: {}", thinking.join("\n")));
                }
                if has_text {
                    let text = a
                        .content
                        .iter()
                        .filter_map(|b| b.as_text().map(|t| t.text.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n");
                    parts.push(format!("[Assistant]: {text}"));
                }
                if !tool_calls.is_empty() {
                    parts.push(format!("[Assistant tool calls]: {}", tool_calls.join("; ")));
                }
            }
            Message::ToolResult(r) => {
                let content = blocks_text(&r.content);
                if !content.is_empty() {
                    parts.push(format!(
                        "[Tool result]: {}",
                        truncate_for_summary(&content, TOOL_RESULT_MAX_CHARS)
                    ));
                }
            }
            Message::System(_) => {}
        }
    }
    parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

pub const SUMMARIZATION_SYSTEM_PROMPT: &str = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

const SUMMARIZATION_PROMPT: &str = r#"The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages."#;

const UPDATE_SUMMARIZATION_PROMPT: &str = r#"The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages."#;

const TURN_PREFIX_SUMMARIZATION_PROMPT: &str = r#"This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix."#;

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

/// Inputs shared by every summarization call.
#[derive(Clone, Default)]
pub struct SummarizationOptions {
    pub api_key: Option<String>,
    pub headers: std::collections::BTreeMap<String, String>,
    pub signal: Option<AbortSignal>,
    pub thinking_level: Option<ThinkingLevel>,
    /// Routing id forwarded without enabling prompt caching.
    pub session_id: Option<String>,
    pub max_retries: Option<u32>,
    pub max_retry_delay_ms: Option<u64>,
}

fn create_summarization_options(model: &Model, max_tokens: u64, opts: &SummarizationOptions) -> StreamOptions {
    let mut options = StreamOptions {
        api_key: opts.api_key.clone(),
        headers: opts.headers.clone(),
        max_tokens: Some(max_tokens),
        signal: opts.signal.clone(),
        // Avoid cache writes for one-off summaries; callers without a
        // routing id get a fresh one.
        cache_retention: Some("none".into()),
        session_id: Some(opts.session_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string())),
        ..Default::default()
    };
    if let Some(r) = opts.max_retries {
        options.max_retries = r;
    }
    if let Some(d) = opts.max_retry_delay_ms {
        options.max_retry_delay_ms = Some(d);
    }
    if model.reasoning {
        if let Some(level) = opts.thinking_level {
            if level != ThinkingLevel::Off {
                options.reasoning = Some(level);
            }
        }
    }
    options
}

/// `completeSummarization`: one provider call, drained to its final message.
pub async fn complete_summarization(
    model: &Model,
    prompt_text: String,
    options: StreamOptions,
    stream_fn: &StreamFn,
) -> AssistantMessage {
    let context = normalize_context(Some(SUMMARIZATION_SYSTEM_PROMPT), None, vec![Message::user_text(prompt_text)]);
    let mut rx = stream_fn(model.clone(), context, options);
    let mut last_partial: Option<AssistantMessage> = None;
    while let Some(event) = rx.recv().await {
        match event {
            AssistantMessageEvent::Done { message, .. } => return message,
            AssistantMessageEvent::Error { error, .. } => return error,
            other => last_partial = Some(other.partial().clone()),
        }
    }
    let mut msg = last_partial.unwrap_or_else(|| AssistantMessage::pending(model));
    msg.stop_reason = StopReason::Error;
    msg.error_message = Some("Provider stream ended without a terminal event".into());
    msg
}

fn summarization_failure(response: &AssistantMessage, label: &str) -> Option<String> {
    match response.stop_reason {
        StopReason::Error => Some(format!(
            "{label} failed: {}",
            response.error_message.as_deref().unwrap_or("Unknown error")
        )),
        StopReason::Length => Some(format!(
            "{label} failed: generation hit the token cap and the summary is incomplete"
        )),
        _ => None,
    }
}

fn response_text(response: &AssistantMessage) -> String {
    response
        .content
        .iter()
        .filter_map(|b| b.as_text().map(|t| t.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn max_tokens_for(model: &Model, fraction: f64, reserve_tokens: u64) -> u64 {
    let budget = (fraction * reserve_tokens as f64).floor() as u64;
    if model.max_tokens > 0 {
        budget.min(model.max_tokens)
    } else {
        budget
    }
}

pub struct SummaryWithUsage {
    pub text: String,
    pub usage: Usage,
}

/// `generateSummaryWithUsage`: summarize `messages`, merging into
/// `previous_summary` when given.
pub async fn generate_summary_with_usage(
    messages: &[AgentMessage],
    model: &Model,
    reserve_tokens: u64,
    custom_instructions: Option<&str>,
    previous_summary: Option<&str>,
    opts: &SummarizationOptions,
    stream_fn: &StreamFn,
) -> Result<SummaryWithUsage, String> {
    let max_tokens = max_tokens_for(model, 0.8, reserve_tokens);
    let conversation = serialize_conversation(&convert_to_llm(messages));

    let mut base_prompt = if previous_summary.is_some() {
        UPDATE_SUMMARIZATION_PROMPT.to_string()
    } else {
        SUMMARIZATION_PROMPT.to_string()
    };
    if let Some(custom) = custom_instructions.map(str::trim).filter(|s| !s.is_empty()) {
        base_prompt.push_str(&format!("\n\nAdditional focus: {custom}"));
    }

    let mut prompt_text = format!("<conversation>\n{conversation}\n</conversation>\n\n");
    if let Some(prev) = previous_summary {
        prompt_text.push_str(&format!("<previous-summary>\n{prev}\n</previous-summary>\n\n"));
    }
    prompt_text.push_str(&base_prompt);

    let response = complete_summarization(
        model,
        prompt_text,
        create_summarization_options(model, max_tokens, opts),
        stream_fn,
    )
    .await;

    if let Some(failure) = summarization_failure(&response, "Summarization") {
        return Err(failure);
    }
    if response.content.iter().any(|b| matches!(b, AssistantContent::ToolCall(_))) {
        return Err("Summarization attempted to call a tool".into());
    }
    Ok(SummaryWithUsage {
        text: response_text(&response),
        usage: response.usage,
    })
}

/// `generateTurnPrefixSummary`: smaller-budget summary of a split turn's prefix.
async fn generate_turn_prefix_summary(
    messages: &[AgentMessage],
    model: &Model,
    reserve_tokens: u64,
    opts: &SummarizationOptions,
    stream_fn: &StreamFn,
) -> Result<SummaryWithUsage, String> {
    let max_tokens = max_tokens_for(model, 0.5, reserve_tokens);
    let conversation = serialize_conversation(&convert_to_llm(messages));
    let prompt_text = format!("<conversation>\n{conversation}\n</conversation>\n\n{TURN_PREFIX_SUMMARIZATION_PROMPT}");

    let response = complete_summarization(
        model,
        prompt_text,
        create_summarization_options(model, max_tokens, opts),
        stream_fn,
    )
    .await;

    if let Some(failure) = summarization_failure(&response, "Turn prefix summarization") {
        return Err(failure);
    }
    if response.content.iter().any(|b| matches!(b, AssistantContent::ToolCall(_))) {
        return Err("Turn prefix summarization attempted to call a tool".into());
    }
    Ok(SummaryWithUsage {
        text: response_text(&response),
        usage: response.usage,
    })
}

fn combine_usage(first: &Usage, second: &Usage) -> Usage {
    let opt_sum = |a: Option<u64>, b: Option<u64>| {
        if a.is_none() && b.is_none() {
            None
        } else {
            Some(a.unwrap_or(0) + b.unwrap_or(0))
        }
    };
    Usage {
        input: first.input + second.input,
        output: first.output + second.output,
        cache_read: first.cache_read + second.cache_read,
        cache_write: first.cache_write + second.cache_write,
        cache_write_1h: opt_sum(first.cache_write_1h, second.cache_write_1h),
        reasoning: opt_sum(first.reasoning, second.reasoning),
        total_tokens: first.total_tokens + second.total_tokens,
        cost: crate::harness::types::UsageCost {
            input: first.cost.input + second.cost.input,
            output: first.cost.output + second.cost.output,
            cache_read: first.cost.cache_read + second.cost.cache_read,
            cache_write: first.cost.cache_write + second.cost.cache_write,
            total: first.cost.total + second.cost.total,
        },
    }
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CompactionPreparation {
    /// Index (into the input messages) of the first message to keep.
    pub first_kept_index: usize,
    /// Messages that will be summarized and discarded.
    pub messages_to_summarize: Vec<AgentMessage>,
    /// Messages turned into a turn-prefix summary (when splitting a turn).
    pub turn_prefix_messages: Vec<AgentMessage>,
    pub is_split_turn: bool,
    pub tokens_before: u64,
    /// Summary from the previous compaction, for iterative update.
    pub previous_summary: Option<String>,
    pub file_ops: FileOperations,
    pub settings: CompactionSettings,
}

/// `prepareCompaction`: decide what to summarize. `None` when there is
/// nothing to do (last message is already a compaction summary, or no
/// summarizable messages before the cut).
pub fn prepare_compaction(messages: &[AgentMessage], settings: CompactionSettings) -> Option<CompactionPreparation> {
    if messages.last().is_some_and(is_compaction_summary) {
        return None;
    }

    let prev_compaction_index = messages.iter().rposition(is_compaction_summary);
    let (previous_summary, boundary_start) = match prev_compaction_index {
        Some(i) => (compaction_summary_text(&messages[i]).map(str::to_string), i + 1),
        None => (None, 0),
    };
    let boundary_end = messages.len();

    let tokens_before = estimate_context_tokens(messages).tokens;

    let cut = find_cut_point(messages, boundary_start, boundary_end, settings.keep_recent_tokens);

    let history_end = if cut.is_split_turn {
        cut.turn_start_index.unwrap_or(cut.first_kept_index)
    } else {
        cut.first_kept_index
    };

    // System messages are prompt state, not conversation; the applied
    // compaction carries their collapsed replay.
    let summarizable = |m: &AgentMessage| !m.is_system() && !is_compaction_summary(m);

    let messages_to_summarize: Vec<AgentMessage> = messages[boundary_start..history_end]
        .iter()
        .filter(|m| summarizable(m))
        .cloned()
        .collect();

    let turn_prefix_messages: Vec<AgentMessage> = match (cut.is_split_turn, cut.turn_start_index) {
        (true, Some(ts)) => messages[ts..cut.first_kept_index]
            .iter()
            .filter(|m| summarizable(m))
            .cloned()
            .collect(),
        _ => Vec::new(),
    };

    if messages_to_summarize.is_empty() && turn_prefix_messages.is_empty() {
        return None;
    }

    let mut file_ops = FileOperations::default();
    if let Some(i) = prev_compaction_index {
        if let AgentMessage::Custom(c) = &messages[i] {
            extract_file_ops_from_details(c.details.as_ref(), &mut file_ops);
        }
    }
    for m in &messages_to_summarize {
        extract_file_ops_from_message(m, &mut file_ops);
    }
    for m in &turn_prefix_messages {
        extract_file_ops_from_message(m, &mut file_ops);
    }

    Some(CompactionPreparation {
        first_kept_index: cut.first_kept_index,
        messages_to_summarize,
        turn_prefix_messages,
        is_split_turn: cut.is_split_turn,
        tokens_before,
        previous_summary,
        file_ops,
        settings,
    })
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionDetails {
    pub read_files: Vec<String>,
    pub modified_files: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CompactionResult {
    pub summary: String,
    pub first_kept_index: usize,
    pub tokens_before: u64,
    pub usage: Usage,
    pub details: CompactionDetails,
}

/// `compact`: generate the summary (or summaries, for a split turn) for a
/// preparation. Does not modify the transcript; see [`apply_compaction`].
pub async fn compact(
    preparation: &CompactionPreparation,
    model: &Model,
    custom_instructions: Option<&str>,
    opts: &SummarizationOptions,
    stream_fn: &StreamFn,
) -> Result<CompactionResult, String> {
    let settings = preparation.settings;
    let previous = preparation.previous_summary.as_deref();

    let (mut summary, usage) = if preparation.is_split_turn && !preparation.turn_prefix_messages.is_empty() {
        let mut history_text = previous.unwrap_or("No prior history.").to_string();
        let mut history_usage: Option<Usage> = None;
        if !preparation.messages_to_summarize.is_empty() {
            let history = generate_summary_with_usage(
                &preparation.messages_to_summarize,
                model,
                settings.reserve_tokens,
                custom_instructions,
                previous,
                opts,
                stream_fn,
            )
            .await?;
            history_text = history.text;
            history_usage = Some(history.usage);
        }
        let prefix = generate_turn_prefix_summary(
            &preparation.turn_prefix_messages,
            model,
            settings.reserve_tokens,
            opts,
            stream_fn,
        )
        .await?;
        let summary = format!("{history_text}\n\n---\n\n**Turn Context (split turn):**\n\n{}", prefix.text);
        let usage = match history_usage {
            Some(h) => combine_usage(&h, &prefix.usage),
            None => prefix.usage,
        };
        (summary, usage)
    } else {
        let result = generate_summary_with_usage(
            &preparation.messages_to_summarize,
            model,
            settings.reserve_tokens,
            custom_instructions,
            previous,
            opts,
            stream_fn,
        )
        .await?;
        (result.text, result.usage)
    };

    let (read_files, modified_files) = compute_file_lists(&preparation.file_ops);
    summary.push_str(&format_file_operations(&read_files, &modified_files));

    Ok(CompactionResult {
        summary,
        first_kept_index: preparation.first_kept_index,
        tokens_before: preparation.tokens_before,
        usage,
        details: CompactionDetails { read_files, modified_files },
    })
}

/// Rebuild the transcript after compaction (pi `buildContextEntries` for
/// a compaction entry): the collapsed system message current at compaction
/// time, the summary, then every kept message from `first_kept_index`
/// (system messages excluded — the collapsed one already replays them).
pub fn apply_compaction(messages: &[AgentMessage], result: &CompactionResult) -> Vec<AgentMessage> {
    let llm: Vec<Message> = convert_to_llm(messages);
    let mut out: Vec<AgentMessage> = Vec::with_capacity(messages.len() - result.first_kept_index + 2);
    if let Some(system) = get_current_system_message(&llm) {
        out.push(AgentMessage::from(system));
    }
    let details = json!({
        "readFiles": result.details.read_files,
        "modifiedFiles": result.details.modified_files,
    });
    out.push(create_compaction_summary_message(&result.summary, result.tokens_before, Some(details)));
    out.extend(
        messages[result.first_kept_index..]
            .iter()
            .filter(|m| !m.is_system())
            .cloned(),
    );
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::harness::test_support::{model, scripted_stream, Script};
    use crate::harness::types::{Api, TextContent, ToolCall, ToolResultMessage};

    fn user(text: &str) -> AgentMessage {
        AgentMessage::user_text(text)
    }

    fn assistant_text(text: &str) -> AgentMessage {
        AgentMessage::from(AssistantMessage {
            content: vec![AssistantContent::Text(TextContent { text: text.into(), text_signature: None })],
            api: Api::OpenAICompletions,
            provider: "p".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: 0,
        })
    }

    fn assistant_tool(name: &str, path: &str) -> AgentMessage {
        AgentMessage::from(AssistantMessage {
            content: vec![AssistantContent::ToolCall(ToolCall {
                id: "c1".into(),
                name: name.into(),
                arguments: json!({ "path": path }),
                thought_signature: None,
                namespace: None,
            })],
            api: Api::OpenAICompletions,
            provider: "p".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: StopReason::ToolUse,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: 0,
        })
    }

    fn tool_result(text: &str) -> AgentMessage {
        AgentMessage::from(ToolResultMessage {
            tool_call_id: "c1".into(),
            tool_name: "read".into(),
            content: vec![UserContent::text(text)],
            details: None,
            usage: None,
            is_error: false,
            timestamp: 0,
        })
    }

    fn with_usage(m: AgentMessage, total: u64) -> AgentMessage {
        match m {
            AgentMessage::Llm(Message::Assistant(mut a)) => {
                a.usage.total_tokens = total;
                AgentMessage::from(a)
            }
            other => other,
        }
    }

    #[test]
    fn should_compact_respects_reserve_and_enabled() {
        let s = CompactionSettings::default();
        assert!(!should_compact(100, 100_000, &s));
        assert!(should_compact(100_000 - 16384 + 1, 100_000, &s));
        assert!(!should_compact(100_000 - 16384, 100_000, &s));
        let off = CompactionSettings { enabled: false, ..s };
        assert!(!should_compact(1_000_000, 100_000, &off));
    }

    #[test]
    fn estimate_uses_last_usage_plus_trailing() {
        let msgs = vec![
            user("a".repeat(400).as_str()),
            with_usage(assistant_text("x"), 5000),
            user("b".repeat(40).as_str()),
        ];
        let e = estimate_context_tokens(&msgs);
        assert_eq!(e.usage_tokens, 5000);
        assert_eq!(e.trailing_tokens, 10);
        assert_eq!(e.tokens, 5010);
        assert_eq!(e.last_usage_index, Some(1));

        let e2 = estimate_context_tokens(&[user("abcd"), user("efgh")]);
        assert_eq!(e2.tokens, 2);
        assert_eq!(e2.last_usage_index, None);
    }

    #[test]
    fn errored_assistant_usage_is_ignored() {
        let mut a = match assistant_text("x") {
            AgentMessage::Llm(Message::Assistant(a)) => a,
            _ => unreachable!(),
        };
        a.usage.total_tokens = 999;
        a.stop_reason = StopReason::Error;
        let msgs = vec![user("abcd"), AgentMessage::from(a)];
        assert_eq!(estimate_context_tokens(&msgs).usage_tokens, 0);
    }

    #[test]
    fn cut_point_never_lands_on_tool_result() {
        // user(0) assistant-tool(1) result(2, huge) assistant(3) user(4)
        let msgs = vec![
            user("start"),
            assistant_tool("read", "a.rs"),
            tool_result(&"r".repeat(4000)),
            assistant_text("done"),
            user("next"),
        ];
        let cut = find_cut_point(&msgs, 0, msgs.len(), 500);
        // Budget hits inside the tool result (index 2); nearest cut point ≥ 2 is 3.
        assert_eq!(cut.first_kept_index, 3);
        assert!(cut.is_split_turn);
        assert_eq!(cut.turn_start_index, Some(0));
    }

    #[test]
    fn cut_point_on_user_is_not_split() {
        let msgs = vec![
            user(&"a".repeat(400)),
            assistant_text(&"b".repeat(400)),
            user(&"c".repeat(400)),
            assistant_text(&"d".repeat(400)),
        ];
        // keep 150 tokens: d=100, c=100 → 200 ≥ 150 at index 2 (user) → not split
        let cut = find_cut_point(&msgs, 0, 4, 150);
        assert_eq!(cut.first_kept_index, 2);
        assert!(!cut.is_split_turn);
        assert_eq!(cut.turn_start_index, None);
    }

    #[test]
    fn cut_point_with_nothing_to_cut_keeps_everything() {
        let msgs = vec![user("hi"), assistant_text("yo")];
        let cut = find_cut_point(&msgs, 0, 2, 20000);
        assert_eq!(cut.first_kept_index, 0);
        assert!(!cut.is_split_turn);
    }

    #[test]
    fn prepare_returns_none_when_nothing_to_summarize() {
        let msgs = vec![user("hi"), assistant_text("yo")];
        assert!(prepare_compaction(&msgs, CompactionSettings::default()).is_none());
        let msgs2 = vec![user("hi"), create_compaction_summary_message("s", 1, None)];
        assert!(prepare_compaction(&msgs2, CompactionSettings::default()).is_none());
    }

    #[test]
    fn prepare_collects_history_and_file_ops() {
        let settings = CompactionSettings { keep_recent_tokens: 150, ..Default::default() };
        let msgs = vec![
            AgentMessage::from(crate::harness::transcript::create_initial_system_message(Some("sys"), None).unwrap()),
            user(&"a".repeat(400)),
            assistant_tool("read", "a.rs"),
            tool_result("ok"),
            assistant_tool("edit", "a.rs"),
            tool_result("ok"),
            user(&"c".repeat(400)),
            assistant_text(&"d".repeat(400)),
        ];
        let prep = prepare_compaction(&msgs, settings).unwrap();
        assert_eq!(prep.first_kept_index, 6);
        assert!(!prep.is_split_turn);
        assert_eq!(prep.messages_to_summarize.len(), 5); // system excluded
        assert!(prep.turn_prefix_messages.is_empty());
        assert!(prep.previous_summary.is_none());
        assert!(prep.file_ops.read.contains("a.rs"));
        assert!(prep.file_ops.edited.contains("a.rs"));
        let (read, modified) = compute_file_lists(&prep.file_ops);
        assert!(read.is_empty());
        assert_eq!(modified, vec!["a.rs".to_string()]);
    }

    #[test]
    fn prepare_uses_previous_summary_and_details() {
        let settings = CompactionSettings { keep_recent_tokens: 150, ..Default::default() };
        let prev = create_compaction_summary_message(
            "old summary",
            10,
            Some(json!({"readFiles": ["x.rs"], "modifiedFiles": ["y.rs"]})),
        );
        let msgs = vec![
            user("very old"),
            prev,
            user(&"a".repeat(400)),
            assistant_text(&"b".repeat(400)),
            user(&"c".repeat(400)),
            assistant_text(&"d".repeat(400)),
        ];
        let prep = prepare_compaction(&msgs, settings).unwrap();
        assert_eq!(prep.previous_summary.as_deref(), Some("old summary"));
        // boundary starts after the previous summary; "very old" excluded
        assert_eq!(prep.messages_to_summarize.len(), 2);
        assert_eq!(prep.first_kept_index, 4);
        assert!(prep.file_ops.read.contains("x.rs"));
        assert!(prep.file_ops.edited.contains("y.rs"));
    }

    #[test]
    fn serialize_conversation_tags_and_truncates() {
        let msgs = vec![
            user("hello"),
            assistant_tool("read", "a.rs"),
            tool_result(&"z".repeat(2500)),
            assistant_text("done"),
        ];
        let s = serialize_conversation(&convert_to_llm(&msgs));
        assert!(s.starts_with("[User]: hello\n\n[Assistant tool calls]: read(path=\"a.rs\")\n\n[Tool result]: "));
        assert!(s.contains("[... 500 more characters truncated]"));
        assert!(s.ends_with("[Assistant]: done"));
    }

    #[test]
    fn format_file_operations_shapes() {
        assert_eq!(format_file_operations(&[], &[]), "");
        assert_eq!(
            format_file_operations(&["a".into()], &["b".into(), "c".into()]),
            "\n\n<read-files>\na\n</read-files>\n\n<modified-files>\nb\nc\n</modified-files>"
        );
    }

    #[tokio::test]
    async fn compact_single_summary_and_apply() {
        let settings = CompactionSettings { keep_recent_tokens: 150, ..Default::default() };
        let msgs = vec![
            AgentMessage::from(crate::harness::transcript::create_initial_system_message(Some("sys"), None).unwrap()),
            user(&"a".repeat(400)),
            assistant_tool("read", "a.rs"),
            tool_result("ok"),
            user(&"c".repeat(400)),
            assistant_text(&"d".repeat(400)),
        ];
        let prep = prepare_compaction(&msgs, settings).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(vec![Script::Text("## Goal\nsummary".into())], requests.clone());
        let result = compact(&prep, &model(), Some("focus on tests"), &SummarizationOptions::default(), &stream)
            .await
            .unwrap();
        assert_eq!(result.summary, "## Goal\nsummary\n\n<read-files>\na.rs\n</read-files>");
        assert_eq!(result.details.read_files, vec!["a.rs".to_string()]);

        // Request shape: summarization system prompt + one user message with conversation & prompt.
        let reqs = requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        let req = &reqs[0];
        assert_eq!(req.messages.len(), 2);
        let sys = req.messages[0].as_system().unwrap();
        assert_eq!(sys.content, SUMMARIZATION_SYSTEM_PROMPT);
        let prompt = req.messages[1].as_user().unwrap().content.text();
        assert!(prompt.starts_with("<conversation>\n[User]: aaaa"));
        assert!(prompt.contains("Additional focus: focus on tests"));
        assert!(!prompt.contains("<previous-summary>"));
        drop(reqs);

        let after = apply_compaction(&msgs, &result);
        assert_eq!(after.len(), 4);
        assert!(after[0].is_system());
        assert_eq!(after[0].as_system().unwrap().content, "sys");
        assert!(is_compaction_summary(&after[1]));
        assert_eq!(compaction_summary_text(&after[1]), Some(result.summary.as_str()));
        assert_eq!(after[2], msgs[4]);
        assert_eq!(after[3], msgs[5]);
        // Re-preparing right after compaction: previous summary is picked up.
        let prep2 = prepare_compaction(&after, CompactionSettings { keep_recent_tokens: 50, ..settings }).unwrap();
        assert_eq!(prep2.previous_summary.as_deref(), Some(result.summary.as_str()));
    }

    #[tokio::test]
    async fn compact_split_turn_runs_two_summaries() {
        let settings = CompactionSettings { keep_recent_tokens: 150, ..Default::default() };
        let msgs = vec![
            user(&"old".repeat(200)),
            assistant_text(&"reply".repeat(100)),
            user("big turn"),
            assistant_tool("write", "out.rs"),
            tool_result(&"r".repeat(4000)),
            assistant_text(&"d".repeat(800)),
        ];
        let prep = prepare_compaction(&msgs, settings).unwrap();
        assert!(prep.is_split_turn);
        assert_eq!(prep.turn_prefix_messages.len(), 3);
        assert_eq!(prep.messages_to_summarize.len(), 2);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream = scripted_stream(
            vec![Script::Text("HISTORY".into()), Script::Text("PREFIX".into())],
            requests.clone(),
        );
        let result = compact(&prep, &model(), None, &SummarizationOptions::default(), &stream).await.unwrap();
        assert_eq!(
            result.summary,
            "HISTORY\n\n---\n\n**Turn Context (split turn):**\n\nPREFIX\n\n<modified-files>\nout.rs\n</modified-files>"
        );
        let reqs = requests.lock().unwrap();
        assert_eq!(reqs.len(), 2);
        let second = reqs[1].messages[1].as_user().unwrap().content.text();
        assert!(second.contains("This is the PREFIX of a turn"));
    }

    #[tokio::test]
    async fn compact_surfaces_provider_errors() {
        let settings = CompactionSettings { keep_recent_tokens: 150, ..Default::default() };
        let msgs = vec![
            user(&"a".repeat(400)),
            assistant_text(&"b".repeat(400)),
            user(&"c".repeat(400)),
            assistant_text(&"d".repeat(400)),
        ];
        let prep = prepare_compaction(&msgs, settings).unwrap();
        let stream = scripted_stream(vec![Script::Error("boom".into())], Arc::new(Mutex::new(Vec::new())));
        let err = compact(&prep, &model(), None, &SummarizationOptions::default(), &stream).await.unwrap_err();
        assert_eq!(err, "Summarization failed: boom");

        let stream = scripted_stream(
            vec![Script::ToolCalls(vec![("1".into(), "echo".into(), json!({}))])],
            Arc::new(Mutex::new(Vec::new())),
        );
        let err = compact(&prep, &model(), None, &SummarizationOptions::default(), &stream).await.unwrap_err();
        assert_eq!(err, "Summarization attempted to call a tool");
    }

    #[test]
    fn summarization_options_disable_cache_and_gate_reasoning() {
        let mut m = model();
        m.reasoning = true;
        let opts = SummarizationOptions { thinking_level: Some(ThinkingLevel::High), ..Default::default() };
        let so = create_summarization_options(&m, 1000, &opts);
        assert_eq!(so.cache_retention.as_deref(), Some("none"));
        assert!(so.session_id.is_some());
        assert_eq!(so.max_tokens, Some(1000));
        assert_eq!(so.reasoning, Some(ThinkingLevel::High));
        m.reasoning = false;
        assert_eq!(create_summarization_options(&m, 1000, &opts).reasoning, None);
        // max_tokens: min(0.8*reserve, model.max_tokens)
        assert_eq!(max_tokens_for(&m, 0.8, 16384), 1000);
        m.max_tokens = 0;
        assert_eq!(max_tokens_for(&m, 0.8, 16384), 13107);
    }
}
