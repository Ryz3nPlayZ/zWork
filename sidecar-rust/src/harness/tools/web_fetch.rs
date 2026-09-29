//! `web_fetch`: read a URL the way opencode's `webfetch` does — HTML becomes
//! markdown (or plain text), images come back as images, and documents
//! (PDF, Word, Excel, PowerPoint) go through the same extractor as local
//! files. Output past the usual budget is saved to a temp file the model can
//! page through with `read`, instead of being thrown away.

use std::time::Duration;

use serde_json::{json, Value};

use crate::harness::agent_types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, ReplayPolicy, ToolFuture};
use crate::harness::types::{AbortSignal, ImageContent, UserContent};

use super::truncate::{format_size, truncate_head, TruncationOptions};

pub const WEB_FETCH_SNIPPET: &str = "Fetch a URL and read it as markdown, text, or HTML";
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 120;
const BROWSER_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/// Page chrome that is never the content the model asked for.
const SKIP_TAGS: &[&str] = &["script", "style", "noscript", "template", "svg", "canvas", "iframe", "nav", "footer", "head", "button"];

#[derive(Default)]
pub struct WebFetchTool;

#[derive(serde::Deserialize)]
struct Args {
    url: String,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    timeout: Option<f64>,
}

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Markdown,
    Text,
    Html,
}

impl AgentTool for WebFetchTool {
    fn name(&self) -> &str {
        "web_fetch"
    }
    fn label(&self) -> &str {
        "Fetch"
    }
    fn description(&self) -> &str {
        "Fetch a URL and return its content. Web pages are converted to markdown by default (format: \"text\" strips \
         formatting, \"html\" returns the raw page). PDFs and Office documents are extracted to text; images are returned \
         as images. Use it to read a page the user links, documentation, or a search result. Only http(s) URLs; \
         responses over 5MB are rejected. Long output is saved to a file you can `read` with offset/limit."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "The URL to fetch (http:// or https://)" },
                "format": { "type": "string", "enum": ["markdown", "text", "html"], "description": "How to return a web page (default: markdown)" },
                "timeout": { "type": "number", "description": format!("Timeout in seconds (default {DEFAULT_TIMEOUT_SECS}, max {MAX_TIMEOUT_SECS})") }
            },
            "required": ["url"]
        })
    }
    fn prompt_snippet(&self) -> Option<&str> {
        Some(WEB_FETCH_SNIPPET)
    }
    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }
    fn execute<'a>(&'a self, _id: &'a str, params: Value, signal: Option<&'a AbortSignal>, _on_update: AgentToolUpdateCallback) -> ToolFuture<'a> {
        Box::pin(async move {
            let args: Args = serde_json::from_value(params).map_err(|e| format!("Invalid web_fetch arguments: {e}"))?;
            let format = match args.format.as_deref() {
                Some("text") => Format::Text,
                Some("html") => Format::Html,
                _ => Format::Markdown,
            };
            let url = normalize_url(&args.url)?;
            let timeout = Duration::from_secs(args.timeout.map(|t| t.max(1.0) as u64).unwrap_or(DEFAULT_TIMEOUT_SECS).min(MAX_TIMEOUT_SECS));
            let aborted = async {
                match signal {
                    Some(s) => s.cancelled().await,
                    None => std::future::pending().await,
                }
            };
            let fetched = tokio::select! {
                r = tokio::time::timeout(timeout, fetch(&url, format)) => r.map_err(|_| format!("Timed out after {}s fetching {url}", timeout.as_secs()))??,
                _ = aborted => return Err("Fetch aborted".into()),
            };
            render(&url, format, fetched).await
        })
    }
}

struct Fetched {
    final_url: String,
    mime: String,
    bytes: Vec<u8>,
}

fn normalize_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let url = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else if !raw.contains("://") && raw.contains('.') {
        format!("https://{raw}")
    } else {
        return Err(format!("URL must start with http:// or https:// (got {raw})"));
    };
    reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL {url}: {e}"))?;
    Ok(url)
}

fn client(ua: &str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(ua)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch(url: &str, format: Format) -> Result<Fetched, String> {
    let accept = match format {
        Format::Markdown => "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
        Format::Text => "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
        Format::Html => "text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1",
    };
    let get = |ua: &str| {
        let c = client(ua);
        async move { c?.get(url).header("Accept", accept).header("Accept-Language", "en-US,en;q=0.9").send().await.map_err(|e| describe(&e)) }
    };
    let mut resp = get(BROWSER_UA).await?;
    // Cloudflare challenges browser-looking agents that can't run JS; an
    // honest agent string is often let through.
    if resp.status() == 403 && resp.headers().get("cf-mitigated").is_some_and(|v| v == "challenge") {
        resp = get(concat!("zWork/", env!("CARGO_PKG_VERSION"))).await?;
    }
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{url} returned HTTP {}", status));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_RESPONSE_BYTES) {
        return Err(format!("Response too large (over {})", format_size(MAX_RESPONSE_BYTES)));
    }
    let final_url = resp.url().to_string();
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_lowercase())
        .unwrap_or_default();
    let mut bytes = Vec::new();
    let mut stream = resp;
    while let Some(chunk) = stream.chunk().await.map_err(|e| describe(&e))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(format!("Response too large (over {})", format_size(MAX_RESPONSE_BYTES)));
        }
    }
    Ok(Fetched { final_url, mime, bytes })
}

fn describe(e: &reqwest::Error) -> String {
    if e.is_connect() {
        format!("Could not connect: {e}")
    } else if e.is_redirect() {
        "Too many redirects".into()
    } else {
        e.to_string()
    }
}

async fn render(url: &str, format: Format, f: Fetched) -> Result<AgentToolResult, String> {
    let details = json!({ "url": url, "finalUrl": f.final_url, "contentType": f.mime, "bytes": f.bytes.len() });
    let source = if f.final_url == url { url.to_string() } else { format!("{url} (redirected to {})", f.final_url) };

    if f.mime.starts_with("image/") && f.mime != "image/svg+xml" {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.encode(&f.bytes);
        return Ok(AgentToolResult {
            content: vec![
                UserContent::text(format!("Image from {source} ({}, {})", f.mime, format_size(f.bytes.len()))),
                UserContent::Image(ImageContent { data, mime_type: f.mime.clone() }),
            ],
            details,
            usage: None,
            terminate: None,
        });
    }

    if let Some(ext) = document_extension(&f.mime, &f.final_url) {
        let text = extract_document(&f.bytes, ext).await?;
        return Ok(AgentToolResult::text(budget(&source, &text, "txt")).with_details(details));
    }

    let body = String::from_utf8_lossy(&f.bytes);
    let is_html = f.mime.contains("html") || (f.mime.is_empty() && body.trim_start().starts_with('<'));
    let (text, ext) = match (is_html, format) {
        (true, Format::Markdown) => (absolutize_links(&html_to_markdown(main_content(&body)), &f.final_url), "md"),
        (true, Format::Text) => (markdown_to_text(&html_to_markdown(main_content(&body))), "txt"),
        (true, Format::Html) => (body.into_owned(), "html"),
        (false, _) => (body.into_owned(), "txt"),
    };
    if text.trim().is_empty() {
        return Ok(AgentToolResult::text(format!("{source} returned no readable text ({}). It may need JavaScript — try the browser tools.", f.mime)).with_details(details));
    }
    let title = if is_html { page_title(&String::from_utf8_lossy(&f.bytes)) } else { None };
    let header = match title {
        Some(t) => format!("{t}\n{source}"),
        None => source,
    };
    Ok(AgentToolResult::text(budget(&header, &text, ext)).with_details(details))
}

/// Keep output inside the shared tool budget; the full text goes to a temp
/// file so nothing is lost.
fn budget(header: &str, text: &str, ext: &str) -> String {
    let t = truncate_head(text, TruncationOptions::default());
    if !t.truncated {
        return format!("{header}\n\n{text}");
    }
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    let path = std::env::temp_dir().join(format!("zwork-fetch-{hash:016x}.{ext}"));
    let saved = std::fs::write(&path, text).is_ok();
    let more = if saved {
        format!("Full content saved to {} — use `read` with offset/limit to see the rest.", path.display())
    } else {
        "Could not save the rest.".into()
    };
    format!(
        "{header}\n\n{}\n\n[Showing {} of {} lines ({} of {}). {more}]",
        t.content,
        t.output_lines,
        t.total_lines,
        format_size(t.output_bytes),
        format_size(t.total_bytes)
    )
}

fn document_extension(mime: &str, url: &str) -> Option<&'static str> {
    let by_mime = match mime {
        "application/pdf" => Some("pdf"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        _ => None,
    };
    by_mime.or_else(|| {
        if !(mime.is_empty() || mime == "application/octet-stream") {
            return None;
        }
        let path = url.split(['?', '#']).next().unwrap_or("").to_lowercase();
        ["pdf", "docx", "xlsx", "pptx"].into_iter().find(|e| path.ends_with(&format!(".{e}")))
    })
}

async fn extract_document(bytes: &[u8], ext: &str) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!("zwork-fetch-{}.{ext}", uuid::Uuid::new_v4()));
    tokio::fs::write(&path, bytes).await.map_err(|e| format!("Could not save download: {e}"))?;
    let result = crate::tools::doc_extract::execute_extract_document(&json!({ "path": path.to_string_lossy() })).await;
    let _ = tokio::fs::remove_file(&path).await;
    result
}

/// HTML → CommonMark, dropping scripts, styles and site chrome.
pub fn html_to_markdown(html: &str) -> String {
    let converter = htmd::HtmlToMarkdown::builder().skip_tags(SKIP_TAGS.to_vec()).build();
    let md = converter.convert(html).unwrap_or_default();
    collapse_blank_lines(&md)
}

/// The page's own content region when it marks one — a single `<main>`, else
/// a single `<article>` — so headers, sidebars and menus don't bury it.
fn main_content(html: &str) -> &str {
    let lower = html.to_ascii_lowercase();
    for tag in ["main", "article"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        let starts: Vec<usize> = lower
            .match_indices(&open)
            .map(|(i, _)| i)
            .filter(|&i| lower[i + open.len()..].starts_with(|c: char| c == '>' || c.is_ascii_whitespace()))
            .collect();
        if let ([start], Some(end)) = (starts.as_slice(), lower.rfind(&close)) {
            if end > *start {
                return &html[*start..end + close.len()];
            }
        }
    }
    html
}

/// Rewrite relative link and image targets against the page URL so the model
/// can follow them with another `web_fetch`.
fn absolutize_links(md: &str, base: &str) -> String {
    use std::sync::OnceLock;
    static LINK: OnceLock<regex::Regex> = OnceLock::new();
    let Ok(base) = reqwest::Url::parse(base) else { return md.to_string() };
    // Targets may carry markdown escapes (`\(`, `\)`), which a URL parser
    // would read as path separators.
    let re = LINK.get_or_init(|| regex::Regex::new(r"\]\(((?:\\.|[^)\s\\])+)").unwrap());
    re.replace_all(md, |c: &regex::Captures| {
        let target = c[1].replace("\\(", "(").replace("\\)", ")");
        let relative = !target.contains("://") && !target.starts_with('#') && !target.starts_with("mailto:") && !target.starts_with("data:");
        match base.join(&target) {
            Ok(u) if relative => format!("]({}", u.as_str().replace('(', "\\(").replace(')', "\\)")),
            _ => c[0].to_string(),
        }
    })
    .into_owned()
}

/// Markdown → plain reading text: link targets, images and emphasis markers go.
fn markdown_to_text(md: &str) -> String {
    use std::sync::OnceLock;
    static RES: OnceLock<[(regex::Regex, &'static str); 4]> = OnceLock::new();
    let res = RES.get_or_init(|| {
        [
            (regex::Regex::new(r"!\[([^\]]*)\]\([^)]*\)").unwrap(), "$1"),
            (regex::Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap(), "$1"),
            (regex::Regex::new(r"(?m)^#{1,6}\s+").unwrap(), ""),
            (regex::Regex::new(r"\*\*|__|`").unwrap(), ""),
        ]
    });
    let mut out = md.to_string();
    for (re, rep) in res {
        out = re.replace_all(&out, *rep).into_owned();
    }
    collapse_blank_lines(&out)
}

fn collapse_blank_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank = 0;
    for line in s.lines() {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out.trim().to_string()
}

fn page_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = start + lower[start..].find('>')? + 1;
    let end = open_end + lower[open_end..].find("</title>")?;
    let title = htmd::convert(&html[open_end..end]).ok()?.trim().to_string();
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_html_and_drops_chrome() {
        let html = r#"<html><head><title>Docs &amp; more</title><style>x{}</style></head><body>
            <nav><a href="/">Home</a></nav>
            <h1>Hello</h1><p>Some <strong>bold</strong> <a href="https://x.dev">link</a>.</p>
            <script>alert(1)</script><footer>© 2026</footer></body></html>"#;
        let md = html_to_markdown(html);
        assert!(md.contains("# Hello") && md.contains("**bold**") && md.contains("[link](https://x.dev)"), "{md}");
        assert!(!md.contains("alert") && !md.contains("Home") && !md.contains("2026"), "{md}");
        assert_eq!(markdown_to_text(&md), "Hello\n\nSome bold link.");
        assert_eq!(page_title(html).as_deref(), Some("Docs & more"));
    }

    #[test]
    fn prefers_main_and_resolves_links() {
        let html = r##"<header>Menu</header><main id="c"><p><a href="/wiki/X_(y)">X</a> <a href="#top">top</a> <a href="https://y.dev/">Y</a></p></main><aside>ads</aside>"##;
        let md = absolutize_links(&html_to_markdown(main_content(html)), "https://en.wikipedia.org/wiki/Rust");
        assert_eq!(md, "[X](https://en.wikipedia.org/wiki/X_\\(y\\)) [top](#top) [Y](https://y.dev/)");
        assert_eq!(main_content("<mainframe>x</mainframe>"), "<mainframe>x</mainframe>");
    }

    #[test]
    fn urls_and_documents() {
        assert_eq!(normalize_url("example.com/a").unwrap(), "https://example.com/a");
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert_eq!(document_extension("application/pdf", "https://x/y"), Some("pdf"));
        assert_eq!(document_extension("application/octet-stream", "https://x/report.DOCX?dl=1"), Some("docx"));
        assert_eq!(document_extension("text/html", "https://x/a.pdf"), None);
    }

    #[test]
    fn long_output_is_saved_not_lost() {
        let text = (0..5000).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let out = budget("T", &text, "md");
        let path = out.rsplit("saved to ").next().unwrap().split(" — ").next().unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        let _ = std::fs::remove_file(path);
    }

    /// `cargo test live_fetch -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_fetch() {
        let noop: AgentToolUpdateCallback = std::sync::Arc::new(|_| {});
        for (url, fmt) in [
            ("example.com", "markdown"),
            ("https://en.wikipedia.org/wiki/Rust_(programming_language)", "markdown"),
            ("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", "markdown"),
        ] {
            let r = WebFetchTool.execute("1", json!({ "url": url, "format": fmt }), None, noop.clone()).await;
            let text = r.map(|r| r.text_content()).unwrap_or_else(|e| format!("ERR {e}"));
            println!("=== {url}\n{}\n...\n{}\n", &text[..text.len().min(400)], &text[text.len().saturating_sub(300)..]);
        }
    }
}
