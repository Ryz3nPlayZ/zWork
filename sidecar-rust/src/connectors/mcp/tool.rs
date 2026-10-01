//! An MCP server tool as a native harness [`AgentTool`].

use crate::harness::agent_types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, ReplayPolicy, ToolFuture};
use crate::harness::tools::truncate::{format_size, truncate_head, TruncationOptions};
use crate::harness::types::{AbortSignal, ImageContent, UserContent};
use serde_json::{json, Value};

/// Prefix shared by every MCP tool name: `mcp__{server}__{tool}` (the
/// Claude Code convention, so skills written for it address the same tools).
pub const TOOL_PREFIX: &str = "mcp__";
/// Provider limit on tool-name length (OpenAI, Anthropic).
const MAX_NAME_LEN: usize = 64;
const MAX_DESCRIPTION_CHARS: usize = 4000;

#[derive(Debug, Clone)]
pub struct McpTool {
    pub server: String,
    /// The tool's own name, as the server knows it.
    pub remote_name: String,
    name: String,
    /// Human title (`title`, `annotations.title`, or the tool name).
    pub title: String,
    label: String,
    description: String,
    parameters: Value,
    /// `annotations.readOnlyHint`: safe in plan mode and to auto-approve.
    pub read_only: bool,
    /// `annotations.destructiveHint` (spec default: true unless read-only).
    pub destructive: bool,
}

impl McpTool {
    /// Build from one entry of a `tools/list` result.
    pub fn from_listing(server: &str, entry: &Value) -> Option<Self> {
        let remote_name = entry.get("name")?.as_str()?.to_string();
        let annotations = entry.get("annotations").cloned().unwrap_or(Value::Null);
        let hint = |k: &str| annotations.get(k).and_then(Value::as_bool);
        let title = entry
            .get("title")
            .or_else(|| annotations.get("title"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let read_only = hint("readOnlyHint").unwrap_or(false);
        let destructive = !read_only && hint("destructiveHint").unwrap_or(true);

        let mut description = entry.get("description").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        if description.is_empty() {
            description = title.clone().unwrap_or_else(|| format!("{remote_name} (from the {server} connector)"));
        }
        if description.chars().count() > MAX_DESCRIPTION_CHARS {
            description = description.chars().take(MAX_DESCRIPTION_CHARS).collect::<String>() + "…";
        }

        let title = title.unwrap_or_else(|| remote_name.clone());
        Some(McpTool {
            name: tool_name(server, &remote_name),
            label: format!("{server}: {title}"),
            title,
            server: server.to_string(),
            remote_name,
            description,
            parameters: normalize_schema(entry.get("inputSchema").cloned().unwrap_or(Value::Null)),
            read_only,
            destructive,
        })
    }
}

impl AgentTool for McpTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> Value {
        self.parameters.clone()
    }

    fn prepare_arguments(&self, args: Value) -> Result<Value, String> {
        // Models sometimes send `null` for a no-argument tool.
        Ok(if args.is_null() { json!({}) } else { args })
    }

    fn execute<'a>(
        &'a self,
        _tool_call_id: &'a str,
        params: Value,
        signal: Option<&'a AbortSignal>,
        _on_update: AgentToolUpdateCallback,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            let result = super::call_tool(&self.server, &self.remote_name, params, signal).await?;
            let content = convert_content(&result);
            if result.get("isError").and_then(Value::as_bool).unwrap_or(false) {
                let text = AgentToolResult { content, ..Default::default() }.text_content();
                return Err(if text.trim().is_empty() { format!("{} reported an error", self.label) } else { text });
            }
            let details = json!({
                "server": self.server,
                "tool": self.remote_name,
                "structuredContent": result.get("structuredContent").cloned().unwrap_or(Value::Null),
            });
            Ok(AgentToolResult { content, details, usage: None, terminate: None })
        })
    }

    fn replay(&self) -> ReplayPolicy {
        if self.read_only {
            ReplayPolicy::Safe
        } else {
            ReplayPolicy::Never
        }
    }
}

/// `mcp__{server}__{tool}`, restricted to `[A-Za-z0-9_-]` and 64 chars. Long
/// names keep a stable hash suffix so they stay unique across restarts.
pub fn tool_name(server: &str, tool: &str) -> String {
    let clean = |s: &str| -> String {
        s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
    };
    let full = format!("{TOOL_PREFIX}{}__{}", clean(server), clean(tool));
    if full.len() <= MAX_NAME_LEN {
        return full;
    }
    let hash = full.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    let suffix = format!("_{:08x}", hash as u32);
    format!("{}{suffix}", &full[..MAX_NAME_LEN - suffix.len()])
}

/// Providers require an object schema with `properties`; some servers send
/// `{}` or omit it, and `$schema` trips strict validators.
fn normalize_schema(schema: Value) -> Value {
    let mut schema = match schema {
        Value::Object(m) => m,
        _ => Default::default(),
    };
    schema.remove("$schema");
    schema.insert("type".into(), json!("object"));
    schema.entry("properties").or_insert_with(|| json!({}));
    Value::Object(schema)
}

/// MCP `CallToolResult.content` → harness content blocks.
pub fn convert_content(result: &Value) -> Vec<UserContent> {
    let mut out = Vec::new();
    for block in result.get("content").and_then(Value::as_array).into_iter().flatten() {
        let s = |k: &str| block.get(k).and_then(Value::as_str).unwrap_or_default();
        match s("type") {
            "text" => out.push(text(s("text"))),
            "image" => out.push(UserContent::Image(ImageContent { data: s("data").to_string(), mime_type: s("mimeType").to_string() })),
            "audio" => out.push(UserContent::text(format!("[audio ({}) returned — not shown]", s("mimeType")))),
            "resource" => {
                let res = block.get("resource").cloned().unwrap_or(Value::Null);
                let r = |k: &str| res.get(k).and_then(Value::as_str).unwrap_or_default();
                let mime = r("mimeType");
                if let Some(body) = res.get("text").and_then(Value::as_str) {
                    out.push(text(&format!("{}\n{body}", r("uri"))));
                } else if mime.starts_with("image/") {
                    out.push(UserContent::Image(ImageContent { data: r("blob").to_string(), mime_type: mime.to_string() }));
                } else {
                    let size = r("blob").len() * 3 / 4;
                    out.push(UserContent::text(format!("[binary resource {} ({mime}, {})]", r("uri"), format_size(size))));
                }
            }
            "resource_link" => {
                let mut line = format!("Link: {} <{}>", s("name"), s("uri"));
                if !s("description").is_empty() {
                    line += &format!(" — {}", s("description"));
                }
                out.push(UserContent::text(line));
            }
            _ => {}
        }
    }
    if out.is_empty() {
        if let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null()) {
            out.push(text(&serde_json::to_string_pretty(structured).unwrap_or_default()));
        } else {
            out.push(UserContent::text("(no output)"));
        }
    }
    out
}

/// Keep tool output inside the same budget as the built-in tools.
fn text(body: &str) -> UserContent {
    let t = truncate_head(body, TruncationOptions::default());
    if !t.truncated {
        return UserContent::text(body);
    }
    UserContent::text(format!(
        "{}\n\n[Output truncated: showing {} of {} lines ({} of {}).]",
        t.content,
        t.output_lines,
        t.total_lines,
        format_size(t.output_bytes),
        format_size(t.total_bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_sanitized_and_bounded() {
        assert_eq!(tool_name("google drive", "files.list"), "mcp__google_drive__files_list");
        let long = tool_name("a-very-long-server-name-indeed", "an_even_longer_tool_name_that_overflows_the_limit");
        assert_eq!(long.len(), 64);
        assert_eq!(long, tool_name("a-very-long-server-name-indeed", "an_even_longer_tool_name_that_overflows_the_limit"));
    }

    #[test]
    fn listing_reads_annotations_and_fixes_schema() {
        let t = McpTool::from_listing(
            "gh",
            &json!({ "name": "list_issues", "inputSchema": { "$schema": "x" }, "annotations": { "readOnlyHint": true } }),
        )
        .unwrap();
        assert!(t.read_only && !t.destructive);
        assert_eq!(t.parameters(), json!({ "type": "object", "properties": {} }));
        assert_eq!(t.description(), "list_issues (from the gh connector)");

        let w = McpTool::from_listing("gh", &json!({ "name": "create_issue", "description": "Create" })).unwrap();
        assert!(!w.read_only && w.destructive);
    }

    #[test]
    fn converts_every_content_type() {
        let result = json!({ "content": [
            { "type": "text", "text": "hello" },
            { "type": "image", "data": "AAAA", "mimeType": "image/png" },
            { "type": "resource", "resource": { "uri": "file:///a.txt", "text": "body" } },
            { "type": "resource_link", "uri": "https://x", "name": "doc" }
        ]});
        let content = convert_content(&result);
        assert_eq!(content.len(), 4);
        assert!(matches!(&content[1], UserContent::Image(i) if i.mime_type == "image/png"));
        let structured = convert_content(&json!({ "content": [], "structuredContent": { "n": 1 } }));
        assert!(matches!(&structured[0], UserContent::Text(t) if t.text.contains("\"n\": 1")));
    }
}
