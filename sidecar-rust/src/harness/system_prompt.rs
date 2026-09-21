//! Port of pi `core/system-prompt.ts`.
//!
//! The system prompt is assembled from named sections. Every section other
//! than `preamble` is rendered as `<name>\ncontent\n</name>` and the ordered
//! section map is stored on the transcript's system message so later turns
//! can diff/patch individual sections instead of re-sending the whole
//! prompt (see [`diff_system_prompt_sections`]).
//!
//! Differences from pi: no `docs` section (pi's own documentation pointers)
//! and a zWork preamble. Section names, ordering, wrapping and rule
//! semantics are otherwise identical.

use std::collections::{BTreeMap, HashMap};

use crate::harness::skills::{format_skills_for_prompt, Skill, SkillFileReadTool};
use crate::harness::types::SystemMessage;

/// Ordered list of section name → content. `None` content means the section
/// is absent (used only in patches; see [`SystemPromptSections`]).
pub type SystemPromptSections = Vec<(String, String)>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct BuildSystemPromptOptions<'a> {
    /// Replaces the default preamble.
    pub custom_prompt: Option<&'a str>,
    /// Bypasses section assembly entirely and uses this exact text.
    pub force_system_prompt: Option<&'a str>,
    /// Tools the model has access to. Defaults to read/bash/edit/write.
    pub selected_tools: Option<&'a [String]>,
    /// One-line description per tool for the `tools` section.
    pub tool_snippets: &'a HashMap<String, String>,
    /// Extra rules per tool for the `rules` section.
    pub tool_guidelines: &'a HashMap<String, Vec<String>>,
    /// Extra global rules.
    pub prompt_guidelines: &'a [String],
    /// Text for the `addendum` section.
    pub append_system_prompt: Option<&'a str>,
    /// Custom sections appended after the built-in ones.
    pub sections: &'a BTreeMap<String, String>,
    pub cwd: Option<&'a str>,
    /// Project instruction files (ZWORK.md, AGENTS.md, ...).
    pub context_files: &'a [ContextFile],
    pub skills: &'a [Skill],
}

pub const DEFAULT_SELECTED_TOOLS: [&str; 4] = ["read", "bash", "edit", "write"];

pub const DEFAULT_PREAMBLE: &str = "You are an expert assistant operating inside zWork, an agent harness. You help users by reading files, executing commands, editing code, writing new files, and operating the connected tools and integrations on their behalf.";

const RESERVED_SECTION_NAMES: [&str; 1] = ["preamble"];

pub fn is_valid_section_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn validate_section_name(name: &str) -> Result<(), String> {
    if !is_valid_section_name(name) || RESERVED_SECTION_NAMES.contains(&name) {
        return Err(format!("Invalid system prompt section name: {name}"));
    }
    Ok(())
}

fn build_rules(selected: &[String], options: &BuildSystemPromptOptions<'_>) -> Vec<String> {
    let has = |t: &str| selected.iter().any(|s| s == t);
    let mut rules: Vec<String> = Vec::new();
    if (has("bash") || has("powershell")) && !has("grep") && !has("find") && !has("ls") {
        rules.push("Use bash for file operations like ls, rg, find".into());
    }
    for tool in selected {
        if let Some(guidelines) = options.tool_guidelines.get(tool) {
            rules.extend(guidelines.iter().cloned());
        }
    }
    rules.extend(options.prompt_guidelines.iter().cloned());
    rules.push("Be concise in your responses".into());
    rules.push("Show file paths clearly when working with files".into());

    // Trim, drop empties, dedupe preserving first occurrence.
    let mut seen = std::collections::HashSet::new();
    rules
        .into_iter()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .filter(|r| seen.insert(r.clone()))
        .collect()
}

fn build_tools_section(selected: &[String], options: &BuildSystemPromptOptions<'_>) -> String {
    let lines: Vec<String> = selected
        .iter()
        .filter_map(|t| options.tool_snippets.get(t).map(|s| format!("- {t}: {s}")))
        .collect();
    let body = if lines.is_empty() { "(none)".to_string() } else { lines.join("\n") };
    format!("{body}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.")
}

fn build_project_context(files: &[ContextFile]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let blocks: Vec<String> = files
        .iter()
        .map(|f| format!("<project_instructions path=\"{}\">\n{}\n</project_instructions>", f.path, f.content))
        .collect();
    Some(format!("Project-specific instructions and guidelines:\n\n{}", blocks.join("\n\n")))
}

/// `buildSystemPromptSections`: ordered `(name, content)` pairs.
pub fn build_system_prompt_sections(options: &BuildSystemPromptOptions<'_>) -> Result<SystemPromptSections, String> {
    let default_tools: Vec<String> = DEFAULT_SELECTED_TOOLS.iter().map(|s| s.to_string()).collect();
    let selected: &[String] = options.selected_tools.unwrap_or(&default_tools);

    let mut sections: SystemPromptSections = Vec::new();
    sections.push(("preamble".into(), options.custom_prompt.unwrap_or(DEFAULT_PREAMBLE).to_string()));
    sections.push(("tools".into(), build_tools_section(selected, options)));

    let rules = build_rules(selected, options);
    if !rules.is_empty() {
        let rendered: Vec<String> = rules.iter().map(|r| format!("- {r}")).collect();
        sections.push(("rules".into(), rendered.join("\n")));
    }

    if let Some(addendum) = options.append_system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        sections.push(("addendum".into(), addendum.to_string()));
    }

    if let Some(ctx) = build_project_context(options.context_files) {
        sections.push(("project_context".into(), ctx));
    }

    if !options.skills.is_empty() {
        let read_tool = if selected.iter().any(|t| t == "read") {
            Some(SkillFileReadTool::Read)
        } else if selected.iter().any(|t| t == "bash") {
            Some(SkillFileReadTool::Bash)
        } else {
            None
        };
        if let Some(read_tool) = read_tool {
            let formatted = format_skills_for_prompt(options.skills, read_tool);
            let formatted = formatted.trim();
            if !formatted.is_empty() {
                sections.push(("skills".into(), formatted.to_string()));
            }
        }
    }

    if let Some(cwd) = options.cwd {
        sections.push(("cwd".into(), cwd.replace('\\', "/")));
    }

    for (name, content) in options.sections {
        validate_section_name(name)?;
        if sections.iter().any(|(n, _)| n == name) {
            // Custom sections override built-ins of the same name in place.
            if let Some(slot) = sections.iter_mut().find(|(n, _)| n == name) {
                slot.1 = content.clone();
            }
        } else {
            sections.push((name.clone(), content.clone()));
        }
    }

    Ok(sections)
}

/// Render sections to the flat text the provider sees.
pub fn render_sections(sections: &[(String, String)]) -> String {
    sections
        .iter()
        .filter(|(_, content)| !content.trim().is_empty())
        .map(|(name, content)| {
            if name == "preamble" {
                content.trim().to_string()
            } else {
                format!("<{name}>\n{}\n</{name}>", content.trim())
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// State stored on the transcript's system message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemPromptState {
    /// Free-form text (used only when the prompt was forced).
    pub content: String,
    /// Ordered sections; `None` when forced.
    pub sections: Option<SystemPromptSections>,
}

impl SystemPromptState {
    /// Flat prompt text.
    pub fn text(&self) -> String {
        match &self.sections {
            Some(sections) => {
                let rendered = render_sections(sections);
                if self.content.trim().is_empty() {
                    rendered
                } else if rendered.is_empty() {
                    self.content.trim().to_string()
                } else {
                    format!("{}\n\n{rendered}", self.content.trim())
                }
            }
            None => self.content.clone(),
        }
    }

    /// Ordered section map in the shape [`SystemMessage::sections`] stores.
    pub fn section_map(&self) -> Option<BTreeMap<String, Option<String>>> {
        self.sections
            .as_ref()
            .map(|s| s.iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect())
    }

    pub fn into_system_message(self) -> SystemMessage {
        let sections = self.section_map();
        SystemMessage {
            content: self.text(),
            sections,
            tools_added: None,
            tools_removed: None,
            timestamp: crate::harness::types::now_ms(),
        }
    }
}

/// `buildSystemPromptState`.
pub fn build_system_prompt_state(options: &BuildSystemPromptOptions<'_>) -> Result<SystemPromptState, String> {
    if let Some(forced) = options.force_system_prompt {
        return Ok(SystemPromptState { content: forced.to_string(), sections: None });
    }
    Ok(SystemPromptState { content: String::new(), sections: Some(build_system_prompt_sections(options)?) })
}

/// `buildSystemPrompt`: the flat prompt text.
pub fn build_system_prompt(options: &BuildSystemPromptOptions<'_>) -> Result<String, String> {
    Ok(build_system_prompt_state(options)?.text())
}

/// `diffSystemPromptSections`: a patch of changed sections. Changed or added
/// sections carry their new content; removed sections map to `None`.
/// Returns `None` when nothing changed.
pub fn diff_system_prompt_sections(
    previous: &[(String, String)],
    current: &[(String, String)],
) -> Option<BTreeMap<String, Option<String>>> {
    let prev: BTreeMap<&str, &str> = previous.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let cur: BTreeMap<&str, &str> = current.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let mut patch: BTreeMap<String, Option<String>> = BTreeMap::new();
    for (name, content) in &cur {
        if prev.get(name) != Some(content) {
            patch.insert((*name).to_string(), Some((*content).to_string()));
        }
    }
    for name in prev.keys() {
        if !cur.contains_key(name) {
            patch.insert((*name).to_string(), None);
        }
    }
    if patch.is_empty() {
        None
    } else {
        Some(patch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn base<'a>(
        snippets: &'a HashMap<String, String>,
        guidelines: &'a HashMap<String, Vec<String>>,
        sections: &'a BTreeMap<String, String>,
    ) -> BuildSystemPromptOptions<'a> {
        BuildSystemPromptOptions {
            custom_prompt: None,
            force_system_prompt: None,
            selected_tools: None,
            tool_snippets: snippets,
            tool_guidelines: guidelines,
            prompt_guidelines: &[],
            append_system_prompt: None,
            sections,
            cwd: None,
            context_files: &[],
            skills: &[],
        }
    }

    #[test]
    fn default_sections_and_rendering() {
        let mut snippets = HashMap::new();
        snippets.insert("read".to_string(), "Read a file".to_string());
        snippets.insert("bash".to_string(), "Run a command".to_string());
        let guidelines = HashMap::new();
        let sections = BTreeMap::new();
        let mut opts = base(&snippets, &guidelines, &sections);
        opts.cwd = Some("C:\\work\\proj");

        let built = build_system_prompt_sections(&opts).unwrap();
        let names: Vec<&str> = built.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["preamble", "tools", "rules", "cwd"]);
        let tools = &built[1].1;
        assert!(tools.starts_with("- read: Read a file\n- bash: Run a command\n\nIn addition"));
        let rules = &built[2].1;
        assert!(rules.starts_with("- Use bash for file operations like ls, rg, find\n"));
        assert!(rules.ends_with("- Show file paths clearly when working with files"));
        assert_eq!(built[3].1, "C:/work/proj");

        let text = build_system_prompt(&opts).unwrap();
        assert!(text.starts_with(DEFAULT_PREAMBLE));
        assert!(text.contains("\n\n<tools>\n- read: Read a file"));
        assert!(text.ends_with("<cwd>\nC:/work/proj\n</cwd>"));
    }

    #[test]
    fn rules_dedupe_and_skip_bash_hint_when_grep_present() {
        let snippets = HashMap::new();
        let mut guidelines = HashMap::new();
        guidelines.insert("edit".to_string(), vec!["Be concise in your responses".to_string(), "  ".to_string()]);
        let sections = BTreeMap::new();
        let mut opts = base(&snippets, &guidelines, &sections);
        let selected = vec!["bash".to_string(), "grep".to_string(), "edit".to_string()];
        opts.selected_tools = Some(&selected);
        let built = build_system_prompt_sections(&opts).unwrap();
        let rules = &built.iter().find(|(n, _)| n == "rules").unwrap().1;
        assert!(!rules.contains("Use bash for file operations"));
        assert_eq!(rules.matches("Be concise in your responses").count(), 1);
        assert_eq!(built[1].1.split("\n\n").next().unwrap(), "(none)");
    }

    #[test]
    fn project_context_addendum_skills_and_custom_sections() {
        let snippets = HashMap::new();
        let guidelines = HashMap::new();
        let mut sections = BTreeMap::new();
        sections.insert("memory".to_string(), "remember things".to_string());
        sections.insert("cwd".to_string(), "/override".to_string());
        let mut opts = base(&snippets, &guidelines, &sections);
        opts.append_system_prompt = Some("  extra  ");
        let files = vec![ContextFile { path: "/p/ZWORK.md".into(), content: "do X".into() }];
        opts.context_files = &files;
        let skills = vec![Skill {
            name: "docx".into(),
            description: "Word".into(),
            file_path: PathBuf::from("/s/docx/SKILL.md"),
            base_dir: PathBuf::from("/s/docx"),
            source: "user".into(),
            disable_model_invocation: false,
        }];
        opts.skills = &skills;
        opts.cwd = Some("/p");

        let built = build_system_prompt_sections(&opts).unwrap();
        let names: Vec<&str> = built.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["preamble", "tools", "rules", "addendum", "project_context", "skills", "cwd", "memory"]);
        assert_eq!(built[3].1, "extra");
        assert_eq!(
            built[4].1,
            "Project-specific instructions and guidelines:\n\n<project_instructions path=\"/p/ZWORK.md\">\ndo X\n</project_instructions>"
        );
        assert!(built[5].1.starts_with("The following skills provide"));
        assert!(built[5].1.contains("<name>docx</name>"));
        assert_eq!(built[6].1, "/override");
        assert_eq!(built[7].1, "remember things");
    }

    #[test]
    fn invalid_section_names_rejected() {
        let snippets = HashMap::new();
        let guidelines = HashMap::new();
        for bad in ["Preamble", "preamble", "1abc", "has space", ""] {
            let mut sections = BTreeMap::new();
            sections.insert(bad.to_string(), "x".to_string());
            let opts = base(&snippets, &guidelines, &sections);
            let err = build_system_prompt_sections(&opts).unwrap_err();
            assert_eq!(err, format!("Invalid system prompt section name: {bad}"));
        }
    }

    #[test]
    fn forced_prompt_has_no_sections() {
        let snippets = HashMap::new();
        let guidelines = HashMap::new();
        let sections = BTreeMap::new();
        let mut opts = base(&snippets, &guidelines, &sections);
        opts.force_system_prompt = Some("exact text");
        let state = build_system_prompt_state(&opts).unwrap();
        assert_eq!(state.sections, None);
        assert_eq!(state.text(), "exact text");
        let msg = state.into_system_message();
        assert_eq!(msg.content, "exact text");
        assert!(msg.sections.is_none());
    }

    #[test]
    fn diff_reports_changes_additions_removals() {
        let prev = vec![("a".to_string(), "1".to_string()), ("b".to_string(), "2".to_string())];
        let cur = vec![("a".to_string(), "1".to_string()), ("c".to_string(), "3".to_string())];
        assert_eq!(diff_system_prompt_sections(&prev, &prev), None);
        let patch = diff_system_prompt_sections(&prev, &cur).unwrap();
        assert_eq!(patch.get("b"), Some(&None));
        assert_eq!(patch.get("c"), Some(&Some("3".to_string())));
        assert!(!patch.contains_key("a"));
    }
}
