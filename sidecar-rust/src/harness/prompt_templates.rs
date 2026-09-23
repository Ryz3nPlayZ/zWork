//! Port of pi `harness/prompt-templates.ts`.
//!
//! Prompt templates are `.md` files with optional `description` /
//! `argument-hint` frontmatter that expand into a user prompt with
//! positional-argument substitution (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`,
//! `${@:N:L}`). Like pi, zWork treats them as application-invoked (the
//! runtime's `promptFromTemplate`), not model-invoked, so they are loaded
//! and formatted here but never advertised to the model.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::skills::parse_frontmatter;

const DESCRIPTION_FALLBACK_MAX: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub name: String,
    pub description: String,
    pub content: String,
    /// Where the template was loaded from ("user" | "project" | custom).
    pub source: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplateDiagnostic {
    /// Stable code (pi: file_info_failed | list_failed | read_failed | parse_failed).
    pub code: String,
    pub message: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoadPromptTemplatesResult {
    pub templates: Vec<PromptTemplate>,
    pub diagnostics: Vec<PromptTemplateDiagnostic>,
}

/// Load prompt templates from source-tagged paths (pi
/// `loadSourcedPromptTemplates`). Directory inputs load direct `.md`
/// children non-recursively; file inputs load explicit `.md` files. Missing
/// paths and non-markdown files are skipped silently; read/parse failures
/// surface as diagnostics.
pub fn load_prompt_templates(inputs: &[(PathBuf, String)]) -> LoadPromptTemplatesResult {
    let mut out = LoadPromptTemplatesResult::default();
    for (path, source) in inputs {
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue, // missing paths are skipped, not diagnosed
        };
        if meta.is_dir() {
            load_templates_from_dir(path, source, &mut out);
        } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md")) {
            load_template_from_file(path, source, &mut out);
        }
    }
    out
}

fn load_templates_from_dir(dir: &Path, source: &str, out: &mut LoadPromptTemplatesResult) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            out.diagnostics.push(PromptTemplateDiagnostic {
                code: "list_failed".into(),
                message: e.to_string(),
                path: dir.to_path_buf(),
            });
            return;
        }
    };
    let mut names: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .collect();
    names.sort();
    for path in names {
        if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md")) {
            load_template_from_file(&path, source, out);
        }
    }
}

fn load_template_from_file(path: &Path, source: &str, out: &mut LoadPromptTemplatesResult) {
    let raw = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            out.diagnostics.push(PromptTemplateDiagnostic {
                code: "read_failed".into(),
                message: e.to_string(),
                path: path.to_path_buf(),
            });
            return;
        }
    };
    let parsed = match parse_frontmatter(&raw) {
        Ok(p) => p,
        Err(e) => {
            out.diagnostics.push(PromptTemplateDiagnostic {
                code: "parse_failed".into(),
                message: e,
                path: path.to_path_buf(),
            });
            return;
        }
    };
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .trim_end_matches(".md")
        .to_string();
    let mut description = parsed.get("description").unwrap_or("").to_string();
    if description.is_empty() {
        if let Some(first_line) = parsed.body.lines().find(|l| !l.trim().is_empty()) {
            description = first_line.chars().take(DESCRIPTION_FALLBACK_MAX).collect();
            if first_line.chars().count() > DESCRIPTION_FALLBACK_MAX {
                description.push_str("...");
            }
        }
    }
    out.templates.push(PromptTemplate { name, description, content: parsed.body.trim().to_string(), source: source.into(), path: path.to_path_buf() });
}

/// Parse an argument string using simple shell-style single and double quotes.
pub fn parse_command_args(args_string: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quote: Option<char> = None;

    for c in args_string.chars() {
        if let Some(q) = in_quote {
            if c == q {
                in_quote = None;
            } else {
                current.push(c);
            }
        } else if c == '"' || c == '\'' {
            in_quote = Some(c);
        } else if c == ' ' || c == '\t' {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

/// Substitute prompt template placeholders (`$1`, `$@`, `$ARGUMENTS`,
/// `${@:N}`, `${@:N:L}`) with command arguments.
pub fn substitute_args(content: &str, args: &[String]) -> String {
    let dollar = |n: usize| args.get(n.wrapping_sub(1)).cloned().unwrap_or_default();
    let mut out = String::with_capacity(content.len());
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'$' {
            // Copy the full UTF-8 sequence.
            let start = i;
            i += 1;
            while i < bytes.len() && (bytes[i] & 0xc0) == 0x80 {
                i += 1;
            }
            out.push_str(&content[start..i]);
            continue;
        }
        // $ at end of string.
        if i + 1 >= bytes.len() {
            out.push('$');
            break;
        }
        let next = bytes[i + 1];
        if next == b'{' {
            if let Some(end) = content[i..].find('}') {
                let spec = &content[i + 2..i + end]; // between "${" and "}"
                if let Some(rest) = spec.strip_prefix("@:") {
                    let (start_s, len_s) = match rest.split_once(':') {
                        Some((s, l)) => (s, Some(l)),
                        None => (rest, None),
                    };
                    if let (Ok(start), Ok(len)) = (start_s.parse::<usize>(), len_s.map(str::parse::<usize>).transpose()) {
                        let start = start.saturating_sub(1);
                        let joined = match len {
                            Some(l) => args.iter().skip(start).take(l).cloned().collect::<Vec<_>>().join(" "),
                            None => args.iter().skip(start).cloned().collect::<Vec<_>>().join(" "),
                        };
                        out.push_str(&joined);
                        i += end + 1;
                        continue;
                    }
                }
            }
            out.push('$');
            i += 1;
            continue;
        }
        if next.is_ascii_digit() {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if let Ok(n) = content[i + 1..j].parse::<usize>() {
                out.push_str(&dollar(n));
                i = j;
                continue;
            }
        }
        if content[i..].starts_with("$ARGUMENTS") {
            out.push_str(&args.join(" "));
            i += "$ARGUMENTS".len();
            continue;
        }
        if next == b'@' {
            out.push_str(&args.join(" "));
            i += 2;
            continue;
        }
        out.push('$');
        i += 1;
    }
    out
}

/// Format a prompt template invocation with positional arguments.
pub fn format_prompt_template_invocation(template: &PromptTemplate, args: &[String]) -> String {
    substitute_args(&template.content, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, content: &str) {
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn loads_templates_from_dir_and_file() {
        let dir = std::env::temp_dir().join(format!("zwork-tpl-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        write(
            &dir.join("review.md"),
            "---\ndescription: Review a diff\n---\nPlease review $1 against $2.",
        );
        write(&dir.join("notes.txt"), "not markdown");
        let nested = dir.join("nested.md");
        std::fs::create_dir(&nested).unwrap();
        write(&nested.join("inner.md"), "nested");

        let standalone = std::env::temp_dir().join(format!("zwork-tpl-{}.md", uuid::Uuid::new_v4().simple()));
        write(&standalone, "First body line is long enough to be truncated past the sixty character limit for descriptions");

        let result = load_prompt_templates(&[
            (dir.clone(), "user".into()),
            (standalone.clone(), "path".into()),
            (dir.join("missing"), "user".into()),
        ]);
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_file(&standalone).ok();

        assert_eq!(result.templates.len(), 2);
        assert!(result.diagnostics.is_empty());
        let review = result.templates.iter().find(|t| t.name == "review").unwrap();
        assert_eq!(review.description, "Review a diff");
        assert_eq!(review.source, "user");
        // Nested directories are not walked; non-markdown is skipped.
        assert!(!result.templates.iter().any(|t| t.name == "inner" || t.name == "notes"));

        let solo = result.templates.iter().find(|t| t.path == standalone).unwrap();
        assert!(solo.description.starts_with("First body line is long enough to be truncated past the"));
        assert!(solo.description.ends_with("..."));
        assert_eq!(solo.description.len(), DESCRIPTION_FALLBACK_MAX + 3);
    }

    #[test]
    fn command_args_quoting() {
        assert_eq!(parse_command_args("a 'b c' \"d'e\""), vec!["a", "b c", "d'e"]);
        assert_eq!(parse_command_args("  spaced\tout  "), vec!["spaced", "out"]);
        assert_eq!(parse_command_args(""), Vec::<String>::new());
    }

    #[test]
    fn substitutes_all_placeholder_forms() {
        let args: Vec<String> = ["one", "two", "three"].map(String::from).to_vec();
        assert_eq!(substitute_args("$1 and $2", &args), "one and two");
        assert_eq!(substitute_args("$9 missing", &args), " missing");
        assert_eq!(substitute_args("$@", &args), "one two three");
        assert_eq!(substitute_args("$ARGUMENTS", &args), "one two three");
        assert_eq!(substitute_args("${@:2}", &args), "two three");
        assert_eq!(substitute_args("${@:2:1}", &args), "two");
        assert_eq!(substitute_args("costs $5 or $$", &args), "costs  or $$");
        assert_eq!(substitute_args("plain text", &args), "plain text");
    }

    #[test]
    fn invocation_formats() {
        let t = PromptTemplate {
            name: "review".into(),
            description: String::new(),
            content: "Review $1".into(),
            source: "user".into(),
            path: PathBuf::new(),
        };
        assert_eq!(
            format_prompt_template_invocation(&t, &["src/main.rs".into()]),
            "Review src/main.rs"
        );
    }
}
