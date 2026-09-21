//! Port of pi `core/tools/write.ts`.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::harness::agent_types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolFuture};
use crate::harness::types::AbortSignal;

use super::file_mutation_queue::with_file_mutation_queue;
use super::path_utils::resolve_to_cwd;

pub const WRITE_SNIPPET: &str = "Create or overwrite files";
pub const WRITE_GUIDELINES: &[&str] = &["Use write only for new files or complete rewrites."];

pub struct WriteTool {
    cwd: PathBuf,
}

impl WriteTool {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}

#[derive(serde::Deserialize)]
struct WriteArgs {
    path: String,
    content: String,
}

impl AgentTool for WriteTool {
    fn name(&self) -> &str {
        "write"
    }
    fn description(&self) -> &str {
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to write (relative or absolute)" },
                "content": { "type": "string", "description": "Content to write to the file" }
            },
            "required": ["path", "content"]
        })
    }
    fn prompt_snippet(&self) -> Option<&str> {
        Some(WRITE_SNIPPET)
    }
    fn prompt_guidelines(&self) -> Vec<String> {
        WRITE_GUIDELINES.iter().map(|s| s.to_string()).collect()
    }
    fn execute<'a>(&'a self, _id: &'a str, params: Value, signal: Option<&'a AbortSignal>, _on_update: AgentToolUpdateCallback) -> ToolFuture<'a> {
        Box::pin(async move {
            let args: WriteArgs = serde_json::from_value(params).map_err(|e| format!("Invalid write arguments: {e}"))?;
            let absolute = resolve_to_cwd(&args.path, &self.cwd);
            let aborted = || signal.map(|s| s.is_aborted()).unwrap_or(false);
            if aborted() {
                return Err("Operation aborted".into());
            }
            let path_display = args.path.clone();
            with_file_mutation_queue(&absolute, || {
                let absolute = absolute.clone();
                Box::pin(async move {
                    if aborted() {
                        return Err("Operation aborted".to_string());
                    }
                    if let Some(parent) = absolute.parent() {
                        tokio::fs::create_dir_all(parent).await.map_err(|e| format!("Could not create directory {}: {e}", parent.display()))?;
                    }
                    if aborted() {
                        return Err("Operation aborted".to_string());
                    }
                    tokio::fs::write(&absolute, args.content.as_bytes())
                        .await
                        .map_err(|e| format!("Could not write file {}: {e}", absolute.display()))?;
                    Ok(AgentToolResult::text(format!("Successfully wrote to {path_display}")))
                })
            })
            .await
        })
    }
}
