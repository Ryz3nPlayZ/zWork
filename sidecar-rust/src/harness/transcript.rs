//! Transcript replay helpers.
//!
//! Port of pi-mono `packages/ai/src/utils/transcript.ts` and `utils/text.ts`.
//! The system prompt and tool declarations live inside system messages; these
//! helpers replay them into "current" state or fold them for APIs that can't
//! take system messages mid-conversation.

use std::collections::BTreeMap;

use serde_json::Value;

use super::types::{Message, SystemMessage, Tool, ToolReference, TranscriptContext};

/// Build the leading system message for a prompt and tool set. `None` when
/// both are empty, so an empty transcript stays empty.
pub fn create_initial_system_message(system_prompt: Option<&str>, tools: Option<&[Tool]>) -> Option<SystemMessage> {
    let has_prompt = system_prompt.map_or(false, |s| !s.is_empty());
    let has_tools = tools.map_or(false, |t| !t.is_empty());
    if !has_prompt && !has_tools {
        return None;
    }
    Some(SystemMessage {
        content: system_prompt.unwrap_or("").to_string(),
        sections: None,
        tools_added: if has_tools { tools.map(|t| t.to_vec()) } else { None },
        tools_removed: None,
        timestamp: 0,
    })
}

/// Fold a prompt and tools into a leading system message ahead of `messages`.
pub fn normalize_context(system_prompt: Option<&str>, tools: Option<&[Tool]>, messages: Vec<Message>) -> TranscriptContext {
    let mut out = Vec::with_capacity(messages.len() + 1);
    if let Some(initial) = create_initial_system_message(system_prompt, tools) {
        out.push(Message::System(initial));
    }
    out.extend(messages);
    TranscriptContext { messages: out }
}

/// Leading system message, if the transcript starts with one.
pub fn get_initial_system_message(messages: &[Message]) -> Option<&SystemMessage> {
    messages.first().and_then(|m| m.as_system())
}

/// Drop the leading system message for APIs that carry the prompt outside
/// the message list.
pub fn without_initial_system_message(messages: &[Message]) -> &[Message] {
    if get_initial_system_message(messages).is_some() {
        &messages[1..]
    } else {
        messages
    }
}

/// Tools available after applying every transcript delta in order.
pub fn get_current_tools(messages: &[Message]) -> Vec<Tool> {
    // Insertion-ordered map: pi uses a JS Map, which preserves first-insert
    // order and keeps that slot on overwrite.
    let mut order: Vec<String> = Vec::new();
    let mut tools: BTreeMap<String, Tool> = BTreeMap::new();
    for m in messages {
        let Some(sm) = m.as_system() else { continue };
        for r in sm.tools_removed.iter().flatten() {
            tools.remove(&r.name);
            order.retain(|n| n != &r.name);
        }
        for t in sm.tools_added.iter().flatten() {
            if !tools.contains_key(&t.name) {
                order.push(t.name.clone());
            }
            tools.insert(t.name.clone(), t.clone());
        }
    }
    order.into_iter().filter_map(|n| tools.remove(&n)).collect()
}

/// Replay every system message into one leading system message holding the
/// current prompt and tools.
pub fn get_current_system_message(messages: &[Message]) -> Option<SystemMessage> {
    let mut content: Vec<String> = Vec::new();
    let mut sections: BTreeMap<String, String> = BTreeMap::new();
    let mut timestamp: Option<i64> = None;
    for m in messages {
        let Some(sm) = m.as_system() else { continue };
        if timestamp.is_none() {
            timestamp = Some(sm.timestamp);
        }
        if !sm.content.is_empty() {
            content.push(sm.content.clone());
        }
        for (name, value) in sm.sections.iter().flatten() {
            match value {
                None => {
                    sections.remove(name);
                }
                Some(v) => {
                    sections.insert(name.clone(), v.clone());
                }
            }
        }
    }
    let tools = get_current_tools(messages);
    if timestamp.is_none() && tools.is_empty() {
        return None;
    }
    Some(SystemMessage {
        content: content.join("\n\n"),
        sections: if sections.is_empty() {
            None
        } else {
            Some(sections.into_iter().map(|(k, v)| (k, Some(v))).collect())
        },
        tools_added: if tools.is_empty() { None } else { Some(tools) },
        tools_removed: None,
        timestamp: timestamp.unwrap_or(0),
    })
}

/// Current system prompt text after replaying every system message.
pub fn get_current_system_prompt(messages: &[Message]) -> String {
    get_current_system_message(messages)
        .map(|m| get_system_message_text(&m))
        .unwrap_or_default()
}

/// Rebuild the transcript for APIs without mid-conversation system messages.
pub fn collapse_system_messages(context: &TranscriptContext) -> TranscriptContext {
    let head = get_current_system_message(&context.messages);
    let mut messages: Vec<Message> = Vec::with_capacity(context.messages.len());
    if let Some(h) = head {
        messages.push(Message::System(h));
    }
    messages.extend(context.messages.iter().filter(|m| m.as_system().is_none()).cloned());
    TranscriptContext { messages }
}

/// Keep later system messages when the model accepts them; else collapse.
pub fn resolve_transcript(context: &TranscriptContext, supports_mid_convo_system_messages: bool) -> TranscriptContext {
    if supports_mid_convo_system_messages {
        context.clone()
    } else {
        collapse_system_messages(context)
    }
}

/// Strip everything but the model-facing declaration.
pub fn to_tool_declaration(tool: &Tool) -> Tool {
    Tool {
        name: tool.name.clone(),
        description: tool.description.clone(),
        parameters: tool.parameters.clone(),
    }
}

pub fn declarations_equal(left: &Tool, right: &Tool) -> bool {
    left.name == right.name && left.description == right.description && left.parameters == right.parameters
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolStateChanges {
    pub tools_added: Vec<Tool>,
    pub tools_removed: Vec<ToolReference>,
}

/// Compare two complete tool states. A changed definition is a removal
/// followed by an addition.
pub fn get_tool_state_changes(previous: &[Tool], current: &[Tool]) -> ToolStateChanges {
    let tools_added = current
        .iter()
        .filter(|t| match previous.iter().find(|p| p.name == t.name) {
            None => true,
            Some(p) => !declarations_equal(p, t),
        })
        .map(to_tool_declaration)
        .collect();
    let tools_removed = previous
        .iter()
        .filter(|p| match current.iter().find(|c| c.name == p.name) {
            None => true,
            Some(c) => !declarations_equal(p, c),
        })
        .map(|t| ToolReference { name: t.name.clone() })
        .collect();
    ToolStateChanges {
        tools_added,
        tools_removed,
    }
}

/// Every definition referenced by transcript tool state, in first-declaration order.
pub fn get_declared_tools(messages: &[Message]) -> Vec<Tool> {
    let mut order: Vec<String> = Vec::new();
    let mut defs: BTreeMap<String, Tool> = BTreeMap::new();
    for m in messages {
        let Some(sm) = m.as_system() else { continue };
        for t in sm.tools_added.iter().flatten() {
            if !defs.contains_key(&t.name) {
                order.push(t.name.clone());
            }
            defs.insert(t.name.clone(), t.clone());
        }
    }
    order.into_iter().filter_map(|n| defs.remove(&n)).collect()
}

pub fn has_tool_history(messages: &[Message]) -> bool {
    messages.iter().any(|m| match m {
        Message::ToolResult(_) => true,
        Message::Assistant(a) => a.content.iter().any(|c| c.as_tool_call().is_some()),
        _ => false,
    })
}

/// Whether tool history contains a removal or same-name redeclaration.
pub fn has_non_additive_tool_changes(messages: &[Message]) -> bool {
    let mut declared: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for m in messages {
        let Some(sm) = m.as_system() else { continue };
        if sm.tools_removed.as_ref().map_or(false, |r| !r.is_empty()) {
            return true;
        }
        for t in sm.tools_added.iter().flatten() {
            if !declared.insert(t.name.as_str()) {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone, Default)]
pub struct TranscriptTools {
    /// Tools sent in the top-level request field.
    pub request_tools: Vec<Tool>,
    /// Whether later system messages carry their own `toolsAdded` in place.
    pub anchors_additions: bool,
}

/// Split tool declarations between the top-level request field and in-place
/// additions.
pub fn resolve_transcript_tools(messages: &[Message], supports_tool_additions: bool) -> TranscriptTools {
    let anchors_additions = supports_tool_additions && !has_non_additive_tool_changes(messages);
    TranscriptTools {
        request_tools: if anchors_additions {
            get_initial_system_message(messages)
                .and_then(|m| m.tools_added.clone())
                .unwrap_or_default()
        } else {
            get_current_tools(messages)
        },
        anchors_additions,
    }
}

// ---------------------------------------------------------------------------
// text.ts
// ---------------------------------------------------------------------------

/// Render a system message as a complete prompt: content then sections.
pub fn get_system_message_text(message: &SystemMessage) -> String {
    let mut parts: Vec<&str> = vec![message.content.as_str()];
    for v in message.sections.iter().flatten().filter_map(|(_, v)| v.as_deref()) {
        parts.push(v);
    }
    parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// Render a later system message for APIs that accept mid-conversation
/// system messages. Section changes are framed by name.
pub fn render_system_message_update(message: &SystemMessage) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !message.content.is_empty() {
        parts.push(message.content.clone());
    }
    for (name, value) in message.sections.iter().flatten() {
        parts.push(match value {
            None => format!("Removed system prompt section \"{name}\"."),
            Some(v) => format!("Updated system prompt section \"{name}\":\n\n{v}"),
        });
    }
    parts.join("\n\n")
}

/// Convenience for building a tool declaration from name/description/schema.
pub fn tool(name: &str, description: &str, parameters: Value) -> Tool {
    Tool {
        name: name.to_string(),
        description: description.to_string(),
        parameters,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t(name: &str) -> Tool {
        tool(name, "d", json!({"type":"object","properties":{}}))
    }

    #[test]
    fn replays_tools_and_sections() {
        let msgs = vec![
            Message::System(SystemMessage {
                content: "base".into(),
                sections: Some(BTreeMap::from([("a".to_string(), Some("A1".to_string()))])),
                tools_added: Some(vec![t("x"), t("y")]),
                tools_removed: None,
                timestamp: 1,
            }),
            Message::user_text("hi"),
            Message::System(SystemMessage {
                content: String::new(),
                sections: Some(BTreeMap::from([
                    ("a".to_string(), Some("A2".to_string())),
                    ("b".to_string(), Some("B".to_string())),
                ])),
                tools_added: Some(vec![t("z")]),
                tools_removed: Some(vec![ToolReference { name: "x".into() }]),
                timestamp: 2,
            }),
        ];
        let tools = get_current_tools(&msgs);
        assert_eq!(tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["y", "z"]);
        let prompt = get_current_system_prompt(&msgs);
        assert_eq!(prompt, "base\n\nA2\n\nB");
        let collapsed = collapse_system_messages(&TranscriptContext { messages: msgs.clone() });
        assert_eq!(collapsed.messages.len(), 2);
        assert!(has_non_additive_tool_changes(&msgs));
        let rt = resolve_transcript_tools(&msgs, true);
        assert!(!rt.anchors_additions);
        assert_eq!(rt.request_tools.len(), 2);
    }

    #[test]
    fn state_changes_diff() {
        let prev = vec![t("a"), t("b")];
        let mut b2 = t("b");
        b2.description = "changed".into();
        let cur = vec![b2, t("c")];
        let d = get_tool_state_changes(&prev, &cur);
        assert_eq!(d.tools_added.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["b", "c"]);
        assert_eq!(d.tools_removed.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    }

    #[test]
    fn render_update() {
        let m = SystemMessage {
            content: String::new(),
            sections: Some(BTreeMap::from([("s".to_string(), None)])),
            tools_added: None,
            tools_removed: None,
            timestamp: 0,
        };
        assert_eq!(render_system_message_update(&m), "Removed system prompt section \"s\".");
    }
}
