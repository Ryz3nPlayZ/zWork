use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::paths::schedules_path;

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

/// A user-configured recurring task. The scheduler loop fires it on its
/// schedule and posts findings to the inbox.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ScheduledTask {
    pub id: String,
    pub title: String,
    /// The objective sent to the agent as the user message on each run.
    pub prompt: String,
    /// v1 only supports `"time"`. Reserved for future `"event"` triggers
    /// (e.g. "when an email from X arrives").
    #[serde(default = "default_trigger_time")]
    pub trigger_type: String,
    /// Every N minutes. Mutually exclusive with `daily_time`.
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    /// `"HH:MM"` (24h, local time). Mutually exclusive with `interval_minutes`.
    #[serde(default)]
    pub daily_time: Option<String>,
    /// Weekdays the daily task runs. 0=Sun..6=Sat. `None`/empty = every day.
    #[serde(default)]
    pub daily_weekdays: Option<Vec<u32>>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Where run findings get delivered. v1 = `"inbox"` (default).
    #[serde(default = "default_inbox_channel")]
    pub notify_channel: String,
    /// Override model; `None` = use the default model from settings.
    #[serde(default)]
    pub model: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub last_run_at: Option<u64>,
    #[serde(default)]
    pub next_run_at: Option<u64>,
    /// The most recent run's automation chat id.
    #[serde(default)]
    pub last_chat_id: Option<String>,
}

fn default_trigger_time() -> String { "time".to_string() }
fn default_true() -> bool { true }
fn default_inbox_channel() -> String { "inbox".to_string() }

#[derive(Serialize, Deserialize, Default)]
struct ScheduleStoreData {
    #[serde(default)]
    tasks: Vec<ScheduledTask>,
}

// ─── Persistence ──────────────────────────────────────────────────────────────

fn load_data() -> ScheduleStoreData {
    let p = schedules_path();
    if !p.exists() {
        return ScheduleStoreData::default();
    }
    let content = match fs::read_to_string(&p) {
        Ok(c) => c,
        Err(_) => return ScheduleStoreData::default(),
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_data(data: &ScheduleStoreData) {
    let p = schedules_path();
    if let Ok(content) = serde_json::to_string_pretty(data) {
        let tmp = p.with_extension("tmp");
        if fs::write(&tmp, content).is_ok() {
            let _ = fs::rename(tmp, p);
        }
    }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

pub fn get_all() -> Vec<ScheduledTask> {
    load_data().tasks
}

pub fn get(task_id: &str) -> Option<ScheduledTask> {
    load_data().tasks.into_iter().find(|t| t.id == task_id)
}

/// Count of currently enabled tasks. Used for free-tier task-cap enforcement.
pub fn count_enabled() -> usize {
    load_data().tasks.iter().filter(|t| t.enabled).count()
}

#[derive(Default)]
pub struct CreateParams {
    pub title: String,
    pub prompt: String,
    pub trigger_type: Option<String>,
    pub interval_minutes: Option<u32>,
    pub daily_time: Option<String>,
    pub daily_weekdays: Option<Vec<u32>>,
    pub enabled: Option<bool>,
    pub notify_channel: Option<String>,
    pub model: Option<String>,
}

pub fn create(p: CreateParams) -> ScheduledTask {
    let mut data = load_data();
    let now = now_ms();
    let task = ScheduledTask {
        id: uid(),
        title: p.title,
        prompt: p.prompt,
        trigger_type: p.trigger_type.unwrap_or_else(default_trigger_time),
        interval_minutes: p.interval_minutes,
        daily_time: p.daily_time,
        daily_weekdays: p.daily_weekdays,
        enabled: p.enabled.unwrap_or(true),
        notify_channel: p.notify_channel.unwrap_or_else(default_inbox_channel),
        model: p.model,
        created_at: now,
        updated_at: now,
        last_run_at: None,
        next_run_at: None,
        last_chat_id: None,
    };
    data.tasks.push(task.clone());
    save_data(&data);
    task
}

#[derive(Default)]
pub struct UpdateParams {
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub trigger_type: Option<String>,
    pub interval_minutes: Option<Option<u32>>,
    pub daily_time: Option<Option<String>>,
    pub daily_weekdays: Option<Option<Vec<u32>>>,
    pub enabled: Option<bool>,
    pub notify_channel: Option<String>,
    pub model: Option<Option<String>>,
}

/// Update a scheduled task. The `Option<Option<T>>` fields let callers
/// distinguish "leave unchanged" (`None`) from "clear this field"
/// (`Some(None)`), which matters for switching between interval and daily.
pub fn update(task_id: &str, p: UpdateParams) -> Option<ScheduledTask> {
    let mut data = load_data();
    let task = data.tasks.iter_mut().find(|t| t.id == task_id)?;
    if let Some(t) = p.title { task.title = t; }
    if let Some(pr) = p.prompt { task.prompt = pr; }
    if let Some(tt) = p.trigger_type { task.trigger_type = tt; }
    if let Some(im) = p.interval_minutes { task.interval_minutes = im; }
    if let Some(dt) = p.daily_time { task.daily_time = dt; }
    if let Some(dw) = p.daily_weekdays { task.daily_weekdays = dw; }
    if let Some(e) = p.enabled { task.enabled = e; }
    if let Some(nc) = p.notify_channel { task.notify_channel = nc; }
    if let Some(m) = p.model { task.model = m; }
    task.updated_at = now_ms();
    let result = task.clone();
    save_data(&data);
    Some(result)
}

/// Record the outcome of a run and advance the schedule. Returns the updated task.
pub fn set_run_state(
    task_id: &str,
    last_run_at: u64,
    next_run_at: u64,
    last_chat_id: &str,
) -> Option<ScheduledTask> {
    let mut data = load_data();
    let task = data.tasks.iter_mut().find(|t| t.id == task_id)?;
    task.last_run_at = Some(last_run_at);
    task.next_run_at = Some(next_run_at);
    task.last_chat_id = Some(last_chat_id.to_string());
    task.updated_at = now_ms();
    let result = task.clone();
    save_data(&data);
    Some(result)
}

pub fn delete(task_id: &str) -> bool {
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
