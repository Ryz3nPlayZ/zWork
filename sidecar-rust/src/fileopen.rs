//! Open a file the agent made in the user's own app (Excel, Word, Preview…),
//! or show it in Finder / Explorer. Backs the file chips in chat replies.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Extensions that would run something when "opened". These are revealed in
/// the file manager instead, so a click on a chip never executes code.
const RUNNABLE: &[&str] = &[
    "app", "command", "sh", "bash", "zsh", "fish", "tool", "terminal", "workflow", "scpt",
    "applescript", "pkg", "mpkg", "dmg", "exe", "bat", "cmd", "com", "msi", "ps1", "vbs",
    "js", "jar", "py", "rb", "pl", "appimage", "desktop", "run", "bin", "lnk", "url",
    "webloc", "inetloc", "fileloc", "reg", "scr",
];

#[derive(Deserialize)]
pub struct OpenFileBody {
    pub path: String,
    #[serde(default)]
    pub reveal: bool,
}

/// Resolves a path as the agent wrote it: `~` is home, relative is the
/// workspace (the backend's working directory).
fn resolve(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim().trim_matches('`').trim_matches('"').trim_matches('\'');
    if raw.is_empty() {
        return None;
    }
    let p = if let Some(rest) = raw.strip_prefix("~/") {
        dirs::home_dir()?.join(rest)
    } else {
        PathBuf::from(raw)
    };
    let p = if p.is_absolute() { p } else { std::env::current_dir().ok()?.join(p) };
    p.canonicalize().ok()
}

fn is_runnable(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| RUNNABLE.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
        || p.to_string_lossy().contains(".app/")
}

fn launch(p: &Path, reveal: bool) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        if reveal {
            c.arg("-R");
        }
        c.arg(p);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        if reveal {
            c.arg(format!("/select,{}", p.display()));
        } else {
            c.arg(p);
        }
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(if reveal { p.parent().unwrap_or(p) } else { p });
        c
    };
    cmd.spawn().map(|_| ())
}

pub async fn open_file(Json(body): Json<OpenFileBody>) -> impl IntoResponse {
    let Some(path) = resolve(&body.path) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "That file isn't there anymore. It may have been moved or deleted." })),
        );
    };
    let reveal = body.reveal || path.is_dir() || is_runnable(&path);
    match launch(&path, reveal) {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "path": path.display().to_string(), "revealed": reveal })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Couldn't open the file: {e}") })),
        ),
    }
}

/// Which of `paths` exist, so the UI only turns real files into chips.
#[derive(Deserialize)]
pub struct StatBody {
    pub paths: Vec<String>,
}

pub async fn stat_files(Json(body): Json<StatBody>) -> impl IntoResponse {
    let existing: Vec<&String> = body
        .paths
        .iter()
        .take(200)
        .filter(|p| resolve(p).is_some_and(|r| r.is_file()))
        .collect();
    Json(json!({ "existing": existing }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_and_apps_are_revealed_not_run() {
        assert!(is_runnable(Path::new("/tmp/x/run.command")));
        assert!(is_runnable(Path::new("/tmp/x/clean.PY")));
        assert!(is_runnable(Path::new("/Applications/Foo.app/Contents/MacOS/foo")));
        assert!(!is_runnable(Path::new("/tmp/x/report.xlsx")));
        assert!(!is_runnable(Path::new("/tmp/x/notes.md")));
    }

    #[test]
    fn missing_files_do_not_resolve() {
        assert!(resolve("definitely/not/here.xlsx").is_none());
        assert!(resolve("").is_none());
    }
}
