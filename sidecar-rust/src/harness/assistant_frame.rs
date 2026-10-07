//! Port of pi-ai `utils/assistant-message-frame.ts` — compact, replayable
//! assistant-message progress.
//!
//! Frames capture a streaming assistant message block-by-block so a crash
//! mid-stream loses at most unflushed deltas; terminal settlement is
//! intentionally excluded and persisted separately by the response
//! transaction.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::harness::json_parse::parse_streaming_json;
use crate::harness::types::{
    AssistantContent, AssistantMessage, AssistantMessageEvent, StopReason, TextContent, ThinkingContent, ToolCall,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AssistantMessageFrame {
    #[serde(rename = "start")]
    Start { partial: AssistantMessage },
    #[serde(rename = "text_start")]
    TextStart { content_index: usize, content: TextContent },
    #[serde(rename = "text_delta")]
    TextDelta { content_index: usize, delta: String },
    #[serde(rename = "text_end")]
    TextEnd {
        content_index: usize,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text_signature: Option<String>,
    },
    #[serde(rename = "thinking_start")]
    ThinkingStart { content_index: usize, content: ThinkingContent },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { content_index: usize, delta: String },
    #[serde(rename = "thinking_end")]
    ThinkingEnd {
        content_index: usize,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thinking_signature: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    #[serde(rename = "toolcall_start")]
    ToolcallStart { content_index: usize, tool_call: ToolCall },
    #[serde(rename = "toolcall_checkpoint")]
    ToolcallCheckpoint { content_index: usize, json: String },
    #[serde(rename = "toolcall_delta")]
    ToolcallDelta { content_index: usize, delta: String },
    #[serde(rename = "toolcall_end")]
    ToolcallEnd {
        content_index: usize,
        id: String,
        name: String,
        arguments: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thought_signature: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
    },
}

enum BlockState {
    Text { covered_chars: usize, delta_chars: usize },
    Thinking { covered_chars: usize, delta_chars: usize },
    ToolCall { caught_up: bool, catchup_json: String, snapshot_arguments: String },
}

fn serialized_arguments(arguments: &Value) -> Result<String, String> {
    serde_json::to_string(arguments).map_err(|e| format!("Tool-call arguments are not JSON-serializable: {e}"))
}

fn empty_parsed_tool_arguments() -> Result<String, String> {
    serialized_arguments(&parse_streaming_json(""))
}

/// True when every part of `snapshot` is a prefix of `current` (legacy
/// grammar tool calls whose delta stream re-sends the start snapshot).
fn is_json_prefix(snapshot: &Value, current: &Value) -> bool {
    match (snapshot, current) {
        (Value::String(s), Value::String(c)) => c.starts_with(s),
        (Value::Array(s), Value::Array(c)) => {
            s.len() <= c.len() && s.iter().zip(c.iter()).all(|(sv, cv)| is_json_prefix(sv, cv))
        }
        (Value::Object(s), Value::Object(c)) => s
            .iter()
            .all(|(key, sv)| c.get(key).map(|cv| is_json_prefix(sv, cv)).unwrap_or(false)),
        _ => snapshot == current,
    }
}

/// Encodes one assistant stream. The event's `partial` is a shared live
/// accumulator; the encoder uses per-block offsets to avoid replaying
/// deltas already visible when an older queued event is consumed.
#[derive(Default)]
pub struct AssistantMessageFrameEncoder {
    started: bool,
    terminal: bool,
    blocks: HashMap<usize, BlockState>,
}

impl AssistantMessageFrameEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn encode(&mut self, event: &AssistantMessageEvent) -> Result<Option<AssistantMessageFrame>, String> {
        if self.terminal {
            return Err(format!("Assistant message event {} follows a terminal event", event.kind()));
        }
        match event {
            AssistantMessageEvent::Start { partial } => {
                if self.started {
                    return Err("Assistant message stream contains more than one start event".into());
                }
                self.started = true;
                Ok(Some(AssistantMessageFrame::Start { partial: clone_start_message(partial) }))
            }
            AssistantMessageEvent::Done { .. } => {
                if !self.started {
                    return Err("Assistant message done event appears before start".into());
                }
                self.terminal = true;
                Ok(None)
            }
            AssistantMessageEvent::Error { .. } => {
                self.terminal = true;
                Ok(None)
            }
            _ if !self.started => Err(format!(
                "Assistant message {} event appears before start",
                event.kind()
            )),
            AssistantMessageEvent::TextStart { content_index, partial } => {
                let block = block_at(partial, *content_index, event.kind())?;
                let AssistantContent::Text(content) = block else {
                    return Err(format!("text_start event points to {} block at index {}", block_type(block), content_index));
                };
                self.start_block(*content_index, BlockState::Text { covered_chars: content.text.len(), delta_chars: 0 })?;
                Ok(Some(AssistantMessageFrame::TextStart { content_index: *content_index, content: content.clone() }))
            }
            AssistantMessageEvent::TextDelta { content_index, delta, .. } => {
                self.encode_text_delta(*content_index, delta, event, false)
            }
            AssistantMessageEvent::TextEnd { content_index, content, partial } => {
                let block = block_at(partial, *content_index, event.kind())?;
                let AssistantContent::Text(text) = block else {
                    return Err(format!("text_end event points to {} block at index {}", block_type(block), content_index));
                };
                self.end_block(*content_index, false)?;
                Ok(Some(AssistantMessageFrame::TextEnd {
                    content_index: *content_index,
                    content: content.clone(),
                    text_signature: text.text_signature.clone(),
                }))
            }
            AssistantMessageEvent::ThinkingStart { content_index, partial } => {
                let block = block_at(partial, *content_index, event.kind())?;
                let AssistantContent::Thinking(content) = block else {
                    return Err(format!(
                        "thinking_start event points to {} block at index {}",
                        block_type(block),
                        content_index
                    ));
                };
                self.start_block(
                    *content_index,
                    BlockState::Thinking { covered_chars: content.thinking.len(), delta_chars: 0 },
                )?;
                Ok(Some(AssistantMessageFrame::ThinkingStart { content_index: *content_index, content: content.clone() }))
            }
            AssistantMessageEvent::ThinkingDelta { content_index, delta, .. } => {
                self.encode_text_delta(*content_index, delta, event, true)
            }
            AssistantMessageEvent::ThinkingEnd { content_index, content, partial } => {
                let block = block_at(partial, *content_index, event.kind())?;
                let AssistantContent::Thinking(thinking) = block else {
                    return Err(format!(
                        "thinking_end event points to {} block at index {}",
                        block_type(block),
                        content_index
                    ));
                };
                self.end_block(*content_index, true)?;
                Ok(Some(AssistantMessageFrame::ThinkingEnd {
                    content_index: *content_index,
                    content: content.clone(),
                    thinking_signature: thinking.thinking_signature.clone(),
                    redacted: thinking.redacted,
                }))
            }
            AssistantMessageEvent::ToolcallStart { content_index, partial } => {
                let block = block_at(partial, *content_index, event.kind())?;
                let AssistantContent::ToolCall(tool_call) = block else {
                    return Err(format!(
                        "toolcall_start event points to {} block at index {}",
                        block_type(block),
                        content_index
                    ));
                };
                let snapshot_arguments = serialized_arguments(&tool_call.arguments)?;
                let empty = empty_parsed_tool_arguments()?;
                let caught_up = snapshot_arguments == empty;
                self.start_block(
                    *content_index,
                    BlockState::ToolCall {
                        caught_up,
                        catchup_json: String::new(),
                        snapshot_arguments: if caught_up { String::new() } else { snapshot_arguments },
                    },
                )?;
                Ok(Some(AssistantMessageFrame::ToolcallStart { content_index: *content_index, tool_call: tool_call.clone() }))
            }
            AssistantMessageEvent::ToolcallDelta { content_index, delta, .. } => {
                let state = self.block_mut(*content_index, true)?;
                let BlockState::ToolCall { caught_up, catchup_json, snapshot_arguments } = state else {
                    return Err("Unreachable tool-call encoder state".into());
                };
                if *caught_up {
                    return Ok(if delta.is_empty() {
                        None
                    } else {
                        Some(AssistantMessageFrame::ToolcallDelta { content_index: *content_index, delta: delta.clone() })
                    });
                }
                catchup_json.push_str(delta);
                let arguments = parse_streaming_json(catchup_json);
                if serialized_arguments(&arguments)? != *snapshot_arguments {
                    // Legacy grammar calls include the initial input in
                    // toolcall_start, but their JSON delta stream still
                    // begins at an empty input.
                    let snapshot = parse_streaming_json(snapshot_arguments);
                    if !is_json_prefix(&snapshot, &arguments) {
                        return Ok(None);
                    }
                }
                *caught_up = true;
                snapshot_arguments.clear();
                let json = std::mem::take(catchup_json);
                Ok(if json.is_empty() {
                    None
                } else {
                    Some(AssistantMessageFrame::ToolcallCheckpoint { content_index: *content_index, json })
                })
            }
            AssistantMessageEvent::ToolcallEnd { content_index, tool_call, .. } => {
                self.end_block(*content_index, true)?;
                Ok(Some(AssistantMessageFrame::ToolcallEnd {
                    content_index: *content_index,
                    id: tool_call.id.clone(),
                    name: tool_call.name.clone(),
                    arguments: tool_call.arguments.clone(),
                    thought_signature: tool_call.thought_signature.clone(),
                    namespace: tool_call.namespace.clone(),
                }))
            }
        }
    }

    fn start_block(&mut self, content_index: usize, state: BlockState) -> Result<(), String> {
        if self.blocks.contains_key(&content_index) {
            return Err(format!("Assistant message block {content_index} starts more than once"));
        }
        self.blocks.insert(content_index, state);
        Ok(())
    }

    fn block_mut(&mut self, content_index: usize, tool_call: bool) -> Result<&mut BlockState, String> {
        let state = self
            .blocks
            .get_mut(&content_index)
            .ok_or_else(|| format!("Assistant message block {content_index} has not started"))?;
        let kind_matches = match state {
            BlockState::Text { .. } | BlockState::Thinking { .. } => !tool_call,
            BlockState::ToolCall { .. } => tool_call,
        };
        if !kind_matches {
            return Err(format!("Assistant message block {content_index} has the wrong kind"));
        }
        Ok(state)
    }

    fn end_block(&mut self, content_index: usize, tool_call: bool) -> Result<(), String> {
        self.block_mut(content_index, tool_call)?;
        self.blocks.remove(&content_index);
        Ok(())
    }

    fn encode_text_delta(
        &mut self,
        content_index: usize,
        delta: &str,
        event: &AssistantMessageEvent,
        thinking: bool,
    ) -> Result<Option<AssistantMessageFrame>, String> {
        let state = self.block_mut(content_index, false)?;
        let (covered_chars, delta_chars) = match state {
            BlockState::Text { covered_chars, delta_chars } => (covered_chars, delta_chars),
            BlockState::Thinking { covered_chars, delta_chars } => (covered_chars, delta_chars),
            BlockState::ToolCall { .. } => return Err("Unreachable text encoder state".into()),
        };
        let _ = event;
        let delta_start = *delta_chars;
        *delta_chars += delta.len();
        let covered = covered_chars.saturating_sub(delta_start);
        if covered >= delta.len() {
            return Ok(None);
        }
        let uncovered = if covered == 0 { delta.to_string() } else { delta[covered..].to_string() };
        Ok(Some(if thinking {
            AssistantMessageFrame::ThinkingDelta { content_index, delta: uncovered }
        } else {
            AssistantMessageFrame::TextDelta { content_index, delta: uncovered }
        }))
    }
}

fn block_at<'a>(partial: &'a AssistantMessage, content_index: usize, event: &str) -> Result<&'a AssistantContent, String> {
    partial
        .content
        .get(content_index)
        .ok_or_else(|| format!("{event} event has no content block at index {content_index}"))
}

fn block_type(content: &AssistantContent) -> &'static str {
    match content {
        AssistantContent::Text(_) => "text",
        AssistantContent::Thinking(_) => "thinking",
        AssistantContent::ToolCall(_) => "toolCall",
    }
}

fn clone_start_message(message: &AssistantMessage) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: message.api,
        provider: message.provider.clone(),
        model: message.model.clone(),
        response_model: message.response_model.clone(),
        response_id: message.response_id.clone(),
        usage: message.usage.clone(),
        stop_reason: StopReason::Pending,
        error_message: None,
        raw_stop_reason: None,
        end_turn: None,
        timestamp: message.timestamp,
    }
}

// ---------------------------------------------------------------------------
// Reduction
// ---------------------------------------------------------------------------

enum ReducerBlockState {
    Text { ended: bool },
    Thinking { ended: bool },
    ToolCall { ended: bool, json: String },
}

/// Replay compact frames without mutating them. `None` when the frames
/// contain no start frame.
pub fn reduce_assistant_message_frames(frames: &[AssistantMessageFrame]) -> Result<Option<AssistantMessage>, String> {
    let mut message: Option<AssistantMessage> = None;
    let mut frame_before_start: Option<&'static str> = None;
    let mut states: HashMap<usize, ReducerBlockState> = HashMap::new();

    for frame in frames {
        if let AssistantMessageFrame::Start { partial } = frame {
            if message.is_some() {
                return Err("Assistant message frame sequence contains more than one start frame".into());
            }
            if let Some(earlier) = frame_before_start {
                return Err(format!("{earlier} frame appears before the start frame"));
            }
            message = Some(partial.clone());
            continue;
        }
        let Some(message) = message.as_mut() else {
            frame_before_start.get_or_insert(frame_name(frame));
            continue;
        };

        match frame {
            AssistantMessageFrame::TextStart { content_index, content } => {
                append_block(
                    message,
                    &mut states,
                    *content_index,
                    AssistantContent::Text(content.clone()),
                    ReducerBlockState::Text { ended: false },
                )?;
            }
            AssistantMessageFrame::TextDelta { content_index, delta } => {
                if let Some(AssistantContent::Text(block)) = message.content.get_mut(*content_index) {
                    block.text.push_str(delta);
                }
                ensure_active(&states, *content_index, "text", "text_delta")?;
            }
            AssistantMessageFrame::TextEnd { content_index, content, text_signature } => {
                ensure_active(&states, *content_index, "text", "text_end")?;
                if let Some(AssistantContent::Text(block)) = message.content.get_mut(*content_index) {
                    block.text = content.clone();
                    block.text_signature = text_signature.clone();
                }
                end_state(&mut states, *content_index);
            }
            AssistantMessageFrame::ThinkingStart { content_index, content } => {
                append_block(
                    message,
                    &mut states,
                    *content_index,
                    AssistantContent::Thinking(content.clone()),
                    ReducerBlockState::Thinking { ended: false },
                )?;
            }
            AssistantMessageFrame::ThinkingDelta { content_index, delta } => {
                if let Some(AssistantContent::Thinking(block)) = message.content.get_mut(*content_index) {
                    block.thinking.push_str(delta);
                }
                ensure_active(&states, *content_index, "thinking", "thinking_delta")?;
            }
            AssistantMessageFrame::ThinkingEnd { content_index, content, thinking_signature, redacted } => {
                ensure_active(&states, *content_index, "thinking", "thinking_end")?;
                if let Some(AssistantContent::Thinking(block)) = message.content.get_mut(*content_index) {
                    block.thinking = content.clone();
                    block.thinking_signature = thinking_signature.clone();
                    block.redacted = *redacted;
                }
                end_state(&mut states, *content_index);
            }
            AssistantMessageFrame::ToolcallStart { content_index, tool_call } => {
                append_block(
                    message,
                    &mut states,
                    *content_index,
                    AssistantContent::ToolCall(tool_call.clone()),
                    ReducerBlockState::ToolCall { ended: false, json: String::new() },
                )?;
            }
            AssistantMessageFrame::ToolcallCheckpoint { content_index, json } => {
                ensure_active(&states, *content_index, "toolCall", "toolcall_checkpoint")?;
                let parsed = parse_streaming_json(json);
                if let Some(AssistantContent::ToolCall(block)) = message.content.get_mut(*content_index) {
                    block.arguments = parsed;
                }
                if let Some(ReducerBlockState::ToolCall { json: state_json, .. }) = states.get_mut(content_index) {
                    *state_json = json.clone();
                }
            }
            AssistantMessageFrame::ToolcallDelta { content_index, delta } => {
                ensure_active(&states, *content_index, "toolCall", "toolcall_delta")?;
                if let Some(ReducerBlockState::ToolCall { json, .. }) = states.get_mut(content_index) {
                    json.push_str(delta);
                }
            }
            AssistantMessageFrame::ToolcallEnd { content_index, id, name, arguments, thought_signature, namespace } => {
                ensure_active(&states, *content_index, "toolCall", "toolcall_end")?;
                if let Some(AssistantContent::ToolCall(block)) = message.content.get_mut(*content_index) {
                    block.id = id.clone();
                    block.name = name.clone();
                    block.arguments = arguments.clone();
                    block.thought_signature = thought_signature.clone();
                    block.namespace = namespace.clone();
                }
                end_state(&mut states, *content_index);
            }
            AssistantMessageFrame::Start { .. } => unreachable!("handled above"),
        }
    }

    let Some(mut message) = message else { return Ok(None) };
    let mut pending_arguments: Vec<(usize, Value)> = Vec::new();
    for (content_index, state) in &states {
        if let ReducerBlockState::ToolCall { ended: false, json } = state {
            if json.is_empty() {
                continue;
            }
            if !matches!(message.content.get(*content_index), Some(AssistantContent::ToolCall(_))) {
                return Err("Unreachable tool-call frame state".into());
            }
            pending_arguments.push((*content_index, parse_streaming_json(json)));
        }
    }
    for (content_index, parsed) in pending_arguments {
        if let Some(AssistantContent::ToolCall(block)) = message.content.get_mut(content_index) {
            block.arguments = parsed;
        }
    }
    Ok(Some(message))
}

fn append_block(
    message: &mut AssistantMessage,
    states: &mut HashMap<usize, ReducerBlockState>,
    content_index: usize,
    block: AssistantContent,
    state: ReducerBlockState,
) -> Result<(), String> {
    if content_index != message.content.len() {
        let reason = if content_index < message.content.len() { "already exists" } else { "would leave a gap" };
        return Err(format!("Cannot start assistant message block at index {content_index}: {reason}"));
    }
    message.content.push(block);
    states.insert(content_index, state);
    Ok(())
}

fn ensure_active(
    states: &HashMap<usize, ReducerBlockState>,
    content_index: usize,
    expected_kind: &str,
    frame_type: &str,
) -> Result<(), String> {
    let state = states
        .get(&content_index)
        .ok_or_else(|| format!("{frame_type} frame has no started block at index {content_index}"))?;
    let (kind, ended) = match state {
        ReducerBlockState::Text { ended } => ("text", *ended),
        ReducerBlockState::Thinking { ended } => ("thinking", *ended),
        ReducerBlockState::ToolCall { ended, .. } => ("toolCall", *ended),
    };
    if kind != expected_kind {
        return Err(format!(
            "{frame_type} frame expected {expected_kind} block at index {content_index}, found {kind}"
        ));
    }
    if ended {
        return Err(format!("{frame_type} frame follows the end of block at index {content_index}"));
    }
    Ok(())
}

fn end_state(states: &mut HashMap<usize, ReducerBlockState>, content_index: usize) {
    match states.get_mut(&content_index) {
        Some(ReducerBlockState::Text { ended })
        | Some(ReducerBlockState::Thinking { ended }) => *ended = true,
        Some(ReducerBlockState::ToolCall { ended, .. }) => *ended = true,
        None => {}
    }
}

fn frame_name(frame: &AssistantMessageFrame) -> &'static str {
    match frame {
        AssistantMessageFrame::Start { .. } => "start",
        AssistantMessageFrame::TextStart { .. } => "text_start",
        AssistantMessageFrame::TextDelta { .. } => "text_delta",
        AssistantMessageFrame::TextEnd { .. } => "text_end",
        AssistantMessageFrame::ThinkingStart { .. } => "thinking_start",
        AssistantMessageFrame::ThinkingDelta { .. } => "thinking_delta",
        AssistantMessageFrame::ThinkingEnd { .. } => "thinking_end",
        AssistantMessageFrame::ToolcallStart { .. } => "toolcall_start",
        AssistantMessageFrame::ToolcallCheckpoint { .. } => "toolcall_checkpoint",
        AssistantMessageFrame::ToolcallDelta { .. } => "toolcall_delta",
        AssistantMessageFrame::ToolcallEnd { .. } => "toolcall_end",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::types::{Api, Usage};

    fn base_message() -> AssistantMessage {
        AssistantMessage {
            content: vec![],
            api: Api::AnthropicMessages,
            provider: "p".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: StopReason::Pending,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: 0,
        }
    }

    fn with_content(mut message: AssistantMessage, content: Vec<AssistantContent>) -> AssistantMessage {
        message.content = content;
        message
    }

    #[test]
    fn encodes_and_reduces_a_full_stream() {
        let mut encoder = AssistantMessageFrameEncoder::new();

        let start_frame = encoder
            .encode(&AssistantMessageEvent::Start { partial: base_message() })
            .unwrap()
            .unwrap();
        let text_start = encoder
            .encode(&AssistantMessageEvent::TextStart {
                content_index: 0,
                // Text already visible in the partial at block start.
                partial: with_content(base_message(), vec![AssistantContent::Text(TextContent { text: "hi".into(), text_signature: None })]),
            })
            .unwrap()
            .unwrap();
        // Delta already covered by the start snapshot: not replayed.
        let covered = encoder
            .encode(&AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "hi".into(),
                partial: with_content(base_message(), vec![AssistantContent::Text(TextContent { text: "hi!".into(), text_signature: None })]),
            })
            .unwrap();
        assert!(covered.is_none(), "covered delta replayed: {covered:?}");
        let delta = encoder
            .encode(&AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "!".into(),
                partial: with_content(base_message(), vec![AssistantContent::Text(TextContent { text: "hi!".into(), text_signature: None })]),
            })
            .unwrap()
            .unwrap();
        let end = encoder
            .encode(&AssistantMessageEvent::TextEnd {
                content_index: 0,
                content: "hi!".into(),
                partial: with_content(base_message(), vec![AssistantContent::Text(TextContent { text: "hi!".into(), text_signature: Some("sig".into()) })]),
            })
            .unwrap()
            .unwrap();
        assert!(encoder
            .encode(&AssistantMessageEvent::Done { reason: StopReason::Stop, message: base_message() })
            .unwrap()
            .is_none());

        let frames = vec![start_frame, text_start, delta, end];
        let reduced = reduce_assistant_message_frames(&frames).unwrap().unwrap();
        assert_eq!(reduced.content.len(), 1);
        let AssistantContent::Text(text) = &reduced.content[0] else { panic!() };
        assert_eq!(text.text, "hi!");
        assert_eq!(text.text_signature.as_deref(), Some("sig"));
        assert_eq!(reduced.stop_reason, StopReason::Pending);
    }

    #[test]
    fn toolcall_frames_round_trip() {
        let mut encoder = AssistantMessageFrameEncoder::new();
        let tool_call = ToolCall { id: "t1".into(), name: "bash".into(), arguments: serde_json::json!({"cmd": "ls"}), thought_signature: None, namespace: None };
        let mut partial = base_message();
        partial.content = vec![AssistantContent::ToolCall(tool_call.clone())];

        let frames = vec![
            encoder.encode(&AssistantMessageEvent::Start { partial: base_message() }).unwrap().unwrap(),
            encoder
                .encode(&AssistantMessageEvent::ToolcallStart { content_index: 0, partial: partial.clone() })
                .unwrap()
                .unwrap(),
            encoder
                .encode(&AssistantMessageEvent::ToolcallEnd {
                    content_index: 0,
                    tool_call: tool_call.clone(),
                    partial: partial.clone(),
                })
                .unwrap()
                .unwrap(),
        ];

        let reduced = reduce_assistant_message_frames(&frames).unwrap().unwrap();
        let AssistantContent::ToolCall(call) = &reduced.content[0] else { panic!() };
        assert_eq!(call.id, "t1");
        assert_eq!(call.arguments, serde_json::json!({"cmd": "ls"}));
    }

    #[test]
    fn toolcall_delta_catchup_emits_checkpoint() {
        let mut encoder = AssistantMessageFrameEncoder::new();
        // Start snapshot carries partial arguments; the delta stream
        // replays them before extending.
        let start_call = ToolCall {
            id: "t2".into(),
            name: "edit".into(),
            arguments: serde_json::json!({"path": "a.rs"}),
            thought_signature: None,
            namespace: None,
        };
        let partial = with_content(base_message(), vec![AssistantContent::ToolCall(start_call)]);

        assert!(encoder.encode(&AssistantMessageEvent::Start { partial: base_message() }).unwrap().is_some());
        assert!(encoder
            .encode(&AssistantMessageEvent::ToolcallStart { content_index: 0, partial: partial.clone() })
            .unwrap()
            .is_some());
        let checkpoint = encoder
            .encode(&AssistantMessageEvent::ToolcallDelta {
                content_index: 0,
                delta: r#"{"path":"a.rs"}"#.into(),
                partial: partial.clone(),
            })
            .unwrap();
        let Some(AssistantMessageFrame::ToolcallCheckpoint { json, .. }) = checkpoint else {
            panic!("expected catch-up checkpoint");
        };
        assert_eq!(json, r#"{"path":"a.rs"}"#);

        // Caught up now: further deltas stream verbatim.
        let delta = encoder
            .encode(&AssistantMessageEvent::ToolcallDelta { content_index: 0, delta: "}".into(), partial })
            .unwrap()
            .unwrap();
        assert!(matches!(delta, AssistantMessageFrame::ToolcallDelta { .. }));
    }

    #[test]
    fn missing_start_yields_none() {
        let frames = vec![AssistantMessageFrame::TextDelta { content_index: 0, delta: "x".into() }];
        assert!(reduce_assistant_message_frames(&frames).unwrap().is_none());
    }

    #[test]
    fn frames_serialize_camel_case() {
        let frame = AssistantMessageFrame::TextEnd {
            content_index: 2,
            content: "done".into(),
            text_signature: Some("s".into()),
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["type"], "text_end");
        assert_eq!(json["contentIndex"], 2);
        assert_eq!(json["textSignature"], "s");
    }
}
