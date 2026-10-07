//! Filesystem walking for `find` and `grep`.
//!
//! pi shells out to `fd` and `ripgrep`. zWork ships no extra binaries, so
//! this is a native walker with the behaviour those tools give by default:
//! hidden files included, `.git` skipped, `.gitignore` files honoured
//! (root-anchored and nested, with negation, dir-only and `**` patterns).

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;

use crate::harness::types::AbortSignal;

/// Compile a glob into an anchored regex. Supports `*`, `**`, `?`, `[...]`
/// and `{a,b}`. `*` and `?` do not cross `/`.
pub fn glob_to_regex(glob: &str, case_insensitive: bool) -> Result<Regex, String> {
    let mut re = String::from("^");
    let chars: Vec<char> = glob.chars().collect();
    let mut i = 0;
    let mut brace_depth = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    // `**/` matches zero or more directories; bare `**` matches anything.
                    if i + 2 < chars.len() && chars[i + 2] == '/' {
                        re.push_str("(?:.*/)?");
                        i += 3;
                        continue;
                    }
                    re.push_str(".*");
                    i += 2;
                    continue;
                }
                re.push_str("[^/]*");
            }
            '?' => re.push_str("[^/]"),
            '[' => {
                let close = chars[i + 1..].iter().position(|&x| x == ']').map(|p| p + i + 1);
                match close {
                    Some(end) => {
                        let mut class = String::from("[");
                        let mut j = i + 1;
                        if j < end && chars[j] == '!' {
                            class.push('^');
                            j += 1;
                        }
                        while j < end {
                            if chars[j] == '\\' || chars[j] == '[' {
                                class.push('\\');
                            }
                            class.push(chars[j]);
                            j += 1;
                        }
                        class.push(']');
                        re.push_str(&class);
                        i = end;
                    }
                    None => re.push_str("\\["),
                }
            }
            '{' => {
                brace_depth += 1;
                re.push_str("(?:");
            }
            '}' if brace_depth > 0 => {
                brace_depth -= 1;
                re.push(')');
            }
            ',' if brace_depth > 0 => re.push('|'),
            '\\' if i + 1 < chars.len() => {
                i += 1;
                re.push_str(&regex::escape(&chars[i].to_string()));
            }
            other => re.push_str(&regex::escape(&other.to_string())),
        }
        i += 1;
    }
    re.push('$');
    let pattern = if case_insensitive { format!("(?i){re}") } else { re };
    Regex::new(&pattern).map_err(|e| format!("invalid glob '{glob}': {e}"))
}

struct IgnoreRule {
    regex: Regex,
    negate: bool,
    dir_only: bool,
    /// Pattern is anchored to the .gitignore's own directory.
    anchored: bool,
}

struct IgnoreFile {
    /// Directory holding the .gitignore.
    base: PathBuf,
    rules: Vec<IgnoreRule>,
}

fn parse_gitignore(base: &Path, content: &str) -> IgnoreFile {
    let mut rules = Vec::new();
    for raw in content.lines() {
        let line = raw.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (negate, line) = match line.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, line),
        };
        let line = line.strip_prefix('\\').unwrap_or(line);
        let (dir_only, line) = match line.strip_suffix('/') {
            Some(rest) => (true, rest),
            None => (false, line),
        };
        // A slash anywhere (other than trailing) anchors the pattern to base.
        let anchored = line.contains('/');
        let line = line.strip_prefix('/').unwrap_or(line);
        let Ok(regex) = glob_to_regex(line, false) else { continue };
        rules.push(IgnoreRule { regex, negate, dir_only, anchored });
    }
    IgnoreFile { base: base.to_path_buf(), rules }
}

fn is_ignored(stack: &[IgnoreFile], path: &Path, is_dir: bool) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mut ignored = false;
    for file in stack {
        let Some(rel) = super::path_utils::relative_posix(path, &file.base) else { continue };
        for rule in &file.rules {
            if rule.dir_only && !is_dir {
                continue;
            }
            let matched = if rule.anchored {
                rule.regex.is_match(&rel)
            } else {
                // Unanchored: match the basename or any suffix of directories.
                rule.regex.is_match(&name)
                    || rel.match_indices('/').any(|(i, _)| rule.regex.is_match(&rel[i + 1..]))
                    || rule.regex.is_match(&rel)
            };
            if matched {
                ignored = !rule.negate;
            }
        }
    }
    ignored
}

#[derive(Debug, Clone)]
pub struct WalkEntry {
    pub path: PathBuf,
    pub is_dir: bool,
}

pub struct WalkOptions<'a> {
    pub root: &'a Path,
    pub respect_gitignore: bool,
    pub signal: Option<&'a AbortSignal>,
}

/// Walk `root` depth-first, calling `visit` for every entry (files and
/// directories, hidden included, `.git` excluded). Symlinks are reported
/// but not followed. Returning `false` from `visit` stops the walk.
pub fn walk(options: WalkOptions<'_>, visit: &mut dyn FnMut(&WalkEntry) -> bool) -> Result<(), String> {
    let mut stack: Vec<IgnoreFile> = Vec::new();
    if options.respect_gitignore {
        // Parent .gitignore files apply to nested paths too.
        let mut ancestors: Vec<&Path> = options.root.ancestors().collect();
        ancestors.reverse();
        for dir in ancestors {
            if let Ok(content) = fs::read_to_string(dir.join(".gitignore")) {
                stack.push(parse_gitignore(dir, &content));
            }
        }
    }
    walk_dir(options.root, &mut stack, options.respect_gitignore, options.signal, visit).map(|_| ())
}

fn walk_dir(
    dir: &Path,
    stack: &mut Vec<IgnoreFile>,
    respect_gitignore: bool,
    signal: Option<&AbortSignal>,
    visit: &mut dyn FnMut(&WalkEntry) -> bool,
) -> Result<bool, String> {
    if signal.is_some_and(|s| s.is_aborted()) {
        return Err("Operation aborted".into());
    }
    let mut pushed = false;
    if respect_gitignore {
        if let Ok(content) = fs::read_to_string(dir.join(".gitignore")) {
            stack.push(parse_gitignore(dir, &content));
            pushed = true;
        }
    }
    let mut entries: Vec<fs::DirEntry> = match fs::read_dir(dir) {
        Ok(rd) => rd.flatten().collect(),
        Err(_) => {
            if pushed {
                stack.pop();
            }
            return Ok(true);
        }
    };
    entries.sort_by_key(|e| e.file_name());
    let mut keep_going = true;
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let is_dir = file_type.is_dir();
        if respect_gitignore && is_ignored(stack, &path, is_dir) {
            continue;
        }
        if !visit(&WalkEntry { path: path.clone(), is_dir }) {
            keep_going = false;
            break;
        }
        if is_dir && !walk_dir(&path, stack, respect_gitignore, signal, visit)? {
            keep_going = false;
            break;
        }
    }
    if pushed {
        stack.pop();
    }
    Ok(keep_going)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_semantics() {
        let m = |g: &str, s: &str| glob_to_regex(g, false).unwrap().is_match(s);
        assert!(m("*.ts", "a.ts"));
        assert!(!m("*.ts", "dir/a.ts"));
        assert!(m("**/*.ts", "a.ts"));
        assert!(m("**/*.ts", "x/y/a.ts"));
        assert!(m("src/**/*.spec.ts", "src/a/b.spec.ts"));
        assert!(m("src/**/*.spec.ts", "src/b.spec.ts"));
        assert!(m("a?c", "abc"));
        assert!(m("*.{js,ts}", "a.ts"));
        assert!(!m("*.{js,ts}", "a.rs"));
        assert!(m("[ab]*", "bx"));
        assert!(!m("[!ab]*", "bx"));
        assert!(glob_to_regex("*.TS", true).unwrap().is_match("a.ts"));
    }

    #[test]
    fn walk_respects_gitignore() {
        let root = std::env::temp_dir().join(format!("zwork-walk-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), "build/\n*.log\n!keep.log\n/root-only.txt\n").unwrap();
        fs::write(root.join("src/nested/.gitignore"), "secret.txt\n").unwrap();
        fs::write(root.join("src/a.rs"), "").unwrap();
        fs::write(root.join("src/nested/b.rs"), "").unwrap();
        fs::write(root.join("src/nested/secret.txt"), "").unwrap();
        fs::write(root.join("src/x.log"), "").unwrap();
        fs::write(root.join("src/keep.log"), "").unwrap();
        fs::write(root.join("build/out.js"), "").unwrap();
        fs::write(root.join("root-only.txt"), "").unwrap();
        fs::write(root.join("src/root-only.txt"), "").unwrap();
        fs::write(root.join(".git/HEAD"), "").unwrap();

        let mut seen = Vec::new();
        walk(WalkOptions { root: &root, respect_gitignore: true, signal: None }, &mut |e| {
            if !e.is_dir {
                seen.push(super::super::path_utils::relative_posix(&e.path, &root).unwrap());
            }
            true
        })
        .unwrap();
        seen.sort();
        assert_eq!(
            seen,
            vec![".gitignore", "src/a.rs", "src/keep.log", "src/nested/.gitignore", "src/nested/b.rs", "src/root-only.txt"]
        );
        fs::remove_dir_all(&root).ok();
    }
}
