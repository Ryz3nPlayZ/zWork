//! "Ask before changes": does a tool call change the user's own files?
//!
//! zWork's home (workspace, uploads, outputs, scratch) and the temp dirs are
//! the agent's to use freely. Everything else on disk belongs to the user, so
//! in Ask mode a write, edit, copy, move or delete that lands there goes
//! through the approval gate. Shell commands are judged by their file verbs
//! and redirects; a script writing from inside Python is invisible here,
//! which is why the Ask-mode prompt tells the model to save through these.

use std::path::{Path, PathBuf};

use crate::harness::tools::path_utils::resolve_to_cwd;

/// Roots the agent may change without asking.
fn agent_roots() -> Vec<PathBuf> {
    let mut roots = vec![crate::paths::home_dir(), std::env::temp_dir()];
    roots.extend(["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/dev"].map(PathBuf::from));
    let canonical: Vec<PathBuf> = roots.iter().filter_map(|r| r.canonicalize().ok()).collect();
    roots.extend(canonical);
    roots
}

fn is_users(path: &Path, roots: &[PathBuf]) -> bool {
    !roots.iter().any(|r| path.starts_with(r))
}

fn expand_home_var(s: &str) -> String {
    for var in ["${HOME}", "$HOME"] {
        if let Some(rest) = s.strip_prefix(var) {
            return format!("~{rest}");
        }
    }
    s.to_string()
}

/// The user-owned file a `write`/`edit` of `path` would change, if any.
pub fn user_file_written(path: &str, cwd: &Path) -> Option<PathBuf> {
    let resolved = resolve_to_cwd(&expand_home_var(path), cwd);
    is_users(&resolved, &agent_roots()).then_some(resolved)
}

/// The first user-owned path a shell command would change, if any.
pub fn user_file_changed_by(command: &str, cwd: &Path) -> Option<PathBuf> {
    let roots = agent_roots();
    let mut cwd = cwd.to_path_buf();
    for segment in segments(command) {
        let resolve = |s: &str, cwd: &Path| resolve_to_cwd(&expand_home_var(s), cwd);
        for target in segment.iter().filter(|t| t.redirect) {
            let p = resolve(&target.text, &cwd);
            if is_users(&p, &roots) {
                return Some(p);
            }
        }
        let words: Vec<&str> = segment.iter().filter(|t| !t.redirect).map(|t| t.text.as_str()).collect();
        let words = skip_prefixes(&words);
        let Some((verb, rest)) = words.split_first() else { continue };
        let verb = verb.rsplit('/').next().unwrap_or(verb);
        let flags: Vec<&str> = rest.iter().copied().filter(|a| a.starts_with('-')).collect();
        let args: Vec<&str> = rest.iter().copied().filter(|a| !a.starts_with('-')).collect();
        let changed: Vec<&str> = match verb {
            "cd" => {
                cwd = resolve(args.first().copied().unwrap_or("~"), &cwd);
                continue;
            }
            "rm" | "rmdir" | "unlink" | "mv" | "touch" | "mkdir" | "ln" | "truncate" | "shred" | "trash" | "tee" => args,
            "chmod" | "chown" | "chgrp" => args.into_iter().skip(1).collect(),
            "cp" | "ditto" | "install" | "rsync" => args.last().copied().into_iter().collect(),
            "sed" | "perl" if flags.iter().any(|f| f.starts_with("-i") || f.starts_with("-pi")) => {
                args.into_iter().skip(1).collect()
            }
            _ => continue,
        };
        if let Some(p) = changed.into_iter().map(|a| resolve(a, &cwd)).find(|p| is_users(p, &roots)) {
            return Some(p);
        }
    }
    None
}

fn skip_prefixes<'a>(words: &'a [&'a str]) -> &'a [&'a str] {
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        let assignment = w.contains('=') && !w.starts_with('-') && !w.starts_with('=');
        if assignment || matches!(w, "sudo" | "env" | "command" | "nohup" | "time" | "exec") {
            i += 1;
        } else {
            break;
        }
    }
    &words[i..]
}

struct Token {
    text: String,
    redirect: bool,
}

/// Split a command into `;`/`&&`/`|`-separated segments of words, marking
/// output-redirect targets. Quotes group words; fd dups (`2>&1`) are ignored.
fn segments(command: &str) -> Vec<Vec<Token>> {
    let mut out = vec![Vec::new()];
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut redirect_next = false;
    let mut chars = command.chars().peekable();

    fn flush(out: &mut Vec<Vec<Token>>, word: &mut String, redirect_next: &mut bool) {
        if !word.is_empty() {
            out.last_mut().unwrap().push(Token { text: std::mem::take(word), redirect: *redirect_next });
            *redirect_next = false;
        }
    }

    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '\'' | '"') => quote = Some(c),
            (None, '\\') => word.extend(chars.next()),
            (None, ' ' | '\t') => flush(&mut out, &mut word, &mut redirect_next),
            (None, ';' | '&' | '|' | '\n' | '(' | ')') => {
                flush(&mut out, &mut word, &mut redirect_next);
                out.push(Vec::new());
            }
            (None, '>') => {
                // `2>` / `&>`: the fd digits aren't a word.
                if word.chars().all(|d| d.is_ascii_digit()) {
                    word.clear();
                } else {
                    flush(&mut out, &mut word, &mut redirect_next);
                }
                if chars.peek() == Some(&'>') {
                    chars.next();
                }
                if chars.peek() == Some(&'&') {
                    chars.next();
                    while chars.peek().is_some_and(|d| d.is_ascii_digit() || *d == '-') {
                        chars.next();
                    }
                    continue;
                }
                redirect_next = true;
            }
            (None, c) => word.push(c),
        }
    }
    flush(&mut out, &mut word, &mut redirect_next);
    out.retain(|s| !s.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_home() -> PathBuf {
        dirs::home_dir().unwrap()
    }

    fn zwork() -> PathBuf {
        crate::paths::workspace_root()
    }

    fn changes(cmd: &str) -> bool {
        user_file_changed_by(cmd, &zwork()).is_some()
    }

    #[test]
    fn agent_space_is_free() {
        assert!(user_file_written("outputs/report.md", &zwork()).is_none());
        assert!(user_file_written("/tmp/x.csv", &zwork()).is_none());
        assert!(!changes("python3 build.py > outputs/log.txt 2>&1"));
        assert!(!changes("cp ~/Documents/data.csv scratch/"));
        assert!(!changes("rm -f scratch/tmp.json && mv a.xlsx outputs/"));
        assert!(!changes("ls ~/Documents | head"));
    }

    #[test]
    fn user_files_are_caught() {
        let docs = user_home().join("Documents/budget.xlsx");
        assert_eq!(user_file_written("~/Documents/budget.xlsx", &zwork()), Some(docs.clone()));
        assert!(user_file_written("$HOME/Documents/budget.xlsx", &zwork()).is_some());
        assert!(user_file_written("budget.xlsx", &user_home()).is_some());
        assert!(changes("cp outputs/Q3.xlsx ~/Downloads/"));
        assert!(changes("cp outputs/Q3.xlsx \"$HOME/Downloads/Q3 final.xlsx\""));
        assert!(changes("mv ~/Desktop/a.pdf outputs/"));
        assert!(changes("echo hi >> ~/notes.txt"));
        assert!(changes("cd ~/Documents && rm old.docx"));
        assert!(changes("sed -i '' 's/a/b/' ~/Documents/list.txt"));
        assert!(changes("sudo touch /etc/hosts"));
    }

    #[test]
    fn tokenizer_handles_quotes_and_fd_dups() {
        let segs = segments("echo 'a > b' 2>&1 | tee \"out file.txt\"; ls");
        assert_eq!(segs.len(), 3);
        assert!(segs.iter().flatten().all(|t| !t.redirect));
        assert_eq!(segs[1][1].text, "out file.txt");
        let segs = segments("cat x >out.txt");
        assert!(segs[0][2].redirect && segs[0][2].text == "out.txt");
    }
}
