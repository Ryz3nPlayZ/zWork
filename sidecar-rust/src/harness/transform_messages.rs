//! Cross-model message normalization.
//!
//! Port of pi-mono `packages/ai/src/api/transform-messages.ts`: downgrade
//! images for non-vision models, strip/convert thinking blocks when the
//! transcript came from a different model, normalize tool-call ids, drop
//! errored/aborted assistant turns, and synthesize results for orphaned tool
//! calls so the API never sees a call without an answer.

use std::collections::{HashMap, HashSet};

use super::types::{
    now_ms, AssistantContent, AssistantMessage, Message, Model, StopReason, TextContent, ToolCall, ToolResultMessage,
    UserContent, UserMessageContent,
};

const NON_VISION_USER_IMAGE_PLACEHOLDER: &str = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER: &str = "(tool image omitted: model does not support images)";

fn replace_images_with_placeholder(content: &[UserContent], placeholder: &str) -> Vec<UserContent> {
    let mut out = Vec::with_capacity(content.len());
    let mut prev_was_placeholder = false;
    for block in content {
        match block {
            UserContent::Image(_) => {
                if !prev_was_placeholder {
                    out.push(UserContent::text(placeholder));
                }
                prev_was_placeholder = true;
            }
            UserContent::Text(t) => {
                prev_was_placeholder = t.text == placeholder;
                out.push(block.clone());
            }
        }
    }
    out
}

fn downgrade_unsupported_images(messages: Vec<Message>, model: &Model) -> Vec<Message> {
    if model.supports_images() {
        return messages;
    }
    messages
        .into_iter()
        .map(|m| match m {
            Message::User(mut u) => {
                if let UserMessageContent::Blocks(blocks) = &u.content {
                    u.content = UserMessageContent::Blocks(replace_images_with_placeholder(blocks, NON_VISION_USER_IMAGE_PLACEHOLDER));
                }
                Message::User(u)
            }
            Message::ToolResult(mut t) => {
                t.content = replace_images_with_placeholder(&t.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER);
                Message::ToolResult(t)
            }
            other => other,
        })
        .collect()
}

/// Normalize a transcript for `model`. `normalize_tool_call_id` runs only
/// for tool calls produced by a *different* model/provider.
pub fn transform_messages(
    messages: Vec<Message>,
    model: &Model,
    normalize_tool_call_id: Option<&dyn Fn(&str) -> String>,
) -> Vec<Message> {
    let mut id_map: HashMap<String, String> = HashMap::new();
    let image_aware = downgrade_unsupported_images(messages, model);

    // First pass: thinking-block + tool-call-id transforms.
    let transformed: Vec<Message> = image_aware
        .into_iter()
        .map(|msg| match msg {
            Message::ToolResult(mut t) => {
                if let Some(n) = id_map.get(&t.tool_call_id) {
                    if n != &t.tool_call_id {
                        t.tool_call_id = n.clone();
                    }
                }
                Message::ToolResult(t)
            }
            Message::Assistant(a) => {
                let is_same_model = a.provider == model.provider && a.api == model.api && a.model == model.id;
                let mut content: Vec<AssistantContent> = Vec::with_capacity(a.content.len());
                for block in a.content {
                    match block {
                        AssistantContent::Thinking(th) => {
                            if th.redacted == Some(true) {
                                if is_same_model {
                                    content.push(AssistantContent::Thinking(th));
                                }
                                continue;
                            }
                            if is_same_model && th.thinking_signature.is_some() {
                                content.push(AssistantContent::Thinking(th));
                                continue;
                            }
                            if th.thinking.trim().is_empty() {
                                continue;
                            }
                            if is_same_model {
                                content.push(AssistantContent::Thinking(th));
                            } else {
                                content.push(AssistantContent::Text(TextContent {
                                    text: th.thinking,
                                    text_signature: None,
                                }));
                            }
                        }
                        AssistantContent::Text(t) => {
                            if is_same_model {
                                content.push(AssistantContent::Text(t));
                            } else {
                                content.push(AssistantContent::Text(TextContent {
                                    text: t.text,
                                    text_signature: None,
                                }));
                            }
                        }
                        AssistantContent::ToolCall(mut tc) => {
                            if !is_same_model {
                                tc.thought_signature = None;
                                if let Some(f) = normalize_tool_call_id {
                                    let n = f(&tc.id);
                                    if n != tc.id {
                                        id_map.insert(tc.id.clone(), n.clone());
                                        tc.id = n;
                                    }
                                }
                            }
                            content.push(AssistantContent::ToolCall(tc));
                        }
                    }
                }
                Message::Assistant(AssistantMessage { content, ..a })
            }
            other => other,
        })
        .collect();

    // Second pass: synthesize results for orphaned tool calls, drop
    // errored/aborted assistant turns, hold system messages that land between
    // a call and its results.
    let mut result: Vec<Message> = Vec::with_capacity(transformed.len());
    let mut pending: Vec<ToolCall> = Vec::new();
    let mut existing_ids: HashSet<String> = HashSet::new();
    let mut held_system: Vec<Message> = Vec::new();

    fn close_pending(
        result: &mut Vec<Message>,
        pending: &mut Vec<ToolCall>,
        existing_ids: &mut HashSet<String>,
        held_system: &mut Vec<Message>,
    ) {
        if !pending.is_empty() {
            for tc in pending.drain(..) {
                if !existing_ids.contains(&tc.id) {
                    result.push(Message::ToolResult(ToolResultMessage {
                        tool_call_id: tc.id,
                        tool_name: tc.name,
                        content: vec![UserContent::text("No result provided")],
                        details: None,
                        usage: None,
                        is_error: true,
                        timestamp: now_ms(),
                    }));
                }
            }
            existing_ids.clear();
        }
        result.append(held_system);
    }

    for msg in transformed {
        match msg {
            Message::Assistant(a) => {
                close_pending(&mut result, &mut pending, &mut existing_ids, &mut held_system);
                if matches!(a.stop_reason, StopReason::Error | StopReason::Aborted) {
                    continue;
                }
                let calls: Vec<ToolCall> = a.content.iter().filter_map(|c| c.as_tool_call().cloned()).collect();
                if !calls.is_empty() {
                    pending = calls;
                    existing_ids.clear();
                }
                result.push(Message::Assistant(a));
            }
            Message::ToolResult(t) => {
                existing_ids.insert(t.tool_call_id.clone());
                result.push(Message::ToolResult(t));
            }
            Message::System(s) => {
                if !pending.is_empty() {
                    held_system.push(Message::System(s));
                } else {
                    result.push(Message::System(s));
                }
            }
            Message::User(u) => {
                close_pending(&mut result, &mut pending, &mut existing_ids, &mut held_system);
                result.push(Message::User(u));
            }
        }
    }
    close_pending(&mut result, &mut pending, &mut existing_ids, &mut held_system);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::types::{Api, InputType, ModelCost, ThinkingContent, Usage};
    use serde_json::json;

    fn model() -> Model {
        Model {
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
            context_window: 1,
            max_tokens: 1,
            headers: None,
            compat: None,
        }
    }

    fn assistant(model: &Model, content: Vec<AssistantContent>, stop: StopReason) -> Message {
        Message::Assistant(AssistantMessage {
            content,
            api: model.api,
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: stop,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: 0,
        })
    }

    fn tc(id: &str) -> AssistantContent {
        AssistantContent::ToolCall(ToolCall {
            id: id.into(),
            name: "read".into(),
            arguments: json!({}),
            thought_signature: None,
            namespace: None,
        })
    }

    #[test]
    fn synthesizes_orphan_results_and_drops_errored() {
        let m = model();
        let msgs = vec![
            Message::user_text("a"),
            assistant(&m, vec![tc("1"), tc("2")], StopReason::ToolUse),
            Message::ToolResult(ToolResultMessage {
                tool_call_id: "1".into(),
                tool_name: "read".into(),
                content: vec![UserContent::text("ok")],
                details: None,
                usage: None,
                is_error: false,
                timestamp: 0,
            }),
            Message::user_text("b"),
            assistant(&m, vec![], StopReason::Error),
        ];
        let out = transform_messages(msgs, &m, None);
        assert_eq!(out.len(), 5);
        match &out[3] {
            Message::ToolResult(t) => {
                assert_eq!(t.tool_call_id, "2");
                assert!(t.is_error);
            }
            _ => panic!("expected synthetic result"),
        }
        assert!(matches!(out[4], Message::User(_)));
    }

    #[test]
    fn cross_model_thinking_becomes_text_and_ids_normalize() {
        let m = model();
        let mut other = m.clone();
        other.id = "other".into();
        let msgs = vec![
            assistant(
                &other,
                vec![
                    AssistantContent::Thinking(ThinkingContent {
                        thinking: "hmm".into(),
                        thinking_signature: Some("sig".into()),
                        redacted: None,
                    }),
                    tc("call|item"),
                ],
                StopReason::ToolUse,
            ),
            Message::ToolResult(ToolResultMessage {
                tool_call_id: "call|item".into(),
                tool_name: "read".into(),
                content: vec![],
                details: None,
                usage: None,
                is_error: false,
                timestamp: 0,
            }),
        ];
        let norm = |id: &str| id.replace('|', "_");
        let out = transform_messages(msgs, &m, Some(&norm));
        let a = out[0].as_assistant().unwrap();
        assert!(matches!(a.content[0], AssistantContent::Text(_)));
        assert_eq!(a.content[1].as_tool_call().unwrap().id, "call_item");
        match &out[1] {
            Message::ToolResult(t) => assert_eq!(t.tool_call_id, "call_item"),
            _ => panic!(),
        }
    }

    #[test]
    fn downgrades_images_for_text_models() {
        let m = model();
        let msgs = vec![Message::user_blocks(vec![
            UserContent::text("see"),
            UserContent::Image(crate::harness::types::ImageContent {
                data: "AAA".into(),
                mime_type: "image/png".into(),
            }),
        ])];
        let out = transform_messages(msgs, &m, None);
        match &out[0] {
            Message::User(u) => match &u.content {
                UserMessageContent::Blocks(b) => {
                    assert_eq!(b.len(), 2);
                    assert!(matches!(&b[1], UserContent::Text(t) if t.text == NON_VISION_USER_IMAGE_PLACEHOLDER));
                }
                _ => panic!(),
            },
            _ => panic!(),
        }
    }
}
