use serde_json::Value;
use std::time::Duration;

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

pub async fn execute_web_search(params: &Value) -> Result<String, String> {
    let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let max_results = params.get("max_results").and_then(|v| v.as_u64()).unwrap_or(6) as usize;
    
    let mut base_url = "https://news.google.com/rss".to_string();
    let mut query_params = Vec::new();
    if !query.is_empty() {
        base_url = "https://news.google.com/rss/search".to_string();
        query_params.push(("q", query.clone()));
    }
    
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap_or_default();
        
    let resp = client.get(&base_url)
        .query(&query_params)
        .header("User-Agent", "zWork/1.0 (+https://tryzwork.app)")
        .header("Accept", "application/rss+xml, application/xml;q=0.9, */*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to search engine: {}", e))?;
        
    let xml = resp.text()
        .await
        .map_err(|e| format!("Failed to read search response: {}", e))?;
        
    let items = extract_all_tags(&xml, "item");
    let mut rows = Vec::new();
    
    for item in items.iter().take(max_results) {
        let title = extract_tag(item, "title");
        let link = extract_tag(item, "link");
        let pub_date = extract_tag(item, "pubDate");
        let source = extract_tag(item, "source");
        
        if title.is_empty() {
            continue;
        }
        
        let mut meta = Vec::new();
        if !source.is_empty() {
            meta.push(source);
        }
        if !pub_date.is_empty() {
            meta.push(pub_date);
        }
        
        if !meta.is_empty() {
            rows.push(format!("- {}\n  {}\n  {}", title, meta.join(" | "), link));
        } else {
            rows.push(format!("- {}\n  {}", title, link));
        }
    }
    
    if rows.is_empty() {
        return Ok("No web/news results found.".to_string());
    }
    
    let heading = if query.is_empty() {
        "Top current headlines".to_string()
    } else {
        format!("Results for: {}", query)
    };
    
    Ok(format!("{}\n\n{}", heading, rows.join("\n")))
}
