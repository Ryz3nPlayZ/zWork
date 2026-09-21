//! Port of pi `core/tools/ls.ts`.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::harness::agent_types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolFuture};
use crate::harness::types::AbortSignal;

use super::path_utils::resolve_to_cwd;
use super::truncate::{format_size, truncate_head, TruncationOptions, DEFAULT_MAX_BYTES};

pub const LS_SNIPPET: &str = "List directory contents";
pub const DEFAULT_LIMIT: usize = 500;

pub struct LsTool {
    cwd: PathBuf,
    description: String,
}

impl LsTool {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            description: format!(
                "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to {DEFAULT_LIMIT} entries or {}KB (whichever is hit first).",
                DEFAULT_MAX_BYTES / 1024
            ),
        }
    }
}

#[derive(serde::Deserialize)]
struct LsArgs {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    limit: Option<f64>,
}

impl AgentTool for LsTool {
    fn name(&self) -> &str {
        "ls"
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory to list (default: current directory)" },
                "limit": { "type": "number", "description": format!("Maximum number of entries to return (default: {DEFAULT_LIMIT})") }
            }
        })
    }
    fn prompt_snippet(&self) -> Option<&str> {
        Some(LS_SNIPPET)
    }
    fn execute<'a>(&'a self, _id: &'a str, params: Value, signal: Option<&'a AbortSignal>, _on_update: AgentToolUpdateCallback) -> ToolFuture<'a> {
        Box::pin(async move {
            if signal.map(|s| s.is_aborted()).unwrap_or(false) {
                return Err("Operation aborted".into());
            }
            let args: LsArgs = serde_json::from_value(params).map_err(|e| format!("Invalid ls arguments: {e}"))?;
            let dir = resolve_to_cwd(args.path.as_deref().unwrap_or("."), &self.cwd);
            let limit = args.limit.map(|l| l as usize).unwrap_or(DEFAULT_LIMIT);
            let meta = tokio::fs::metadata(&dir).await.map_err(|_| format!("Path not found: {}", dir.display()))?;
            if !meta.is_dir() {
                return Err(format!("Not a directory: {}", dir.display()));
            }
            let mut rd = tokio::fs::read_dir(&dir).await.map_err(|e| format!("Cannot read directory: {e}"))?;
            let mut names: Vec<String> = Vec::new();
            while let Some(entry) = rd.next_entry().await.map_err(|e| format!("Cannot read directory: {e}"))? {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
            names.sort_by_key(|n| n.to_lowercase());
            let mut results = Vec::new();
            let mut limit_reached = false;
            for name in names {
                if results.len() >= limit {
                    limit_reached = true;
                    break;
                }
                let Ok(m) = tokio::fs::metadata(dir.join(&name)).await else { continue };
                results.push(if m.is_dir() { format!("{name}/") } else { name });
            }
            if results.is_empty() {
                return Ok(AgentToolResult::text("(empty directory)"));
            }
            let raw = results.join("\n");
            let truncation = truncate_head(&raw, TruncationOptions::bytes_only());
            let mut output = truncation.content.clone();
            let mut details = serde_json::Map::new();
            let mut notices = Vec::new();
            if limit_reached {
                notices.push(format!("{limit} entries limit reached. Use limit={} for more", limit * 2));
                details.insert("entryLimitReached".into(), json!(limit));
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
    async fn lists_sorted_with_dir_suffix() {
        let dir = std::env::temp_dir().join(format!("zwork-ls-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("Sub")).unwrap();
        std::fs::write(dir.join("b.txt"), "").unwrap();
        std::fs::write(dir.join(".hidden"), "").unwrap();
        let tool = LsTool::new(&dir);
        let r = tool.execute("1", json!({}), None, Arc::new(|_| {})).await.unwrap();
        assert_eq!(r.text_content(), ".hidden\nb.txt\nSub/");
        let err = tool.execute("2", json!({"path": "b.txt"}), None, Arc::new(|_| {})).await.unwrap_err();
        assert!(err.starts_with("Not a directory:"));
        let err = tool.execute("3", json!({"path": "nope"}), None, Arc::new(|_| {})).await.unwrap_err();
        assert!(err.starts_with("Path not found:"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
