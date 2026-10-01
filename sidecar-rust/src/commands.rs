//! Slash commands: `/name args` at the start of a message.
//!
//! A command is a markdown prompt file — the format Claude Code, opencode,
//! pi and Codex share — expanded with its arguments (`$1`, `$ARGUMENTS`, …)
//! by the harness's prompt-template loader. Every skill is a command too, as
//! in Claude Code: `/pdf fill in this form` loads the skill with the rest as
//! instructions. The expansion is what the model sees; the chat keeps what
//! the user typed.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::harness::prompt_templates::{load_prompt_templates, parse_command_args, substitute_args, PromptTemplate};

/// Project-local command folders, relative to the working directory.
const PROJECT_DIRS: &[&str] = &[".zwork/commands", ".claude/commands", ".opencode/command", ".opencode/commands", ".pi/prompts"];

/// Other agents' global command folders, relative to the home directory.
const GLOBAL_DIRS: &[(&str, &str)] = &[
    (".claude/commands", "claude"),
    (".config/opencode/command", "opencode"),
    (".config/opencode/commands", "opencode"),
    (".pi/agent/prompts", "pi"),
    (".codex/prompts", "codex"),
];

fn locations(cwd: &Path, home: &Path) -> Vec<(PathBuf, String)> {
    let mut out = vec![(crate::paths::home_dir().join("commands"), "user".to_string())];
    out.extend(PROJECT_DIRS.iter().map(|d| (cwd.join(d), "project".to_string())));
    out.extend(GLOBAL_DIRS.iter().map(|(d, src)| (home.join(d), src.to_string())));
    out
}

fn load_from(locations: &[(PathBuf, String)]) -> Vec<PromptTemplate> {
    let mut seen = std::collections::HashSet::new();
    load_prompt_templates(locations).templates.into_iter().filter(|t| seen.insert(t.name.to_lowercase())).collect()
}

fn load() -> Vec<PromptTemplate> {
    let cwd = std::env::current_dir().unwrap_or_default();
    load_from(&locations(&cwd, &dirs::home_dir().unwrap_or_default()))
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandInfo {
    pub name: String,
    pub description: String,
    /// "command" | "skill"
    pub kind: &'static str,
    pub source: String,
}

/// Everything `/` can reach, for the composer's menu. Commands shadow skills
/// of the same name, matching [`expand`].
pub fn list() -> Vec<CommandInfo> {
    let mut out: Vec<CommandInfo> = load()
        .into_iter()
        .map(|t| CommandInfo { name: t.name, description: t.description, kind: "command", source: t.source })
        .collect();
    let taken: std::collections::HashSet<String> = out.iter().map(|c| c.name.to_lowercase()).collect();
    out.extend(crate::skills::list_skills().into_iter().filter(|s| !taken.contains(&s.slug.to_lowercase())).map(|s| CommandInfo {
        name: s.slug,
        description: s.description,
        kind: "skill",
        source: s.source,
    }));
    out
}

/// The prompt a `/name args` message stands for, or `None` when the message
/// isn't a command (including `/some/path` and unknown names).
pub fn expand(message: &str) -> Option<String> {
    let (name, rest) = split(message)?;
    if let Some(t) = load().into_iter().find(|t| t.name.eq_ignore_ascii_case(name)) {
        return Some(apply(&t.content, rest));
    }
    let skill = name.strip_prefix("skill:").unwrap_or(name);
    crate::skills::invoke(skill, Some(rest).filter(|r| !r.is_empty()))
}

fn split(message: &str) -> Option<(&str, &str)> {
    let body = message.trim_start().strip_prefix('/')?;
    let (name, rest) = body.split_once(char::is_whitespace).unwrap_or((body, ""));
    let valid = !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'));
    valid.then(|| (name, rest.trim()))
}

/// Substitute arguments; a template with no placeholders gets them appended
/// (Claude Code's behaviour) rather than silently dropped.
fn apply(content: &str, rest: &str) -> String {
    let expanded = substitute_args(content, &parse_command_args(rest));
    let has_placeholder = ["$ARGUMENTS", "$@", "${@"].iter().any(|p| content.contains(p))
        || content.match_indices('$').any(|(i, _)| content[i + 1..].starts_with(|c: char| c.is_ascii_digit()));
    if has_placeholder || rest.is_empty() {
        expanded
    } else {
        format!("{expanded}\n\n{rest}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("zwork-cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_command_shaped_messages_split() {
        assert_eq!(split("/review src/main.rs please"), Some(("review", "src/main.rs please")));
        assert_eq!(split("  /skill:pdf"), Some(("skill:pdf", "")));
        assert_eq!(split("/Users/me/file.txt what is this"), None);
        assert_eq!(split("hello /review"), None);
    }

    #[test]
    fn arguments_substitute_or_append() {
        assert_eq!(apply("Review $1 against $2.", "a.rs 'b c.rs'"), "Review a.rs against b c.rs.");
        assert_eq!(apply("Fix: $ARGUMENTS", "the login bug"), "Fix: the login bug");
        assert_eq!(apply("Summarize this week.", "focus on sales"), "Summarize this week.\n\nfocus on sales");
    }

    #[test]
    fn first_location_wins() {
        let (a, b) = (scratch(), scratch());
        std::fs::write(a.join("standup.md"), "---\ndescription: mine\n---\nmine").unwrap();
        std::fs::write(b.join("Standup.md"), "theirs").unwrap();
        std::fs::write(b.join("other.md"), "other").unwrap();
        let got = load_from(&[(a, "user".into()), (b, "claude".into())]);
        let names: Vec<(&str, &str)> = got.iter().map(|t| (t.name.as_str(), t.content.as_str())).collect();
        assert_eq!(names, [("standup", "mine"), ("other", "other")]);
    }
}
