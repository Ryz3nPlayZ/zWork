use std::path::PathBuf;
use std::env;

pub fn home_dir() -> PathBuf {
    let p = if let Ok(val) = env::var("ZWORK_HOME") {
        PathBuf::from(val)
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".zwork")
    };
    let _ = std::fs::create_dir_all(&p);
    p
}

pub fn settings_path() -> PathBuf {
    home_dir().join("settings.json")
}

pub fn chats_dir() -> PathBuf {
    let d = home_dir().join("chats");
    let _ = std::fs::create_dir_all(&d);
    d
}

#[allow(dead_code)]
pub fn runs_dir() -> PathBuf {
    let d = home_dir().join("runs");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn onboarding_path() -> PathBuf {
    home_dir().join("onboarding.json")
}

pub fn repo_root() -> PathBuf {
    if let Ok(val) = env::var("ZWORK_ROOT") {
        let p = PathBuf::from(val);
        if p.exists() {
            return p;
        }
    }
    // Default to current working directory
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn zwork_md_path() -> PathBuf {
    if let Ok(val) = env::var("ZWORK_MD") {
        return PathBuf::from(val);
    }
    let rr = repo_root().join("zwork.md");
    if rr.exists() {
        rr
    } else {
        home_dir().join("zwork.md")
    }
}

pub fn memory_path() -> PathBuf {
    home_dir().join("memory.md")
}

pub fn memories_dir() -> PathBuf {
    let d = home_dir().join("memories");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn user_md_path() -> PathBuf {
    memories_dir().join("USER.md")
}

pub fn memory_md_path() -> PathBuf {
    memories_dir().join("MEMORY.md")
}

#[allow(dead_code)]
pub fn timeline_md_path() -> PathBuf {
    memories_dir().join("TIMELINE.md")
}

pub fn workspace_root() -> PathBuf {
    let d = home_dir().join("workspace");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn workspace_apps_dir() -> PathBuf {
    let d = workspace_root().join("apps");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn workspace_outputs_dir() -> PathBuf {
    let d = workspace_root().join("outputs");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn workspace_uploads_dir() -> PathBuf {
    let d = workspace_root().join("uploads");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn workspace_scratch_dir() -> PathBuf {
    let d = workspace_root().join("scratch");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn projects_dir() -> PathBuf {
    let d = home_dir().join("projects");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn project_dir(project_id: &str) -> PathBuf {
    let d = projects_dir().join(project_id);
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Resolve the skills directory across dev and packaged layouts.
///
/// The repo ships `zWork-Skills/` at its root, but the packaged app has no
/// repo — skills are bundled as a Tauri resource under `Resources/`. We probe,
/// in priority order:
///   1. `ZWORK_ROOT/zWork-Skills`        — explicit dev/custom override
///   2. `ZWORK_RESOURCES/zWork-Skills`   — set by the Tauri app to its
///                                         `resource_dir()` (canonical, cross-platform)
///   3. `<exe>/../Resources/zWork-Skills` — macOS `.app` bundle
///                                            (Contents/MacOS/exe → Contents/Resources)
///   4. `<exe>/Resources/zWork-Skills`    — flat resource layouts
///   5. `repo_root()/zWork-Skills`        — dev fallback (cwd / ZWORK_ROOT)
///
/// Returning a non-existent path is fine: `list_skills()` treats a missing dir
/// as "no skills" rather than erroring.
pub fn skills_dir() -> PathBuf {
    // 1. Explicit override.
    if let Ok(root) = env::var("ZWORK_ROOT") {
        let p = PathBuf::from(root).join("zWork-Skills");
        if p.exists() {
            return p;
        }
    }

    // 2. Tauri resource_dir() passed by the host app.
    if let Ok(res) = env::var("ZWORK_RESOURCES") {
        let p = PathBuf::from(res).join("zWork-Skills");
        if p.exists() {
            return p;
        }
    }

    // 3/4. Derive from our own executable (packaged layouts).
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // macOS .app: Contents/MacOS/<exe> -> Contents/Resources
            if let Some(contents) = exe_dir.parent() {
                let p = contents.join("Resources").join("zWork-Skills");
                if p.exists() {
                    return p;
                }
            }
            // Flat layout: resources live next to the binary.
            let p = exe_dir.join("Resources").join("zWork-Skills");
            if p.exists() {
                return p;
            }
        }
    }

    // 5. Dev fallback.
    repo_root().join("zWork-Skills")
}

pub fn tasks_path() -> PathBuf {
    home_dir().join("tasks.json")
}

pub fn schedules_path() -> PathBuf {
    home_dir().join("schedules.json")
}

pub fn inbox_path() -> PathBuf {
    home_dir().join("inbox.json")
}

/// Per-task aggregated memory. Each scheduled task keeps its own notes file so
/// that, e.g., the invoice-monitor task doesn't pollute the calendar task's
/// context. Mirrors the USER.md / MEMORY.md markdown idiom but scoped per task.
pub fn task_memory_path(task_id: &str) -> PathBuf {
    // Task ids are uuid-v4 simple (hex); validate defensively so a crafted id
    // can't escape the memories dir via path traversal.
    let safe = is_safe_id(task_id);
    let name = if safe {
        format!("task_{}.md", task_id)
    } else {
        "task_invalid.md".to_string()
    };
    memories_dir().join(name)
}

pub fn activity_log_path() -> PathBuf {
    home_dir().join("state").join("activity_log.json")
}

pub fn telemetry_log_path() -> PathBuf {
    home_dir().join("telemetry.jsonl")
}

pub fn agent_log_path() -> PathBuf {
    let d = home_dir().join("logs");
    let _ = std::fs::create_dir_all(&d);
    d.join("agent.jsonl")
}

pub fn is_safe_id(id_str: &str) -> bool {
    if id_str.is_empty() {
        return false;
    }
    id_str.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Give the process the user's real `PATH`.
///
/// An app launched from Finder or the Dock inherits launchd's minimal
/// `/usr/bin:/bin:/usr/sbin:/sbin`, so `npx`/`uvx` MCP servers and the CLIs
/// the agent runs through `bash` (node, python3, brew tools, gh, …) would
/// not be found. Ask the login shell for its `PATH` (bounded by a timeout,
/// since shell rc files can hang) and add the usual install locations.
/// Must run before any threads read the environment.
pub fn hydrate_path() {
    if cfg!(windows) {
        return;
    }
    let current = env::var("PATH").unwrap_or_default();
    // Launched from a terminal the PATH is already the user's; only the
    // launchd default needs the (slow-ish) login-shell round trip.
    let minimal = current.split(':').all(|d| matches!(d, "" | "/usr/bin" | "/bin" | "/usr/sbin" | "/sbin"));
    let shell_path = if minimal { login_shell_path() } else { None };
    let mut dirs: Vec<String> = shell_path.map(|p| p.split(':').map(str::to_string).collect()).unwrap_or_default();
    dirs.extend(current.split(':').map(str::to_string));
    if let Some(home) = dirs::home_dir() {
        for rel in [".local/bin", ".cargo/bin", ".bun/bin", ".volta/bin", ".deno/bin", "go/bin"] {
            dirs.push(home.join(rel).to_string_lossy().into_owned());
        }
    }
    dirs.extend(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(String::from));

    let mut seen = std::collections::HashSet::new();
    let merged: Vec<String> = dirs.into_iter().filter(|d| !d.is_empty() && seen.insert(d.clone())).collect();
    let merged = merged.join(":");
    if merged != current {
        // SAFETY: called at the top of `main`, before the runtime spawns
        // worker threads that could read the environment concurrently.
        unsafe { env::set_var("PATH", merged) };
    }
}

fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const MARKER: &str = "__ZWORK_PATH__";
    let shell = env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    // fish keeps PATH as a list (quoted, it joins with spaces).
    let (flags, script) = if shell.ends_with("fish") {
        ("-lc", format!("printf '{MARKER}%s{MARKER}' (string join : $PATH)"))
    } else {
        ("-ilc", format!("printf '{MARKER}%s{MARKER}' \"$PATH\""))
    };
    let mut child = Command::new(&shell)
        .arg(flags)
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let path = out.split(MARKER).nth(1)?.trim().to_string();
    (!path.is_empty()).then_some(path)
}
