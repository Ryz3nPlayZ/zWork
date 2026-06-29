use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    // Chicago is very similar to APA in block representation
    format_apa(authors, year, title, journal, doi)
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
            (cred.api_key, cred.base_url, cred.shape, real)
        } else {
            return Err("No credentials configured for model".to_string());
        }
    } else {
        match crate::server::resolve("zwork_router", &s, "") {
            Some(cred) => (cred.api_key, cred.base_url, cred.shape, "deepseek-v4-flash".to_string()),
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

pub async fn review_paper(
    paper_content: &str,
    review_type: &str,
) -> Result<String, String> {
    let review_prompt = format!(
        "You are an expert peer reviewer for a major academic conference. Conduct a thorough \"{}\" review of the following paper draft:\n\n\
        {}\n\n\
        Critique the paper and provide a structured feedback report. The report MUST include:\n\
        1. Overall Quality Score (0 to 10)\n\
        2. Key Strengths\n\
        3. Key Weaknesses & Gaps\n\
        4. Detailed Section-by-Section Feedback\n\
        5. Actionable Recommendations for improvement\n\n\
        Return the feedback in Markdown format.",
        review_type, paper_content
    );
    
    let feedback = call_llm("You are a rigorous academic peer reviewer.", &review_prompt).await?;
    Ok(feedback)
}
