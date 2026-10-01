//! Port of pi `core/tools/grep.ts`, using the native walker instead of rg.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use regex::{Regex, RegexBuilder};
use serde_json::{json, Value};

use crate::harness::agent_types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolFuture};
use crate::harness::types::AbortSignal;

use super::path_utils::{relative_posix, resolve_to_cwd};
use super::truncate::{format_size, truncate_head, truncate_line, TruncationOptions, DEFAULT_MAX_BYTES, GREP_MAX_LINE_LENGTH};
use super::walk::{glob_to_regex, walk, WalkOptions};

pub const GREP_SNIPPET: &str = "Search file contents for patterns (respects .gitignore)";
pub const DEFAULT_LIMIT: usize = 100;

pub struct GrepTool {
    cwd: PathBuf,
    description: String,
}

impl GrepTool {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            description: format!(
                "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to {DEFAULT_LIMIT} matches or {}KB (whichever is hit first). Long lines are truncated to {GREP_MAX_LINE_LENGTH} chars.",
                DEFAULT_MAX_BYTES / 1024
            ),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrepArgs {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    glob: Option<String>,
    #[serde(default)]
    ignore_case: Option<bool>,
    #[serde(default)]
    literal: Option<bool>,
    #[serde(default)]
    context: Option<f64>,
    #[serde(default)]
    limit: Option<f64>,
}

struct Match {
    file: PathBuf,
    line_number: usize,
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

struct GrepRun {
    matches: Vec<Match>,
    limit_reached: bool,
}

fn run_grep(search_path: &Path, is_dir: bool, re: &Regex, glob: Option<&Regex>, limit: usize, signal: Option<&AbortSignal>) -> Result<GrepRun, String> {
    let mut matches = Vec::new();
    let mut limit_reached = false;
    let mut scan_file = |path: &Path| -> bool {
        if let Some(g) = glob {
            let rel = relative_posix(path, search_path).unwrap_or_else(|| path.display().to_string());
            let base = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !g.is_match(&rel) && !g.is_match(&base) {
                return true;
            }
        }
        let Ok(bytes) = std::fs::read(path) else { return true };
        if is_binary(&bytes) {
            return true;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.split('\n').enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if re.is_match(line) {
                matches.push(Match { file: path.to_path_buf(), line_number: i + 1 });
                if matches.len() >= limit {
                    limit_reached = true;
                    return false;
                }
            }
        }
        true
    };
    if is_dir {
        walk(WalkOptions { root: search_path, respect_gitignore: true, signal }, &mut |entry| {
            if entry.is_dir {
                return true;
            }
            scan_file(&entry.path)
        })?;
    } else {
        scan_file(search_path);
    }
    if signal.map(|s| s.is_aborted()).unwrap_or(false) {
        return Err("Operation aborted".into());
    }
    Ok(GrepRun { matches, limit_reached })
}

impl AgentTool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Search pattern (regex or literal string)" },
                "path": { "type": "string", "description": "Directory or file to search (default: current directory)" },
                "glob": { "type": "string", "description": "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
                "ignoreCase": { "type": "boolean", "description": "Case-insensitive search (default: false)" },
                "literal": { "type": "boolean", "description": "Treat pattern as literal string instead of regex (default: false)" },
                "context": { "type": "number", "description": "Number of lines to show before and after each match (default: 0)" },
                "limit": { "type": "number", "description": format!("Maximum number of matches to return (default: {DEFAULT_LIMIT})") }
            },
            "required": ["pattern"]
        })
    }
    fn prompt_snippet(&self) -> Option<&str> {
        Some(GREP_SNIPPET)
    }
    fn execute<'a>(&'a self, _id: &'a str, params: Value, signal: Option<&'a AbortSignal>, _on_update: AgentToolUpdateCallback) -> ToolFuture<'a> {
        Box::pin(async move {
            if signal.map(|s| s.is_aborted()).unwrap_or(false) {
                return Err("Operation aborted".into());
            }
            let args: GrepArgs = serde_json::from_value(params).map_err(|e| format!("Invalid grep arguments: {e}"))?;
            let search_path = resolve_to_cwd(args.path.as_deref().unwrap_or("."), &self.cwd);
            let meta = std::fs::metadata(&search_path).map_err(|_| format!("Path not found: {}", search_path.display()))?;
            let is_dir = meta.is_dir();
            let context = args.context.filter(|c| *c > 0.0).map(|c| c as usize).unwrap_or(0);
            let limit = args.limit.map(|l| l as usize).unwrap_or(DEFAULT_LIMIT).max(1);
            let pattern = if args.literal.unwrap_or(false) { regex::escape(&args.pattern) } else { args.pattern.clone() };
            let re = RegexBuilder::new(&pattern)
                .case_insensitive(args.ignore_case.unwrap_or(false))
                .build()
                .map_err(|e| format!("Invalid regex pattern: {e}"))?;
            let glob = match &args.glob {
                Some(g) => Some(glob_to_regex(g, false)?),
                None => None,
            };

            let signal_owned = signal.cloned();
            let sp = search_path.clone();
            let run = tokio::task::spawn_blocking(move || run_grep(&sp, is_dir, &re, glob.as_ref(), limit, signal_owned.as_ref()))
                .await
                .map_err(|e| format!("grep task failed: {e}"))??;

            if run.matches.is_empty() {
                return Ok(AgentToolResult::text("No matches found"));
            }

            let format_path = |file: &Path| -> String {
                if is_dir {
                    if let Some(rel) = relative_posix(file, &search_path) {
                        if !rel.is_empty() && !rel.starts_with("..") {
                            return rel;
                        }
                    }
                }
                file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            };
            let mut cache: HashMap<PathBuf, Vec<String>> = HashMap::new();
            let mut lines_truncated = false;
            let mut out: Vec<String> = Vec::new();
            for m in &run.matches {
                let rel = format_path(&m.file);
                let lines = cache.entry(m.file.clone()).or_insert_with(|| {
                    std::fs::read(&m.file)
                        .map(|b| String::from_utf8_lossy(&b).replace("\r\n", "\n").replace('\r', "\n").split('\n').map(String::from).collect())
                        .unwrap_or_default()
                });
                if lines.is_empty() {
                    out.push(format!("{rel}:{}: (unable to read file)", m.line_number));
                    continue;
                }
                let start = if context > 0 { m.line_number.saturating_sub(context).max(1) } else { m.line_number };
                let end = if context > 0 { (m.line_number + context).min(lines.len()) } else { m.line_number };
                for cur in start..=end {
                    let text = lines.get(cur - 1).map(String::as_str).unwrap_or("");
                    let (t, was) = truncate_line(text, GREP_MAX_LINE_LENGTH);
                    if was {
                        lines_truncated = true;
                    }
                    if cur == m.line_number {
                        out.push(format!("{rel}:{cur}: {t}"));
                    } else {
                        out.push(format!("{rel}-{cur}- {t}"));
                    }
                }
            }
            let raw = out.join("\n");
            let truncation = truncate_head(&raw, TruncationOptions::bytes_only());
            let mut output = truncation.content.clone();
            let mut details = serde_json::Map::new();
            let mut notices = Vec::new();
            if run.limit_reached {
                notices.push(format!("{limit} matches limit reached. Use limit={} for more, or refine pattern", limit * 2));
                details.insert("matchLimitReached".into(), json!(limit));
            }
            if truncation.truncated {
                notices.push(format!("{} limit reached", format_size(DEFAULT_MAX_BYTES)));
                details.insert("truncation".into(), json!(truncation));
            }
            if lines_truncated {
                notices.push(format!("Some lines truncated to {GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines"));
            }
            if !notices.is_empty() {
                output.push_str(&format!("\n\n[{}]", notices.join(". ")));
            }
            let mut result = AgentToolResult::text(output);
            if !details.is_empty() {
                result.details = Value::Object(details);
            }
            Ok(result)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn greps_with_context_and_glob() {
        let dir = std::env::temp_dir().join(format!("zwork-grep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.rs"), "one\nfn target() {}\nthree\n").unwrap();
        std::fs::write(dir.join("b.txt"), "target here\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "ignored.rs\n").unwrap();
        std::fs::write(dir.join("ignored.rs"), "target\n").unwrap();
        let tool = GrepTool::new(&dir);
        let r = tool.execute("1", json!({"pattern": "target", "context": 1}), None, Arc::new(|_| {})).await.unwrap();
        let text = r.text_content();
        assert!(text.contains("src/a.rs:2: fn target() {}"), "{text}");
        assert!(text.contains("src/a.rs-1- one"), "{text}");
        assert!(text.contains("b.txt:1: target here"), "{text}");
        assert!(!text.contains("ignored.rs"), "{text}");
        let r = tool.execute("2", json!({"pattern": "TARGET", "ignoreCase": true, "glob": "*.rs"}), None, Arc::new(|_| {})).await.unwrap();
        assert_eq!(r.text_content(), "src/a.rs:2: fn target() {}");
        let r = tool.execute("3", json!({"pattern": "nope"}), None, Arc::new(|_| {})).await.unwrap();
        assert_eq!(r.text_content(), "No matches found");
        let r = tool.execute("4", json!({"pattern": "target", "limit": 1}), None, Arc::new(|_| {})).await.unwrap();
        assert!(r.text_content().ends_with("[1 matches limit reached. Use limit=2 for more, or refine pattern]"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
