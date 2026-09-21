//! Port of pi `core/tools/edit-diff.ts`: exact/fuzzy text replacement and
//! diff rendering for the `edit` tool.
//!
//! Difference from pi: fuzzy matching does not apply NFKC normalization
//! (no Unicode tables in the sidecar); trailing whitespace, smart quotes,
//! dashes and special spaces are normalized as in pi.

use similar::{ChangeTag, TextDiff};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
}

pub fn detect_line_ending(content: &str) -> LineEnding {
    let lf = content.find('\n');
    let crlf = content.find("\r\n");
    match (lf, crlf) {
        (None, _) | (_, None) => LineEnding::Lf,
        (Some(l), Some(c)) => {
            if c < l {
                LineEnding::CrLf
            } else {
                LineEnding::Lf
            }
        }
    }
}

pub fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn restore_line_endings(text: &str, ending: LineEnding) -> String {
    match ending {
        LineEnding::CrLf => text.replace('\n', "\r\n"),
        LineEnding::Lf => text.to_string(),
    }
}

/// Split a leading UTF-8 BOM off decoded text.
pub fn split_bom(content: &str) -> (&str, &str) {
    match content.strip_prefix('\u{FEFF}') {
        Some(rest) => ("\u{FEFF}", rest),
        None => ("", content),
    }
}

/// Normalize text for fuzzy matching: strip trailing whitespace per line,
/// smart quotes → ASCII, Unicode dashes → `-`, special spaces → ` `.
pub fn normalize_for_fuzzy_match(text: &str) -> String {
    let lines: Vec<String> = text.split('\n').map(|l| l.trim_end().to_string()).collect();
    lines
        .join("\n")
        .chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' | '\u{2212}' => '-',
            '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

/// Split into lines that keep their trailing `\n`.
fn split_lines_with_endings(content: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in content.bytes().enumerate() {
        if b == b'\n' {
            out.push(&content[start..=i]);
            start = i + 1;
        }
    }
    if start < content.len() {
        out.push(&content[start..]);
    }
    out
}

#[derive(Debug, Clone, Copy)]
struct LineSpan {
    start: usize,
    end: usize,
}

fn line_spans(content: &str) -> Vec<LineSpan> {
    let mut offset = 0;
    split_lines_with_endings(content)
        .into_iter()
        .map(|line| {
            let span = LineSpan { start: offset, end: offset + line.len() };
            offset = span.end;
            span
        })
        .collect()
}

#[derive(Debug, Clone)]
struct MatchedEdit {
    edit_index: usize,
    match_index: usize,
    match_length: usize,
    new_text: String,
}

fn replacement_line_range(lines: &[LineSpan], m: &MatchedEdit) -> Result<(usize, usize), String> {
    let start = m.match_index;
    let end = m.match_index + m.match_length;
    let start_line = lines
        .iter()
        .position(|l| start >= l.start && start < l.end)
        .ok_or("Replacement range is outside the base content.")?;
    let mut end_line = start_line;
    while end_line < lines.len() && lines[end_line].end < end {
        end_line += 1;
    }
    if end_line >= lines.len() {
        return Err("Replacement range is outside the base content.".into());
    }
    Ok((start_line, end_line + 1))
}

/// Apply replacements (sorted ascending) in reverse so offsets stay stable.
fn apply_replacements(content: &str, replacements: &[MatchedEdit], offset: usize) -> String {
    let mut result = content.to_string();
    for r in replacements.iter().rev() {
        let idx = r.match_index - offset;
        result = format!("{}{}{}", &result[..idx], r.new_text, &result[idx + r.match_length..]);
    }
    result
}

/// Apply replacements matched against a normalized `base_content` to
/// `original_content`, rewriting only the touched lines from the normalized
/// base and copying every other line from the original.
fn apply_replacements_preserving_unchanged_lines(
    original_content: &str,
    base_content: &str,
    replacements: &[MatchedEdit],
) -> Result<String, String> {
    let original_lines = split_lines_with_endings(original_content);
    let base_lines = line_spans(base_content);
    if original_lines.len() != base_lines.len() {
        return Err("Cannot preserve unchanged lines because the base content has a different line count.".into());
    }

    struct Group {
        start_line: usize,
        end_line: usize,
        replacements: Vec<MatchedEdit>,
    }
    let mut sorted = replacements.to_vec();
    sorted.sort_by_key(|r| r.match_index);
    let mut groups: Vec<Group> = Vec::new();
    for r in sorted {
        let (start_line, end_line) = replacement_line_range(&base_lines, &r)?;
        if let Some(current) = groups.last_mut() {
            if start_line < current.end_line {
                current.end_line = current.end_line.max(end_line);
                current.replacements.push(r);
                continue;
            }
        }
        groups.push(Group { start_line, end_line, replacements: vec![r] });
    }

    let mut result = String::new();
    let mut original_index = 0;
    for group in groups {
        result.push_str(&original_lines[original_index..group.start_line].concat());
        let start_offset = base_lines[group.start_line].start;
        let end_offset = base_lines[group.end_line - 1].end;
        result.push_str(&apply_replacements(&base_content[start_offset..end_offset], &group.replacements, start_offset));
        original_index = group.end_line;
    }
    result.push_str(&original_lines[original_index..].concat());
    Ok(result)
}

#[derive(Debug, Clone)]
pub struct FuzzyMatchResult {
    pub found: bool,
    pub index: usize,
    pub match_length: usize,
    pub used_fuzzy_match: bool,
}

/// Find `old_text` in `content`: exact first, then in fuzzy-normalized space
/// (offsets then refer to `normalize_for_fuzzy_match(content)`).
pub fn fuzzy_find_text(content: &str, old_text: &str) -> FuzzyMatchResult {
    if let Some(i) = content.find(old_text) {
        return FuzzyMatchResult { found: true, index: i, match_length: old_text.len(), used_fuzzy_match: false };
    }
    let fuzzy_content = normalize_for_fuzzy_match(content);
    let fuzzy_old = normalize_for_fuzzy_match(old_text);
    match fuzzy_content.find(&fuzzy_old) {
        Some(i) => FuzzyMatchResult { found: true, index: i, match_length: fuzzy_old.len(), used_fuzzy_match: true },
        None => FuzzyMatchResult { found: false, index: 0, match_length: 0, used_fuzzy_match: false },
    }
}

fn count_occurrences(content: &str, old_text: &str) -> usize {
    let c = normalize_for_fuzzy_match(content);
    let o = normalize_for_fuzzy_match(old_text);
    if o.is_empty() {
        return 0;
    }
    c.matches(&o).count()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedEdits {
    pub base_content: String,
    pub new_content: String,
}

fn not_found_error(path: &str, i: usize, total: usize) -> String {
    if total == 1 {
        format!("Could not find the exact text in {path}. The old text must match exactly including all whitespace and newlines.")
    } else {
        format!("Could not find edits[{i}] in {path}. The oldText must match exactly including all whitespace and newlines.")
    }
}

fn duplicate_error(path: &str, i: usize, total: usize, occurrences: usize) -> String {
    if total == 1 {
        format!("Found {occurrences} occurrences of the text in {path}. The text must be unique. Please provide more context to make it unique.")
    } else {
        format!("Found {occurrences} occurrences of edits[{i}] in {path}. Each oldText must be unique. Please provide more context to make it unique.")
    }
}

fn empty_old_text_error(path: &str, i: usize, total: usize) -> String {
    if total == 1 {
        format!("oldText must not be empty in {path}.")
    } else {
        format!("edits[{i}].oldText must not be empty in {path}.")
    }
}

fn no_change_error(path: &str, total: usize) -> String {
    if total == 1 {
        format!("No changes made to {path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.")
    } else {
        format!("No changes made to {path}. The replacements produced identical content.")
    }
}

/// Apply one or more exact-text replacements to LF-normalized content. All
/// edits are matched against the same original content, then applied in
/// reverse offset order. If any edit needs fuzzy matching the whole batch
/// runs in normalized space and is overlaid back onto the original lines.
pub fn apply_edits_to_normalized_content(normalized_content: &str, edits: &[Edit], path: &str) -> Result<AppliedEdits, String> {
    let edits: Vec<Edit> = edits
        .iter()
        .map(|e| Edit { old_text: normalize_to_lf(&e.old_text), new_text: normalize_to_lf(&e.new_text) })
        .collect();
    let total = edits.len();
    for (i, e) in edits.iter().enumerate() {
        if e.old_text.is_empty() {
            return Err(empty_old_text_error(path, i, total));
        }
    }

    let used_fuzzy = edits.iter().any(|e| fuzzy_find_text(normalized_content, &e.old_text).used_fuzzy_match);
    let replacement_base = if used_fuzzy { normalize_for_fuzzy_match(normalized_content) } else { normalized_content.to_string() };

    let mut matched: Vec<MatchedEdit> = Vec::new();
    for (i, e) in edits.iter().enumerate() {
        let m = fuzzy_find_text(&replacement_base, &e.old_text);
        if !m.found {
            return Err(not_found_error(path, i, total));
        }
        let occurrences = count_occurrences(&replacement_base, &e.old_text);
        if occurrences > 1 {
            return Err(duplicate_error(path, i, total, occurrences));
        }
        matched.push(MatchedEdit { edit_index: i, match_index: m.index, match_length: m.match_length, new_text: e.new_text.clone() });
    }

    matched.sort_by_key(|m| m.match_index);
    for pair in matched.windows(2) {
        let (prev, cur) = (&pair[0], &pair[1]);
        if prev.match_index + prev.match_length > cur.match_index {
            return Err(format!(
                "edits[{}] and edits[{}] overlap in {path}. Merge them into one edit or target disjoint regions.",
                prev.edit_index, cur.edit_index
            ));
        }
    }

    let new_content = if used_fuzzy {
        apply_replacements_preserving_unchanged_lines(normalized_content, &replacement_base, &matched)?
    } else {
        apply_replacements(&replacement_base, &matched, 0)
    };
    if new_content == normalized_content {
        return Err(no_change_error(path, total));
    }
    Ok(AppliedEdits { base_content: normalized_content.to_string(), new_content })
}

/// Standard unified patch (file headers only).
pub fn generate_unified_patch(path: &str, old_content: &str, new_content: &str, context_lines: usize) -> String {
    TextDiff::from_lines(old_content, new_content)
        .unified_diff()
        .context_radius(context_lines)
        .header(path, path)
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffString {
    pub diff: String,
    /// Line number of the first change in the new file.
    pub first_changed_line: Option<usize>,
}

struct Part {
    lines: Vec<String>,
    added: bool,
    removed: bool,
}

/// Display-oriented diff with line numbers and limited context.
pub fn generate_diff_string(old_content: &str, new_content: &str, context_lines: usize) -> DiffString {
    let diff = TextDiff::from_lines(old_content, new_content);
    let mut parts: Vec<Part> = Vec::new();
    for change in diff.iter_all_changes() {
        let (added, removed) = match change.tag() {
            ChangeTag::Equal => (false, false),
            ChangeTag::Insert => (true, false),
            ChangeTag::Delete => (false, true),
        };
        let line = change.value().trim_end_matches('\n').to_string();
        match parts.last_mut() {
            Some(p) if p.added == added && p.removed == removed => p.lines.push(line),
            _ => parts.push(Part { lines: vec![line], added, removed }),
        }
    }

    let width = old_content.split('\n').count().max(new_content.split('\n').count()).to_string().len();
    let num = |n: usize| format!("{:>width$}", n, width = width);
    let blank = " ".repeat(width);
    let mut output: Vec<String> = Vec::new();
    let mut old_line = 1usize;
    let mut new_line = 1usize;
    let mut last_was_change = false;
    let mut first_changed_line = None;

    for i in 0..parts.len() {
        let part = &parts[i];
        let raw = &part.lines;
        if part.added || part.removed {
            if first_changed_line.is_none() {
                first_changed_line = Some(new_line);
            }
            for line in raw {
                if part.added {
                    output.push(format!("+{} {line}", num(new_line)));
                    new_line += 1;
                } else {
                    output.push(format!("-{} {line}", num(old_line)));
                    old_line += 1;
                }
            }
            last_was_change = true;
            continue;
        }

        let next_is_change = i + 1 < parts.len() && (parts[i + 1].added || parts[i + 1].removed);
        let push_ctx = |output: &mut Vec<String>, line: &str, old_line: &mut usize, new_line: &mut usize| {
            output.push(format!(" {} {line}", num(*old_line)));
            *old_line += 1;
            *new_line += 1;
        };
        if last_was_change && next_is_change {
            if raw.len() <= context_lines * 2 {
                for line in raw {
                    push_ctx(&mut output, line, &mut old_line, &mut new_line);
                }
            } else {
                for line in &raw[..context_lines] {
                    push_ctx(&mut output, line, &mut old_line, &mut new_line);
                }
                let skipped = raw.len() - context_lines * 2;
                output.push(format!(" {blank} ..."));
                old_line += skipped;
                new_line += skipped;
                for line in &raw[raw.len() - context_lines..] {
                    push_ctx(&mut output, line, &mut old_line, &mut new_line);
                }
            }
        } else if last_was_change {
            let shown = raw.len().min(context_lines);
            for line in &raw[..shown] {
                push_ctx(&mut output, line, &mut old_line, &mut new_line);
            }
            let skipped = raw.len() - shown;
            if skipped > 0 {
                output.push(format!(" {blank} ..."));
                old_line += skipped;
                new_line += skipped;
            }
        } else if next_is_change {
            let skipped = raw.len().saturating_sub(context_lines);
            if skipped > 0 {
                output.push(format!(" {blank} ..."));
                old_line += skipped;
                new_line += skipped;
            }
            for line in &raw[skipped..] {
                push_ctx(&mut output, line, &mut old_line, &mut new_line);
            }
        } else {
            old_line += raw.len();
            new_line += raw.len();
        }
        last_was_change = false;
    }

    DiffString { diff: output.join("\n"), first_changed_line }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(o: &str, n: &str) -> Edit {
        Edit { old_text: o.into(), new_text: n.into() }
    }

    #[test]
    fn exact_multi_edit() {
        let content = "fn a() {}\nfn b() {}\nfn c() {}\n";
        let r = apply_edits_to_normalized_content(content, &[edit("fn c", "fn cc"), edit("fn a", "fn aa")], "x.rs").unwrap();
        assert_eq!(r.new_content, "fn aa() {}\nfn b() {}\nfn cc() {}\n");
    }

    #[test]
    fn fuzzy_match_preserves_untouched_lines() {
        // Line 1 has trailing whitespace + smart quote; line 3 keeps its trailing spaces.
        let content = "let s = \u{201C}hi\u{201D};   \nlet t = 1;\nlet u = 2;   \n";
        let r = apply_edits_to_normalized_content(content, &[edit("let s = \"hi\";", "let s = \"bye\";")], "x.rs").unwrap();
        assert_eq!(r.new_content, "let s = \"bye\";\nlet t = 1;\nlet u = 2;   \n");
    }

    #[test]
    fn errors() {
        let content = "a\nb\na\n";
        assert!(apply_edits_to_normalized_content(content, &[edit("zzz", "y")], "f").unwrap_err().contains("Could not find the exact text"));
        assert!(apply_edits_to_normalized_content(content, &[edit("a", "y")], "f").unwrap_err().contains("Found 2 occurrences"));
        assert!(apply_edits_to_normalized_content(content, &[edit("", "y")], "f").unwrap_err().contains("must not be empty"));
        assert!(apply_edits_to_normalized_content(content, &[edit("b", "b")], "f").unwrap_err().contains("No changes made"));
        let err = apply_edits_to_normalized_content("hello world\n", &[edit("hello wor", "x"), edit("world", "y")], "f").unwrap_err();
        assert!(err.contains("overlap"), "{err}");
    }

    #[test]
    fn line_endings_and_bom() {
        assert_eq!(detect_line_ending("a\r\nb"), LineEnding::CrLf);
        assert_eq!(detect_line_ending("a\nb\r\n"), LineEnding::Lf);
        assert_eq!(restore_line_endings("a\nb", LineEnding::CrLf), "a\r\nb");
        assert_eq!(split_bom("\u{FEFF}x"), ("\u{FEFF}", "x"));
    }

    #[test]
    fn diff_string_and_patch() {
        let old = (1..=12).map(|i| format!("line{i}")).collect::<Vec<_>>().join("\n") + "\n";
        let new = old.replace("line6", "LINE6");
        let d = generate_diff_string(&old, &new, 2);
        assert_eq!(d.first_changed_line, Some(6));
        let expected = " \u{20}\u{20} ...\n  4 line4\n  5 line5\n- 6 line6\n+ 6 LINE6\n  7 line7\n  8 line8\n    ...";
        assert_eq!(d.diff, expected);
        let patch = generate_unified_patch("x.txt", &old, &new, 1);
        assert!(patch.contains("--- x.txt"));
        assert!(patch.contains("-line6\n+LINE6"));
    }
}
