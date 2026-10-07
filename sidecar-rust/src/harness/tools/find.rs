//! Port of pi `core/tools/find.ts`, using the native walker instead of fd.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::harness::agent_types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolFuture};
use crate::harness::types::AbortSignal;

use super::path_utils::{relative_posix, resolve_to_cwd};
use super::truncate::{format_size, truncate_head, TruncationOptions, DEFAULT_MAX_BYTES};
use super::walk::{glob_to_regex, walk, WalkOptions};

pub const FIND_SNIPPET: &str = "Find files by glob pattern (respects .gitignore)";
pub const DEFAULT_LIMIT: usize = 1000;

pub struct FindTool {
    cwd: PathBuf,
    description: String,
}

impl FindTool {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            description: format!(
                "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to {DEFAULT_LIMIT} results or {}KB (whichever is hit first).",
                DEFAULT_MAX_BYTES / 1024
            ),
        }
    }
}

#[derive(serde::Deserialize)]
struct FindArgs {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    limit: Option<f64>,
}

fn run_find(search_path: &Path, pattern: &str, limit: usize, signal: Option<&AbortSignal>) -> Result<(Vec<String>, bool), String> {
    // fd semantics: a pattern without "/" matches the basename; with "/" it
    // matches the full relative path (anchored with **/ unless absolute-ish).
    let full_path = pattern.contains('/');
    let effective = if full_path && !pattern.starts_with("**/") && !pattern.starts_with('/') {
        format!("**/{pattern}")
    } else {
        pattern.to_string()
    };
    let re = glob_to_regex(&effective, false)?;
    let mut results = Vec::new();
    let mut limit_reached = false;
    walk(WalkOptions { root: search_path, respect_gitignore: true, signal }, &mut |entry| {
        let rel = relative_posix(&entry.path, search_path).unwrap_or_default();
        if rel.is_empty() {
            return true;
        }
        let subject = if full_path { rel.clone() } else { entry.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() };
        if re.is_match(&subject) {
            results.push(if entry.is_dir { format!("{rel}/") } else { rel });
            if results.len() >= limit {
                limit_reached = true;
                return false;
            }
        }
        true
    })?;
    if signal.map(|s| s.is_aborted()).unwrap_or(false) {
        return Err("Operation aborted".into());
    }
    Ok((results, limit_reached))
}

impl AgentTool for FindTool {
    fn name(&self) -> &str {
        "find"
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
                "path": { "type": "string", "description": "Directory to search in (default: current directory)" },
                "limit": { "type": "number", "description": format!("Maximum number of results (default: {DEFAULT_LIMIT})") }
            },
            "required": ["pattern"]
        })
    }
    fn prompt_snippet(&self) -> Option<&str> {
        Some(FIND_SNIPPET)
    }
    fn execute<'a>(&'a self, _id: &'a str, params: Value, signal: Option<&'a AbortSignal>, _on_update: AgentToolUpdateCallback) -> ToolFuture<'a> {
        Box::pin(async move {
            if signal.map(|s| s.is_aborted()).unwrap_or(false) {
                return Err("Operation aborted".into());
            }
            let args: FindArgs = serde_json::from_value(params).map_err(|e| format!("Invalid find arguments: {e}"))?;
            let search_path = resolve_to_cwd(args.path.as_deref().unwrap_or("."), &self.cwd);
            if !search_path.exists() {
                return Err(format!("Path not found: {}", search_path.display()));
            }
            let limit = args.limit.map(|l| l as usize).unwrap_or(DEFAULT_LIMIT).max(1);
            let signal_owned = signal.cloned();
            let pattern = args.pattern.clone();
            let sp = search_path.clone();
            let (results, limit_reached) = tokio::task::spawn_blocking(move || run_find(&sp, &pattern, limit, signal_owned.as_ref()))
                .await
                .map_err(|e| format!("find task failed: {e}"))??;
            if results.is_empty() {
                return Ok(AgentToolResult::text("No files found matching pattern"));
            }
            let raw = results.join("\n");
            let truncation = truncate_head(&raw, TruncationOptions::bytes_only());
            let mut output = truncation.content.clone();
            let mut details = serde_json::Map::new();
            let mut notices = Vec::new();
            if limit_reached {
                notices.push(format!("{limit} results limit reached. Use limit={} for more, or refine pattern", limit * 2));
                details.insert("resultLimitReached".into(), json!(limit));
            }
            if truncation.truncated {
                notices.push(format!("{} limit reached", format_size(DEFAULT_MAX_BYTES)));
                details.insert("truncation".into(), json!(truncation));
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
    async fn finds_by_basename_and_path() {
        let dir = std::env::temp_dir().join(format!("zwork-find-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        std::fs::write(dir.join("src/a.rs"), "").unwrap();
        std::fs::write(dir.join("src/deep/b.rs"), "").unwrap();
        std::fs::write(dir.join("c.txt"), "").unwrap();
        let tool = FindTool::new(&dir);
        let r = tool.execute("1", json!({"pattern": "*.rs"}), None, Arc::new(|_| {})).await.unwrap();
        assert_eq!(r.text_content(), "src/a.rs\nsrc/deep/b.rs");
        let r = tool.execute("2", json!({"pattern": "src/deep/*.rs"}), None, Arc::new(|_| {})).await.unwrap();
        assert_eq!(r.text_content(), "src/deep/b.rs");
        let r = tool.execute("3", json!({"pattern": "*.py"}), None, Arc::new(|_| {})).await.unwrap();
        assert_eq!(r.text_content(), "No files found matching pattern");
        let r = tool.execute("4", json!({"pattern": "*.rs", "limit": 1}), None, Arc::new(|_| {})).await.unwrap();
        assert_eq!(r.text_content(), "src/a.rs\n\n[1 results limit reached. Use limit=2 for more, or refine pattern]");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
