//! Lenient JSON parsing for streamed tool-call arguments.
//!
//! Port of pi-mono `packages/ai/src/utils/json-parse.ts`. `partial-json`
//! (the npm dependency) is replaced with a small recursive-descent parser
//! that returns whatever prefix of the document is complete.

use serde_json::{Map, Value};

const VALID_JSON_ESCAPES: &[char] = &['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'];

fn escape_control_character(c: char) -> String {
    match c {
        '\u{8}' => "\\b".into(),
        '\u{c}' => "\\f".into(),
        '\n' => "\\n".into(),
        '\r' => "\\r".into(),
        '\t' => "\\t".into(),
        other => format!("\\u{:04x}", other as u32),
    }
}

/// Repair malformed JSON string literals: escape raw control characters
/// inside strings and double backslashes before invalid escape characters.
pub fn repair_json(json: &str) -> String {
    let chars: Vec<char> = json.chars().collect();
    let mut repaired = String::with_capacity(json.len());
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_string {
            repaired.push(c);
            if c == '"' {
                in_string = true;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            repaired.push(c);
            in_string = false;
            i += 1;
            continue;
        }
        if c == '\\' {
            let next = chars.get(i + 1).copied();
            match next {
                None => {
                    repaired.push_str("\\\\");
                    i += 1;
                    continue;
                }
                Some('u') => {
                    let digits: String = chars.iter().skip(i + 2).take(4).collect();
                    if digits.len() == 4 && digits.chars().all(|d| d.is_ascii_hexdigit()) {
                        repaired.push_str("\\u");
                        repaired.push_str(&digits);
                        i += 6;
                        continue;
                    }
                    // `\u` without four hex digits: escape the backslash.
                    repaired.push_str("\\\\");
                    i += 1;
                    continue;
                }
                _ => {}
            }
            if let Some(n) = next {
                if VALID_JSON_ESCAPES.contains(&n) {
                    repaired.push('\\');
                    repaired.push(n);
                    i += 2;
                    continue;
                }
            }
            repaired.push_str("\\\\");
            i += 1;
            continue;
        }
        if (c as u32) <= 0x1f {
            repaired.push_str(&escape_control_character(c));
        } else {
            repaired.push(c);
        }
        i += 1;
    }
    repaired
}

pub fn parse_json_with_repair(json: &str) -> Result<Value, serde_json::Error> {
    match serde_json::from_str(json) {
        Ok(v) => Ok(v),
        Err(e) => {
            let repaired = repair_json(json);
            if repaired != json {
                serde_json::from_str(&repaired)
            } else {
                Err(e)
            }
        }
    }
}

/// Parse potentially incomplete JSON during streaming. Always returns a
/// value (an empty object if nothing parses).
pub fn parse_streaming_json(partial: &str) -> Value {
    if partial.trim().is_empty() {
        return Value::Object(Map::new());
    }
    if let Ok(v) = parse_json_with_repair(partial) {
        return v;
    }
    if let Some(v) = partial_parse(partial) {
        return v;
    }
    if let Some(v) = partial_parse(&repair_json(partial)) {
        return v;
    }
    Value::Object(Map::new())
}

// ---------------------------------------------------------------------------
// Partial JSON parser
// ---------------------------------------------------------------------------

struct PartialParser<'a> {
    s: &'a [u8],
    pos: usize,
}

impl<'a> PartialParser<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.s.len() && (self.s[self.pos] as char).is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.pos).copied()
    }

    /// Parse a value. `None` means nothing usable was found at all.
    fn value(&mut self) -> Option<Value> {
        self.skip_ws();
        match self.peek()? {
            b'{' => Some(self.object()),
            b'[' => Some(self.array()),
            b'"' => Some(Value::String(self.string())),
            b't' => self.literal("true", Value::Bool(true)),
            b'f' => self.literal("false", Value::Bool(false)),
            b'n' => self.literal("null", Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn literal(&mut self, word: &str, v: Value) -> Option<Value> {
        let rest = &self.s[self.pos..];
        let w = word.as_bytes();
        // Accept a complete literal or a truncated prefix of one.
        if rest.starts_with(w) {
            self.pos += w.len();
            return Some(v);
        }
        if w.starts_with(rest) {
            self.pos = self.s.len();
            return Some(v);
        }
        None
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.pos;
        while self.pos < self.s.len() {
            let c = self.s[self.pos];
            if c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.' | b'e' | b'E') {
                self.pos += 1;
            } else {
                break;
            }
        }
        let mut text = std::str::from_utf8(&self.s[start..self.pos]).ok()?;
        // Trim a dangling exponent/sign/decimal from a truncated number.
        while !text.is_empty() && text.ends_with(['-', '+', '.', 'e', 'E']) {
            text = &text[..text.len() - 1];
        }
        if text.is_empty() || text == "-" {
            return None;
        }
        serde_json::from_str::<Value>(text).ok()
    }

    fn string(&mut self) -> String {
        // Consume the opening quote.
        self.pos += 1;
        let mut out: Vec<u8> = Vec::new();
        while self.pos < self.s.len() {
            let c = self.s[self.pos];
            match c {
                b'"' => {
                    self.pos += 1;
                    return String::from_utf8_lossy(&out).into_owned();
                }
                b'\\' => {
                    let next = self.s.get(self.pos + 1).copied();
                    match next {
                        None => {
                            // Truncated mid-escape: drop it.
                            self.pos = self.s.len();
                            break;
                        }
                        Some(b'u') => {
                            let hex = self.s.get(self.pos + 2..self.pos + 6);
                            match hex.and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u32::from_str_radix(h, 16).ok()) {
                                Some(cp) => {
                                    if let Some(ch) = char::from_u32(cp) {
                                        let mut buf = [0u8; 4];
                                        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                                    }
                                    self.pos += 6;
                                }
                                None => {
                                    // Truncated \uXXXX: stop here.
                                    self.pos = self.s.len();
                                    break;
                                }
                            }
                        }
                        Some(n) => {
                            let decoded: &[u8] = match n {
                                b'n' => b"\n",
                                b't' => b"\t",
                                b'r' => b"\r",
                                b'b' => b"\x08",
                                b'f' => b"\x0c",
                                b'/' => b"/",
                                b'\\' => b"\\",
                                b'"' => b"\"",
                                other => {
                                    out.push(b'\\');
                                    out.push(other);
                                    self.pos += 2;
                                    continue;
                                }
                            };
                            out.extend_from_slice(decoded);
                            self.pos += 2;
                        }
                    }
                }
                _ => {
                    out.push(c);
                    self.pos += 1;
                }
            }
        }
        // Unterminated string: return what we have.
        String::from_utf8_lossy(&out).into_owned()
    }

    fn array(&mut self) -> Value {
        self.pos += 1; // [
        let mut items = Vec::new();
        loop {
            self.skip_ws();
            match self.peek() {
                None => break,
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(_) => match self.value() {
                    Some(v) => items.push(v),
                    None => break,
                },
            }
        }
        Value::Array(items)
    }

    fn object(&mut self) -> Value {
        self.pos += 1; // {
        let mut map = Map::new();
        loop {
            self.skip_ws();
            match self.peek() {
                None => break,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b'"') => {
                    let key_start = self.pos;
                    let key = self.string();
                    // If the key itself was truncated (no closing quote), drop it.
                    if self.pos >= self.s.len() && !self.s[key_start..].iter().skip(1).any(|&b| b == b'"') {
                        break;
                    }
                    self.skip_ws();
                    if self.peek() != Some(b':') {
                        break;
                    }
                    self.pos += 1;
                    match self.value() {
                        Some(v) => {
                            map.insert(key, v);
                        }
                        None => break,
                    }
                }
                Some(_) => break,
            }
        }
        Value::Object(map)
    }
}

fn partial_parse(s: &str) -> Option<Value> {
    let mut p = PartialParser { s: s.as_bytes(), pos: 0 };
    p.value()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_is_object() {
        assert_eq!(parse_streaming_json(""), json!({}));
        assert_eq!(parse_streaming_json("   "), json!({}));
    }

    #[test]
    fn complete_json() {
        assert_eq!(parse_streaming_json(r#"{"a":1,"b":[1,2]}"#), json!({"a":1,"b":[1,2]}));
    }

    #[test]
    fn truncated_object() {
        assert_eq!(parse_streaming_json(r#"{"path": "/tmp/x", "con"#), json!({"path":"/tmp/x"}));
        assert_eq!(parse_streaming_json(r#"{"path": "/tmp/x", "content": "hel"#), json!({"path":"/tmp/x","content":"hel"}));
        assert_eq!(parse_streaming_json(r#"{"a": [1, 2, {"b": tr"#), json!({"a":[1,2,{"b":true}]}));
        assert_eq!(parse_streaming_json(r#"{"n": 12"#), json!({"n":12}));
        assert_eq!(parse_streaming_json(r#"{"n": 1.5e"#), json!({"n":1.5}));
        assert_eq!(parse_streaming_json(r#"{"a":"x","b":"#), json!({"a":"x"}));
    }

    #[test]
    fn repairs_control_chars_and_bad_escapes() {
        let broken = "{\"text\":\"line1\nline2 \\d\"}";
        let v = parse_streaming_json(broken);
        assert_eq!(v["text"], "line1\nline2 \\d");
        assert_eq!(repair_json(r#"{"a":"\u12"}"#), r#"{"a":"\\u12"}"#);
    }

    #[test]
    fn escapes_in_partial_strings() {
        assert_eq!(parse_streaming_json(r#"{"a":"x\ny\u00e9"#), json!({"a":"x\nyé"}));
        assert_eq!(parse_streaming_json(r#"{"a":"x\"#), json!({"a":"x"}));
    }
}
