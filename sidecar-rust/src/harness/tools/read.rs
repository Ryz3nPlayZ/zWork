//! Port of pi `core/tools/read.ts`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde_json::{json, Value};

use crate::harness::agent_types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolFuture};
use crate::harness::types::{AbortSignal, ImageContent, UserContent};

use super::path_utils::resolve_read_path;
use super::truncate::{format_size, truncate_head, TruncatedBy, TruncationOptions, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES};

pub const READ_SNIPPET: &str = "Read file contents";
pub const READ_GUIDELINES: &[&str] = &["Use read to examine files instead of cat or sed."];

/// Called at execute time to decide whether image blocks may be returned.
pub type SupportsImagesFn = Arc<dyn Fn() -> bool + Send + Sync>;

pub struct ReadTool {
    cwd: PathBuf,
    supports_images: Option<SupportsImagesFn>,
    description: String,
}

impl ReadTool {
    pub fn new(cwd: impl Into<PathBuf>, supports_images: Option<SupportsImagesFn>) -> Self {
        Self {
            cwd: cwd.into(),
            supports_images,
            description: format!(
                "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to {} lines or {}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
                DEFAULT_MAX_LINES,
                DEFAULT_MAX_BYTES / 1024
            ),
        }
    }
}

/// Sniff supported image types by magic bytes (pi `detectSupportedImageMimeTypeFromFile`).
pub fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

#[derive(serde::Deserialize)]
struct ReadArgs {
    path: String,
    #[serde(default)]
    offset: Option<f64>,
    #[serde(default)]
    limit: Option<f64>,
}

fn check_abort(signal: Option<&AbortSignal>) -> Result<(), String> {
    if signal.map(|s| s.is_aborted()).unwrap_or(false) {
        Err("Operation aborted".into())
    } else {
        Ok(())
    }
}

pub fn read_text_file(content: &str, path: &str, offset: Option<usize>, limit: Option<usize>) -> Result<(String, Option<Value>), String> {
    let all_lines: Vec<&str> = content.split('\n').collect();
    let total_file_lines = all_lines.len();
    let start_line = offset.map(|o| o.saturating_sub(1)).unwrap_or(0);
    let start_line_display = start_line + 1;
    if start_line >= all_lines.len() {
        return Err(format!(
            "Offset {} is beyond end of file ({} lines total)",
            offset.unwrap_or(0),
            all_lines.len()
        ));
    }
    let (selected, user_limited) = match limit {
        Some(limit) => {
            let end = (start_line + limit).min(all_lines.len());
            (all_lines[start_line..end].join("\n"), Some(end - start_line))
        }
        None => (all_lines[start_line..].join("\n"), None),
    };
    let truncation = truncate_head(&selected, TruncationOptions::default());
    if truncation.first_line_exceeds_limit {
        let first_line_size = format_size(all_lines[start_line].len());
        let text = format!(
            "[Line {start_line_display} is {first_line_size}, exceeds {} limit. Use bash: sed -n '{start_line_display}p' {path} | head -c {DEFAULT_MAX_BYTES}]",
            format_size(DEFAULT_MAX_BYTES)
        );
        return Ok((text, Some(json!({ "truncation": truncation }))));
    }
    if truncation.truncated {
        let end_line_display = start_line_display + truncation.output_lines - 1;
        let next_offset = end_line_display + 1;
        let mut text = truncation.content.clone();
        if truncation.truncated_by == Some(TruncatedBy::Lines) {
            text.push_str(&format!(
                "\n\n[Showing lines {start_line_display}-{end_line_display} of {total_file_lines}. Use offset={next_offset} to continue.]"
            ));
        } else {
            text.push_str(&format!(
                "\n\n[Showing lines {start_line_display}-{end_line_display} of {total_file_lines} ({} limit). Use offset={next_offset} to continue.]",
                format_size(DEFAULT_MAX_BYTES)
            ));
        }
        return Ok((text, Some(json!({ "truncation": truncation }))));
    }
    if let Some(n) = user_limited {
        if start_line + n < all_lines.len() {
            let remaining = all_lines.len() - (start_line + n);
            let next_offset = start_line + n + 1;
            return Ok((
                format!("{}\n\n[{remaining} more lines in file. Use offset={next_offset} to continue.]", truncation.content),
                None,
            ));
        }
    }
    Ok((truncation.content, None))
}

impl AgentTool for ReadTool {
    fn name(&self) -> &str {
        "read"
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to read (relative or absolute)" },
                "offset": { "type": "number", "description": "Line number to start reading from (1-indexed)" },
                "limit": { "type": "number", "description": "Maximum number of lines to read" }
            },
            "required": ["path"]
        })
    }
    fn prompt_snippet(&self) -> Option<&str> {
        Some(READ_SNIPPET)
    }
    fn prompt_guidelines(&self) -> Vec<String> {
        READ_GUIDELINES.iter().map(|s| s.to_string()).collect()
    }
    fn execute<'a>(&'a self, _id: &'a str, params: Value, signal: Option<&'a AbortSignal>, _on_update: AgentToolUpdateCallback) -> ToolFuture<'a> {
        Box::pin(async move {
            check_abort(signal)?;
            let args: ReadArgs = serde_json::from_value(params).map_err(|e| format!("Invalid read arguments: {e}"))?;
            let absolute = resolve_read_path(&args.path, &self.cwd);
            let bytes = read_file_async(&absolute).await?;
            check_abort(signal)?;
            if let Some(mime) = detect_image_mime(&bytes) {
                let supports = self.supports_images.as_ref().map(|f| f()).unwrap_or(true);
                let mut note = format!("Read image file [{mime}]");
                let mut content = vec![];
                if supports {
                    content.push(UserContent::Image(ImageContent {
                        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
                        mime_type: mime.to_string(),
                    }));
                } else {
                    note.push_str("\n[Current model does not support images. The image will be omitted from this request.]");
                }
                content.insert(0, UserContent::text(note));
                return Ok(AgentToolResult { content, details: Value::Null, usage: None, terminate: None });
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let offset = args.offset.map(|o| o.max(0.0) as usize);
            let limit = args.limit.map(|l| l.max(0.0) as usize);
            let (out, details) = read_text_file(&text, &args.path, offset, limit)?;
            let mut result = AgentToolResult::text(out);
            if let Some(d) = details {
                result.details = d;
            }
            Ok(result)
        })
    }
}

async fn read_file_async(path: &Path) -> Result<Vec<u8>, String> {
    tokio::fs::read(path).await.map_err(|e| format!("{}: {}", e, path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_and_limit() {
        let content = (1..=10).map(|i| format!("l{i}")).collect::<Vec<_>>().join("\n");
        let (out, _) = read_text_file(&content, "f", Some(3), Some(2)).unwrap();
        assert_eq!(out, "l3\nl4\n\n[6 more lines in file. Use offset=5 to continue.]");
        let (out, _) = read_text_file(&content, "f", Some(9), None).unwrap();
        assert_eq!(out, "l9\nl10");
        assert!(read_text_file(&content, "f", Some(11), None).unwrap_err().contains("beyond end of file"));
    }

    #[test]
    fn line_truncation_notice() {
        let content = (1..=2500).map(|i| format!("l{i}")).collect::<Vec<_>>().join("\n");
        let (out, d) = read_text_file(&content, "f", None, None).unwrap();
        assert!(out.ends_with("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]"));
        assert!(d.is_some());
    }

    #[test]
    fn image_sniff() {
        assert_eq!(detect_image_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]), Some("image/png"));
        assert_eq!(detect_image_mime(b"hello"), None);
    }
}
