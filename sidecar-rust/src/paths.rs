use std::path::{Path, PathBuf};
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

pub fn skills_dir() -> PathBuf {
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

pub fn is_safe_id(id_str: &str) -> bool {
    if id_str.is_empty() {
        return false;
    }
    id_str.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
