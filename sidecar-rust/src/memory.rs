use std::fs;
use std::path::PathBuf;

use crate::paths::{memories_dir, memory_md_path, user_md_path, memory_path};

const ENTRY_DELIMITER: &str = "\n§\n";
const MEMORY_CHAR_LIMIT: usize = 2200;
const USER_CHAR_LIMIT: usize = 1375;

/// Which memory file to target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryTarget {
    /// General agent observations and facts about the environment / projects.
    Memory,
    /// What the agent knows about the user (preferences, style, goals).
    User,
}

impl MemoryTarget {
    pub fn path(&self) -> PathBuf {
        match self {
            MemoryTarget::Memory => memory_md_path(),
            MemoryTarget::User => user_md_path(),
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            MemoryTarget::Memory => "MEMORY.md",
            MemoryTarget::User => "USER.md",
        }
    }

    pub fn char_limit(&self) -> usize {
        match self {
            MemoryTarget::Memory => MEMORY_CHAR_LIMIT,
            MemoryTarget::User => USER_CHAR_LIMIT,
        }
    }
}

impl std::str::FromStr for MemoryTarget {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "memory" => Ok(MemoryTarget::Memory),
            "user" => Ok(MemoryTarget::User),
            _ => Err(format!("unknown memory target: {}", s)),
        }
    }
}

/// Read entries from a memory file. Returns an empty vec if the file is missing.
fn read_entries(path: &PathBuf) -> Vec<String> {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    content
        .split(ENTRY_DELIMITER)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Load the curated memory snapshot for injection into the system prompt.
///
/// This mirrors the Hermes / Karpathy-style markdown memory system:
///   - `~/.zwork/memories/USER.md`  — facts about the user
///   - `~/.zwork/memories/MEMORY.md` — general agent observations
/// Entries are separated by `§` (section sign) on its own line.
pub fn load_snapshot() -> (String, String) {
    let _ = memories_dir();

    let user_entries = read_entries(&user_md_path());
    let mut memory_entries = read_entries(&memory_md_path());

    // Backward compatibility: if the new MEMORY.md is empty but the legacy
    // ~/.zwork/memory.md exists, treat its non-empty lines as entries.
    if memory_entries.is_empty() {
        if let Ok(legacy) = fs::read_to_string(memory_path()) {
            let legacy_entries: Vec<String> = legacy
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && !s.starts_with('#'))
                .collect();
            if !legacy_entries.is_empty() {
                memory_entries = legacy_entries;
            }
        }
    }

    let user_block = if user_entries.is_empty() {
        "No user profile recorded yet.".to_string()
    } else {
        format!(
            "Profile of the user (from USER.md):\n\n- {}",
            user_entries.join("\n- ")
        )
    };

    let memory_block = if memory_entries.is_empty() {
        "No general memories recorded yet.".to_string()
    } else {
        format!(
            "General observations and facts (from MEMORY.md):\n\n- {}",
            memory_entries.join("\n- ")
        )
    };

    (user_block, memory_block)
}

/// Append a new entry to the target memory file.
pub fn append(target: MemoryTarget, content: &str) -> Result<String, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Memory content is empty.".to_string());
    }

    let path = target.path();
    let _ = memories_dir();

    let mut entries = read_entries(&path);

    // Deduplicate: don't append an exact duplicate.
    if entries.iter().any(|e| e == content) {
        return Ok(format!("Already recorded in {}.", target.label()));
    }

    // Enforce a rough character budget to keep the system prompt bounded.
    let current_chars: usize = entries.iter().map(|e| e.len()).sum::<usize>()
        + if entries.is_empty() { 0 } else { entries.len() * ENTRY_DELIMITER.len() };
    if current_chars + content.len() > target.char_limit() {
        return Err(format!(
            "{} is near its size limit ({} chars). Remove older entries before adding new ones.",
            target.label(),
            target.char_limit()
        ));
    }

    entries.push(content.to_string());
    let serialized = entries.join(ENTRY_DELIMITER);

    match fs::write(&path, serialized) {
        Ok(_) => Ok(format!("Saved to {}.", target.label())),
        Err(e) => Err(format!("Failed to write {}: {}", target.label(), e)),
    }
}

/// Replace the first entry that contains `substring` with `content`.
pub fn replace(target: MemoryTarget, substring: &str, content: &str) -> Result<String, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Replacement content is empty.".to_string());
    }

    let path = target.path();
    let mut entries = read_entries(&path);

    let mut replaced = false;
    for entry in entries.iter_mut() {
        if entry.contains(substring) {
            *entry = content.to_string();
            replaced = true;
            break;
        }
    }

    if !replaced {
        return Err(format!(
            "No entry in {} contains '{}'.",
            target.label(),
            substring
        ));
    }

    let serialized = entries.join(ENTRY_DELIMITER);
    match fs::write(&path, serialized) {
        Ok(_) => Ok(format!("Updated {}.", target.label())),
        Err(e) => Err(format!("Failed to write {}: {}", target.label(), e)),
    }
}

/// Remove the first entry that contains `substring`.
pub fn remove(target: MemoryTarget, substring: &str) -> Result<String, String> {
    let path = target.path();
    let mut entries = read_entries(&path);

    let before = entries.len();
    entries.retain(|e| !e.contains(substring));

    if entries.len() == before {
        return Err(format!(
            "No entry in {} contains '{}'.",
            target.label(),
            substring
        ));
    }

    let serialized = entries.join(ENTRY_DELIMITER);
    match fs::write(&path, serialized) {
        Ok(_) => Ok(format!("Removed from {}.", target.label())),
        Err(e) => Err(format!("Failed to write {}: {}", target.label(), e)),
    }
}

/// Read all entries from the target memory file.
pub fn read(target: MemoryTarget) -> String {
    let entries = read_entries(&target.path());
    if entries.is_empty() {
        return format!("{} is empty.", target.label());
    }
    format!("{} entries:\n\n- {}", target.label(), entries.join("\n- "))
}

/// Build a concise time-awareness block for the system prompt.
///
/// Includes: now, today, yesterday, the start/end of the current week, and a
/// 7-day look-ahead. This is enough for the agent to make sensible references
/// to "yesterday", "this week", "next week", etc.
pub fn build_timeline_block() -> String {
    use chrono::{Datelike, Local, NaiveDate};

    let now = Local::now();
    let today = now.date_naive();
    let yesterday = today.pred_opt().unwrap_or(today);
    let tomorrow = today.succ_opt().unwrap_or(today);

    let weekday = today.weekday();
    let days_since_monday = weekday.num_days_from_monday() as i64;
    let monday = today - chrono::Duration::days(days_since_monday);
    let sunday = monday + chrono::Duration::days(6);
    let next_monday = sunday + chrono::Duration::days(1);
    let next_sunday = next_monday + chrono::Duration::days(6);

    let date_fmt = |d: NaiveDate| d.format("%A, %B %e, %Y").to_string();

    format!(
        "Current time: {now_str} ({tz})\n\
        Today: {today_str}\n\
        Yesterday: {yesterday_str}\n\
        Tomorrow: {tomorrow_str}\n\
        This week: {week_start} – {week_end}\n\
        Next week: {next_week_start} – {next_week_end}\n\
        The current day of the week is {day_of_week}.",
        now_str = now.format("%I:%M %p").to_string().trim_start_matches('0'),
        tz = now.format("%Z").to_string(),
        today_str = date_fmt(today),
        yesterday_str = date_fmt(yesterday),
        tomorrow_str = date_fmt(tomorrow),
        week_start = date_fmt(monday),
        week_end = date_fmt(sunday),
        next_week_start = date_fmt(next_monday),
        next_week_end = date_fmt(next_sunday),
        day_of_week = weekday,
    )
}
