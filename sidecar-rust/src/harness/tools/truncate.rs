//! Port of pi `core/tools/truncate.ts`.
//!
//! Truncation is based on two independent limits; whichever is hit first
//! wins: a line limit (default 2000) and a byte limit (default 50KB).
//! Never returns partial lines, except the bash tail-truncation edge case.

use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_LINES: usize = 2000;
pub const DEFAULT_MAX_BYTES: usize = 50 * 1024;
/// Max chars per grep match line.
pub const GREP_MAX_LINE_LENGTH: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TruncatedBy {
    Lines,
    Bytes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncationResult {
    pub content: String,
    pub truncated: bool,
    pub truncated_by: Option<TruncatedBy>,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub output_lines: usize,
    pub output_bytes: usize,
    /// Last line was partially truncated (tail truncation edge case).
    pub last_line_partial: bool,
    /// First line exceeded the byte limit (head truncation).
    pub first_line_exceeds_limit: bool,
    pub max_lines: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TruncationOptions {
    pub max_lines: Option<usize>,
    pub max_bytes: Option<usize>,
}

impl TruncationOptions {
    /// Byte limit only: callers that already cap rows (grep/find/ls).
    pub fn bytes_only() -> Self {
        Self { max_lines: Some(usize::MAX), max_bytes: None }
    }
}

fn split_lines_for_counting(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

/// Format bytes as a human-readable size (`512B`, `1.5KB`, `2.0MB`).
pub fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn untruncated(content: &str, total_lines: usize, total_bytes: usize, max_lines: usize, max_bytes: usize) -> TruncationResult {
    TruncationResult {
        content: content.to_string(),
        truncated: false,
        truncated_by: None,
        total_lines,
        total_bytes,
        output_lines: total_lines,
        output_bytes: total_bytes,
        last_line_partial: false,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// Keep the first N lines/bytes. If the first line alone exceeds the byte
/// limit, returns empty content with `first_line_exceeds_limit`.
pub fn truncate_head(content: &str, options: TruncationOptions) -> TruncationResult {
    let max_lines = options.max_lines.unwrap_or(DEFAULT_MAX_LINES);
    let max_bytes = options.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let total_bytes = content.len();
    let lines = split_lines_for_counting(content);
    let total_lines = lines.len();

    if total_lines <= max_lines && total_bytes <= max_bytes {
        return untruncated(content, total_lines, total_bytes, max_lines, max_bytes);
    }

    if lines.first().is_some_and(|l| l.len() > max_bytes) {
        return TruncationResult {
            content: String::new(),
            truncated: true,
            truncated_by: Some(TruncatedBy::Bytes),
            total_lines,
            total_bytes,
            output_lines: 0,
            output_bytes: 0,
            last_line_partial: false,
            first_line_exceeds_limit: true,
            max_lines,
            max_bytes,
        };
    }

    let mut out: Vec<&str> = Vec::new();
    let mut out_bytes = 0usize;
    let mut truncated_by = TruncatedBy::Lines;
    for (i, line) in lines.iter().enumerate().take(max_lines) {
        let line_bytes = line.len() + usize::from(i > 0);
        if out_bytes + line_bytes > max_bytes {
            truncated_by = TruncatedBy::Bytes;
            break;
        }
        out.push(line);
        out_bytes += line_bytes;
    }
    if out.len() >= max_lines && out_bytes <= max_bytes {
        truncated_by = TruncatedBy::Lines;
    }
    let output = out.join("\n");
    TruncationResult {
        output_bytes: output.len(),
        output_lines: out.len(),
        content: output,
        truncated: true,
        truncated_by: Some(truncated_by),
        total_lines,
        total_bytes,
        last_line_partial: false,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// Keep the last N lines/bytes. May return a partial first line if the last
/// line of the original exceeds the byte limit.
pub fn truncate_tail(content: &str, options: TruncationOptions) -> TruncationResult {
    let max_lines = options.max_lines.unwrap_or(DEFAULT_MAX_LINES);
    let max_bytes = options.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let total_bytes = content.len();
    let lines = split_lines_for_counting(content);
    let total_lines = lines.len();

    if total_lines <= max_lines && total_bytes <= max_bytes {
        return untruncated(content, total_lines, total_bytes, max_lines, max_bytes);
    }

    let mut out: std::collections::VecDeque<&str> = std::collections::VecDeque::new();
    let mut out_bytes = 0usize;
    let mut truncated_by = TruncatedBy::Lines;
    let mut last_line_partial = false;
    for line in lines.iter().rev() {
        if out.len() >= max_lines {
            break;
        }
        let line_bytes = line.len() + usize::from(!out.is_empty());
        if out_bytes + line_bytes > max_bytes {
            truncated_by = TruncatedBy::Bytes;
            if out.is_empty() {
                let partial = truncate_str_to_bytes_from_end(line, max_bytes);
                out_bytes = partial.len();
                out.push_front(partial);
                last_line_partial = true;
            }
            break;
        }
        out.push_front(line);
        out_bytes += line_bytes;
    }
    if out.len() >= max_lines && out_bytes <= max_bytes {
        truncated_by = TruncatedBy::Lines;
    }
    let output = out.iter().copied().collect::<Vec<_>>().join("\n");
    TruncationResult {
        output_bytes: output.len(),
        output_lines: out.len(),
        content: output,
        truncated: true,
        truncated_by: Some(truncated_by),
        total_lines,
        total_bytes,
        last_line_partial,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// Last `max_bytes` bytes of `s`, snapped forward to a char boundary.
pub fn truncate_str_to_bytes_from_end(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len() - max_bytes;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Truncate a single line to `max_chars`, adding a `[truncated]` suffix.
pub fn truncate_line(line: &str, max_chars: usize) -> (String, bool) {
    if line.chars().count() <= max_chars {
        return (line.to_string(), false);
    }
    let head: String = line.chars().take(max_chars).collect();
    (format!("{head}... [truncated]"), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_by_lines_and_bytes() {
        let content = "a\nb\nc\nd\n";
        let r = truncate_head(content, TruncationOptions { max_lines: Some(2), max_bytes: None });
        assert_eq!(r.content, "a\nb");
        assert_eq!(r.truncated_by, Some(TruncatedBy::Lines));
        assert_eq!((r.total_lines, r.output_lines), (4, 2));

        let r = truncate_head("aaaa\nbbbb\ncccc", TruncationOptions { max_lines: None, max_bytes: Some(9) });
        assert_eq!(r.content, "aaaa\nbbbb");
        assert_eq!(r.truncated_by, Some(TruncatedBy::Bytes));

        let r = truncate_head("xxxxxxxxxx\ny", TruncationOptions { max_lines: None, max_bytes: Some(5) });
        assert!(r.first_line_exceeds_limit);
        assert_eq!(r.content, "");

        let r = truncate_head("a\nb", TruncationOptions::default());
        assert!(!r.truncated);
    }

    #[test]
    fn tail_by_lines_and_partial() {
        let r = truncate_tail("a\nb\nc\nd", TruncationOptions { max_lines: Some(2), max_bytes: None });
        assert_eq!(r.content, "c\nd");
        assert_eq!(r.truncated_by, Some(TruncatedBy::Lines));

        let r = truncate_tail("short\nthis-line-is-long", TruncationOptions { max_lines: None, max_bytes: Some(4) });
        assert_eq!(r.content, "long");
        assert!(r.last_line_partial);
        assert_eq!(r.truncated_by, Some(TruncatedBy::Bytes));
    }

    #[test]
    fn utf8_boundary_and_sizes() {
        assert_eq!(truncate_str_to_bytes_from_end("héllo", 3), "llo");
        assert_eq!(truncate_str_to_bytes_from_end("héllo", 4), "llo");
        assert_eq!(format_size(512), "512B");
        assert_eq!(format_size(1536), "1.5KB");
        assert_eq!(format_size(2 * 1024 * 1024), "2.0MB");
        let (t, was) = truncate_line("abcdef", 3);
        assert_eq!(t, "abc... [truncated]");
        assert!(was);
    }
}
