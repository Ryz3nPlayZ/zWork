//! `update_todos` tool — lets the agent maintain a live todo list of its
//! current task. The agent sends the full replacement list each call; this
//! tool validates/normalizes it and forwards it to the UI as a `todo_update`
//! SSE event (the agent loop passes through any non-`activity`/`tool_result`
//! event unchanged). No persistence — the snapshot lives in the frontend
//! store, scoped to the active chat.

use serde_json::{json, Value};
use tokio::sync::mpsc;

/// Hard caps to keep a misbehaving model from flooding the UI.
const MAX_ITEMS: usize = 50;
const MAX_CONTENT_CHARS: usize = 200;
const MAX_ID_CHARS: usize = 64;

/// Normalize one todo object: coerce id/content to trimmed strings, validate
/// the status enum, and clamp lengths. Returns None if the entry is unusable
/// (missing/empty id or content).
fn normalize_todo(v: &Value) -> Option<Value> {
    let obj = v.as_object()?;
    let id = obj.get("id")?.as_str()?.trim();
    if id.is_empty() || id.len() > MAX_ID_CHARS {
        return None;
    }
    let content = obj.get("content")?.as_str()?.trim();
    if content.is_empty() {
        return None;
    }
    let content: String = content.chars().take(MAX_CONTENT_CHARS).collect();
    let status = match obj.get("status").and_then(|s| s.as_str()).unwrap_or("pending") {
        "completed" => "completed",
        "in_progress" => "in_progress",
        _ => "pending",
    };
    Some(json!({ "id": id, "content": content, "status": status }))
}

/// Execute `update_todos`. Emits a `todo_update` event carrying the normalized
/// list, then returns a short ack string for the tool_result frame.
pub async fn execute_update_todos(
    params: &Value,
    tx: &mpsc::Sender<Value>,
) -> Result<String, String> {
    let raw_list = match params.get("todos").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Err("`todos` must be an array.".to_string()),
    };

    let mut todos: Vec<Value> = Vec::with_capacity(raw_list.len().min(MAX_ITEMS));
    for item in raw_list {
        if todos.len() >= MAX_ITEMS {
            break;
        }
        if let Some(norm) = normalize_todo(item) {
            todos.push(norm);
        }
    }

    let count = todos.len();

    // Forward the snapshot to the UI. The agent loop forwards this event
    // through unchanged (it isn't `activity` or `tool_result`).
    let _ = tx
        .send(json!({ "type": "todo_update", "todos": todos }))
        .await;

    Ok(format!("Todos updated ({} item{}).", count, if count == 1 { "" } else { "s" }))
}
