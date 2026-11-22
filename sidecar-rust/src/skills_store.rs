//! The Skills storefront: browse and add skills from skills.sh.
//!
//! skills.sh is an open directory of Agent Skills (the same SKILL.md format
//! zWork loads). Its documented v1 API needs a Vercel-issued token, so this
//! uses the two public endpoints its MIT-licensed `skills` CLI calls:
//! `GET /api/search?q=` (names and install counts) and
//! `GET /api/download/{owner}/{repo}/{skill}` (every file of one skill).
//! Both are rate-limited per IP, so answers are cached.
//!
//! An added skill lands in the user's zWork skills folder
//! (`<ZWORK_HOME>/skills/<name>/`) with a `.zwork-source.json` note of where
//! it came from; only skills with that note can be removed from the app.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::harness::skills::parse_frontmatter;

const BASE: &str = "https://skills.sh";
const SEARCH_TTL: Duration = Duration::from_secs(10 * 60);
const DOWNLOAD_TTL: Duration = Duration::from_secs(30 * 60);
/// A skill bigger than this is almost certainly not instructions for paperwork.
const MAX_TOTAL_BYTES: usize = 5 * 1024 * 1024;
const MAX_FILES: usize = 200;
/// Search results shown at once; each is fetched for its description.
const SEARCH_SHOWN: usize = 18;
pub const SOURCE_FILE: &str = ".zwork-source.json";

/// Hand-picked skills for office work, with descriptions in plain words
/// (search results carry no descriptions). Checked against skills.sh on
/// 2026-11-21: each id downloads and has a SKILL.md at its root.
const OFFICE_SHELF: &[(&str, &str, &str)] = &[
    ("anthropics/knowledge-work-plugins/invoice-chase", "Chase unpaid invoices", "Writes reminder emails for overdue invoices, from a gentle nudge to a firm final notice, in your tone."),
    ("composiohq/awesome-claude-skills/invoice-organizer", "File your receipts", "Reads messy invoice and receipt files, renames them the same way and sorts them into folders for tax time."),
    ("claude-office-skills/skills/expense-report", "Expense reports", "Turns receipts and notes into a tidy expense report with categories and totals."),
    ("claude-office-skills/skills/meeting-notes", "Meeting notes", "Turns a transcript or rough notes into clear meeting notes with decisions and next steps."),
    ("github/awesome-copilot/meeting-minutes", "Meeting minutes", "Writes short, actionable minutes: attendees, decisions, and action items with owners and dates."),
    ("claude-office-skills/skills/proposal-writer", "Business proposals", "Drafts a persuasive proposal for a client, partner or funder from your notes."),
    ("paramchoudhary/resumeskills/cover-letter-generator", "Cover letters", "Writes a cover letter that matches your CV to a job description."),
    ("paramchoudhary/resumeskills/resume-tailor", "Tailor your CV", "Adjusts your CV for a specific job posting without making anything up."),
    ("anthropics/k12-teacher-skills/k12-lesson-plan-creation", "Lesson plans", "Builds a structured lesson plan for a subject and grade, with activities and checks for understanding."),
    ("k-dense-ai/scientific-agent-skills/research-grants", "Research grant proposals", "Helps prepare grant applications for NSF, NIH and similar funders: aims, budgets and review criteria."),
];

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("zWork")
        .build()
        .unwrap_or_default()
}

type Cache = Mutex<HashMap<String, (Instant, Value)>>;
static SEARCH_CACHE: std::sync::LazyLock<Cache> = std::sync::LazyLock::new(Default::default);
static DOWNLOAD_CACHE: std::sync::LazyLock<Cache> = std::sync::LazyLock::new(Default::default);

fn cached(cache: &Cache, key: &str, ttl: Duration) -> Option<Value> {
    let map = cache.lock().ok()?;
    let (at, v) = map.get(key)?;
    (at.elapsed() < ttl).then(|| v.clone())
}

fn remember(cache: &Cache, key: &str, v: &Value) {
    if let Ok(mut map) = cache.lock() {
        if map.len() > 200 {
            map.clear();
        }
        map.insert(key.to_string(), (Instant::now(), v.clone()));
    }
}

/// `owner/repo/skill`, each part a plain GitHub-style name. Anything else
/// (including the directory's two-part ids) can't be downloaded.
fn valid_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('/').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty() && *p != "." && *p != ".." && p.len() <= 100 && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
}

/// The installed-name rule from the Agent Skills spec, as the loader applies it.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
}

/// The curated shelf, for the storefront's first screen.
pub fn office_shelf() -> Value {
    let skills: Vec<Value> = OFFICE_SHELF
        .iter()
        .map(|(id, title, blurb)| {
            json!({
                "id": id,
                "name": id.rsplit('/').next().unwrap_or(id),
                "title": title,
                "description": blurb,
                "source": id.rsplitn(2, '/').nth(1).unwrap_or(""),
            })
        })
        .collect();
    json!({ "skills": skills })
}

/// Search skills.sh. Results are names, the repo they live in and how many
/// people installed them; duplicates and ids that can't be added are dropped.
pub async fn search(q: &str) -> Result<Value, String> {
    let q = q.trim();
    if q.chars().count() < 2 {
        return Ok(json!({ "skills": [] }));
    }
    let key = q.to_lowercase();
    if let Some(v) = cached(&SEARCH_CACHE, &key, SEARCH_TTL) {
        return Ok(v);
    }
    let resp = client()
        .get(format!("{BASE}/api/search"))
        .query(&[("q", q), ("limit", "40")])
        .send()
        .await
        .map_err(|_| "skills_unreachable".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("skills_search_failed_{}", resp.status().as_u16()));
    }
    let body: Value = resp.json().await.map_err(|_| "skills_invalid_response".to_string())?;
    let skills: Vec<Value> = body
        .get("skills")
        .and_then(|s| s.as_array())
        .map(|a| {
            a.iter()
                .filter(|s| !s.get("isDuplicate").and_then(|d| d.as_bool()).unwrap_or(false))
                .filter_map(|s| {
                    let id = s.get("id")?.as_str()?;
                    valid_id(id).then(|| {
                        json!({
                            "id": id,
                            "name": s.get("name").and_then(|n| n.as_str()).unwrap_or_else(|| id.rsplit('/').next().unwrap_or(id)),
                            "source": id.rsplitn(2, '/').nth(1).unwrap_or(""),
                            "installs": s.get("installs").and_then(|n| n.as_u64()).unwrap_or(0),
                        })
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let skills = with_descriptions(relevant(skills, &key)).await;
    let v = json!({ "skills": skills });
    remember(&SEARCH_CACHE, &key, &v);
    Ok(v)
}

/// Search results worth showing. skills.sh pads its answer with loose
/// matches (developer skills for "invoice"); when at least three skills are
/// named for a word that was typed, keep only those.
fn relevant(skills: Vec<Value>, q: &str) -> Vec<Value> {
    let words: Vec<String> = q.split_whitespace().filter(|w| w.chars().count() > 1).map(|w| w.chars().take(5).collect()).collect();
    let named = |s: &Value| {
        let name = s.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_lowercase();
        words.iter().any(|w| name.contains(w.as_str()))
    };
    let picked: Vec<Value> = if skills.iter().filter(|s| named(s)).count() >= 3 {
        skills.into_iter().filter(|s| named(s)).collect()
    } else {
        skills
    };
    picked.into_iter().take(SEARCH_SHOWN).collect()
}

/// Search answers carry no descriptions, so fetch each skill (a few at a time;
/// the downloads are cached, which also makes its page open at once) and add
/// the first sentence of what it says it does. A skill that can't be read
/// keeps no description and the card says where it's from.
async fn with_descriptions(skills: Vec<Value>) -> Vec<Value> {
    use futures_util::stream::{self, StreamExt};
    stream::iter(skills)
        .map(|mut s| async move {
            let id = s.get("id").and_then(|i| i.as_str()).unwrap_or_default().to_string();
            let fetched = tokio::time::timeout(Duration::from_secs(8), download(&id)).await;
            if let Ok(Ok(v)) = fetched {
                if let Ok(c) = check(&id, &v) {
                    s["description"] = json!(first_sentence(&c.description));
                    s["name"] = json!(c.name);
                }
            }
            s
        })
        .buffered(6)
        .collect()
        .await
}

/// The opening sentence of a description, for a two-line card.
fn first_sentence(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let end = text
        .char_indices()
        .find(|&(i, c)| matches!(c, '.' | '!' | '?') && text[i + c.len_utf8()..].starts_with(' '))
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(text.len());
    let first = &text[..end];
    if first.chars().count() <= 160 {
        first.to_string()
    } else {
        format!("{}…", first.chars().take(157).collect::<String>().trim_end())
    }
}

/// Every file of one skill, as skills.sh serves it.
async fn download(id: &str) -> Result<Value, String> {
    if !valid_id(id) {
        return Err("skill_id_invalid".into());
    }
    if let Some(v) = cached(&DOWNLOAD_CACHE, id, DOWNLOAD_TTL) {
        return Ok(v);
    }
    let resp = client()
        .get(format!("{BASE}/api/download/{id}"))
        .send()
        .await
        .map_err(|_| "skills_unreachable".to_string())?;
    if resp.status().as_u16() == 404 {
        return Err("skill_not_found".into());
    }
    if !resp.status().is_success() {
        return Err(format!("skills_download_failed_{}", resp.status().as_u16()));
    }
    let v: Value = resp.json().await.map_err(|_| "skills_invalid_response".to_string())?;
    remember(&DOWNLOAD_CACHE, id, &v);
    Ok(v)
}

/// A downloaded skill, checked: a SKILL.md at its root with a usable name and
/// description, safe relative paths, and a sensible size.
struct Checked {
    name: String,
    description: String,
    license: Option<String>,
    body: String,
    files: Vec<(String, String)>,
    hash: String,
}

fn safe_path(p: &str) -> bool {
    !p.is_empty()
        && !p.contains('\\')
        && !p.contains('\0')
        && Path::new(p).components().all(|c| matches!(c, Component::Normal(_)))
}

fn check(id: &str, v: &Value) -> Result<Checked, String> {
    let files: Vec<(String, String)> = v
        .get("files")
        .and_then(|f| f.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|f| Some((f.get("path")?.as_str()?.to_string(), f.get("contents")?.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("skill_files_invalid".into());
    }
    if files.iter().map(|(_, c)| c.len()).sum::<usize>() > MAX_TOTAL_BYTES {
        return Err("skill_too_large".into());
    }
    if let Some((bad, _)) = files.iter().find(|(p, _)| !safe_path(p)) {
        tracing::warn!("skills.sh {id}: unsafe path {bad:?}");
        return Err("skill_files_invalid".into());
    }
    let skill_md = files.iter().find(|(p, _)| p == "SKILL.md").map(|(_, c)| c.as_str()).ok_or("skill_md_missing")?;
    let fm = parse_frontmatter(skill_md).map_err(|_| "skill_md_invalid".to_string())?;
    let folder = id.rsplit('/').next().unwrap_or_default();
    let given = fm.get("name").map(str::trim).filter(|n| !n.is_empty()).unwrap_or(folder);
    // Some publishers write a title ("Invoice Automation") where the format
    // wants a folder-style name. Use the skill's folder name instead; install
    // writes it back so zWork finds the skill under the folder it lands in.
    let renamed = !valid_name(given);
    let name = if renamed { folder } else { given }.to_string();
    if !valid_name(&name) {
        return Err("skill_name_invalid".into());
    }
    let mut description = fm.get("description").map(str::trim).unwrap_or_default().to_string();
    // Some published skills carry a placeholder description (`">"`), which
    // would leave the agent unable to tell when to use them. Fall back to the
    // first paragraph of the instructions; install writes it back.
    let repaired = !description.chars().any(char::is_alphabetic);
    if repaired {
        description = first_paragraph(&fm.body);
    }
    if description.is_empty() {
        return Err("skill_md_invalid".into());
    }
    let license = fm.get("license").map(|l| tidy_license(l)).filter(|l| !l.is_empty()).or_else(|| {
        files
            .iter()
            .any(|(p, _)| {
                let p = p.to_ascii_uppercase();
                p.starts_with("LICENSE") || p.starts_with("LICENCE")
            })
            .then(|| "See the licence file included with this skill".to_string())
    });
    let mut files = files;
    if let Some((_, md)) = files.iter_mut().find(|(p, _)| p == "SKILL.md") {
        if repaired {
            *md = with_field(md, "description", &description);
        }
        if renamed {
            *md = with_field(md, "name", &name);
        }
    }
    Ok(Checked {
        name,
        description,
        license,
        body: fm.body,
        files,
        hash: v.get("hash").and_then(|h| h.as_str()).unwrap_or_default().to_string(),
    })
}

/// `SPDX-License-Identifier: Apache-2.0` and similar boilerplate, cut down
/// to the licence's name.
fn tidy_license(raw: &str) -> String {
    let raw = raw.trim().trim_matches('"').trim();
    if let Some(i) = raw.find("SPDX-License-Identifier:") {
        let rest = &raw[i + "SPDX-License-Identifier:".len()..];
        let id: String = rest.trim().chars().take_while(|c| !c.is_whitespace()).collect();
        return id.trim_end_matches(['.', ',', ';']).to_string();
    }
    let raw = raw.strip_suffix(" license").or_else(|| raw.strip_suffix(" License")).unwrap_or(raw);
    if raw.chars().count() > 60 {
        return "See the licence file included with this skill".to_string();
    }
    raw.to_string()
}

/// The first prose paragraph of the instructions, skipping headings.
fn first_paragraph(body: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in body.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') || line.starts_with("```") || line.starts_with('|') {
            if !out.is_empty() {
                break;
            }
            continue;
        }
        out.push(line.trim_start_matches(['-', '*', '>', ' ']));
    }
    let text = out.join(" ");
    let mut short: String = text.chars().take(300).collect();
    if text.chars().count() > 300 {
        short.push('…');
    }
    short
}

/// SKILL.md with its frontmatter `description` replaced.
fn with_field(md: &str, key: &str, value: &str) -> String {
    let quoted = serde_json::to_string(value).unwrap_or_default();
    let prefix = format!("{key}:");
    let mut in_front = false;
    let mut done = false;
    let mut lines: Vec<String> = Vec::new();
    for (i, line) in md.lines().enumerate() {
        if line.trim() == "---" {
            in_front = i == 0;
        }
        if in_front && !done && line.starts_with(&prefix) {
            lines.push(format!("{key}: {quoted}"));
            done = true;
            continue;
        }
        lines.push(line.to_string());
    }
    lines.join("\n") + "\n"
}

/// Files a computer would run rather than read.
fn is_script(path: &str) -> bool {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "py" | "sh" | "bash" | "zsh" | "js" | "mjs" | "cjs" | "ts" | "rb" | "pl" | "ps1" | "bat" | "cmd" | "exe" | "go" | "rs")
}

fn user_skills_dir() -> PathBuf {
    crate::paths::home_dir().join("skills")
}

/// One skill's page: what it says it does, its instructions, its files, and
/// whether it's already here.
pub async fn detail(id: &str) -> Result<Value, String> {
    let v = download(id).await?;
    let c = check(id, &v)?;
    let installed = crate::skills::list_skills().into_iter().find(|s| s.name == c.name);
    let preview: String = c.body.chars().take(6000).collect();
    Ok(json!({
        "id": id,
        "name": c.name,
        "description": c.description,
        "license": c.license,
        "source": id.rsplitn(2, '/').nth(1).unwrap_or(""),
        "url": format!("{BASE}/{id}"),
        "instructions": preview,
        "truncated": c.body.chars().count() > 6000,
        "files": c.files.iter().map(|(p, _)| p).collect::<Vec<_>>(),
        "scripts": c.files.iter().filter(|(p, _)| is_script(p)).count(),
        "installed": installed.as_ref().map(|s| json!({ "source": s.source, "from_store": store_id(&s.path).is_some() })),
    }))
}

/// Where an installed skill came from, if the storefront added it.
pub fn store_id(skill_md: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(skill_md.parent()?.join(SOURCE_FILE)).ok()?;
    serde_json::from_str::<Value>(&raw).ok()?.get("id")?.as_str().map(str::to_string)
}

/// Add a skill from skills.sh to the user's zWork skills folder. Re-adding
/// one the storefront added replaces it; anything else with the same name
/// is left alone.
pub async fn install(id: &str) -> Result<Value, String> {
    let v = download(id).await?;
    let c = check(id, &v)?;
    if let Some(existing) = crate::skills::list_skills().into_iter().find(|s| s.name == c.name) {
        if existing.source != "user" || store_id(&existing.path).is_none() {
            return Err("skill_name_taken".into());
        }
    }
    let root = user_skills_dir();
    let dest = root.join(&c.name);
    if dest.exists() && !dest.join(SOURCE_FILE).exists() {
        return Err("skill_name_taken".into());
    }
    // Write into a staging folder first so a failure never leaves half a skill.
    let staging = root.join(format!(".adding-{}", c.name));
    let _ = std::fs::remove_dir_all(&staging);
    let write = || -> std::io::Result<()> {
        for (path, contents) in &c.files {
            let target = staging.join(path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(target, contents)?;
        }
        let note = json!({
            "id": id,
            "url": format!("{BASE}/{id}"),
            "hash": c.hash,
            "license": c.license,
            "added_at": chrono::Utc::now().to_rfc3339(),
        });
        std::fs::write(staging.join(SOURCE_FILE), serde_json::to_vec_pretty(&note).unwrap_or_default())?;
        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }
        std::fs::rename(&staging, &dest)
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_dir_all(&staging);
        tracing::warn!("adding skill {id} failed: {e}");
        return Err("skill_write_failed".into());
    }
    Ok(json!({ "ok": true, "name": c.name, "description": c.description }))
}

/// Remove a skill the storefront added. Skills the user wrote or copied in
/// by hand, and ones from other apps, are never touched.
pub fn remove(name: &str) -> Result<Value, String> {
    if !valid_name(name) {
        return Err("skill_name_invalid".into());
    }
    let dir = user_skills_dir().join(name);
    if !dir.join(SOURCE_FILE).exists() {
        return Err("skill_not_removable".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|_| "skill_remove_failed".to_string())?;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(files: &[(&str, &str)]) -> Value {
        json!({ "files": files.iter().map(|(p, c)| json!({ "path": p, "contents": c })).collect::<Vec<_>>(), "hash": "h" })
    }

    #[test]
    fn ids_must_be_three_plain_parts() {
        assert!(valid_id("anthropics/skills/pdf"));
        assert!(valid_id("github/awesome-copilot/meeting-minutes"));
        assert!(!valid_id("open.feishu.cn/lark-drive"));
        assert!(!valid_id("a/../b"));
        assert!(!valid_id("a/b/c?x=1"));
    }

    #[test]
    fn check_rejects_escaping_paths_and_missing_skill_md() {
        let md = "---\nname: notes\ndescription: Take notes\n---\nDo it.";
        assert!(check("a/b/notes", &skill(&[("SKILL.md", md)])).is_ok());
        assert!(check("a/b/notes", &skill(&[("SKILL.md", md), ("../evil.sh", "x")])).is_err());
        assert!(check("a/b/notes", &skill(&[("SKILL.md", md), ("/etc/x", "x")])).is_err());
        assert!(check("a/b/notes", &skill(&[("notes.md", md)])).is_err());
    }

    #[test]
    fn check_reads_folded_descriptions_and_licence_files() {
        let md = "---\nname: invoice-chase\ndescription: >\n  Chase overdue\n  invoices.\n---\nBody";
        let c = check("x/y/invoice-chase", &skill(&[("SKILL.md", md), ("LICENSE.txt", "MIT")])).unwrap();
        assert_eq!(c.description, "Chase overdue invoices.");
        assert!(c.license.is_some());
        assert!(check("x/y/Z_", &skill(&[("SKILL.md", "---\nname: Bad Name\ndescription: d\n---\n")])).is_err());
    }

    #[test]
    fn placeholder_descriptions_are_repaired_from_the_body() {
        let md = "---\nname: meeting-notes\ndescription: \">\"\nlicense: MIT\n---\n# Meeting Notes\n\n## Overview\n\nTurns raw notes into minutes.\nWith action items.\n\n## Use";
        let c = check("a/b/meeting-notes", &skill(&[("SKILL.md", md)])).unwrap();
        assert_eq!(c.description, "Turns raw notes into minutes. With action items.");
        let written = &c.files[0].1;
        assert!(written.contains("description: \"Turns raw notes into minutes. With action items.\""));
        let reparsed = parse_frontmatter(written).unwrap();
        assert_eq!(reparsed.get("description"), Some("Turns raw notes into minutes. With action items."));
    }

    #[test]
    fn title_style_names_fall_back_to_the_folder() {
        let md = "---\nname: Invoice Automation\ndescription: Automate invoices\n---\nBody";
        let c = check("a/b/invoice-automation", &skill(&[("SKILL.md", md)])).unwrap();
        assert_eq!(c.name, "invoice-automation");
        let reparsed = parse_frontmatter(&c.files[0].1).unwrap();
        assert_eq!(reparsed.get("name"), Some("invoice-automation"));
        assert_eq!(reparsed.get("description"), Some("Automate invoices"));
    }

    #[test]
    fn search_keeps_skills_named_for_the_query() {
        let r = |n: &str| json!({ "id": format!("a/b/{n}"), "name": n });
        let all = vec![r("vercel-deploy"), r("invoice-chase"), r("invoicing"), r("convex"), r("invoice-organizer")];
        let names: Vec<_> = relevant(all.clone(), "invoices").iter().map(|s| s["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["invoice-chase", "invoicing", "invoice-organizer"]);
        assert_eq!(relevant(all, "receipts").len(), 5);
    }

    #[test]
    fn first_sentence_is_short_and_whole() {
        assert_eq!(first_sentence("Writes minutes.  Then more. "), "Writes minutes.");
        assert_eq!(first_sentence("Use v1.2 of the form. Next"), "Use v1.2 of the form.");
        assert!(first_sentence(&"word ".repeat(80)).ends_with('…'));
    }

    #[test]
    fn licences_are_cut_to_their_name() {
        assert_eq!(tidy_license("Copyright 2026 Anthropic, PBC · SPDX-License-Identifier: Apache-2.0. Complete terms in LICENSE."), "Apache-2.0");
        assert_eq!(tidy_license("MIT license"), "MIT");
        assert_eq!(tidy_license("\"MIT\""), "MIT");
    }

    #[test]
    fn shelf_ids_are_downloadable_shapes() {
        for (id, _, _) in OFFICE_SHELF {
            assert!(valid_id(id), "{id}");
        }
    }
}
