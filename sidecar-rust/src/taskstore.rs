use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::paths::tasks_path;

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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(default = "default_inbox")]
    pub column: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub completed_at: Option<u64>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub assignee: String,
    #[serde(default = "default_medium")]
    pub priority: String,
}

fn default_inbox() -> String { "inbox".to_string() }
fn default_medium() -> String { "medium".to_string() }

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub date: String,
    pub created_at: u64,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct TaskStoreData {
    #[serde(default)]
    tasks: Vec<Task>,
    #[serde(default)]
    events: Vec<CalendarEvent>,
}

// ─── Persistence ──────────────────────────────────────────────────────────────

fn load_data() -> TaskStoreData {
    let p = tasks_path();
    if !p.exists() {
        return TaskStoreData::default();
    }
    let content = match fs::read_to_string(&p) {
        Ok(c) => c,
        Err(_) => return TaskStoreData::default(),
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_data(data: &TaskStoreData) {
    let p = tasks_path();
    if let Ok(content) = serde_json::to_string_pretty(data) {
        let tmp = p.with_extension("tmp");
        if fs::write(&tmp, content).is_ok() {
            let _ = fs::rename(tmp, p);
        }
    }
}

// ─── Task CRUD ────────────────────────────────────────────────────────────────

pub fn get_tasks() -> Vec<Task> {
    load_data().tasks
}

pub fn create_task(
    title: String,
    column: Option<String>,
    description: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    assignee: Option<String>,
) -> Task {
    let mut data = load_data();
    let now = now_ms();
    let task = Task {
        id: uid(),
        title,
        column: column.unwrap_or_else(default_inbox),
        created_at: now,
        updated_at: now,
        due_date,
        completed_at: None,
        description: description.unwrap_or_default(),
        assignee: assignee.unwrap_or_default(),
        priority: priority.unwrap_or_else(default_medium),
    };
    data.tasks.push(task.clone());
    save_data(&data);
    task
}

pub fn update_task(
    task_id: &str,
    title: Option<String>,
    column: Option<String>,
    description: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    assignee: Option<String>,
) -> Option<Task> {
    let mut data = load_data();
    let task = data.tasks.iter_mut().find(|t| t.id == task_id)?;
    if let Some(t) = title { task.title = t; }
    if let Some(c) = column {
        // Auto-set completed_at when moving to done
        if c == "done" && task.column != "done" {
            task.completed_at = Some(now_ms());
        }
        task.column = c;
    }
    if let Some(d) = description { task.description = d; }
    if let Some(p) = priority { task.priority = p; }
    if due_date.is_some() { task.due_date = due_date; }
    if let Some(a) = assignee { task.assignee = a; }
    task.updated_at = now_ms();
    let result = task.clone();
    save_data(&data);
    Some(result)
}

pub fn update_task_column(task_id: &str, column: &str) -> Option<Task> {
    let mut data = load_data();
    let task = data.tasks.iter_mut().find(|t| t.id == task_id)?;
    if column == "done" && task.column != "done" {
        task.completed_at = Some(now_ms());
    }
    task.column = column.to_string();
    task.updated_at = now_ms();
    let result = task.clone();
    save_data(&data);
    Some(result)
}

pub fn delete_task(task_id: &str) -> bool {
    let mut data = load_data();
    let before = data.tasks.len();
    data.tasks.retain(|t| t.id != task_id);
    if data.tasks.len() != before {
        save_data(&data);
        true
    } else {
        false
    }
}

// ─── Event CRUD ───────────────────────────────────────────────────────────────

pub fn get_events() -> Vec<CalendarEvent> {
    load_data().events
}

pub fn create_event(
    title: String,
    date: String,
    start_time: Option<String>,
    end_time: Option<String>,
) -> CalendarEvent {
    let mut data = load_data();
    let event = CalendarEvent {
        id: uid(),
        title,
        date,
        created_at: now_ms(),
        start_time,
        end_time,
    };
    data.events.push(event.clone());
    save_data(&data);
    event
}

pub fn delete_event(event_id: &str) -> bool {
    let mut data = load_data();
    let before = data.events.len();
    data.events.retain(|e| e.id != event_id);
    if data.events.len() != before {
        save_data(&data);
        true
    } else {
        false
    }
}
