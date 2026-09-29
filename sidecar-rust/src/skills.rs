//! Skills from everywhere people keep them, loaded by the harness's Agent
//! Skills loader ([`crate::harness::skills`]).
//!
//! A skill installed for Claude Code, Codex, opencode or pi works in zWork
//! unchanged. When two locations define the same name the first wins:
//! the user's zWork skills, then the working directory's, then the skills
//! bundled with the app (written for zWork's tools), then other agents'
//! global folders.

use std::path::{Path, PathBuf};

use crate::harness::skills::{format_skill_invocation, load_skills, parse_frontmatter, LoadSkillsOptions, Skill};

#[derive(Clone, Debug)]
pub struct SkillMeta {
    /// What `read_skill` takes: the skill's name.
    pub slug: String,
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    /// "user" | "project" | "claude" | "codex" | ... | "bundled"
    pub source: String,
}

/// Project-local skill folders, relative to the working directory.
const PROJECT_DIRS: &[&str] = &[".zwork/skills", ".claude/skills", ".agents/skills", ".pi/skills", ".opencode/skill", ".opencode/skills"];

/// Other agents' global skill folders, relative to the home directory.
const GLOBAL_DIRS: &[(&str, &str)] = &[
    (".claude/skills", "claude"),
    (".agents/skills", "agents"),
    (".pi/agent/skills", "pi"),
    (".config/opencode/skill", "opencode"),
    (".config/opencode/skills", "opencode"),
    (".codex/skills", "codex"),
];

fn locations(cwd: &Path, home: &Path) -> Vec<(PathBuf, String)> {
    let mut out = vec![(crate::paths::home_dir().join("skills"), "user".to_string())];
    out.extend(PROJECT_DIRS.iter().map(|d| (cwd.join(d), "project".to_string())));
    out.push((crate::paths::skills_dir(), "bundled".to_string()));
    out.extend(GLOBAL_DIRS.iter().map(|(d, src)| (home.join(d), src.to_string())));
    out
}

fn load_all() -> Vec<Skill> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();
    let mut skills = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (dir, source) in locations(&cwd, &home) {
        if !dir.is_dir() {
            continue;
        }
        let loaded = load_skills(&LoadSkillsOptions {
            cwd: cwd.clone(),
            agent_dir: PathBuf::new(),
            skill_paths: vec![dir],
            include_defaults: false,
        });
        for mut s in loaded.skills {
            if seen.insert(s.name.to_lowercase()) {
                s.source = source.clone();
                skills.push(s);
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

pub fn list_skills() -> Vec<SkillMeta> {
    load_all()
        .into_iter()
        .filter(|s| !s.disable_model_invocation)
        .map(|s| SkillMeta {
            slug: s.name.clone(),
            name: s.name,
            description: clip(&s.description, 280),
            path: s.file_path,
            source: s.source,
        })
        .collect()
}

/// The skill's instructions, wrapped so relative references (`scripts/`,
/// `reference.md`) resolve against its folder. Accepts the name or, for
/// older transcripts, a `folder/name` path.
pub fn read_skill(slug: &str) -> Option<String> {
    let want = slug.trim().trim_matches('/').to_lowercase();
    let want = want.rsplit('/').next().unwrap_or(&want).to_string();
    let skill = load_all().into_iter().find(|s| {
        s.name.to_lowercase() == want || s.base_dir.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase() == want)
    })?;
    let raw = std::fs::read_to_string(&skill.file_path).ok()?;
    let body = parse_frontmatter(&raw).map(|fm| fm.body).unwrap_or(raw);
    Some(format_skill_invocation(&skill, body.trim(), None))
}

pub fn format_for_system_prompt() -> String {
    let skills = list_skills();
    if skills.is_empty() {
        return "(none installed)".to_string();
    }
    const LIMIT: usize = 60;
    let mut lines: Vec<String> = skills.iter().take(LIMIT).map(|s| format!("- `{}` — {}", s.slug, s.description)).collect();
    if skills.len() > LIMIT {
        lines.push(format!("- …and {} more", skills.len() - LIMIT));
    }
    lines.join("\n")
}

fn clip(s: &str, n: usize) -> String {
    let clean = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= n {
        return clean;
    }
    let cut: String = clean.chars().take(n - 1).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_skills_load_by_name_with_their_folder() {
        let names: Vec<String> = list_skills().into_iter().filter(|s| s.source == "bundled").map(|s| s.name).collect();
        if names.is_empty() {
            return; // no zWork-Skills checkout next to this build
        }
        assert!(names.iter().any(|n| n == "pdf"), "{names:?}");
        let pdf = read_skill("anthropic-skills/pdf").expect("path-style slug still resolves");
        assert!(pdf.starts_with("<skill name=\"pdf\""), "{}", &pdf[..80.min(pdf.len())]);
        assert!(pdf.contains("References are relative to"));
        assert!(!pdf.contains("\n---\nname:"), "frontmatter is stripped");
    }

    #[test]
    fn clip_counts_characters() {
        assert_eq!(clip("héllo  wörld", 6), "héllo…");
        assert_eq!(clip("a\nb", 10), "a b");
    }
}
