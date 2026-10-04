//! Server-Sent Events framing.
//!
//! The byte-stream seam between transport and protocol (opencode's
//! `route/framing.ts`). A correct SSE decoder matters here because the old
//! `stream_upstream` hand-rolled `buffer.find('\n')` framing: it would happily
//! hand a half-delivered JSON line to `serde_json::from_str`, which then
//! `Err(_) => continue`-dropped it silently. This decoder only yields a
//! `data:` payload once its terminating blank line has arrived, so a parser
//! never sees a truncated frame.

/// Incremental SSE decoder. Feed UTF-8 chunks via [`SseDecoder::push`] and
/// collect complete `data:` payloads; call [`SseDecoder::finish`] at EOF to
/// flush any final payload the server emitted without a trailing blank line.
pub struct SseDecoder {
    /// Unconsumed bytes that have not yet hit a newline.
    buf: String,
    /// `data:` payloads accumulated for the in-flight event. SSE allows
    /// multiple `data:` lines per event (joined with `\n`); our providers send
    /// one, but we honour the spec.
    current_data: Option<String>,
    /// Last line that is not an SSE field but looks like a JSON object. Some
    /// OpenAI-compatible gateways (Ollama cloud) abort a stream by writing a
    /// bare `{"error":{...}}` line with no `data:` prefix; per spec that line
    /// is ignored, so keep it aside for the protocol parser to inspect.
    stray_json: Option<String>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self {
            buf: String::new(),
            current_data: None,
            stray_json: None,
        }
    }

    /// Feed a chunk of decoded text. Returns the `data:` payloads of any
    /// events whose terminating blank line has now arrived.
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();

        // Find each complete line terminator. SSE allows `\n` or `\r\n`.
        while let Some(nl) = self.buf.find('\n') {
            let mut line = self.buf[..nl].to_string();
            // The bytes up to and including `\n` are consumed.
            self.buf = self.buf[nl + 1..].to_string();
            // Strip a trailing `\r` (CRLF line endings).
            if line.ends_with('\r') {
                line.pop();
            }

            if line.is_empty() {
                // Blank line = event terminator. Flush accumulated data.
                if let Some(data) = self.current_data.take() {
                    if let Some(payload) = normalize_payload(&data) {
                        out.push(payload);
                    }
                }
                continue;
            }

            // `data:` line — accumulate the payload.
            if let Some(rest) = line.strip_prefix("data:") {
                // Per spec, strip exactly one leading space.
                let payload = rest.strip_prefix(' ').unwrap_or(rest);
                match &mut self.current_data {
                    Some(existing) => {
                        existing.push('\n');
                        existing.push_str(payload);
                    }
                    None => self.current_data = Some(payload.to_string()),
                }
                continue;
            }

            if line.trim_start().starts_with('{') {
                self.stray_json = Some(line);
                continue;
            }

            // `event:`, `id:`, `retry:`, and `:` comments are ignored — the
            // event type lives inside our providers' JSON `type` field, and we
            // don't implement client-driven retry.
        }

        out
    }

    /// The last non-SSE line that looked like a JSON object, if any.
    pub fn take_stray_json(&mut self) -> Option<String> {
        self.stray_json.take()
    }

    /// Flush any payload still buffered at EOF.
    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        // A trailing partial line without a newline is not a complete SSE
        // event by spec, but most servers close the last `data:` payload
        // without a blank line — be lenient and flush it.
        let trailing = self.buf.trim_end_matches(['\r', '\n']);
        if !trailing.is_empty() {
            if trailing.trim_start().starts_with('{') {
                self.stray_json = Some(trailing.to_string());
            } else if let Some(rest) = trailing.strip_prefix("data:") {
                let payload = rest.strip_prefix(' ').unwrap_or(rest);
                match &mut self.current_data {
                    Some(existing) => {
                        existing.push('\n');
                        existing.push_str(payload);
                    }
                    None => self.current_data = Some(payload.to_string()),
                }
            }
        }
        if let Some(data) = self.current_data.take() {
            if let Some(payload) = normalize_payload(&data) {
                out.push(payload);
            }
        }
        self.buf.clear();
        out
    }
}

/// Drop `[DONE]` keep-alives and empty payloads. Everything else is a JSON
/// frame for the protocol parser.
fn normalize_payload(data: &str) -> Option<String> {
    let trimmed = data.trim();
    if trimmed.is_empty() || trimmed == "[DONE]" {
        return None;
    }
    Some(data.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_json_line_is_kept_aside_not_yielded() {
        let mut d = SseDecoder::new();
        let out = d.push("data: {\"a\":1}\n\n{\"error\":{\"message\":\"boom\"}}\n");
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
        assert!(d.finish().is_empty());
        assert_eq!(d.take_stray_json().as_deref(), Some("{\"error\":{\"message\":\"boom\"}}"));
        assert!(d.take_stray_json().is_none());
    }

    #[test]
    fn bare_json_without_newline_at_eof_is_kept_aside() {
        let mut d = SseDecoder::new();
        assert!(d.push("{\"error\":\"x\"}").is_empty());
        assert!(d.finish().is_empty());
        assert_eq!(d.take_stray_json().as_deref(), Some("{\"error\":\"x\"}"));
    }

    #[test]
    fn single_event_two_newlines() {
        let mut d = SseDecoder::new();
        let out = d.push("data: {\"a\":1}\n\n");
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn split_across_chunks() {
        let mut d = SseDecoder::new();
        assert!(d.push("data: {\"a\":").is_empty());
        assert!(d.push("1}\n").is_empty());
        let out = d.push("\n");
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn ignores_event_and_id_lines() {
        let mut d = SseDecoder::new();
        let out = d.push("event: content_block_delta\ndata: {\"type\":\"x\"}\nid: 5\n\n");
        assert_eq!(out, vec!["{\"type\":\"x\"}".to_string()]);
    }

    #[test]
    fn drops_done_and_empty() {
        let mut d = SseDecoder::new();
        let out = d.push("data: [DONE]\n\n: comment\n\n");
        assert!(out.is_empty());
    }

    #[test]
    fn flushes_trailing_without_blank_line() {
        let mut d = SseDecoder::new();
        d.push("data: {\"a\":1}\n");
        let out = d.finish();
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn crlf_endings() {
        let mut d = SseDecoder::new();
        let out = d.push("data: {\"a\":1}\r\n\r\n");
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
    }
}
