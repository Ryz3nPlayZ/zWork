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
