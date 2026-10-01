//! Port of pi `core/skills.ts` + `utils/frontmatter.ts`.
//!
//! Skills follow the Agent Skills spec (https://agentskills.io): a
//! directory holding a `SKILL.md` with `name` / `description` frontmatter.
//! The loader walks skill roots, validates names and descriptions, and
//! formats the visible skills as the `<available_skills>` prompt block.
//!
//! Differences from pi: `.gitignore`/`.ignore` files inside skill roots
//! are not honoured (no ignore-matcher crate); dot-directories and
//! `node_modules` are still skipped. Frontmatter is parsed with a small
//! YAML subset (scalars, quoted strings, `|`/`>` block scalars) rather
//! than a full YAML parser.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;

/// Name of the per-project config directory (pi: `.pi`).
pub const CONFIG_DIR_NAME: &str = ".zwork";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub file_path: PathBuf,
    pub base_dir: PathBuf,
    /// "user" | "project" | "path" | custom
    pub source: String,
    pub disable_model_invocation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SkillDiagnostic {
    Warning {
        message: String,
        path: PathBuf,
    },
    Collision {
        message: String,
        path: PathBuf,
        name: String,
        winner_path: PathBuf,
        loser_path: PathBuf,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoadSkillsResult {
    pub skills: Vec<Skill>,
    pub diagnostics: Vec<SkillDiagnostic>,
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub fields: BTreeMap<String, String>,
    pub body: String,
}

impl Frontmatter {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields.get(key).map(String::as_str)
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        match self.get(key)?.trim() {
            "true" | "True" | "TRUE" | "yes" => Some(true),
            "false" | "False" | "FALSE" | "no" => Some(false),
            _ => None,
        }
    }
}

fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 {
        let (first, last) = (v.as_bytes()[0], v.as_bytes()[v.len() - 1]);
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            let inner = &v[1..v.len() - 1];
            return if first == b'"' {
                inner.replace("\\\"", "\"").replace("\\n", "\n")
            } else {
                inner.replace("''", "'")
            };
        }
    }
    v.to_string()
}

/// Parse a YAML-ish frontmatter block. Returns empty fields (and the whole
/// text as body) when there is no `---` block.
pub fn parse_frontmatter(content: &str) -> Result<Frontmatter, String> {
    let normalized = normalize_newlines(content.trim_start_matches('\u{feff}'));
    if !normalized.starts_with("---") {
        return Ok(Frontmatter { fields: BTreeMap::new(), body: normalized });
    }
    let Some(end) = normalized[3..].find("\n---") else {
        return Ok(Frontmatter { fields: BTreeMap::new(), body: normalized });
    };
    let yaml = &normalized[4..3 + end];
    let body = normalized[3 + end + 4..].trim().to_string();

    let mut fields = BTreeMap::new();
    let lines: Vec<&str> = yaml.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        i += 1;
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            return Err(format!("unexpected indented line in frontmatter: {trimmed}"));
        }
        let Some(colon) = line.find(':') else {
            return Err(format!("invalid frontmatter line: {trimmed}"));
        };
        let key = line[..colon].trim().to_string();
        let raw = line[colon + 1..].trim();
        let value = if raw == "|" || raw == ">" || raw == "|-" || raw == ">-" {
            // Block scalar: consume indented continuation lines.
            let mut block: Vec<String> = Vec::new();
            while i < lines.len() && (lines[i].starts_with(' ') || lines[i].starts_with('\t') || lines[i].trim().is_empty()) {
                block.push(lines[i].trim().to_string());
                i += 1;
            }
            while block.last().is_some_and(|l| l.is_empty()) {
                block.pop();
            }
            if raw.starts_with('|') {
                block.join("\n")
            } else {
                block.join(" ")
            }
        } else if raw.is_empty() {
            // Value may continue on indented lines (plain multi-line scalar).
            let mut cont: Vec<String> = Vec::new();
            while i < lines.len() && (lines[i].starts_with(' ') || lines[i].starts_with('\t')) {
                cont.push(lines[i].trim().to_string());
                i += 1;
            }
            cont.join(" ")
        } else {
            let mut value = unquote(raw);
            // Plain scalars may wrap onto indented continuation lines.
            if !raw.starts_with('"') && !raw.starts_with('\'') {
                while i < lines.len() && (lines[i].starts_with(' ') || lines[i].starts_with('\t')) && !lines[i].trim().is_empty() {
                    value.push(' ');
                    value.push_str(lines[i].trim());
                    i += 1;
                }
            }
            value
        };
        fields.insert(key, value);
    }
    Ok(Frontmatter { fields, body })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn validate_name(name: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if name.len() > MAX_NAME_LENGTH {
        errors.push(format!("name exceeds {MAX_NAME_LENGTH} characters ({})", name.len()));
    }
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)".into());
    }
    if name.starts_with('-') || name.ends_with('-') {
        errors.push("name must not start or end with a hyphen".into());
    }
    if name.contains("--") {
        errors.push("name must not contain consecutive hyphens".into());
    }
    errors
}

fn validate_description(description: Option<&str>) -> Vec<String> {
    match description {
        Some(d) if !d.trim().is_empty() => {
            if d.len() > MAX_DESCRIPTION_LENGTH {
                vec![format!("description exceeds {MAX_DESCRIPTION_LENGTH} characters ({})", d.len())]
            } else {
                Vec::new()
            }
        }
        _ => vec!["description is required".into()],
    }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

fn warning(message: impl Into<String>, path: &Path) -> SkillDiagnostic {
    SkillDiagnostic::Warning { message: message.into(), path: path.to_path_buf() }
}

fn load_skill_from_file(file_path: &Path, source: &str) -> (Option<Skill>, Vec<SkillDiagnostic>) {
    let mut diagnostics = Vec::new();
    let is_declared_skill = file_path.file_name().is_some_and(|n| n == "SKILL.md");

    let raw = match fs::read_to_string(file_path) {
        Ok(s) => s,
        Err(e) => {
            diagnostics.push(warning(e.to_string(), file_path));
            return (None, diagnostics);
        }
    };

    let fm = match parse_frontmatter(&raw) {
        Ok(fm) => fm,
        Err(e) => {
            if is_declared_skill {
                diagnostics.push(warning(e, file_path));
            }
            return (None, diagnostics);
        }
    };

    let description = fm.get("description");
    let has_description = description.is_some_and(|d| !d.trim().is_empty());
    if !is_declared_skill && !has_description {
        return (None, diagnostics);
    }

    let skill_dir = file_path.parent().map(Path::to_path_buf).unwrap_or_default();
    let parent_dir_name = skill_dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    for e in validate_description(description) {
        diagnostics.push(warning(e, file_path));
    }

    let name = fm
        .get("name")
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or(parent_dir_name);
    for e in validate_name(&name) {
        diagnostics.push(warning(e, file_path));
    }

    if !has_description {
        return (None, diagnostics);
    }

    let skill = Skill {
        name,
        description: description.unwrap_or_default().to_string(),
        file_path: file_path.to_path_buf(),
        base_dir: skill_dir,
        source: source.to_string(),
        disable_model_invocation: fm.get_bool("disable-model-invocation").unwrap_or(false),
    };
    (Some(skill), diagnostics)
}

/// Load skills from a directory.
///
/// Discovery rules:
/// - a directory containing `SKILL.md` is a skill root; don't recurse further
/// - otherwise load direct `.md` children of the root (only when they carry
///   a description)
/// - recurse into subdirectories to find `SKILL.md`
pub fn load_skills_from_dir(dir: &Path, source: &str) -> LoadSkillsResult {
    load_skills_from_dir_internal(dir, source, true)
}

fn load_skills_from_dir_internal(dir: &Path, source: &str, include_root_files: bool) -> LoadSkillsResult {
    let mut result = LoadSkillsResult::default();
    let Ok(entries) = fs::read_dir(dir) else { return result };
    let mut entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();

    // A SKILL.md makes this directory a skill root.
    if let Some(skill_md) = entries.iter().find(|p| p.file_name().is_some_and(|n| n == "SKILL.md")) {
        if skill_md.is_file() {
            let (skill, diags) = load_skill_from_file(skill_md, source);
            result.skills.extend(skill);
            result.diagnostics.extend(diags);
            return result;
        }
    }

    for path in entries {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        // `is_dir`/`is_file` follow symlinks; broken links fail both and are skipped.
        if path.is_dir() {
            let sub = load_skills_from_dir_internal(&path, source, false);
            result.skills.extend(sub.skills);
            result.diagnostics.extend(sub.diagnostics);
            continue;
        }
        if !path.is_file() || !include_root_files || !name.ends_with(".md") {
            continue;
        }
        let (skill, diags) = load_skill_from_file(&path, source);
        result.skills.extend(skill);
        result.diagnostics.extend(diags);
    }
    result
}

pub struct LoadSkillsOptions {
    /// Working directory for project-local skills.
    pub cwd: PathBuf,
    /// Agent config directory for global skills (`<agent_dir>/skills`).
    pub agent_dir: PathBuf,
    /// Explicit skill paths (files or directories).
    pub skill_paths: Vec<PathBuf>,
    /// Include the default user/project skill directories.
    pub include_defaults: bool,
}

fn is_under_path(target: &Path, root: &Path) -> bool {
    target == root || target.starts_with(root)
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `loadSkills`: gather skills from every configured location, dropping
/// symlinked duplicates silently and reporting name collisions (first wins).
pub fn load_skills(options: &LoadSkillsOptions) -> LoadSkillsResult {
    let user_skills_dir = options.agent_dir.join("skills");
    let project_skills_dir = options.cwd.join(CONFIG_DIR_NAME).join("skills");

    let mut acc = Accumulator::default();

    if options.include_defaults {
        acc.add(load_skills_from_dir_internal(&user_skills_dir, "user", true));
        acc.add(load_skills_from_dir_internal(&project_skills_dir, "project", true));
    }

    for raw in &options.skill_paths {
        let resolved = if raw.is_absolute() { raw.clone() } else { options.cwd.join(raw) };
        if !resolved.exists() {
            acc.diagnostics.push(warning("skill path does not exist", &resolved));
            continue;
        }
        let source = if !options.include_defaults {
            if is_under_path(&resolved, &user_skills_dir) {
                "user"
            } else if is_under_path(&resolved, &project_skills_dir) {
                "project"
            } else {
                "path"
            }
        } else {
            "path"
        };
        if resolved.is_dir() {
            acc.add(load_skills_from_dir_internal(&resolved, source, true));
        } else if resolved.is_file() && resolved.extension().is_some_and(|e| e == "md") {
            let (skill, diags) = load_skill_from_file(&resolved, source);
            acc.add(LoadSkillsResult { skills: skill.into_iter().collect(), diagnostics: diags });
        } else {
            acc.diagnostics.push(warning("skill path is not a markdown file", &resolved));
        }
    }

    let Accumulator { skills, mut diagnostics, collisions, .. } = acc;
    diagnostics.extend(collisions);
    LoadSkillsResult { skills, diagnostics }
}

/// Merges per-location results: symlinked duplicates are dropped silently,
/// name collisions keep the first skill and record a diagnostic.
#[derive(Default)]
struct Accumulator {
    by_name: HashMap<String, usize>,
    real_paths: HashSet<PathBuf>,
    skills: Vec<Skill>,
    diagnostics: Vec<SkillDiagnostic>,
    collisions: Vec<SkillDiagnostic>,
}

impl Accumulator {
    fn add(&mut self, result: LoadSkillsResult) {
        self.diagnostics.extend(result.diagnostics);
        for skill in result.skills {
            let real = canonical(&skill.file_path);
            if self.real_paths.contains(&real) {
                continue;
            }
            if let Some(&existing) = self.by_name.get(&skill.name) {
                self.collisions.push(SkillDiagnostic::Collision {
                    message: format!("name \"{}\" collision", skill.name),
                    path: skill.file_path.clone(),
                    name: skill.name.clone(),
                    winner_path: self.skills[existing].file_path.clone(),
                    loser_path: skill.file_path.clone(),
                });
            } else {
                self.by_name.insert(skill.name.clone(), self.skills.len());
                self.real_paths.insert(real);
                self.skills.push(skill);
            }
        }
    }
}


// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

pub fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Which tool the prompt tells the model to load skill files with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillFileReadTool {
    Read,
    Bash,
}

/// `formatSkillsForPrompt`: `<available_skills>` block per the Agent Skills
/// integration guide. Skills with `disable-model-invocation` are omitted.
/// One skill invocation as sent to the model (pi `formatSkillInvocation`).
/// `content` is the SKILL.md body; callers read it from disk at invocation.
pub fn format_skill_invocation(skill: &Skill, content: &str, additional_instructions: Option<&str>) -> String {
    let skill_block = format!(
        "<skill name=\"{}\" location=\"{}\">\nReferences are relative to {}.\n\n{}\n</skill>",
        skill.name,
        skill.file_path.display(),
        skill.base_dir.display(),
        content
    );
    match additional_instructions {
        Some(extra) => format!("{skill_block}\n\n{extra}"),
        None => skill_block,
    }
}

pub fn format_skills_for_prompt(skills: &[Skill], file_read_tool: SkillFileReadTool) -> String {
    let visible: Vec<&Skill> = skills.iter().filter(|s| !s.disable_model_invocation).collect();
    if visible.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = vec![
        "\n\nThe following skills provide specialized instructions for specific tasks.".into(),
        match file_read_tool {
            SkillFileReadTool::Read => "Use the read tool to load a skill's file when the task matches its description.".into(),
            SkillFileReadTool::Bash => "Use bash to load a skill's file when the task matches its description.".into(),
        },
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.".into(),
        String::new(),
        "<available_skills>".into(),
    ];
    for skill in visible {
        lines.push("  <skill>".into());
        lines.push(format!("    <name>{}</name>", escape_xml(&skill.name)));
        lines.push(format!("    <description>{}</description>", escape_xml(&skill.description)));
        lines.push(format!("    <location>{}</location>", escape_xml(&skill.file_path.to_string_lossy())));
        lines.push("  </skill>".into());
    }
    lines.push("</available_skills>".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zwork-skills-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn frontmatter_scalars_quotes_and_blocks() {
        let fm = parse_frontmatter(
            "---\nname: docx\ndescription: \"Make, read: docs\"\nlong: >\n  first line\n  second line\nlit: |\n  a\n  b\ndisable-model-invocation: true\n---\n# Body\n",
        )
        .unwrap();
        assert_eq!(fm.get("name"), Some("docx"));
        assert_eq!(fm.get("description"), Some("Make, read: docs"));
        assert_eq!(fm.get("long"), Some("first line second line"));
        assert_eq!(fm.get("lit"), Some("a\nb"));
        assert_eq!(fm.get_bool("disable-model-invocation"), Some(true));
        assert_eq!(fm.body, "# Body");
    }

    #[test]
    fn frontmatter_absent_or_unterminated() {
        let fm = parse_frontmatter("# no frontmatter\n").unwrap();
        assert!(fm.fields.is_empty());
        let fm = parse_frontmatter("---\nname: x\n# never closed\n").unwrap();
        assert!(fm.fields.is_empty());
        assert!(parse_frontmatter("---\n  bad: indent\n---\n").is_err());
    }

    #[test]
    fn loads_skill_roots_and_root_md_files() {
        let root = tmp("load");
        fs::create_dir_all(root.join("docx/scripts")).unwrap();
        fs::write(root.join("docx/SKILL.md"), "---\nname: docx\ndescription: Word documents\n---\nbody").unwrap();
        // nested SKILL.md under a skill root is ignored (root wins)
        fs::write(root.join("docx/scripts/SKILL.md"), "---\nname: nested\ndescription: nope\n---").unwrap();
        // root .md with description → skill; without → ignored
        fs::write(root.join("notes.md"), "---\nname: notes\ndescription: Loose notes\n---").unwrap();
        fs::write(root.join("README.md"), "# readme").unwrap();
        // deeper directory found via recursion; name from folder
        fs::create_dir_all(root.join("group/pdf")).unwrap();
        fs::write(root.join("group/pdf/SKILL.md"), "---\ndescription: PDFs\n---").unwrap();
        // hidden + node_modules skipped
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join(".hidden/SKILL.md"), "---\ndescription: hidden\n---").unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("node_modules/x/SKILL.md"), "---\ndescription: dep\n---").unwrap();

        let result = load_skills_from_dir(&root, "user");
        let mut names: Vec<&str> = result.skills.iter().map(|s| s.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["docx", "notes", "pdf"]);
        let pdf = result.skills.iter().find(|s| s.name == "pdf").unwrap();
        assert_eq!(pdf.base_dir, root.join("group/pdf"));
        assert_eq!(pdf.source, "user");
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_description_and_bad_name_diagnostics() {
        let root = tmp("diag");
        fs::create_dir_all(root.join("Bad_Name")).unwrap();
        fs::write(root.join("Bad_Name/SKILL.md"), "---\nname: Bad_Name\n---").unwrap();
        let result = load_skills_from_dir(&root, "user");
        assert!(result.skills.is_empty());
        let msgs: Vec<String> = result
            .diagnostics
            .iter()
            .map(|d| match d {
                SkillDiagnostic::Warning { message, .. } => message.clone(),
                _ => String::new(),
            })
            .collect();
        assert!(msgs.iter().any(|m| m == "description is required"));
        assert!(msgs.iter().any(|m| m.contains("invalid characters")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_skills_dedupes_and_reports_collisions() {
        let agent = tmp("agent");
        let cwd = tmp("cwd");
        fs::create_dir_all(agent.join("skills/a")).unwrap();
        fs::write(agent.join("skills/a/SKILL.md"), "---\nname: a\ndescription: user a\n---").unwrap();
        fs::create_dir_all(cwd.join(CONFIG_DIR_NAME).join("skills/a")).unwrap();
        fs::write(cwd.join(CONFIG_DIR_NAME).join("skills/a/SKILL.md"), "---\nname: a\ndescription: project a\n---").unwrap();
        let extra = tmp("extra");
        fs::create_dir_all(extra.join("b")).unwrap();
        fs::write(extra.join("b/SKILL.md"), "---\ndescription: b\n---").unwrap();

        let result = load_skills(&LoadSkillsOptions {
            cwd: cwd.clone(),
            agent_dir: agent.clone(),
            skill_paths: vec![extra.clone(), extra.join("missing")],
            include_defaults: true,
        });
        let names: Vec<&str> = result.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b"]);
        assert_eq!(result.skills[0].description, "user a");
        assert_eq!(result.skills[1].source, "path");
        assert!(result.diagnostics.iter().any(|d| matches!(d, SkillDiagnostic::Collision { name, .. } if name == "a")));
        assert!(result
            .diagnostics
            .iter()
            .any(|d| matches!(d, SkillDiagnostic::Warning { message, .. } if message == "skill path does not exist")));
        for d in [agent, cwd, extra] {
            fs::remove_dir_all(d).ok();
        }
    }

    #[test]
    fn prompt_format_escapes_and_hides_disabled() {
        let skills = vec![
            Skill {
                name: "a".into(),
                description: "x < y & \"z\"".into(),
                file_path: PathBuf::from("/s/a/SKILL.md"),
                base_dir: PathBuf::from("/s/a"),
                source: "user".into(),
                disable_model_invocation: false,
            },
            Skill {
                name: "hidden".into(),
                description: "no".into(),
                file_path: PathBuf::from("/s/h/SKILL.md"),
                base_dir: PathBuf::from("/s/h"),
                source: "user".into(),
                disable_model_invocation: true,
            },
        ];
        let out = format_skills_for_prompt(&skills, SkillFileReadTool::Read);
        assert!(out.contains("Use the read tool to load"));
        assert!(out.contains("<description>x &lt; y &amp; &quot;z&quot;</description>"));
        assert!(out.contains("<location>/s/a/SKILL.md</location>"));
        assert!(!out.contains("hidden"));
        assert_eq!(format_skills_for_prompt(&skills[1..], SkillFileReadTool::Bash), "");
    }
}
