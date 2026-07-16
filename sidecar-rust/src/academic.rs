use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct PaperResult {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<u32>,
    pub venue: String,
    pub doi: Option<String>,
    pub url: String,
    pub pdf_url: Option<String>,
    pub citation_count: u32,
    pub source: String,
    pub snippet: String,
    pub journal: String,
}

// ═══════════════════════════════════════════════════════════════════════════════
// XML String Scanner (arXiv)
// ═══════════════════════════════════════════════════════════════════════════════
fn extract_tag(content: &str, tag: &str) -> String {
    let start_tag = format!("<{}>", tag);
    let end_tag = format!("</{}>", tag);
    if let Some(start_pos) = content.find(&start_tag) {
        if let Some(end_pos) = content[start_pos..].find(&end_tag) {
            return content[start_pos + start_tag.len()..start_pos + end_pos].trim().to_string();
        }
    }
    String::new()
}

fn extract_all_tags(content: &str, tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let start_tag = format!("<{}>", tag);
    let end_tag = format!("</{}>", tag);
    let mut current = content;
    while let Some(start_pos) = current.find(&start_tag) {
        if let Some(end_pos) = current[start_pos..].find(&end_tag) {
            let item = current[start_pos + start_tag.len()..start_pos + end_pos].trim().to_string();
            out.push(item);
            current = &current[start_pos + end_pos + end_tag.len()..];
        } else {
            break;
        }
    }
    out
}

// ═══════════════════════════════════════════════════════════════════════════════
// Search Clients
// ═══════════════════════════════════════════════════════════════════════════════
async fn search_arxiv(client: &reqwest::Client, query: &str, limit: usize) -> Vec<PaperResult> {
    let url = "https://export.arxiv.org/api/query";
    let params = [
        ("search_query", format!("all:{}", query)),
        ("start", "0".to_string()),
        ("max_results", limit.to_string()),
        ("sortBy", "relevance".to_string()),
    ];
    let resp = match client.get(url).query(&params).send().await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let text = match resp.text().await {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    
    let mut results = Vec::new();
    let entries = extract_all_tags(&text, "entry");
    for entry in entries {
        let raw_title = extract_tag(&entry, "title");
        let title = raw_title.replace('\n', " ").trim().to_string();
        let abstract_txt = extract_tag(&entry, "summary").replace('\n', " ").trim().to_string();
        
        let mut authors = Vec::new();
        let author_blocks = extract_all_tags(&entry, "author");
        for auth_b in author_blocks {
            let name = extract_tag(&auth_b, "name");
            if !name.is_empty() {
                authors.push(name);
            }
        }
        
        let raw_id = extract_tag(&entry, "id");
        let arxiv_id = raw_id.split("/abs/").last().unwrap_or("").to_string();
        let year = extract_tag(&entry, "published")
            .split('-')
            .next()
            .and_then(|y| y.parse::<u32>().ok());
            
        results.push(PaperResult {
            title,
            authors,
            year,
            venue: "arXiv".to_string(),
            doi: None,
            url: if arxiv_id.is_empty() { raw_id } else { format!("https://arxiv.org/abs/{}", arxiv_id) },
            pdf_url: if arxiv_id.is_empty() { None } else { Some(format!("https://arxiv.org/pdf/{}", arxiv_id)) },
            citation_count: 0,
            source: "arxiv".to_string(),
            snippet: clip(&abstract_txt, 300),
            journal: String::new(),
        });
    }
    results
}

async fn search_openalex(client: &reqwest::Client, query: &str, limit: usize) -> Vec<PaperResult> {
    let url = "https://api.openalex.org/works";
    let params = [
        ("filter", format!("title_and_abstract.search:{}", query)),
        ("per-page", limit.to_string()),
        ("sort", "relevance_score:desc".to_string()),
        ("select", "id,title,abstract_inverted_index,authorships,publication_year,cited_by_count,doi,primary_location,open_access".to_string()),
    ];
    let resp = match client.get(url).query(&params).send().await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let data: Value = match resp.json().await {
        Ok(json) => json,
        Err(_) => return Vec::new(),
    };
    
    let mut results = Vec::new();
    if let Some(arr) = data.get("results").and_then(|v| v.as_array()) {
        for work in arr {
            let title = work.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if title.is_empty() {
                continue;
            }
            
            // Reconstruct abstract from inverted index
            let abstract_txt = reconstruct_abstract(work.get("abstract_inverted_index"));
            
            let mut authors = Vec::new();
            if let Some(auth_arr) = work.get("authorships").and_then(|v| v.as_array()) {
                for a in auth_arr {
                    if let Some(name) = a.get("author").and_then(|v| v.get("display_name")).and_then(|v| v.as_str()) {
                        authors.push(name.to_string());
                    }
                }
            }
            
            let year = work.get("publication_year").and_then(|v| v.as_u64()).map(|y| y as u32);
            let cited = work.get("cited_by_count").and_then(|v| v.as_u64()).map(|c| c as u32).unwrap_or(0);
            let doi = work.get("doi").and_then(|v| v.as_str()).map(|d| d.replace("https://doi.org/", "").trim().to_string());
            
            let primary_loc = work.get("primary_location");
            let venue = primary_loc
                .and_then(|v| v.get("source"))
                .and_then(|v| v.get("display_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
                
            let open_access_pdf = work.get("open_access")
                .and_then(|v| v.get("oa_url"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
                
            results.push(PaperResult {
                title: title.clone(),
                authors,
                year,
                venue: venue.clone(),
                doi: doi.clone(),
                url: doi.map_or(String::new(), |d| format!("https://doi.org/{}", d)),
                pdf_url: open_access_pdf,
                citation_count: cited,
                source: "openalex".to_string(),
                snippet: clip(&abstract_txt, 300),
                journal: venue,
            });
        }
    }
    results
}

fn reconstruct_abstract(inverted: Option<&Value>) -> String {
    let inverted = match inverted {
        Some(Value::Object(map)) => map,
        _ => return String::new(),
    };
    let mut positions = Vec::new();
    for (word, pos_val) in inverted {
        if let Some(arr) = pos_val.as_array() {
            for p in arr {
                if let Some(idx) = p.as_u64() {
                    positions.push((idx, word.clone()));
                }
            }
        }
    }
    positions.sort_by_key(|x| x.0);
    positions.into_iter().map(|(_, w)| w).collect::<Vec<_>>().join(" ")
}

fn clip(s: &str, n: usize) -> String {
    let clean = s.replace('\n', " ").trim().to_string();
    if clean.len() <= n {
        clean
    } else {
        format!("{}…", &clean[..n - 1])
    }
}

/// Semantic Scholar — strong citation counts + open-access PDF links for
/// CS/ML/biomedical papers. The primary ranking signal (citation_count) used
/// to come almost entirely from here in the Python backend.
async fn search_semantic_scholar(client: &reqwest::Client, query: &str, limit: usize) -> Vec<PaperResult> {
    let url = "https://api.semanticscholar.org/graph/v1/paper/search";
    let fields = "title,authors,year,venue,externalIds,abstract,openAccessPdf,citationCount,journal";
    let params = [
        ("query", query.to_string()),
        ("limit", limit.to_string()),
        ("fields", fields.to_string()),
    ];
    let resp = match client.get(url).query(&params).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };
    let v: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let items = match v.get("data").and_then(|d| d.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut results = Vec::new();
    for it in items {
        let title = it.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if title.is_empty() {
            continue;
        }
        let authors = it.get("authors")
            .and_then(|a| a.as_array())
            .map(|arr| arr.iter()
                .filter_map(|au| au.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .collect())
            .unwrap_or_default();
        let year = it.get("year").and_then(|y| y.as_u64()).map(|y| y as u32);
        let venue = it.get("venue").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let journal = it.get("journal").and_then(|j| j.as_str()).unwrap_or("").to_string();
        let citation_count = it.get("citationCount").and_then(|c| c.as_u64()).unwrap_or(0) as u32;
        let doi = it.get("externalIds")
            .and_then(|e| e.get("DOI"))
            .and_then(|d| d.as_str())
            .map(|s| s.to_string());
        let url = doi.as_ref()
            .map(|d| format!("https://doi.org/{}", d))
            .unwrap_or_default();
        let pdf_url = it.get("openAccessPdf")
            .and_then(|o| o.get("url"))
            .and_then(|u| u.as_str())
            .map(|s| s.to_string());
        let abstract_txt = it.get("abstract").and_then(|a| a.as_str()).unwrap_or("").to_string();
        results.push(PaperResult {
            title, authors, year, venue, doi, url, pdf_url, citation_count,
            source: "semanticscholar".to_string(),
            snippet: clip(&abstract_txt, 300),
            journal,
        });
    }
    results
}

/// CrossRef — broad journal-metadata coverage (medicine, social science, econ)
/// with rich citation counts. Second of the two citation-bearing sources.
async fn search_crossref(client: &reqwest::Client, query: &str, limit: usize) -> Vec<PaperResult> {
    let url = "https://api.crossref.org/works";
    let params = [
        ("query", query.to_string()),
        ("rows", limit.to_string()),
    ];
    let resp = match client.get(url).query(&params).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };
    let v: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let items = v.get("message")
        .and_then(|m| m.get("items"))
        .and_then(|i| i.as_array())
        .cloned()
        .unwrap_or_default();
    let mut results = Vec::new();
    for it in items {
        let title = it.get("title")
            .and_then(|t| t.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        if title.is_empty() {
            continue;
        }
        let authors = it.get("author")
            .and_then(|a| a.as_array())
            .map(|arr| arr.iter().filter_map(|au| {
                let given = au.get("given").and_then(|g| g.as_str()).unwrap_or("");
                let family = au.get("family").and_then(|f| f.as_str()).unwrap_or("");
                if family.is_empty() { None } else { Some(format!("{} {}", given, family).trim().to_string()) }
            }).collect())
            .unwrap_or_default();
        let year = it.get("published-print")
            .or_else(|| it.get("published-online"))
            .or_else(|| it.get("issued"))
            .and_then(|d| d.get("date-parts"))
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
            .and_then(|y| y.as_u64())
            .map(|y| y as u32);
        let venue = it.get("container-title")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let doi = it.get("DOI").and_then(|d| d.as_str()).map(|s| s.to_string());
        let url = doi.as_ref().map(|d| format!("https://doi.org/{}", d)).unwrap_or_default();
        let citation_count = it.get("is-referenced-by-count")
            .and_then(|c| c.as_u64())
            .unwrap_or(0) as u32;
        results.push(PaperResult {
            title, authors, year, doi, url,
            pdf_url: None, citation_count,
            source: "crossref".to_string(),
            snippet: String::new(),
            journal: venue.clone(),
            venue,
        });
    }
    results
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public Search Entry Point
// ═══════════════════════════════════════════════════════════════════════════════
pub async fn search_academic_literature(
    query: &str,
    max_results: usize,
    year_min: Option<u32>,
    year_max: Option<u32>,
) -> Vec<PaperResult> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    let limit = max_results.max(10);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_default();

    let query_str = query.trim().to_string();

    // Search all four sources in parallel. Semantic Scholar + CrossRef carry
    // the citation counts that drive ranking; arXiv + OpenAlex carry PDFs/abstracts.
    let (arxiv_res, openalex_res, ss_res, crossref_res) = tokio::join!(
        search_arxiv(&client, &query_str, limit),
        search_openalex(&client, &query_str, limit),
        search_semantic_scholar(&client, &query_str, limit),
        search_crossref(&client, &query_str, limit),
    );

    let mut all_papers = Vec::new();
    all_papers.extend(arxiv_res);
    all_papers.extend(openalex_res);
    all_papers.extend(ss_res);
    all_papers.extend(crossref_res);

    // Deduplicate by DOI (preferred) or normalized title. Normalization strips
    // ALL non-alphanumerics (not just whitespace) and truncates to 60 chars so
    // punctuation/case variants collapse — matching the Python dedup.
    let mut seen_doi = std::collections::HashSet::new();
    let mut seen_title = std::collections::HashSet::new();
    let mut deduplicated = Vec::new();

    for p in all_papers {
        let title_norm: String = p.title.to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .take(60)
            .collect();
        if let Some(ref d) = p.doi {
            if seen_doi.contains(d) {
                // Merge: fill missing fields on the existing entry where possible.
                continue;
            }
            seen_doi.insert(d.clone());
        }
        if seen_title.contains(&title_norm) {
            continue;
        }
        seen_title.insert(title_norm);

        // Year filter — keep papers with unknown year (Python behavior) so
        // arXiv preprints with unparseable dates aren't silently excluded.
        if let Some(ymin) = year_min {
            if let Some(y) = p.year {
                if y < ymin {
                    continue;
                }
            }
        }
        if let Some(ymax) = year_max {
            if let Some(y) = p.year {
                if y > ymax {
                    continue;
                }
            }
        }

        deduplicated.push(p);
    }

    // Composite ranking: citation weight + abstract + open-access PDF + recency.
    // Mirrors the Python `_rank` scoring so citation-rich results surface first
    // while still rewarding completeness and freshness.
    let now_year = chrono::Utc::now().format("%Y").to_string().parse::<u32>().unwrap_or(2026);
    let score = |p: &PaperResult| {
        let citation = (p.citation_count as f64).ln_1p() * 2.0;
        let abstract_bonus = if !p.snippet.is_empty() { 3.0 } else { 0.0 };
        let pdf_bonus = if p.pdf_url.is_some() { 4.0 } else { 0.0 };
        let recency = p.year
            .map(|y| (now_year.saturating_sub(y)).min(10) as f64 * 0.2)
            .unwrap_or(0.0);
        citation + abstract_bonus + pdf_bonus + recency
    };
    deduplicated.sort_by(|a, b| {
        score(b).partial_cmp(&score(a)).unwrap_or(std::cmp::Ordering::Equal)
    });

    deduplicated.into_iter().take(max_results).collect()
}

// ═══════════════════════════════════════════════════════════════════════════════
// Citation Formatting Helpers
// ═══════════════════════════════════════════════════════════════════════════════
pub fn format_citation(paper: &Value, style: &str) -> String {
    let title = paper.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        return String::new();
    }
    
    let mut authors = Vec::new();
    if let Some(arr) = paper.get("authors").and_then(|v| v.as_array()) {
        for a in arr {
            if let Some(name) = a.as_str() {
                authors.push(name.to_string());
            }
        }
    }
    
    let year = paper.get("year").and_then(|v| v.as_u64()).map(|y| y as u32);
    let journal = paper.get("journal").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let doi = paper.get("doi").and_then(|v| v.as_str()).map(|s| s.to_string());
    
    match style.to_lowercase().as_str() {
        "mla" => format_mla(&authors, year, &title, &journal, doi.as_deref()),
        "chicago" => format_chicago(&authors, year, &title, &journal, doi.as_deref()),
        _ => format_apa(&authors, year, &title, &journal, doi.as_deref()),
    }
}

fn format_authors_apa(authors: &[String]) -> String {
    if authors.is_empty() {
        return String::new();
    }
    let format_one = |a: &str| {
        let parts: Vec<&str> = a.split_whitespace().collect();
        if parts.len() >= 2 {
            let initials: String = parts[..parts.len() - 1].iter().map(|p| format!("{}. ", &p[..1])).collect();
            format!("{}, {}", parts.last().unwrap(), initials.trim())
        } else {
            a.to_string()
        }
    };
    
    if authors.len() == 1 {
        return format_one(&authors[0]);
    }
    if authors.len() <= 7 {
        let mut formatted: Vec<String> = authors.iter().map(|a| format_one(a)).collect();
        let last = formatted.pop().unwrap();
        return format!("{}, & {}", formatted.join(", "), last);
    }
    let formatted: Vec<String> = authors.iter().take(6).map(|a| format_one(a)).collect();
    let last = format_one(authors.last().unwrap());
    format!("{}, ... {}", formatted.join(", "), last)
}

fn format_authors_mla(authors: &[String]) -> String {
    if authors.is_empty() {
        return String::new();
    }
    let format_first = |a: &str| {
        let parts: Vec<&str> = a.split_whitespace().collect();
        if parts.len() >= 2 {
            format!("{}, {}", parts.last().unwrap(), parts[..parts.len() - 1].join(" "))
        } else {
            a.to_string()
        }
    };
    
    if authors.len() == 1 {
        return format_first(&authors[0]);
    }
    if authors.len() == 2 {
        let a0 = format_first(&authors[0]);
        let a1 = &authors[1]; // In MLA, second author is Name Surname
        return format!("{}, and {}", a0, a1);
    }
    format!("{}, et al.", format_first(&authors[0]))
}

fn format_apa(authors: &[String], year: Option<u32>, title: &str, journal: &str, doi: Option<&str>) -> String {
    let auths_txt = format_authors_apa(authors);
    let year_txt = year.map_or("(n.d.).".to_string(), |y| format!("({}).", y));
    let mut citation = format!("{} {} {}", auths_txt, year_txt, title);
    if !citation.ends_with('.') {
        citation.push('.');
    }
    if !journal.is_empty() {
        citation = format!("{} *{}.*", citation, journal);
    }
    if let Some(d) = doi {
        citation = format!("{} https://doi.org/{}", citation, d);
    }
    citation
}

fn format_mla(authors: &[String], year: Option<u32>, title: &str, journal: &str, doi: Option<&str>) -> String {
    let auths_txt = format_authors_mla(authors);
    let mut citation = auths_txt;
    if !citation.is_empty() && !citation.ends_with('.') {
        citation.push('.');
    }
    citation = format!("{} \"{}\".", citation, title);
    if !journal.is_empty() {
        citation = format!("{} *{},*", citation, journal);
    }
    if let Some(y) = year {
        citation = format!("{} {},", citation, y);
    }
    if let Some(d) = doi {
        citation = format!("{} doi:{}", citation, d);
    }
    if citation.ends_with(',') {
        citation.pop();
        citation.push('.');
    }
    citation
}

fn format_chicago(authors: &[String], year: Option<u32>, title: &str, journal: &str, doi: Option<&str>) -> String {
    // Chicago author rules: 1 → full name; 2–3 → "A, B, and C"; 4+ → "A et al."
    let author_str = if authors.is_empty() {
        "Anonymous".to_string()
    } else if authors.len() == 1 {
        authors[0].clone()
    } else if authors.len() <= 3 {
        format!("{}, and {}", authors[..authors.len() - 1].join(", "), authors.last().unwrap())
    } else {
        format!("{} et al.", authors[0])
    };
    let mut citation = format!("{}. \"{}.\"", author_str, title);
    if !journal.is_empty() {
        citation.push_str(&format!(" *{}*", journal));
    }
    if let Some(y) = year {
        citation.push_str(&format!(" ({})", y));
    }
    if let Some(d) = doi {
        citation.push_str(&format!(". https://doi.org/{}", d));
    }
    citation.push('.');
    citation
}

// ═══════════════════════════════════════════════════════════════════════════════
// Autonomous Paper Writing Pipeline & Peer Review (AutoResearchClaw-inspired)
// ═══════════════════════════════════════════════════════════════════════════════

async fn call_llm(system: &str, prompt: &str) -> Result<String, String> {
    let s = crate::settings::load();
    let model_id = if !s.default_model.is_empty() { &s.default_model } else { "deepseek-v4-flash" };

    let (api_key, base_url, shape, real_model) = if let Some(m) = s.custom_models.iter().find(|m| m.id == model_id) {
        let real = if m.model_id.is_empty() { "deepseek-v4-flash".to_string() } else { m.model_id.clone() };
        if let Some(cred) = crate::server::resolve(&m.credential, &s, &m.base_url_override) {
            (cred.api_key, cred.base_url, m.shape.clone(), real)
        } else {
            return Err("No credentials configured for model".to_string());
        }
    } else {
        match crate::server::resolve("zwork_router", &s, "") {
            Some(cred) => (cred.api_key, cred.base_url, "anthropic".to_string(), "deepseek-v4-flash".to_string()),
            None => {
                // Try fallback to anthropic or openai directly from env
                if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
                    (key, "https://api.anthropic.com".to_string(), "anthropic".to_string(), "claude-3-5-sonnet-latest".to_string())
                } else if let Ok(key) = std::env::var("OPENAI_API_KEY") {
                    (key, "https://api.openai.com/v1".to_string(), "openai".to_string(), "gpt-4o-mini".to_string())
                } else {
                    return Err("No model credentials available. Please set ANTHROPIC_API_KEY or OPENAI_API_KEY in your settings/environment.".to_string());
                }
            }
        }
    };

    let endpoint = if shape == "anthropic" {
        format!("{}/v1/messages", base_url)
    } else {
        format!("{}/chat/completions", base_url)
    };

    let messages = if shape == "anthropic" {
        serde_json::json!([
            {"role": "user", "content": prompt}
        ])
    } else {
        serde_json::json!([
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ])
    };

    let req_body = if shape == "anthropic" {
        serde_json::json!({
            "model": real_model,
            "system": system,
            "messages": messages,
            "max_tokens": 4000
        })
    } else {
        serde_json::json!({
            "model": real_model,
            "messages": messages,
            "max_tokens": 4000
        })
    };

    let client = reqwest::Client::new();
    let mut req = client.post(&endpoint).json(&req_body);
    if shape == "anthropic" {
        req = req.header("x-api-key", &api_key).header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("authorization", format!("Bearer {}", api_key));
    }

    match req.send().await {
        Ok(resp) => {
            if !resp.status().is_success() {
                let status = resp.status();
                let txt = resp.text().await.unwrap_or_default();
                return Err(format!("LLM request failed (status={}): {}", status, txt));
            }
            let text = resp.text().await.unwrap_or_default();
            if let Ok(val) = serde_json::from_str::<Value>(&text) {
                let content = if shape == "anthropic" {
                    val.get("content").and_then(|c| c.get(0)).and_then(|c| c.get("text")).and_then(|t| t.as_str()).unwrap_or(&text).to_string()
                } else {
                    val.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|t| t.as_str()).unwrap_or(&text).to_string()
                };
                Ok(content)
            } else {
                Err("Failed to parse LLM response".to_string())
            }
        }
        Err(e) => Err(format!("LLM request failed: {}", e)),
    }
}

pub async fn write_research_paper(
    topic: &str,
    style: &str,
    word_count: u32,
    tx: &tokio::sync::mpsc::Sender<Value>,
) -> Result<String, String> {
    let activity_id = format!("act_paper_{}", uuid::Uuid::new_v4().simple());
    
    // 1. Search prior art literature
    let _ = tx.send(serde_json::json!({
        "type": "activity",
        "id": &activity_id,
        "label": "Searching literature & validation",
        "done": false
    })).await;
    
    let papers = search_academic_literature(topic, 5, None, None).await;
    
    // Format literature references for prompting
    let mut ref_string = String::new();
    let mut bib_list = Vec::new();
    for (i, p) in papers.iter().enumerate() {
        let p_val = serde_json::to_value(p).unwrap_or(Value::Null);
        let cit = format_citation(&p_val, "apa");
        ref_string.push_str(&format!("{}. {}\n\n", i + 1, cit));
        bib_list.push(cit);
    }
    
    if ref_string.is_empty() {
        ref_string = "No matching reference papers found in academic databases.".to_string();
    }

    // 2. Outline Generation
    let _ = tx.send(serde_json::json!({
        "type": "activity",
        "id": &activity_id,
        "label": "Generating paper outline",
        "done": false
    })).await;
    
    let outline_prompt = format!(
        "We are writing a research paper on the topic: \"{}\".\n\
        The style requested is: \"{}\".\n\
        Here is the relevant literature found:\n\n\
        {}\n\n\
        Draft a detailed paper outline in Markdown format. The outline should contain exactly the following sections:\n\
        1. Abstract\n\
        2. Introduction\n\
        3. Related Work\n\
        4. Methodology\n\
        5. Experiments & Results\n\
        6. Conclusion\n\n\
        For each section, specify 2-3 brief sub-points or key hypotheses we will cover. Return ONLY the Markdown outline.",
        topic, style, ref_string
    );
    
    let outline = call_llm("You are an expert academic paper writer.", &outline_prompt).await?;
    
    // 3. Draft Sections sequentially
    let sections = vec![
        ("Abstract", "Write a concise abstract summarizing the paper, covering background, proposed method, experiments, and results."),
        ("Introduction", "Write the introduction motivating the research, outlining the problem statement, and defining our contributions."),
        ("Related Work", "Write the related work section discussing existing papers from our literature list and explaining how our approach differs."),
        ("Methodology", "Detail our proposed methodology, introducing equations (LaTeX math block style, e.g., $...$ or $$...$$) and architectural details."),
        ("Experiments & Results", "Draft the experiments and results section, describing the hardware setup, hyperparameters, and structured tables showing results comparison."),
        ("Conclusion", "Summarize our contributions, state potential limitations, and identify areas for future work.")
    ];
    
    let mut compiled_paper = format!("# {}\n\n## Outline\n{}\n\n", topic, outline);
    
    for (sec_name, sec_instruction) in sections {
        let _ = tx.send(serde_json::json!({
            "type": "activity",
            "id": &activity_id,
            "label": format!("Drafting section: {}", sec_name),
            "done": false
        })).await;
        
        let draft_prompt = format!(
            "We are writing a research paper on \"{}\" in \"{}\" style.\n\
            Here is our paper outline:\n\n\
            {}\n\n\
            Here is our literature base:\n\n\
            {}\n\n\
            Draft the section: \"{}\".\n\
            Instruction: {}\n\
            Target word count: {} words.\n\n\
            Write the full content for this section. Ground all claims in the literature base (use cite numbers like [1] or [2] matching the literature base). Return ONLY the section text (do not repeat the section header).",
            topic, style, outline, ref_string, sec_name, sec_instruction, word_count
        );
        
        let sec_content = call_llm("You are a professional academic manuscript editor.", &draft_prompt).await?;
        compiled_paper.push_str(&format!("## {}\n\n{}\n\n", sec_name, sec_content));
    }
    
    // 4. Append references
    compiled_paper.push_str("## References\n\n");
    for (i, bib) in bib_list.iter().enumerate() {
        compiled_paper.push_str(&format!("{}. {}\n", i + 1, bib));
    }
    
    // 5. Save paper to workspace output directory
    let _ = tx.send(serde_json::json!({
        "type": "activity",
        "id": &activity_id,
        "label": "Saving paper to workspace output folder",
        "done": false
    })).await;
    
    let filename = format!("research_paper_{}.md", topic.to_lowercase().replace(char::is_whitespace, "_").replace(|c: char| !c.is_alphanumeric() && c != '_', ""));
    let output_dir = crate::paths::workspace_outputs_dir();
    let _ = std::fs::create_dir_all(&output_dir);
    let paper_path = output_dir.join(&filename);
    let _ = std::fs::write(&paper_path, &compiled_paper);
    
    let _ = tx.send(serde_json::json!({
        "type": "activity",
        "id": &activity_id,
        "label": "Paper writing complete",
        "done": true
    })).await;
    
    let path_str = paper_path.to_string_lossy().to_string();
    Ok(format!("Successfully generated research paper at: {}\n\nPreview:\n\n{}", path_str, &compiled_paper[..1000.min(compiled_paper.len())]))
}

/// Deterministic structural review of a paper draft. Mirrors the Python
/// `review_paper` tool: detects section presence, scans for placeholder/template
/// content, and computes a completeness ratio + quality gate — without an LLM
/// call. This catches the "the model wrote `[INSERT ...]` everywhere" failure
/// mode that a subjective LLM review would miss.
pub async fn review_paper(
    paper_content: &str,
    _review_type: &str,
) -> Result<String, String> {
    use regex::Regex;

    // 1. Section detection
    let has = |pat: &str| -> bool {
        Regex::new(&format!("(?i)\\b{}\\b", pat)).map(|r| r.is_match(paper_content)).unwrap_or(false)
    };
    let sections_found = [
        ("Abstract", has("abstract")),
        ("Introduction", has("introduction")),
        ("Methodology/Model", has("(method|methodology|model|proposed method)")),
        ("Experiments/Results", has("(experiments|results|evaluation)")),
        ("Related Work", has("(related work|literature review)")),
        ("Conclusion", has("conclusion")),
        ("References", has("(references|bibliography)")),
    ];
    let sections_found_count = sections_found.iter().filter(|(_, f)| *f).count();
    let completeness_ratio =
        (sections_found_count as f64 / sections_found.len() as f64 * 100.0).round() / 100.0;

    // 2. Placeholder / template scan
    let patterns: &[(&str, &str)] = &[
        ("(?i)template\\s+(abstract|introduction|method|methodology|conclusion|discussion|results|related\\s+work)", "Template section header"),
        ("(?i)\\[INSERT\\s+.*?\\]", "Insert placeholder"),
        ("(?i)\\[TODO\\s*:?\\s*.*?\\]", "TODO placeholder"),
        ("(?i)\\[PLACEHOLDER\\s*:?\\s*.*?\\]", "Explicit placeholder"),
        ("(?i)lorem\\s+ipsum", "Lorem ipsum filler"),
        ("(?i)this\\s+section\\s+will\\s+(describe|discuss|present|outline|explain)", "Future-tense placeholder"),
        ("(?i)add\\s+(your|the)\\s+(content|text|description)\\s+here", "Add content placeholder"),
        ("(?i)replace\\s+this\\s+(text|content|section)", "Replace placeholder"),
    ];
    let compiled: Vec<(Regex, &str)> = patterns.iter()
        .filter_map(|(p, d)| Regex::new(p).ok().map(|r| (r, *d)))
        .collect();

    let mut matches: Vec<(usize, &str, String)> = Vec::new(); // (line, desc, excerpt)
    let mut template_chars: usize = 0;
    let mut total_chars: usize = 0;
    for (i, raw_line) in paper_content.lines().enumerate() {
        let stripped = raw_line.trim();
        if stripped.is_empty() {
            continue;
        }
        total_chars += stripped.len();
        for (re, desc) in &compiled {
            if re.is_match(stripped) {
                let excerpt = stripped.chars().take(100).collect();
                matches.push((i + 1, desc, excerpt));
                template_chars += stripped.len();
                break;
            }
        }
    }
    let template_ratio = if total_chars > 0 { template_chars as f64 / total_chars as f64 } else { 0.0 };
    let template_ratio = (template_ratio * 10000.0).round() / 10000.0;
    let template_count = matches.len();

    // 3. Score
    let word_count = paper_content.split_whitespace().count();
    let mut rigor_score = 5.0_f64;
    // sections_found layout: [Abstract, Intro, Methodology, Experiments, Related Work, Conclusion, References]
    if sections_found[3].1 { rigor_score += 2.0; } // Experiments/Results
    if sections_found[6].1 { rigor_score += 1.0; } // References
    if word_count > 3000 { rigor_score += 1.0; }
    let estimated_quality = (1.0_f64).max(rigor_score - template_ratio * 10.0);
    let passed_gate = template_ratio <= 0.05;

    // 4. Build a markdown report
    let mut report = String::new();
    report.push_str("# Paper Review (structural audit)\n\n");
    report.push_str(&format!("- **Estimated quality score:** {:.1} / 10\n", estimated_quality));
    report.push_str(&format!("- **Passed quality gate:** {} (template ratio {:.1}% ≤ 5%)\n", if passed_gate { "yes" } else { "no" }, template_ratio * 100.0));
    report.push_str(&format!("- **Word count:** {}\n", word_count));
    report.push_str(&format!("- **Sections completeness:** {}% ({}/{})\n", (completeness_ratio * 100.0) as u32, sections_found_count, sections_found.len()));
    report.push_str("\n## Sections found\n");
    for (name, found) in &sections_found {
        report.push_str(&format!("- {}: {}\n", name, if *found { "yes" } else { "missing" }));
    }
    report.push_str(&format!("\n## Template/placeholder content ({} match{})\n", template_count, if template_count == 1 { "" } else { "es" }));
    if template_count == 0 {
        report.push_str("None detected.\n");
    } else {
        for (line, desc, excerpt) in matches.iter().take(10) {
            report.push_str(&format!("- L{} — {} — `{}`\n", line, desc, excerpt));
        }
        if template_count > 10 {
            report.push_str(&format!("- ...and {} more\n", template_count - 10));
        }
    }
    if !passed_gate {
        report.push_str("\n## Recommendation\nThe draft contains significant placeholder/template content. Replace it with real prose before submission.\n");
    } else if completeness_ratio < 0.5 {
        report.push_str("\n## Recommendation\nSeveral expected sections are missing. Consider adding them for a complete paper.\n");
    } else {
        report.push_str("\n## Recommendation\nThe draft is structurally complete with minimal placeholder content. Proceed to a detailed prose review.\n");
    }
    Ok(report)
}

/// Check the novelty of a research topic/hypotheses against the literature.
/// Extracts keywords, searches papers, computes Jaccard similarity per paper,
/// and rates overall novelty. Mirrors the Python `check_novelty` tool.
pub async fn check_novelty(topic: &str, hypotheses: &str) -> Result<String, String> {
    use std::collections::HashSet;

    let stop_words: HashSet<&str> = [
        "a", "an", "the", "and", "or", "but", "in", "on", "of", "for", "to",
        "with", "by", "at", "from", "as", "is", "are", "was", "were", "be",
        "been", "using", "method", "approach", "novel",
    ].iter().copied().collect();

    let get_keywords = |text: &str| -> HashSet<String> {
        text.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.len() >= 3 && !stop_words.contains(*t))
            .map(|t| t.to_string())
            .collect()
    };

    let topic_keywords = get_keywords(topic);
    let hyp_keywords = get_keywords(hypotheses);
    let all_keywords: HashSet<&str> = topic_keywords.iter()
        .chain(hyp_keywords.iter())
        .map(|s| s.as_str())
        .collect();

    // Query from topic, or fall back to top keywords.
    let query = if !topic.trim().is_empty() {
        topic.to_string()
    } else {
        all_keywords.iter().take(5).copied().collect::<Vec<_>>().join(" ")
    };

    let mut papers = search_academic_literature(&query, 15, None, None).await;
    if papers.is_empty() && !all_keywords.is_empty() {
        let fallback = all_keywords.iter().take(3).copied().collect::<Vec<_>>().join(" ");
        papers = search_academic_literature(&fallback, 15, None, None).await;
    }

    let mut max_sim = 0.0_f64;
    #[derive(Serialize)]
    struct SimilarPaper {
        title: String,
        authors: Vec<String>,
        year: Option<u32>,
        similarity: f64,
        url: String,
        pdf_url: Option<String>,
    }
    let mut similar_papers: Vec<SimilarPaper> = Vec::new();

    for p in &papers {
        let paper_text = format!("{} {}", p.title, p.snippet);
        let paper_keywords = get_keywords(&paper_text);
        let paper_kw: HashSet<&str> = paper_keywords.iter().map(|s| s.as_str()).collect();

        let intersection = all_keywords.intersection(&paper_kw).count();
        let union = all_keywords.union(&paper_kw).count();
        let similarity = if union == 0 { 0.0 } else { intersection as f64 / union as f64 };

        if similarity > 0.05 {
            similar_papers.push(SimilarPaper {
                title: p.title.clone(),
                authors: p.authors.clone(),
                year: p.year,
                similarity: (similarity * 1000.0).round() / 1000.0,
                url: p.url.clone(),
                pdf_url: p.pdf_url.clone(),
            });
            if similarity > max_sim {
                max_sim = similarity;
            }
        }
    }
    similar_papers.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal));
    let top_similar: Vec<&SimilarPaper> = similar_papers.iter().take(5).collect();

    let (rating, recommendation) = if max_sim > 0.25 {
        ("Low Novelty", "High overlap detected. Suggest differentiating your hypotheses or focusing on a different niche.")
    } else if max_sim > 0.12 {
        ("Medium Novelty", "Moderate overlap. Ensure your implementation details and specific validation distinguish your work.")
    } else {
        ("High Novelty", "No significant overlap found in the top retrieved literature. The idea appears novel.")
    };

    let report = json!({
        "novelty_rating": rating,
        "max_similarity_score": (max_sim * 1000.0).round() / 1000.0,
        "recommendation": recommendation,
        "similar_papers": top_similar,
        "topic_keywords_analyzed": topic_keywords,
        "hypotheses_keywords_analyzed": hyp_keywords,
    });
    Ok(serde_json::to_string_pretty(&report).unwrap_or_default())
}
