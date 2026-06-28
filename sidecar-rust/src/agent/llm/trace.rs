//! Durable per-turn agent tracing.
//!
//! The observability layer (port plan item #1). Every meaningful agent-loop
//! boundary is appended as one JSONL line to `~/.zwork/logs/agent.jsonl`, so
//! any failure can be diagnosed after the fact: the exact tool calls the model
//! produced (name + parsed input), each tool dispatch + result, and every hard
//! error with its raw payload.
//!
//! This is what lets us see "deepseek emitted tool_call X with input Y" — the
//! diagnosis that the old code, with its silent drop / silent-empty-args
//! paths, made impossible. Raw SSE frames are verbose, so they are gated
//! behind `ZWORK_TRACE_SSE=1`; the high-signal events are always logged.

use std::fs::OpenOptions;
use std::io::Write;

use chrono::Utc;
use serde_json::{json, Value};

use crate::paths;

/// Append one structured event to the agent log. Cheap and best-effort: a
/// failed write is swallowed (tracing must never break an agent turn).
pub fn trace(chat_id: &str, turn: u32, kind: &str, payload: Value) {
    let line = json!({
        "ts": Utc::now().to_rfc3339(),
        "chat_id": chat_id,
        "turn": turn,
        "kind": kind,
        "data": payload,
    });
    let mut s = match serde_json::to_string(&line) {
        Ok(s) => s,
        Err(_) => return,
    };
    s.push('\n');
    if let Some(path) = log_path() {
        // Blocking append. A single line write is sub-microsecond; acceptable
        // for a diagnostic stream on a local task thread.
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(s.as_bytes());
            let _ = f.flush();
        }
    }
}

/// True iff the caller should also emit raw SSE frames. Verbose; opt-in.
pub fn trace_sse_enabled() -> bool {
    std::env::var("ZWORK_TRACE_SSE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn log_path() -> Option<std::path::PathBuf> {
    let dir = paths::home_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("agent.jsonl"))
}
