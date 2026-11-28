//! Port of pi `core/tools/path-utils.ts` + the relevant bits of
//! `utils/paths.ts`: tilde expansion, cwd-relative resolution and the
//! macOS screenshot filename fallbacks used by `read`.
//!
//! Difference from pi: no NFD (decomposed Unicode) variant lookup; that
//! needs a normalization table and macOS APFS resolves either form.

use std::path::{Component, Path, PathBuf};

const NARROW_NO_BREAK_SPACE: char = '\u{202F}';

fn is_unicode_space(c: char) -> bool {
    matches!(c, '\u{00A0}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}')
}

/// Normalize a model-supplied path: unicode spaces → " ", strip a leading
/// `@`, expand `~`, unwrap `file://`.
pub fn expand_path(input: &str) -> PathBuf {
    let mut s: String = input.chars().map(|c| if is_unicode_space(c) { ' ' } else { c }).collect();
    if let Some(rest) = s.strip_prefix('@') {
        s = rest.to_string();
    }
    if s == "~" {
        return home_dir();
    }
    if let Some(rest) = s.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    if let Some(rest) = s.strip_prefix("$HOME/") {
        return home_dir().join(rest);
    }
    if let Some(rest) = s.strip_prefix("file://") {
        return PathBuf::from(rest);
    }
    rehome_dropped_home(PathBuf::from(s))
}

/// Models often drop the home folder from an absolute path ("/Desktop/a.pdf",
/// "/Programming/zWork"). When the first folder does not exist at the disk
/// root but does in the home folder, use the home one.
fn rehome_dropped_home(path: PathBuf) -> PathBuf {
    rehome_under(path, &home_dir())
}

fn rehome_under(path: PathBuf, home: &Path) -> PathBuf {
    if !path.is_absolute() || path.starts_with(home) {
        return path;
    }
    let mut comps = path.components();
    comps.next(); // root
    let Some(Component::Normal(first)) = comps.next() else { return path };
    if Path::new("/").join(first).exists() || !home.join(first).exists() {
        return path;
    }
    home.join(path.strip_prefix("/").unwrap_or(&path))
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Lexically normalize `.` and `..` components (no filesystem access).
pub fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve a path relative to `cwd`, with tilde expansion.
pub fn resolve_to_cwd(input: &str, cwd: &Path) -> PathBuf {
    let expanded = expand_path(input);
    let joined = if expanded.is_absolute() { expanded } else { cwd.join(expanded) };
    normalize_lexically(&joined)
}

fn try_macos_screenshot_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_ref();
    while let Some(idx) = rest.find(' ') {
        let after = &rest[idx + 1..];
        let matched = ["AM.", "PM.", "am.", "pm."].iter().find(|m| after.starts_with(**m));
        out.push_str(&rest[..idx]);
        if let Some(m) = matched {
            out.push(NARROW_NO_BREAK_SPACE);
            out.push_str(m);
            rest = &after[m.len()..];
        } else {
            out.push(' ');
            rest = after;
        }
    }
    out.push_str(rest);
    PathBuf::from(out)
}

fn try_curly_quote_variant(p: &Path) -> PathBuf {
    PathBuf::from(p.to_string_lossy().replace('\'', "\u{2019}"))
}

/// Resolve a read path, falling back to macOS screenshot-name variants
/// (narrow no-break space before AM/PM, curly apostrophes) when the literal
/// path does not exist.
pub fn resolve_read_path(input: &str, cwd: &Path) -> PathBuf {
    let resolved = resolve_to_cwd(input, cwd);
    if resolved.exists() {
        return resolved;
    }
    for variant in [try_macos_screenshot_path(&resolved), try_curly_quote_variant(&resolved)] {
        if variant != resolved && variant.exists() {
            return variant;
        }
    }
    resolved
}

/// Path relative to `base` with `/` separators, or `None` if outside it.
pub fn relative_posix(path: &Path, base: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    let s = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/");
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    // `/Desktop/a.pdf` has no drive, so it isn't absolute on Windows.
    #[cfg(unix)]
    #[test]
    fn absolute_path_missing_the_home_folder_is_rehomed() {
        let home = std::env::temp_dir().join(format!("zw-home-{}", std::process::id()));
        std::fs::create_dir_all(home.join("Desktop")).unwrap();
        let home = home.canonicalize().unwrap();
        assert_eq!(rehome_under(PathBuf::from("/Desktop/a.pdf"), &home), home.join("Desktop/a.pdf"));
        // Real root folders and unknown folders stay as written.
        assert_eq!(rehome_under(PathBuf::from("/tmp/a"), &home), PathBuf::from("/tmp/a"));
        assert_eq!(rehome_under(PathBuf::from("/Nope/a"), &home), PathBuf::from("/Nope/a"));
        assert_eq!(rehome_under(home.join("Desktop"), &home), home.join("Desktop"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resolves_relative_tilde_and_dots() {
        let cwd = Path::new("/work/proj");
        assert_eq!(resolve_to_cwd("src/../lib/a.rs", cwd), PathBuf::from("/work/proj/lib/a.rs"));
        assert_eq!(resolve_to_cwd("/abs/x", cwd), PathBuf::from("/abs/x"));
        assert_eq!(resolve_to_cwd("@./a.txt", cwd), PathBuf::from("/work/proj/a.txt"));
        assert!(resolve_to_cwd("~/x", cwd).is_absolute());
        assert_eq!(resolve_to_cwd("a\u{00A0}b", cwd), PathBuf::from("/work/proj/a b"));
    }

    #[test]
    fn screenshot_variant_inserts_narrow_space() {
        let p = Path::new("/x/Screenshot 2024-01-01 at 3.14.15 PM.png");
        assert_eq!(
            try_macos_screenshot_path(p).to_string_lossy(),
            "/x/Screenshot 2024-01-01 at 3.14.15\u{202F}PM.png"
        );
    }

    #[test]
    fn relative_posix_outside_is_none() {
        assert_eq!(relative_posix(Path::new("/a/b/c"), Path::new("/a")), Some("b/c".into()));
        assert_eq!(relative_posix(Path::new("/z"), Path::new("/a")), None);
    }
}
