//! Port of pi `core/tools/output-accumulator.ts`.
//!
//! Incrementally tracks streaming output with bounded memory: keeps only a
//! decoded tail for display snapshots and spills the full raw output to a
//! temp file once it exceeds the display limits.

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

use super::truncate::{
    truncate_head, truncate_tail, TruncatedBy, TruncationOptions, TruncationResult, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES,
};

#[derive(Debug, Clone, Default)]
pub struct OutputAccumulatorOptions {
    pub max_lines: Option<usize>,
    pub max_bytes: Option<usize>,
    pub temp_file_prefix: Option<String>,
    /// Which end of the output to keep when truncating (pi
    /// `ShellOutputLimits.retain`). Default: tail.
    pub retain: Option<Retain>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Retain {
    #[default]
    Tail,
    Head,
}

/// Strip bytes that break terminals, JSON payloads, and model parsing but
/// carry no content: C0 controls except tab/newline, plus the interlinear
/// annotation marks U+FFF9..U+FFFB (pi `sanitizeShellOutput`).
pub fn sanitize_shell_output(text: &str) -> String {
    text.chars()
        .filter(|&c| !matches!(c, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{fff9}'..='\u{fffb}'))
        .collect()
}

#[derive(Debug, Clone)]
pub struct OutputSnapshot {
    pub content: String,
    pub truncation: TruncationResult,
    pub full_output_path: Option<PathBuf>,
}

pub struct OutputAccumulator {
    max_lines: usize,
    max_bytes: usize,
    max_rolling_bytes: usize,
    retain: Retain,
    temp_file_prefix: String,

    raw_chunks: Vec<Vec<u8>>,
    /// Undecoded trailing bytes of an incomplete UTF-8 sequence.
    pending: Vec<u8>,
    tail_text: String,
    tail_starts_at_line_boundary: bool,
    total_raw_bytes: usize,
    total_decoded_bytes: usize,
    completed_lines: usize,
    total_lines: usize,
    current_line_bytes: usize,
    has_open_line: bool,
    finished: bool,

    temp_file_path: Option<PathBuf>,
    temp_file: Option<File>,
}

impl OutputAccumulator {
    pub fn new(options: OutputAccumulatorOptions) -> Self {
        let max_bytes = options.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
        Self {
            max_lines: options.max_lines.unwrap_or(DEFAULT_MAX_LINES),
            max_bytes,
            max_rolling_bytes: (max_bytes * 2).max(1),
            retain: options.retain.unwrap_or_default(),
            temp_file_prefix: options.temp_file_prefix.unwrap_or_else(|| "zwork-output".into()),
            raw_chunks: Vec::new(),
            pending: Vec::new(),
            tail_text: String::new(),
            tail_starts_at_line_boundary: true,
            total_raw_bytes: 0,
            total_decoded_bytes: 0,
            completed_lines: 0,
            total_lines: 0,
            current_line_bytes: 0,
            has_open_line: false,
            finished: false,
            temp_file_path: None,
            temp_file: None,
        }
    }

    pub fn append(&mut self, data: &[u8]) {
        if self.finished {
            return;
        }
        self.total_raw_bytes += data.len();
        let text = self.decode_streaming(data);
        self.append_decoded_text(&text);

        if self.temp_file.is_some() || self.should_use_temp_file() {
            self.ensure_temp_file();
            if let Some(f) = self.temp_file.as_mut() {
                let _ = f.write_all(data);
            }
        } else if !data.is_empty() {
            self.raw_chunks.push(data.to_vec());
        }
    }

    pub fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        if !self.pending.is_empty() {
            let rest = String::from_utf8_lossy(&self.pending).into_owned();
            self.pending.clear();
            self.append_decoded_text(&rest);
        }
        if self.should_use_temp_file() {
            self.ensure_temp_file();
        }
    }

    pub fn snapshot(&mut self, persist_if_truncated: bool) -> OutputSnapshot {
        let window = self.snapshot_text();
        let retained = match self.retain {
            Retain::Tail => truncate_tail(
                window,
                TruncationOptions { max_lines: Some(self.max_lines), max_bytes: Some(self.max_bytes) },
            ),
            Retain::Head => truncate_head(
                window,
                TruncationOptions { max_lines: Some(self.max_lines), max_bytes: Some(self.max_bytes) },
            ),
        };
        let truncated = self.total_lines > self.max_lines || self.total_decoded_bytes > self.max_bytes;
        let truncated_by = if truncated {
            retained.truncated_by.or(Some(if self.total_decoded_bytes > self.max_bytes {
                TruncatedBy::Bytes
            } else {
                TruncatedBy::Lines
            }))
        } else {
            None
        };
        let truncation = TruncationResult {
            truncated,
            truncated_by,
            total_lines: self.total_lines,
            total_bytes: self.total_decoded_bytes,
            max_lines: self.max_lines,
            max_bytes: self.max_bytes,
            ..retained
        };
        if persist_if_truncated && truncation.truncated {
            self.ensure_temp_file();
        }
        OutputSnapshot { content: sanitize_shell_output(&truncation.content), truncation, full_output_path: self.temp_file_path.clone() }
    }

    pub fn close_temp_file(&mut self) {
        if let Some(mut f) = self.temp_file.take() {
            let _ = f.flush();
        }
    }

    pub fn last_line_bytes(&self) -> usize {
        self.current_line_bytes
    }

    /// Streaming UTF-8 decode: complete sequences are decoded now, a trailing
    /// partial sequence waits for the next chunk.
    fn decode_streaming(&mut self, data: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(data);
        match std::str::from_utf8(&buf) {
            Ok(s) => s.to_string(),
            Err(e) => {
                let valid = e.valid_up_to();
                if e.error_len().is_none() {
                    // Incomplete sequence at the end: keep it for later.
                    self.pending = buf[valid..].to_vec();
                    String::from_utf8_lossy(&buf[..valid]).into_owned()
                } else {
                    String::from_utf8_lossy(&buf).into_owned()
                }
            }
        }
    }

    fn append_decoded_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let bytes = text.len();
        self.total_decoded_bytes += bytes;
        self.tail_text.push_str(text);
        if self.tail_text.len() > self.max_rolling_bytes * 2 {
            self.trim_tail();
        }

        let newlines = text.matches('\n').count();
        if newlines == 0 {
            self.current_line_bytes += bytes;
            self.has_open_line = true;
        } else {
            self.completed_lines += newlines;
            let tail = &text[text.rfind('\n').unwrap() + 1..];
            self.current_line_bytes = tail.len();
            self.has_open_line = !tail.is_empty();
        }
        self.total_lines = self.completed_lines + usize::from(self.has_open_line);
    }

    fn trim_tail(&mut self) {
        if self.tail_text.len() <= self.max_rolling_bytes {
            return;
        }
        match self.retain {
            Retain::Tail => {
                let mut start = self.tail_text.len() - self.max_rolling_bytes;
                while start < self.tail_text.len() && !self.tail_text.is_char_boundary(start) {
                    start += 1;
                }
                self.tail_starts_at_line_boundary = if start == 0 {
                    self.tail_starts_at_line_boundary
                } else {
                    self.tail_text.as_bytes()[start - 1] == b'\n'
                };
                self.tail_text = self.tail_text[start..].to_string();
            }
            Retain::Head => {
                // Keep the first bytes; the window start never moves, so the
                // starts-at-line-boundary invariant is unchanged.
                let mut end = self.max_rolling_bytes;
                while end < self.tail_text.len() && !self.tail_text.is_char_boundary(end) {
                    end += 1;
                }
                self.tail_text.truncate(end);
            }
        }
    }

    fn snapshot_text(&self) -> &str {
        if self.tail_starts_at_line_boundary {
            return &self.tail_text;
        }
        match self.tail_text.find('\n') {
            Some(i) => &self.tail_text[i + 1..],
            None => &self.tail_text,
        }
    }

    fn should_use_temp_file(&self) -> bool {
        self.total_raw_bytes > self.max_bytes || self.total_decoded_bytes > self.max_bytes || self.total_lines > self.max_lines
    }

    fn ensure_temp_file(&mut self) {
        if self.temp_file_path.is_some() {
            return;
        }
        let path = std::env::temp_dir().join(format!("{}-{}.log", self.temp_file_prefix, uuid::Uuid::new_v4().simple()));
        match File::create(&path) {
            Ok(mut f) => {
                for chunk in self.raw_chunks.drain(..) {
                    let _ = f.write_all(&chunk);
                }
                self.temp_file = Some(f);
                self.temp_file_path = Some(path);
            }
            Err(_) => {
                // Keep buffering in memory if the temp dir is unwritable.
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_output_is_not_truncated() {
        let mut acc = OutputAccumulator::new(OutputAccumulatorOptions::default());
        acc.append(b"hello\nwor");
        acc.append(b"ld\n");
        acc.finish();
        let snap = acc.snapshot(true);
        assert_eq!(snap.content, "hello\nworld\n");
        assert!(!snap.truncation.truncated);
        assert_eq!(snap.truncation.total_lines, 2);
        assert!(snap.full_output_path.is_none());
    }

    #[test]
    fn large_output_spills_to_temp_file_and_keeps_tail() {
        let mut acc = OutputAccumulator::new(OutputAccumulatorOptions {
            max_lines: Some(3),
            max_bytes: Some(1000),
            temp_file_prefix: Some("zwork-test".into()),
            retain: None,
        });
        for i in 0..10 {
            acc.append(format!("line{i}\n").as_bytes());
        }
        acc.finish();
        let snap = acc.snapshot(true);
        assert!(snap.truncation.truncated);
        assert_eq!(snap.truncation.truncated_by, Some(TruncatedBy::Lines));
        assert_eq!(snap.truncation.total_lines, 10);
        assert_eq!(snap.content, "line7\nline8\nline9");
        let path = snap.full_output_path.expect("temp file");
        acc.close_temp_file();
        let full = std::fs::read_to_string(&path).unwrap();
        assert_eq!(full.lines().count(), 10);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn split_utf8_sequences_decode_correctly() {
        let mut acc = OutputAccumulator::new(OutputAccumulatorOptions::default());
        let bytes = "é".as_bytes();
        acc.append(&bytes[..1]);
        acc.append(&bytes[1..]);
        acc.finish();
        assert_eq!(acc.snapshot(false).content, "é");
    }

    #[test]
    fn head_retention_keeps_first_lines() {
        let mut acc = OutputAccumulator::new(OutputAccumulatorOptions {
            max_lines: Some(3),
            max_bytes: Some(1000),
            retain: Some(Retain::Head),
            temp_file_prefix: Some("zwork-test".into()),
        });
        for i in 0..10 {
            acc.append(format!("line{i}\n").as_bytes());
        }
        acc.finish();
        let snap = acc.snapshot(true);
        assert!(snap.truncation.truncated);
        assert!(snap.content.starts_with("line0\n"));
        assert!(snap.content.contains("line2"));
        assert!(!snap.content.contains("line5"));
    }

    #[test]
    fn sanitizes_control_characters() {
        let mut acc = OutputAccumulator::new(OutputAccumulatorOptions::default());
        acc.append("ok\u{0}\u{7}\u{1f}bo\u{9}lt\u{fff9}o\n".as_bytes());
        acc.finish();
        // Tab survives; C0 controls and interlinear annotation marks don't.
        assert_eq!(acc.snapshot(false).content, "okbo\tlto\n");
    }
}
