use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;
use futures_util::future::join_all;

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
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_default();
        
    let query_str = query.trim().to_string();
    
    // Search both sources in parallel
    let (arxiv_res, openalex_res) = tokio::join!(
        search_arxiv(&client, &query_str, limit),
        search_openalex(&client, &query_str, limit)
    );
    
    let mut all_papers = Vec::new();
    all_papers.extend(arxiv_res);
    all_papers.extend(openalex_res);
    
    // Deduplicate by title similarity or DOI
    let mut seen_doi = std::collections::HashSet::new();
    let mut seen_title = std::collections::HashSet::new();
    let mut deduplicated = Vec::new();
    
    for p in all_papers {
        let title_norm = p.title.to_lowercase().replace(char::is_whitespace, "");
        if let Some(ref d) = p.doi {
            if seen_doi.contains(d) {
                continue;
            }
            seen_doi.insert(d.clone());
        }
        if seen_title.contains(&title_norm) {
            continue;
        }
        seen_title.insert(title_norm);
        
        // Year filter
        if let Some(ymin) = year_min {
            if p.year.map_or(true, |y| y < ymin) {
                continue;
            }
        }
        if let Some(ymax) = year_max {
            if p.year.map_or(true, |y| y > ymax) {
                continue;
            }
        }
        
        deduplicated.push(p);
    }
    
    // Sort by citation count or year (descending)
    deduplicated.sort_by(|a, b| b.citation_count.cmp(&a.citation_count));
    
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
    let mut formatted: Vec<String> = authors.iter().take(6).map(|a| format_one(a)).collect();
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
    // Chicago is very similar to APA in block representation
    format_apa(authors, year, title, journal, doi)
}
