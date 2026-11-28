//! "Send logs" in Settings: gathers zWork's own log files, strips anything
//! secret or personal, and uploads them to the zWork server, which answers
//! with a short code the user can pass on.
//!
//! What leaves the computer, per file (newest part only):
//! - `backend.log`, `host-crashes.jsonl` (the desktop shell, one folder up
//!   from the backend's home) and `logs/crashes.jsonl` (the backend).
//! - `logs/agent.jsonl`, reduced to event names, counts, models and error
//!   text: tool inputs, tool output and anything else that could hold the
//!   user's messages or files is dropped (Settings promises content is never
//!   sent to us).
//!
//! Every file then has known keys, key-shaped strings and the user's home
//! folder path removed.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use axum::{http::StatusCode, response::IntoResponse, Json};
use regex::Regex;
use serde_json::{json, Map, Value};

const REMOVED: &str = "[removed]";

/// Bytes of each file sent, from its end. Keeps an upload under 1MB (the
/// server refuses bodies over 2MB).
const PLAIN_LOG_LIMIT: u64 = 200_000;
const AGENT_LOG_READ: u64 = 4_000_000;
const AGENT_LOG_LIMIT: usize = 400_000;
/// Longest error text kept from one agent event.
const MAX_FIELD_CHARS: usize = 500;

/// String fields of an agent event that describe what happened rather than
/// what the user wrote. Numbers and true/false are always kept.
const SAFE_STRING_KEYS: &[&str] = &[
    "ts", "chat_id", "run_id", "task_id", "kind", "event", "name", "tool", "error", "stop_reason",
    "model_id", "real_model_id", "provider", "shape", "harness", "status", "reason",
];

struct LogFile {
    name: &'static str,
    text: String,
}

/// The desktop shell keeps its logs one folder above the backend's home
/// (`%LOCALAPPDATA%\zWork` holds `state\`); a dev home has no such parent.
fn shell_dir(home: &Path) -> Option<PathBuf> {
    (home.file_name()? == "state").then(|| home.parent().map(Path::to_path_buf)).flatten()
}

/// The folder "Open log folder" shows: the shell's, which holds the rest.
pub fn log_folder() -> PathBuf {
    let home = crate::paths::home_dir();
    shell_dir(&home).unwrap_or(home)
}

/// The last `limit` bytes of a file, starting at a whole line.
fn read_tail(path: &Path, limit: u64) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(limit);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    Some(match (start > 0, text.find('\n')) {
        (true, Some(i)) => text[i + 1..].to_string(),
        _ => text,
    })
}

/// Keep only the newest `limit` bytes of `text`, cut at a line start.
fn keep_tail(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut cut = text.len() - limit;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    match text[cut..].find('\n') {
        Some(i) => &text[cut + i + 1..],
        None => &text[cut..],
    }
}

/// Text is kept only for a safe key on the event itself or in its
/// `data`/`payload` (depth 0 or 1): deeper down sit tool inputs, where a
/// `name` can be a person's name.
fn strip_content(v: &Value, key: Option<&str>, depth: usize) -> Option<Value> {
    match v {
        Value::Null | Value::Bool(_) | Value::Number(_) => Some(v.clone()),
        Value::String(s) => key
            .filter(|k| depth <= 1 && SAFE_STRING_KEYS.contains(k))
            .map(|_| Value::String(s.chars().take(MAX_FIELD_CHARS).collect())),
        Value::Object(m) => {
            let inner = if key.is_none() { 0 } else { depth + 1 };
            let kept: Map<String, Value> = m
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), strip_content(v, Some(k), inner)?)))
                .collect();
            Some(Value::Object(kept))
        }
        // Lists hold tool calls, messages and attachments; a count is enough.
        Value::Array(a) => Some(json!(a.len())),
    }
}

/// One agent-log line without anything the user wrote or a tool returned.
/// Lines that aren't JSON are dropped.
fn agent_line_without_content(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    serde_json::to_string(&strip_content(&v, None, 0)?).ok()
}

fn key_patterns() -> &'static [(Regex, &'static str)] {
    static P: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| {
        [
            (r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}", "${1}[removed]"),
            (r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}", REMOVED),
            (r"\bAIza[0-9A-Za-z_-]{30,}", REMOVED),
            (r"\bgh[pousr]_[A-Za-z0-9]{20,}", REMOVED),
            (r"\bxox[abprs]-[A-Za-z0-9-]{10,}", REMOVED),
            (
                r#"(?i)("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)"?\s*[:=]\s*"?)[^"\s,}]{8,}"#,
                "${1}[removed]",
            ),
        ]
        .into_iter()
        .map(|(re, to)| (Regex::new(re).expect("valid key pattern"), to))
        .collect()
    })
}

/// Remove the user's saved keys, anything shaped like a key, and the home
/// folder path (it holds their account name).
fn redact(text: &str, secrets: &[String], home: Option<&str>) -> String {
    let mut out = text.to_string();
    for s in secrets.iter().filter(|s| s.len() >= 8) {
        out = out.replace(s.as_str(), REMOVED);
    }
    for (re, to) in key_patterns() {
        out = re.replace_all(&out, *to).into_owned();
    }
    if let Some(h) = home.filter(|h| h.len() > 1) {
        out = out.replace(h, "~");
        // JSON logs write Windows paths with doubled backslashes.
        if h.contains('\\') {
            out = out.replace(&h.replace('\\', "\\\\"), "~");
        }
    }
    out
}

fn gather(home: &Path, secrets: &[String], user_home: Option<&str>) -> Vec<LogFile> {
    let shell = shell_dir(home);
    let mut files = Vec::new();
    let mut plain = |name: &'static str, path: Option<PathBuf>| {
        if let Some(text) = path.and_then(|p| read_tail(&p, PLAIN_LOG_LIMIT)) {
            files.push(LogFile { name, text });
        }
    };
    plain("backend.log", shell.as_ref().map(|d| d.join("backend.log")));
    plain("host-crashes.jsonl", shell.as_ref().map(|d| d.join("host-crashes.jsonl")));
    plain("crashes.jsonl", Some(home.join("logs").join("crashes.jsonl")));
    if let Some(raw) = read_tail(&home.join("logs").join("agent.jsonl"), AGENT_LOG_READ) {
        let stripped: String =
            raw.lines().filter_map(agent_line_without_content).map(|l| l + "\n").collect();
        files.push(LogFile { name: "agent.jsonl", text: keep_tail(&stripped, AGENT_LOG_LIMIT).to_string() });
    }
    for f in &mut files {
        f.text = redact(&f.text, secrets, user_home);
    }
    files.retain(|f| !f.text.trim().is_empty());
    files
}

/// `POST /api/logs/send` → `{ code }`, or `{ error }` in plain words.
pub async fn send_logs() -> impl IntoResponse {
    let settings = crate::settings::load();
    let token = settings.api_keys.get("zwork_router").cloned().unwrap_or_default();
    let mut secrets: Vec<String> = settings.api_keys.values().cloned().collect();
    secrets.extend(std::env::var("ZWORK_SIDECAR_TOKEN").ok());
    let base = settings
        .provider_config
        .get("zwork_router")
        .and_then(|m| m.get("base_url"))
        .filter(|b| !b.is_empty())
        .cloned()
        .unwrap_or_else(|| "https://api.tryzwork.app/api".into());

    let home = crate::paths::home_dir();
    let user_home = dirs::home_dir().map(|p| p.display().to_string());
    let files = match tokio::task::spawn_blocking(move || gather(&home, &secrets, user_home.as_deref())).await {
        Ok(f) => f,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't read the logs. Try again."),
    };
    if files.is_empty() {
        return err(StatusCode::NOT_FOUND, "There are no logs to send yet.");
    }

    let body = json!({
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "files": files.iter().map(|f| json!({ "name": f.name, "text": f.text })).collect::<Vec<_>>(),
    });
    let mut req = reqwest::Client::new()
        .post(format!("{}/logs/report", base.trim_end_matches('/')))
        .timeout(Duration::from_secs(60))
        .json(&body);
    if !token.trim().is_empty() {
        req = req.bearer_auth(token.trim());
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return err(StatusCode::BAD_GATEWAY, "Couldn't reach zWork. Check your internet connection and try again."),
    };
    let status = resp.status();
    let reply: Value = resp.json().await.unwrap_or(Value::Null);
    match reply.get("code").and_then(Value::as_str) {
        Some(code) if status.is_success() => (StatusCode::OK, Json(json!({ "code": code }))),
        _ if status.as_u16() == 429 => err(StatusCode::TOO_MANY_REQUESTS, "Logs were sent a moment ago. Wait a minute, then try again."),
        _ => err(StatusCode::BAD_GATEWAY, "zWork couldn't take the logs right now. Try again later."),
    }
}

/// `POST /api/logs/open`: shows the log folder in Explorer or Finder.
pub async fn open_log_folder() -> impl IntoResponse {
    match crate::fileopen::launch(&log_folder(), false) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't open the folder."),
    }
}

fn err(status: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": msg })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_lines_lose_everything_the_user_wrote() {
        let line = r#"{"ts":"t","chat_id":"c","turn":2,"kind":"tool_dispatch","data":{"id":"x","name":"write_file","input":{"path":"/Users/ann/rent.docx","content":"Dear landlord","name":"Ann Lee"}}}"#;
        let out = agent_line_without_content(line).unwrap();
        assert!(out.contains("write_file") && out.contains("tool_dispatch") && out.contains("\"turn\":2"));
        assert!(!out.contains("landlord") && !out.contains("rent.docx") && !out.contains("Ann Lee"), "{out}");

        let result = r#"{"kind":"tool_result","data":{"name":"bash","ok":false,"preview":"secret salary list","len":18}}"#;
        let out = agent_line_without_content(result).unwrap();
        assert!(out.contains("\"len\":18") && !out.contains("salary"), "{out}");

        let finish = r#"{"kind":"finish","data":{"error":"400 Bad Request: model not found","tool_calls":0,"messages":["hi","there"]}}"#;
        let out = agent_line_without_content(finish).unwrap();
        assert!(out.contains("model not found") && out.contains("\"messages\":2") && !out.contains("there"), "{out}");

        assert_eq!(agent_line_without_content("not json"), None);
    }

    #[test]
    fn keys_and_the_home_folder_are_removed() {
        let saved = vec!["my-saved-router-token-123".to_string()];
        let text = "token my-saved-router-token-123 used\n\
                    Authorization: Bearer abcdefghijklmnop123\n\
                    key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA\n\
                    {\"api_key\":\"zzzzzzzzzzzz\"}\n\
                    open C:\\Users\\Ann\\Documents\\x.txt and \"C:\\\\Users\\\\Ann\\\\y\"\n";
        let out = redact(text, &saved, Some(r"C:\Users\Ann"));
        for gone in ["my-saved-router-token-123", "abcdefghijklmnop123", "sk-ant-api03", "zzzzzzzzzzzz", "Ann"] {
            assert!(!out.contains(gone), "{gone} still in:\n{out}");
        }
        assert!(out.contains(r"~\Documents\x.txt") && out.contains("Bearer [removed]"), "{out}");
    }

    #[test]
    fn tails_start_on_a_whole_line_and_survive_non_ascii() {
        let text: String = (0..1000).map(|i| format!("é line {i}\n")).collect();
        let tail = keep_tail(&text, 100);
        assert!(tail.len() <= 100 && tail.starts_with("é line") && tail.ends_with("999\n"));

        let dir = std::env::temp_dir().join(format!("zwork-logs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("backend.log");
        std::fs::write(&p, &text).unwrap();
        let t = read_tail(&p, 100).unwrap();
        assert!(t.starts_with("é line") && t.ends_with("999\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_the_shell_logs_only_beside_a_state_folder() {
        assert_eq!(shell_dir(Path::new("/data/zWork/state")), Some(PathBuf::from("/data/zWork")));
        assert_eq!(shell_dir(Path::new("/home/ann/.zwork")), None);
    }
}
