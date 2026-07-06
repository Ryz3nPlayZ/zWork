use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::paths::inbox_path;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn uid() -> String {
    Uuid::new_v4().simple().to_string()
}

// ─── Data Structures ──────────────────────────────────────────────────────────

/// A message the agent pushes to the user unprompted. This is the agent's
/// outbound channel — distinct from chat (where the user initiates). Items are
/// created by scheduled-task runs (summaries, flags, questions, errors) or by
/// `post_to_inbox` tool calls from interactive chats.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct InboxItem {
    pub id: String,
    /// The scheduled task that produced this, if any. `None` for items posted
    /// from interactive chat or manually.
    #[serde(default)]
    pub task_id: Option<String>,
    /// The run's automation chat id, so the UI can deep-link into the transcript.
    #[serde(default)]
    pub chat_id: Option<String>,
    /// `"summary"` | `"flag"` | `"question"` | `"error"`
    #[serde(default = "default_kind")]
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub created_at: u64,
    #[serde(default)]
    pub read: bool,
}

fn default_kind() -> String { "summary".to_string() }

#[derive(Serialize, Deserialize, Default)]
struct InboxStoreData {
    #[serde(default)]
    items: Vec<InboxItem>,
}

// ─── Persistence ──────────────────────────────────────────────────────────────

fn load_data() -> InboxStoreData {
    let p = inbox_path();
    if !p.exists() {
        return InboxStoreData::default();
    }
    let content = match fs::read_to_string(&p) {
        Ok(c) => c,
        Err(_) => return InboxStoreData::default(),
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_data(data: &InboxStoreData) {
    let p = inbox_path();
    if let Ok(content) = serde_json::to_string_pretty(data) {
        let tmp = p.with_extension("tmp");
        if fs::write(&tmp, content).is_ok() {
            let _ = fs::rename(tmp, p);
        }
    }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/// All items, newest first. If `unread_only` is true, only unread items.
pub fn get_all(unread_only: bool) -> Vec<InboxItem> {
    let mut items = load_data().items;
    if unread_only {
        items.retain(|i| !i.read);
    }
    items.sort_by_key(|i| std::cmp::Reverse(i.created_at));
    items
}

#[derive(Default)]
pub struct CreateParams {
    pub task_id: Option<String>,
    pub chat_id: Option<String>,
    pub kind: Option<String>,
    pub title: String,
    pub body: Option<String>,
}

pub fn create(p: CreateParams) -> InboxItem {
    let mut data = load_data();
    let item = InboxItem {
        id: uid(),
        task_id: p.task_id,
        chat_id: p.chat_id,
        kind: p.kind.unwrap_or_else(default_kind),
        title: p.title,
        body: p.body.unwrap_or_default(),
        created_at: now_ms(),
        read: false,
    };
    data.items.push(item.clone());
    save_data(&data);
    item
}

pub fn mark_read(item_id: &str) -> bool {
    let mut data = load_data();
    let item = data.items.iter_mut().find(|i| i.id == item_id);
    if let Some(i) = item {
        i.read = true;
        save_data(&data);
        true
    } else {
        false
    }
}

pub fn mark_all_read() -> usize {
    let mut data = load_data();
    let mut changed = 0;
    for i in data.items.iter_mut() {
        if !i.read {
            i.read = true;
            changed += 1;
        }
    }
    if changed > 0 {
        save_data(&data);
    }
    changed
}

pub fn delete(item_id: &str) -> bool {
    let mut data = load_data();
    let before = data.items.len();
    data.items.retain(|i| i.id != item_id);
    if data.items.len() != before {
        save_data(&data);
        true
    } else {
        false
    }
}
