use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use crate::paths::skills_dir;

#[derive(Clone, Debug)]
pub struct SkillMeta {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

fn parse_frontmatter(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return out;
    }
    let after_first = &trimmed[3..];
    if let Some(end_pos) = after_first.find("---") {
        let frontmatter_content = &after_first[..end_pos];
        for line in frontmatter_content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(colon_pos) = line.find(':') {
                let key = line[..colon_pos].trim().to_string();
                let value = line[colon_pos + 1..]
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
                out.insert(key, value);
            }
        }
    }
    out
}

fn clip(s: &str, n: usize) -> String {
    let clean = s.replace('\n', " ").trim().to_string();
    if clean.len() <= n {
        clean
    } else {
        format!("{}…", &clean[..n - 1])
    }
}

fn first_paragraph(text: &str) -> String {
    let trimmed = text.trim_start();
    let body = if trimmed.starts_with("---") {
        if let Some(pos) = trimmed[3..].find("---") {
            &trimmed[3 + pos + 3..]
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    
    let mut lines = Vec::new();
    for line in body.lines() {
        let s = line.trim();
        if s.starts_with('#') {
            continue;
        }
        if s.is_empty() {
            if !lines.is_empty() {
                break;
            }
            continue;
        }
        lines.push(s);
        let total_len: usize = lines.iter().map(|l| l.len()).sum();
        if total_len > 200 {
            break;
        }
    }
    lines.join(" ")
}

fn visit_dirs(dir: &Path, files: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit_dirs(&path, files);
            } else if path.file_name().map_or(false, |n| n == "SKILL.md") {
                files.push(path);
            }
        }
    }
}

pub fn list_skills() -> Vec<SkillMeta> {
    let root = skills_dir();
    if !root.exists() {
        return Vec::new();
    }
    let mut skill_files = Vec::new();
    visit_dirs(&root, &mut skill_files);
    skill_files.sort();
    
    let mut out = Vec::new();
    for md_path in skill_files {
        if let Ok(text) = fs::read_to_string(&md_path) {
            let fm = parse_frontmatter(&text);
            let name = fm.get("name").cloned().unwrap_or_else(|| {
                md_path.parent()
                    .and_then(|p| p.file_name())
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string())
            });
            let desc = fm.get("description").cloned().unwrap_or_else(|| first_paragraph(&text));
            
            // Generate slug relative to root
            let slug = if let Ok(rel) = md_path.parent().unwrap().relative_to(&root) {
                rel.to_string_lossy().to_string().replace('\\', "/")
            } else {
                md_path.parent().unwrap().file_name().unwrap().to_string_lossy().to_string()
            };
            
            out.push(SkillMeta {
                slug,
                name,
                description: clip(&desc, 280),
                path: md_path,
            });
        }
    }
    out
}

pub fn read_skill(slug: &str) -> Option<String> {
    let slug_norm = slug.trim().trim_matches('/').to_lowercase();
    let skills = list_skills();
    for s in skills {
        let s_slug_norm = s.slug.to_lowercase();
        if s_slug_norm == slug_norm 
            || s_slug_norm.ends_with(&format!("/{}", slug_norm))
            || s.path.parent().unwrap().file_name().unwrap().to_string_lossy().to_lowercase() == slug_norm
        {
            return fs::read_to_string(s.path).ok();
        }
    }
    None
}

pub fn format_for_system_prompt() -> String {
    let skills = list_skills();
    if skills.is_empty() {
        return "(none installed)".to_string();
    }
    let limit = 40;
    let mut lines = Vec::new();
    for s in skills.iter().take(limit) {
        lines.push(format!("- `{}` — {}", s.slug, s.description));
    }
    if skills.len() > limit {
        lines.push(format!("- …and {} more", skills.len() - limit));
    }
    lines.join("\n")
}

// Minimal path helper for relativity
trait RelativeTo {
    fn relative_to(&self, base: &Path) -> Result<PathBuf, std::path::StripPrefixError>;
}

impl RelativeTo for Path {
    fn relative_to(&self, base: &Path) -> Result<PathBuf, std::path::StripPrefixError> {
        self.strip_prefix(base).map(|p| p.to_path_buf())
    }
}
