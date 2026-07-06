//! Scheduled-task runner.
//!
//! A background loop (spawned once at server startup) that fires user-configured
//! recurring tasks on their schedules. Each run spawns a fresh automation chat,
//! invokes [`crate::agent::run_agent_turn`] with a scheduled-task system prompt
//! (identity + trigger + per-task memory), drains the returned event stream, and
//! posts a summary/flag/error to the inbox.
//!
//! The loop mirrors [`crate::cua::idle_teardown_task`]: a plain `async fn` with
//! an infinite `loop { sleep; ... }`, holding no handles — it reaches state the
//! same way every other module does (global singletons + on-disk stores).

use std::collections::HashSet;
use std::sync::OnceLock;

use chrono::{Datelike, Local, NaiveTime};
use futures_util::StreamExt;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::schedulestore::{self, ScheduledTask};

/// Tasks currently running. Prevents overlapping runs of the *same* task (a
/// slow daily run that hasn't finished when the next tick fires).
static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn running() -> &'static Mutex<HashSet<String>> {
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Free-tier limits. These bound the per-user monthly cost the operator
/// subsidizes. Pro/Max tiers lift the task cap; the min-interval floor still
/// applies to protect against a single runaway task.
const FREE_TIER_MAX_ENABLED_TASKS: usize = 3;
const MIN_INTERVAL_MINUTES: u32 = 15;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Entry point. Spawned once in `main.rs`.
pub async fn scheduler_loop() {
    info!("scheduler: loop started ({}s tick)", 60);
    // On startup, backfill next_run_at for any task missing it so first-run
    // scheduling is deterministic.
    startup_backfill();

    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        ticker.tick().await;
        // Don't hold a lock across runs; snapshot the task list.
        let tasks = schedulestore::get_all();
        for task in tasks {
            if !task.enabled {
                continue;
            }
            let Some(next) = task.next_run_at else { continue };
            if next > now_ms() {
                continue;
            }
            // Minimal startup catch-up: if a run is overdue, fire once then
            // advance. Full catch-up (run N missed intervals) is intentionally
            // deferred — see plan.
            run_task(task).await;
        }
    }
}

/// Compute the next run time (epoch-ms) given the schedule and "from" instant.
/// Returns `None` for a task with neither an interval nor a daily time.
fn compute_next_run(task: &ScheduledTask, from_ms: u64) -> Option<u64> {
    if let Some(mins) = task.interval_minutes {
        let step = (mins.max(MIN_INTERVAL_MINUTES) as u64) * 60_000;
        return Some(from_ms + step);
    }
    if let Some(time) = &task.daily_time {
        let hhmm = parse_hhmm(time)?;
        let now = Local::now();
        // Walk forward day-by-day from today, up to a week, finding the next
        // matching weekday at or after the requested local time.
        let mut day_offset = 0i64;
        while day_offset <= 7 {
            let candidate_date = now.date_naive() + chrono::Duration::days(day_offset);
            let weekday = candidate_date.weekday().num_days_from_sunday();
            let allowed = match &task.daily_weekdays {
                Some(days) if !days.is_empty() => days.contains(&weekday),
                _ => true,
            };
            if !allowed {
                day_offset += 1;
                continue;
            }
            let candidate_local = candidate_date
                .and_hms_opt(hhmm.0, hhmm.1, 0)?
                .and_local_timezone(Local)
                .single()?;
            let candidate_ms = candidate_local.timestamp_millis() as u64;
            // Today's slot must be strictly in the future; future days always qualify.
            if candidate_ms > from_ms {
                return Some(candidate_ms);
            }
            day_offset += 1;
        }
        return None;
    }
    None
}

/// Parse `"HH:MM"` (24h) into `(hour, minute)`.
fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h < 24 && m < 60 {
        NaiveTime::from_hms_opt(h, m, 0)?;
        Some((h, m))
    } else {
        None
    }
}

/// On startup, set next_run_at for tasks that don't have one yet (first run).
fn startup_backfill() {
    let tasks = schedulestore::get_all();
    let now = now_ms();
    for t in tasks {
        if !t.enabled || t.next_run_at.is_some() {
            continue;
        }
        if let Some(next) = compute_next_run(&t, now) {
            let _ = schedulestore::set_run_state(
                &t.id,
                t.last_run_at.unwrap_or(0),
                next,
                &t.last_chat_id.clone().unwrap_or_default(),
            );
        }
    }
}

/// Manually trigger a task run out of band (the "Run now" button). Fires the
/// same path the scheduler uses. Public so the HTTP handler can spawn it.
pub async fn run_task_now(task: ScheduledTask) {
    run_task(task).await
}

async fn run_task(task: ScheduledTask) {
    let task_id = task.id.clone();

    // Free-tier task cap: skip defensively if over cap. (Creation also enforces
    // this, but a user could downgrade or hand-edit the file.)
    if !tier_allows_new_run().await {
        warn!("scheduler: task {} skipped (free-tier task cap)", task_id);
        advance_schedule(&task, now_ms());
        return;
    }

    // Per-task overlap guard: never run the same task concurrently.
    {
        let mut guard = running().lock().await;
        if guard.contains(&task_id) {
            warn!("scheduler: task {} already running, skipping tick", task_id);
            return;
        }
        guard.insert(task_id.clone());
    }

    // Ensure the guard is released on every exit path (including early returns
    // above, which `return` straight through). Runs below this point always
    // release via `release_task` at the end.
    let task_title = task.title.clone();
    info!("scheduler: firing task «{}» ({})", task_title, task_id);

    let started_at = now_ms();

    // 1. Create a dedicated automation chat for this run.
    let model = task
        .model
        .clone()
        .unwrap_or_else(|| crate::settings::load().default_model.clone());
    let chat = crate::chatstore::create_kind(&task_title, &model, "", "automation");

    // 2. Build the scheduled-task system-prompt block: identity, trigger
    //    description, and per-task memory (notes aggregated from prior runs).
    let task_memory = std::fs::read_to_string(crate::paths::task_memory_path(&task_id))
        .unwrap_or_default();
    let trigger_desc = describe_trigger(&task);
    let mut extra = format!(
        "## Scheduled task\n\n\
         You are running as a scheduled task named **{title}**. It runs {trigger}.\n\
         Your objective is stated in the user message below. Complete it autonomously.",
        title = task_title,
        trigger = trigger_desc
    );
    if !task_memory.trim().is_empty() {
        extra.push_str(&format!(
            "\n\n### Notes from previous runs of this task\n\
             These are findings you saved on prior runs. Use them as baseline context:\n\n\
             {memory}",
            memory = task_memory.trim()
        ));
    }
    extra.push_str(
        "\n\n### Reporting\n\
         - If you find something the user should act on — an anomaly, a decision needed, \
           a failure — call `post_to_inbox` with a concise title and body. This is how the \
           user hears from you without opening the app.\n\
         - After completing the objective, save any durable, task-relevant findings for \
           future runs via `save_memory` with `target: \"task\"`.\n\
         - Keep your final text response short — the user reads a one-line summary in their \
           inbox, not a full transcript. The detailed transcript lives in the run's chat.",
    );

    // 3. Run the agent turn. Drained below — no HTTP SSE involved.
    let run_id = format!("sched_{}", chrono::Local::now().format("%Y%m%d%H%M%S"));
    let stream = crate::agent::run_agent_turn(
        chat.id.clone(),
        run_id,
        model.clone(),
        task.prompt.clone(),
        Vec::new(), // no attachments
        String::new(),
        false,                  // plan_mode
        false,                  // auto_approve — scheduled runs must NOT auto-run destructive ops
        false,                  // artifact_mode
        false,                  // web_search_enabled
        Some(extra),
    );

    // 4. Drain the stream. Capture assistant text for the summary; watch for
    //    errors. `post_to_inbox` tool calls already wrote to the inbox inside
    //    the tool dispatcher, so we don't double-post those.
    let mut assistant_text = String::new();
    let mut had_error = false;
    let mut error_text = String::new();
    let mut stream = stream;
    while let Some(ev) = stream.next().await {
        let val = ev.unwrap_or_default();
        match val.get("type").and_then(|v| v.as_str()) {
            Some("delta") => {
                if let Some(t) = val.get("text").and_then(|v| v.as_str()) {
                    assistant_text.push_str(t);
                }
            }
            Some("error") => {
                had_error = true;
                if let Some(t) = val.get("text").and_then(|v| v.as_str()) {
                    if !error_text.is_empty() {
                        error_text.push('\n');
                    }
                    error_text.push_str(t);
                }
            }
            _ => {}
        }
    }

    let finished_at = now_ms();

    // 5. Post a result to the inbox. Errors get an `error` item; a clean run
    //    with notable final text gets a `summary`. We avoid posting an empty
    //    summary when the run already posted flags via `post_to_inbox`.
    if had_error {
        let body = if error_text.is_empty() {
            "The scheduled task encountered an error. Open the run transcript for details.".to_string()
        } else {
            error_text
        };
        crate::inboxstore::create(crate::inboxstore::CreateParams {
            task_id: Some(task_id.clone()),
            chat_id: Some(chat.id.clone()),
            kind: Some("error".to_string()),
            title: format!("“{}” hit an error", task_title),
            body: Some(body),
        });
    } else {
        let summary = assistant_text.trim();
        if !summary.is_empty() {
            // Truncate very long summaries so the inbox stays scannable.
            let body = if summary.chars().count() > 600 {
                let cut: String = summary.chars().take(600).collect();
                format!("{cut}…")
            } else {
                summary.to_string()
            };
            crate::inboxstore::create(crate::inboxstore::CreateParams {
                task_id: Some(task_id.clone()),
                chat_id: Some(chat.id.clone()),
                kind: Some("summary".to_string()),
                title: format!("“{}” finished", task_title),
                body: Some(body),
            });
        }
    }

    // 6. Advance the schedule and record the run.
    let next = compute_next_run(&task, finished_at).unwrap_or_else(|| {
        // No resolvable schedule — push a default interval to avoid a hot loop.
        finished_at + 3_600_000
    });
    schedulestore::set_run_state(&task_id, started_at, next, &chat.id);

    info!(
        "scheduler: task «{}» finished in {}s, next run at {}",
        task_title,
        (finished_at - started_at) / 1000,
        chrono::DateTime::from_timestamp_millis(next as i64)
            .map(|dt| dt.to_string())
            .unwrap_or_else(|| "?".to_string())
    );

    release_task(task_id).await;
}

/// Stamp a fresh next_run_at without running (used when skipping).
fn advance_schedule(task: &ScheduledTask, from_ms: u64) {
    let next = compute_next_run(task, from_ms).unwrap_or(from_ms + 3_600_000);
    let _ = schedulestore::set_run_state(
        &task.id,
        task.last_run_at.unwrap_or(0),
        next,
        &task.last_chat_id.clone().unwrap_or_default(),
    );
}

fn describe_trigger(task: &ScheduledTask) -> String {
    if let Some(mins) = task.interval_minutes {
        return format!("every {} minutes", mins.max(MIN_INTERVAL_MINUTES));
    }
    if let Some(t) = &task.daily_time {
        let days = match &task.daily_weekdays {
            Some(d) if !d.is_empty() => {
                let names = d
                    .iter()
                    .map(|i| match i {
                        0 => "Sun", 1 => "Mon", 2 => "Tue", 3 => "Wed",
                        4 => "Thu", 5 => "Fri", 6 => "Sat", _ => "?",
                    })
                    .collect::<Vec<_>>()
                    .join("/");
                format!("on {}", names)
            }
            _ => "every day".to_string(),
        };
        return format!("at {} local ({})", t, days);
    }
    "on a schedule".to_string()
}

/// Free-tier cap check. The sidecar has no authoritative tier today (it lives
/// cloud-side); we read a best-effort `account_tier` from settings, defaulting
/// to free. Pro/Max lifts the cap.
async fn tier_allows_new_run() -> bool {
    let tier = crate::settings::load().account_tier.clone();
    if tier == "pro" || tier == "max" {
        return true;
    }
    schedulestore::count_enabled() <= FREE_TIER_MAX_ENABLED_TASKS
}

async fn release_task(id: String) {
    let mut guard = running().lock().await;
    guard.remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_task(interval: Option<u32>, daily_time: Option<&str>, weekdays: Option<Vec<u32>>) -> ScheduledTask {
        ScheduledTask {
            id: "t1".into(),
            title: "test".into(),
            prompt: "do thing".into(),
            trigger_type: "time".into(),
            interval_minutes: interval,
            daily_time: daily_time.map(String::from),
            daily_weekdays: weekdays,
            enabled: true,
            notify_channel: "inbox".into(),
            model: None,
            created_at: 0,
            updated_at: 0,
            last_run_at: None,
            next_run_at: None,
            last_chat_id: None,
        }
    }

    #[test]
    fn parse_hhmm_valid() {
        assert_eq!(parse_hhmm("09:30"), Some((9, 30)));
        assert_eq!(parse_hhmm("23:59"), Some((23, 59)));
        assert_eq!(parse_hhmm("00:00"), Some((0, 0)));
    }

    #[test]
    fn parse_hhmm_invalid() {
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("12:60"), None);
        assert_eq!(parse_hhmm("noon"), None);
        assert_eq!(parse_hhmm("12"), None);
    }

    #[test]
    fn interval_advances_by_step() {
        // A 30-min interval should advance ~30 min from the from-instant.
        let t = mk_task(Some(30), None, None);
        let from = 1_000_000_000_u64; // arbitrary fixed instant
        let next = compute_next_run(&t, from).expect("interval should resolve");
        assert_eq!(next - from, 30 * 60_000);
    }

    #[test]
    fn interval_enforces_min_floor() {
        // Below the 15-min floor — should be clamped up, not run every minute.
        let t = mk_task(Some(5), None, None);
        let from = 1_000_000_000_u64;
        let next = compute_next_run(&t, from).expect("clamped interval should resolve");
        assert_eq!(next - from, MIN_INTERVAL_MINUTES as u64 * 60_000);
    }

    #[test]
    fn daily_time_resolves_to_a_future_instant() {
        let t = mk_task(None, Some("09:00"), None);
        let now = now_ms();
        let next = compute_next_run(&t, now).expect("daily should resolve");
        assert!(next > now, "next run must be strictly in the future");
        // And within at most ~24h (could be today's slot or tomorrow's).
        assert!(next - now <= 25 * 60 * 60_000, "next run should be within ~24h");
    }

    #[test]
    fn no_schedule_returns_none() {
        let t = mk_task(None, None, None);
        assert!(compute_next_run(&t, now_ms()).is_none());
    }

    #[test]
    fn weekday_filter_skips_non_matching_days() {
        // Only Mondays (1). Next run must land on a Monday.
        let t = mk_task(None, Some("08:00"), Some(vec![1]));
        let now = now_ms();
        let next = compute_next_run(&t, now).expect("should resolve");
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(next as i64)
            .expect("valid timestamp")
            .with_timezone(&chrono::Local);
        assert_eq!(dt.weekday().num_days_from_monday(), 0, "should be a Monday");
    }
}
