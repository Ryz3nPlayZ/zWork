//! Instruction files the agent picks up without being told: `AGENTS.md` /
//! `CLAUDE.md`, the convention shared by pi, opencode, Codex and Claude Code.
//!
//! Same rules as pi's `loadProjectContextFiles`: one global file, then the
//! first of `AGENTS.md` / `CLAUDE.md` in every directory from the filesystem
//! root down to the working directory, so the nearest file comes last and
//! wins where they disagree.

use std::path::{Path, PathBuf};

use super::system_prompt::ContextFile;

const PROJECT_NAMES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
/// A runaway file shouldn't eat the context window.
const MAX_BYTES: usize = 64 * 1024;

/// Global instruction files, in priority order; the first that exists is used.
fn global_candidates(home: &Path, zwork_home: &Path) -> Vec<PathBuf> {
    vec![
        zwork_home.join("AGENTS.md"),
        home.join(".config/opencode/AGENTS.md"),
        home.join(".pi/agent/AGENTS.md"),
        home.join(".claude/CLAUDE.md"),
        home.join(".codex/AGENTS.md"),
    ]
}

pub fn load(cwd: &Path) -> Vec<ContextFile> {
    let home = dirs::home_dir().unwrap_or_default();
    load_from(cwd, &global_candidates(&home, &crate::paths::home_dir()))
}

fn load_from(cwd: &Path, globals: &[PathBuf]) -> Vec<ContextFile> {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut take = |path: &Path, files: &mut Vec<ContextFile>| -> bool {
        let Some(content) = read(path) else { return false };
        let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if seen.insert(key) {
            files.push(ContextFile { path: path.display().to_string(), content });
        }
        true
    };

    for g in globals {
        if take(g, &mut files) {
            break;
        }
    }
    let mut dirs: Vec<&Path> = cwd.ancestors().collect();
    dirs.reverse();
    for dir in dirs {
        for name in PROJECT_NAMES {
            if take(&dir.join(name), &mut files) {
                break;
            }
        }
    }
    files
}

fn read(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.len() <= MAX_BYTES {
        return Some(text.to_string());
    }
    let mut end = MAX_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(format!("{}\n\n[truncated — the rest of {} was not loaded]", &text[..end], path.display()))
}

/// The prompt block, or empty when there are no files.
pub fn prompt_block(files: &[ContextFile]) -> String {
    super::system_prompt::build_project_context(files).map(|b| format!("\n\n## Instructions from files\n\n{b}")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("zwork-ctx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn global_then_root_to_cwd_nearest_last() {
        let root = &scratch();
        let work = root.join("a/b");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(root.join("a/CLAUDE.md"), "outer").unwrap();
        std::fs::write(work.join("AGENTS.md"), "inner").unwrap();
        std::fs::write(work.join("CLAUDE.md"), "shadowed by AGENTS.md").unwrap();
        std::fs::write(root.join("global.md"), "global").unwrap();
        std::fs::write(root.join("empty.md"), "  \n").unwrap();

        let globals = [root.join("missing.md"), root.join("empty.md"), root.join("global.md")];
        let got: Vec<String> = load_from(&work, &globals).into_iter().map(|f| f.content).collect();
        assert_eq!(got, ["global", "outer", "inner"]);
    }

    #[test]
    fn a_global_file_found_again_on_the_walk_loads_once() {
        let t = scratch();
        std::fs::write(t.join("AGENTS.md"), "once").unwrap();
        let got = load_from(&t, &[t.join("AGENTS.md")]);
        assert_eq!(got.len(), 1);
    }
}
