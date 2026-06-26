use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use crate::paths::chats_dir;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub role: String, // "user" | "assistant" | "system"
    pub content: Value,
    pub created_at: u64,
    #[serde(default)]
    pub activities: Vec<Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub compacted_summary: String,
    #[serde(default)]
    pub compaction_cursor: u64,
}

fn chat_file_path(chat_id: &str) -> PathBuf {
    chats_dir().join(format!("{}.json", chat_id))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn uid() -> String {
    Uuid::new_v4().simple().to_string()
}

pub fn create(title: &str, model: &str, project_id: &str) -> Chat {
    let now = now_ms();
    let c = Chat {
        id: uid(),
        title: title.to_string(),
        created_at: now,
        updated_at: now,
        messages: Vec::new(),
        model: model.to_string(),
        project_id: project_id.to_string(),
        compacted_summary: String::new(),
        compaction_cursor: 0,
    };
    save(&c);
    c
}

pub fn list_all() -> Vec<Value> {
    let mut out = Vec::new();
    let dir = chats_dir();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(d) = serde_json::from_str::<Value>(&content) {
                        let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let title = d.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
                        let created_at = d.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
                        let updated_at = d.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(0);
                        let message_count = d.get("messages").and_then(|v| v.as_array()).map_or(0, |a| a.len());
                        let model = d.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let project_id = d.get("project_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        
                        out.push(serde_json::json!({
                            "id": id,
                            "title": title,
                            "created_at": created_at,
                            "updated_at": updated_at,
                            "message_count": message_count,
                            "model": model,
                            "project_id": project_id
                        }));
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| {
        let a_time = a.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(0);
        let b_time = b.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(0);
        b_time.cmp(&a_time)
    });
    out
}

pub fn get(chat_id: &str) -> Option<Chat> {
    let p = chat_file_path(chat_id);
    if !p.exists() {
        return None;
    }
    let content = fs::read_to_string(p).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save(chat: &Chat) {
    let p = chat_file_path(&chat.id);
    if let Ok(content) = serde_json::to_string_pretty(chat) {
        let tmp = p.with_extension("tmp");
        if fs::write(&tmp, content).is_ok() {
            let _ = fs::rename(tmp, p);
        }
    }
}

pub fn delete(chat_id: &str) -> bool {
    let p = chat_file_path(chat_id);
    if p.exists() {
        fs::remove_file(p).is_ok()
    } else {
        false
    }
}

pub fn rename(chat_id: &str, title: &str) -> Option<Chat> {
    let mut c = get(chat_id)?;
    c.title = title.to_string();
    c.updated_at = now_ms();
    save(&c);
    Some(c)
}

/// Extract displayable plain text from a stored message `content` value.
///
/// `content` is normally a JSON string, but older chats stored Anthropic
/// content blocks — either a single `{type,text}` object or an array of them
/// — which the frontend cannot render (React #31: "object with keys {text,
/// type}") and which `as_str()` cannot read. This normalizes every shape to a
/// plain string so display, auto-titling, and de-dup all compare text.
pub fn content_to_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(str::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => {
            if v.get("type").and_then(|t| t.as_str()) == Some("text") {
                v.get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

pub fn append_message(chat_id: &str, role: &str, content: Value) -> Option<ChatMessage> {
    let mut c = get(chat_id)?;
    let msg = ChatMessage {
        id: uid(),
        role: role.to_string(),
        content: content.clone(),
        created_at: now_ms(),
        activities: Vec::new(),
    };
    
    c.messages.push(msg.clone());
    c.updated_at = msg.created_at;
    
    // Auto-title from first user message
    if c.title == "New chat" && role == "user" {
        let txt = content_to_text(&content);
        if !txt.is_empty() {
            let first_line = txt.lines().next().unwrap_or("").trim();
            // Slice on char boundaries so multi-byte (emoji/CJK) first lines
            // don't panic the backend mid-turn.
            let title: String = first_line.chars().take(64).collect();
            if !title.is_empty() {
                c.title = title;
            }
        }
    }
    
    save(&c);
    Some(msg)
}

pub fn update_message(
    chat_id: &str,
    message_id: &str,
    content: Option<Value>,
    activities: Option<Vec<Value>>,
) -> Option<ChatMessage> {
    let mut c = get(chat_id)?;
    let mut updated = None;
    for msg in &mut c.messages {
        if msg.id == message_id {
            if let Some(ref val) = content {
                msg.content = val.clone();
            }
            if let Some(ref acts) = activities {
                msg.activities = acts.clone();
            }
            updated = Some(msg.clone());
            break;
        }
    }
    if updated.is_some() {
        c.updated_at = now_ms();
        save(&c);
    }
    updated
}

pub fn set_project(chat_id: &str, project_id: &str) -> Option<Chat> {
    let mut c = get(chat_id)?;
    c.project_id = project_id.to_string();
    c.updated_at = now_ms();
    save(&c);
    Some(c)
}

pub fn set_compaction(chat_id: &str, summary: &str, cursor: u64) -> Option<Chat> {
    let mut c = get(chat_id)?;
    c.compacted_summary = summary.to_string();
    c.compaction_cursor = cursor;
    c.updated_at = now_ms();
    save(&c);
    Some(c)
}

/// Remove all messages after the given message_id, optionally updating that
/// message's content. Returns the updated chat.
pub fn truncate_at_message(chat_id: &str, message_id: &str, content: Option<Value>) -> Option<Chat> {
    let mut c = get(chat_id)?;
    let pos = c.messages.iter().position(|m| m.id == message_id)?;
    // Optionally update the truncation target message
    if let Some(ref val) = content {
        c.messages[pos].content = val.clone();
    }
    // Keep only messages up to and including the target
    c.messages.truncate(pos + 1);
    c.updated_at = now_ms();
    save(&c);
    Some(c)
}
