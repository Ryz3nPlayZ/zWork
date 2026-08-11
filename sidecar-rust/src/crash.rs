//! Panic + signal crash capture.
//!
//! Without this, a Rust panic in the sidecar backend is written to stdout
//! (which the Tauri host pipes to `backend.log`) and then the process aborts.
//! On a real user's machine that log is effectively invisible — we never see
//! the crash, never get the backtrace, and can't fix what we can't see.
//!
//! This module installs a `std::panic::set_hook` that captures the panic
//! payload, location, thread name, and a `Backtrace` into a structured JSON
//! record appended to `~/.zwork/logs/crashes.jsonl`. That file is the single
//! source of truth for "what crashed" — a future Sentry/minidump sink uploads
//! from the same records, and the frontend can surface a "report last crash"
//! affordance on next launch by reading the tail.
//!
//! We also chain to the previous hook (so `tracing`/default formatting still
//! reaches stderr) and keep allocation + I/O minimal inside the hook itself,
//! since a panic can leave the process in a partially broken state.

use std::backtrace::Backtrace;
use std::io::Write;
use std::panic;

/// Install the crash-capturing panic hook. Idempotent — calling more than once
/// just re-chains. Must run as early as possible in `main()` so panics during
/// setup are captured too.
pub fn install() {
    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        capture_panic(info);
        // Chain to the previous hook so default stderr output + any
        // `tracing`/`console_error_panic_hook` formatting still fires.
        prev(info);
    }));
}

fn capture_panic(info: &panic::PanicHookInfo<'_>) {
    let payload = info.payload();
    let msg = if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "Box<dyn Any> panic payload".to_string()
    };

    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_default();

    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("<unnamed>").to_string();

    // `Backtrace::capture()` respects `RUST_BACKTRACE`; in a release build
    // without that env var it returns a disabled frame, which is still more
    // useful than nothing (it records *that* a backtrace was requested).
    let backtrace = format!("{}", Backtrace::force_capture());

    let record = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "kind": "panic",
        "thread": thread_name,
        "message": msg,
        "location": location,
        "backtrace": backtrace,
        "version": env!("CARGO_PKG_VERSION"),
    });

    if let Ok(line) = serde_json::to_string(&record) {
        let path = crate::paths::home_dir().join("logs").join("crashes.jsonl");
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        // Best-effort append — never let a failure here mask the original panic.
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "{line}");
        }
    }
}
