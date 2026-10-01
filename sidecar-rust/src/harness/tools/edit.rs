//! Port of pi `core/tools/edit.ts`.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::harness::agent_types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolFuture};
use crate::harness::types::AbortSignal;

use super::edit_diff::{
    apply_edits_to_normalized_content, detect_line_ending, generate_diff_string, generate_unified_patch, normalize_to_lf,
    restore_line_endings, split_bom, Edit,
};
use super::file_mutation_queue::with_file_mutation_queue;
use super::path_utils::resolve_to_cwd;

pub const EDIT_SNIPPET: &str = "Make precise file edits with exact text replacement, including multiple disjoint edits in one call";
pub const EDIT_GUIDELINES: &[&str] = &[
    "Use edit for precise changes (edits[].oldText must match exactly)",
    "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
    "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
    "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
];

pub struct EditTool {
    cwd: PathBuf,
}

impl EditTool {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}

fn is_single_edit(v: &Value) -> bool {
    v.get("oldText").map(Value::is_string).unwrap_or(false) && v.get("newText").map(Value::is_string).unwrap_or(false)
}

/// Compatibility shim: some models send `edits` as a JSON string, a single
/// object, or legacy top-level `oldText`/`newText`.
pub fn prepare_edit_arguments(mut input: Value) -> Value {
    let Some(args) = input.as_object_mut() else { return input };
    match args.get("edits").cloned() {
        Some(Value::String(s)) => {
            if let Ok(parsed) = serde_json::from_str::<Value>(&s) {
                if parsed.is_array() {
                    args.insert("edits".into(), parsed);
                } else if is_single_edit(&parsed) {
                    args.insert("edits".into(), Value::Array(vec![parsed]));
                }
            }
        }
        Some(v) if is_single_edit(&v) => {
            args.insert("edits".into(), Value::Array(vec![v]));
        }
        _ => {}
    }
    let (old, new) = (args.get("oldText").cloned(), args.get("newText").cloned());
    if let (Some(Value::String(old)), Some(Value::String(new))) = (old, new) {
        let mut edits = match args.remove("edits") {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        };
        edits.push(json!({ "oldText": old, "newText": new }));
        args.remove("oldText");
        args.remove("newText");
        args.insert("edits".into(), Value::Array(edits));
    }
    input
}

#[derive(serde::Deserialize)]
struct EditArgs {
    path: String,
    #[serde(default)]
    edits: Vec<Edit>,
}

impl AgentTool for EditTool {
    fn name(&self) -> &str {
        "edit"
    }
    fn description(&self) -> &str {
        "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to edit (relative or absolute)" },
                "edits": {
                    "type": "array",
                    "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldText": { "type": "string", "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." },
                            "newText": { "type": "string", "description": "Replacement text for this targeted edit." }
                        },
                        "required": ["oldText", "newText"]
                    }
                }
            },
            "required": ["path", "edits"]
        })
    }
    fn prepare_arguments(&self, args: Value) -> Result<Value, String> {
        Ok(prepare_edit_arguments(args))
    }
    fn prompt_snippet(&self) -> Option<&str> {
        Some(EDIT_SNIPPET)
    }
    fn prompt_guidelines(&self) -> Vec<String> {
        EDIT_GUIDELINES.iter().map(|s| s.to_string()).collect()
    }
    fn execute<'a>(&'a self, _id: &'a str, params: Value, signal: Option<&'a AbortSignal>, _on_update: AgentToolUpdateCallback) -> ToolFuture<'a> {
        Box::pin(async move {
            let args: EditArgs = serde_json::from_value(params).map_err(|e| format!("Invalid edit arguments: {e}"))?;
            if args.edits.is_empty() {
                return Err("Edit tool input is invalid. edits must contain at least one replacement.".into());
            }
            let absolute = resolve_to_cwd(&args.path, &self.cwd);
            let aborted = || signal.map(|s| s.is_aborted()).unwrap_or(false);
            let path = args.path.clone();
            let edits = args.edits;
            with_file_mutation_queue(&absolute, || {
                let absolute = absolute.clone();
                Box::pin(async move {
                    if aborted() {
                        return Err("Operation aborted".to_string());
                    }
                    let raw = match tokio::fs::read(&absolute).await {
                        Ok(b) => b,
                        Err(e) => {
                            if aborted() {
                                return Err("Operation aborted".to_string());
                            }
                            let code = e.raw_os_error().map(|c| format!("Error code: {c}")).unwrap_or_else(|| e.to_string());
                            return Err(format!("Could not edit file: {path}. {code}."));
                        }
                    };
                    if aborted() {
                        return Err("Operation aborted".to_string());
                    }
                    let raw = String::from_utf8_lossy(&raw).into_owned();
                    let (bom, content) = split_bom(&raw);
                    let ending = detect_line_ending(content);
                    let normalized = normalize_to_lf(content);
                    let applied = apply_edits_to_normalized_content(&normalized, &edits, &path)?;
                    if aborted() {
                        return Err("Operation aborted".to_string());
                    }
                    let final_content = format!("{bom}{}", restore_line_endings(&applied.new_content, ending));
                    tokio::fs::write(&absolute, final_content.as_bytes())
                        .await
                        .map_err(|e| format!("Could not write file {}: {e}", absolute.display()))?;
                    let diff = generate_diff_string(&applied.base_content, &applied.new_content, 4);
                    let patch = generate_unified_patch(&path, &applied.base_content, &applied.new_content, 3);
                    Ok(AgentToolResult::text(format!("Successfully replaced {} block(s) in {path}.", edits.len())).with_details(json!({
                        "diff": diff.diff,
                        "patch": patch,
                        "firstChangedLine": diff.first_changed_line,
                    })))
                })
            })
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_arguments_shims() {
        let v = prepare_edit_arguments(json!({"path":"a","edits":"[{\"oldText\":\"x\",\"newText\":\"y\"}]"}));
        assert_eq!(v["edits"][0]["oldText"], "x");
        let v = prepare_edit_arguments(json!({"path":"a","edits":{"oldText":"x","newText":"y"}}));
        assert_eq!(v["edits"].as_array().unwrap().len(), 1);
        let v = prepare_edit_arguments(json!({"path":"a","oldText":"x","newText":"y"}));
        assert_eq!(v["edits"][0]["newText"], "y");
        assert!(v.get("oldText").is_none());
    }

    #[tokio::test]
    async fn edits_file_and_preserves_crlf() {
        let dir = std::env::temp_dir().join(format!("zwork-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        std::fs::write(&file, "\u{FEFF}one\r\ntwo\r\nthree\r\n").unwrap();
        let tool = EditTool::new(&dir);
        let r = tool
            .execute("1", json!({"path":"f.txt","edits":[{"oldText":"two","newText":"2"}]}), None, std::sync::Arc::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(r.text_content(), "Successfully replaced 1 block(s) in f.txt.");
        assert_eq!(r.details["firstChangedLine"], 2);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "\u{FEFF}one\r\n2\r\nthree\r\n");
        let err = tool
            .execute("2", json!({"path":"missing.txt","edits":[{"oldText":"a","newText":"b"}]}), None, std::sync::Arc::new(|_| {}))
            .await
            .unwrap_err();
        assert!(err.starts_with("Could not edit file: missing.txt."), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
