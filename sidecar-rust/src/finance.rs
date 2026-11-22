//! Finance tab and the finance chat's data: quotes, price history, news and
//! company financials, all from free keyless sources (Yahoo Finance's public
//! chart/search endpoints, Google News RSS, SEC EDGAR).

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

// Yahoo answers 429 to curl's and to full browser user agents from some IPs; this one passes.
const YAHOO_UA: &str = "Mozilla/5.0";
// The SEC asks automated clients to name themselves.
const SEC_UA: &str = "zWork/1.0 (desktop app; https://tryzwork.app)";
const DEFAULT_WATCHLIST: &[&str] = &["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];

fn http(ua: &str) -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).user_agent(ua).build().unwrap_or_default()
}

async fn get_json(url: &str, ua: &str) -> Result<Value, String> {
    let resp = http(ua).get(url).send().await.map_err(|e| format!("Couldn't reach the market data service: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("The market data service answered {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

/// Tickers go into URLs, so only the characters tickers use (`BRK-B`, `^GSPC`, `EURUSD=X`, `VOD.L`).
pub fn clean_symbol(s: &str) -> Option<String> {
    let s = s.trim().to_uppercase();
    let ok = !s.is_empty() && s.len() <= 20 && s.chars().all(|c| c.is_ascii_alphanumeric() || ".^=-".contains(c));
    ok.then_some(s)
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

fn closes(result: &Value) -> Vec<(i64, f64)> {
    let ts = result["timestamp"].as_array().cloned().unwrap_or_default();
    let cs = result["indicators"]["quote"][0]["close"].as_array().cloned().unwrap_or_default();
    ts.iter().zip(cs.iter()).filter_map(|(t, c)| Some((t.as_i64()?, num(c)?))).collect()
}

fn quote_from(meta: &Value, points: &[(i64, f64)], prev_key: &str) -> Value {
    let price = num(&meta["regularMarketPrice"]).or(points.last().map(|p| p.1));
    let prev = num(&meta[prev_key]).or(num(&meta["chartPreviousClose"]));
    let change = price.zip(prev).map(|(p, q)| p - q);
    json!({
        "symbol": meta["symbol"],
        "name": meta["shortName"].as_str().or(meta["longName"].as_str()).unwrap_or(""),
        "currency": meta["currency"],
        "price": price,
        "previousClose": prev,
        "change": change,
        "changePct": change.zip(prev).filter(|(_, q)| *q != 0.0).map(|(c, q)| c / q * 100.0),
        "dayHigh": meta["regularMarketDayHigh"],
        "dayLow": meta["regularMarketDayLow"],
        "yearHigh": meta["fiftyTwoWeekHigh"],
        "yearLow": meta["fiftyTwoWeekLow"],
        "volume": meta["regularMarketVolume"],
        "exchange": meta["fullExchangeName"].as_str().or(meta["exchangeName"].as_str()).unwrap_or(""),
        "type": meta["instrumentType"],
        "marketTime": meta["regularMarketTime"],
    })
}

/// Today's price, change and an intraday sparkline for up to 20 symbols in one request.
pub async fn quotes(symbols: &[String]) -> Result<Vec<Value>, String> {
    if symbols.is_empty() {
        return Ok(vec![]);
    }
    let list = symbols.iter().take(20).map(|s| s.replace('^', "%5E")).collect::<Vec<_>>().join(",");
    let body = get_json(&format!("https://query1.finance.yahoo.com/v7/finance/spark?symbols={list}&range=1d&interval=15m"), YAHOO_UA).await?;
    let results = body["spark"]["result"].as_array().cloned().unwrap_or_default();
    Ok(results
        .iter()
        .filter_map(|r| {
            let res = &r["response"][0];
            let pts = closes(res);
            // previousClose is yesterday's close; chartPreviousClose can be older for a 1d range.
            let mut q = quote_from(&res["meta"], &pts, "previousClose");
            q["points"] = json!(pts.iter().map(|p| p.1).collect::<Vec<_>>());
            res["meta"].is_object().then_some(q)
        })
        .collect())
}

fn interval_for(range: &str) -> &'static str {
    match range {
        "1d" => "5m",
        "5d" => "30m",
        "1mo" | "3mo" | "6mo" | "ytd" | "1y" => "1d",
        "2y" | "5y" => "1wk",
        _ => "1mo",
    }
}

/// Price history for one symbol. `previousClose` is the close before the range starts,
/// so `change` is the move over the whole range.
pub async fn chart(symbol: &str, range: &str) -> Result<Value, String> {
    let range = if ["1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "max"].contains(&range) { range } else { "1mo" };
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?range={range}&interval={}",
        symbol.replace('^', "%5E"),
        interval_for(range)
    );
    let body = get_json(&url, YAHOO_UA).await?;
    let result = &body["chart"]["result"][0];
    if !result["meta"].is_object() {
        return Err(format!("No price data for {symbol}."));
    }
    let pts = closes(result);
    let mut q = quote_from(&result["meta"], &pts, if range == "1d" { "previousClose" } else { "chartPreviousClose" });
    q["range"] = json!(range);
    q["points"] = json!(pts.iter().map(|(t, c)| json!({ "t": t, "c": c })).collect::<Vec<_>>());
    Ok(q)
}

/// Ticker lookup by name or symbol. Crypto is left out on purpose.
pub async fn search(query: &str) -> Result<Vec<Value>, String> {
    let url = reqwest::Url::parse_with_params(
        "https://query2.finance.yahoo.com/v1/finance/search",
        &[("q", query), ("quotesCount", "8"), ("newsCount", "0")],
    )
    .map_err(|e| e.to_string())?;
    let body = get_json(url.as_str(), YAHOO_UA).await?;
    Ok(body["quotes"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|q| matches!(q["quoteType"].as_str(), Some("EQUITY" | "ETF" | "INDEX" | "MUTUALFUND")))
        .map(|q| json!({
            "symbol": q["symbol"],
            "name": q["shortname"].as_str().or(q["longname"].as_str()).unwrap_or(""),
            "type": q["quoteType"],
            "exchange": q["exchDisp"],
        }))
        .collect())
}

fn decode_entities(s: &str) -> String {
    s.replace("<![CDATA[", "").replace("]]>", "").replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

fn tag<'a>(item: &'a str, name: &str) -> &'a str {
    let Some(start) = item.find(&format!("<{name}")) else { return "" };
    let Some(open_end) = item[start..].find('>') else { return "" };
    let body = &item[start + open_end + 1..];
    body.find(&format!("</{name}>")).map(|end| body[..end].trim()).unwrap_or("")
}

pub fn parse_news_rss(xml: &str, max: usize) -> Vec<Value> {
    xml.split("<item>")
        .skip(1)
        .take(max)
        .filter_map(|item| {
            let source = decode_entities(tag(item, "source"));
            let mut title = decode_entities(tag(item, "title"));
            // Google News appends " - Source" to every title.
            if !source.is_empty() {
                if let Some(stripped) = title.strip_suffix(&format!(" - {source}")) {
                    title = stripped.to_string();
                }
            }
            let published = chrono::DateTime::parse_from_rfc2822(tag(item, "pubDate")).ok().map(|d| d.timestamp());
            (!title.is_empty()).then(|| json!({ "title": title, "url": decode_entities(tag(item, "link")), "source": source, "published": published }))
        })
        .collect()
}

/// Headlines from the last week about `query` (a company name or ticker), or today's
/// market headlines when it's empty.
/// shortcut: Google News links go through a news.google.com redirect; fine for clicking, not for scraping.
pub async fn news(query: &str, max: usize) -> Result<Vec<Value>, String> {
    let q = if query.trim().is_empty() { "stock market when:1d".to_string() } else { format!("{} stock when:7d", query.trim()) };
    let url = reqwest::Url::parse_with_params("https://news.google.com/rss/search", &[("q", q.as_str()), ("hl", "en-US"), ("gl", "US"), ("ceid", "US:en")])
        .map_err(|e| e.to_string())?;
    let resp = http("zWork/1.0 (+https://tryzwork.app)").get(url).send().await.map_err(|e| format!("Couldn't reach the news feed: {e}"))?;
    let xml = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_news_rss(&xml, max))
}

// ── SEC EDGAR ──────────────────────────────────────────────────────────

fn cik_cache() -> &'static Mutex<HashMap<String, (u64, String)>> {
    static C: OnceLock<Mutex<HashMap<String, (u64, String)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn cik_for(symbol: &str) -> Result<(u64, String), String> {
    if cik_cache().lock().unwrap().is_empty() {
        let body = get_json("https://www.sec.gov/files/company_tickers.json", SEC_UA).await?;
        let mut map = cik_cache().lock().unwrap();
        for v in body.as_object().into_iter().flat_map(|o| o.values()) {
            if let (Some(t), Some(c)) = (v["ticker"].as_str(), v["cik_str"].as_u64()) {
                map.insert(t.to_uppercase(), (c, v["title"].as_str().unwrap_or("").to_string()));
            }
        }
    }
    // EDGAR writes class shares as BRK-B; Yahoo as BRK-B too, but some feeds use BRK.B.
    let key = symbol.replace('.', "-");
    cik_cache().lock().unwrap().get(&key).cloned().ok_or_else(|| format!("{symbol} has no SEC filings. Financials cover US-listed companies only."))
}

const REVENUE_TAGS: &[&str] = &[
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
];

/// One value per calendar year from a us-gaap tag, using EDGAR's `frame` labels (CY2024),
/// which already pick a single fact per period across amended filings.
fn yearly(facts: &Value, tag: &str, unit: &str) -> Vec<(i32, f64)> {
    let mut out: Vec<(i32, f64)> = facts["facts"]["us-gaap"][tag]["units"][unit]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let frame = f["frame"].as_str()?;
            let year = frame.strip_prefix("CY").filter(|y| y.len() == 4)?.parse().ok()?;
            Some((year, num(&f["val"])?))
        })
        .collect();
    out.sort_by_key(|p| p.0);
    out.dedup_by_key(|p| p.0);
    out
}

/// Revenue, operating income, net income and diluted EPS for the last six years,
/// plus the latest filings with links. Pure function so it can be tested on a fixture.
pub fn summarize_facts(facts: &Value, submissions: &Value, cik: u64) -> Value {
    // Companies switch revenue tags over time; take the one with the newest data.
    let revenue = REVENUE_TAGS
        .iter()
        .map(|t| yearly(facts, t, "USD"))
        .filter(|s| !s.is_empty())
        .max_by_key(|s| s.last().map(|p| p.0))
        .unwrap_or_default();
    let series = [
        ("revenue", revenue),
        ("operatingIncome", yearly(facts, "OperatingIncomeLoss", "USD")),
        ("netIncome", yearly(facts, "NetIncomeLoss", "USD")),
        ("eps", yearly(facts, "EarningsPerShareDiluted", "USD/shares")),
    ];
    let mut years: Vec<i32> = series.iter().flat_map(|(_, s)| s.iter().map(|p| p.0)).collect();
    years.sort();
    years.dedup();
    let years: Vec<Value> = years
        .iter()
        .rev()
        .take(6)
        .rev()
        .map(|y| {
            let mut row = json!({ "year": y });
            for (key, s) in &series {
                row[*key] = json!(s.iter().find(|p| p.0 == *y).map(|p| p.1));
            }
            row
        })
        .collect();

    let recent = &submissions["filings"]["recent"];
    let col = |k: &str| recent[k].as_array().cloned().unwrap_or_default();
    let (forms, dates, accs, docs, descs) = (col("form"), col("filingDate"), col("accessionNumber"), col("primaryDocument"), col("primaryDocDescription"));
    let filings: Vec<Value> = (0..forms.len())
        .filter(|&i| matches!(forms[i].as_str(), Some("10-K" | "10-Q" | "8-K" | "20-F" | "6-K" | "DEF 14A")))
        .take(10)
        .map(|i| {
            let acc = accs.get(i).and_then(|v| v.as_str()).unwrap_or("").replace('-', "");
            json!({
                "form": forms[i],
                "date": dates.get(i),
                "title": descs.get(i).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(forms[i].as_str().unwrap_or("")),
                "url": format!("https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{}", docs.get(i).and_then(|v| v.as_str()).unwrap_or("")),
            })
        })
        .collect();
    json!({ "name": facts["entityName"], "cik": cik, "years": years, "filings": filings })
}

/// shortcut: companyfacts is ~4 MB per company and refetched on every call; cache it if the tab feels slow.
pub async fn financials(symbol: &str) -> Result<Value, String> {
    let (cik, title) = cik_for(symbol).await?;
    let (facts_url, subs_url) = (
        format!("https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010}.json"),
        format!("https://data.sec.gov/submissions/CIK{cik:010}.json"),
    );
    let (facts, subs) = tokio::join!(get_json(&facts_url, SEC_UA), get_json(&subs_url, SEC_UA));
    let mut out = summarize_facts(&facts?, &subs.unwrap_or(Value::Null), cik);
    out["symbol"] = json!(symbol);
    if out["name"].is_null() {
        out["name"] = json!(title);
    }
    Ok(out)
}

// ── Chat tools (plain text for the model) ──────────────────────────────

fn money(v: &Value) -> String {
    match num(v) {
        Some(n) if n.abs() >= 1e9 => format!("${:.2}B", n / 1e9),
        Some(n) if n.abs() >= 1e6 => format!("${:.1}M", n / 1e6),
        Some(n) => format!("${n:.2}"),
        None => "n/a".into(),
    }
}

pub async fn financials_text(ticker: &str) -> Result<String, String> {
    let sym = clean_symbol(ticker).ok_or("Give a ticker such as AAPL.")?;
    let f = financials(&sym).await?;
    let mut out = format!("{} ({sym}), from SEC filings. Calendar years; fiscal years that end mid-year are mapped to the nearest calendar year.\n\nYear | Revenue | Operating income | Net income | Diluted EPS\n", f["name"].as_str().unwrap_or(""));
    for y in f["years"].as_array().into_iter().flatten() {
        out += &format!("{} | {} | {} | {} | {}\n", y["year"], money(&y["revenue"]), money(&y["operatingIncome"]), money(&y["netIncome"]), money(&y["eps"]));
    }
    out += "\nLatest filings:\n";
    for x in f["filings"].as_array().into_iter().flatten() {
        out += &format!("- {} {} ({}): {}\n", x["date"].as_str().unwrap_or(""), x["form"].as_str().unwrap_or(""), x["title"].as_str().unwrap_or(""), x["url"].as_str().unwrap_or(""));
    }
    Ok(out)
}

pub async fn news_text(query: &str) -> Result<String, String> {
    let items = news(query, 10).await?;
    if items.is_empty() {
        return Ok("No recent headlines found. Try web_search.".into());
    }
    Ok(items
        .iter()
        .map(|n| {
            let when = n["published"].as_i64().and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string()).unwrap_or_default();
            format!("- {} ({}, {when})\n  {}", n["title"].as_str().unwrap_or(""), n["source"].as_str().unwrap_or(""), n["url"].as_str().unwrap_or(""))
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

// ── Watchlist ──────────────────────────────────────────────────────────

fn watchlist_path() -> std::path::PathBuf {
    crate::paths::home_dir().join("finance.json")
}

pub fn watchlist() -> Vec<String> {
    std::fs::read_to_string(watchlist_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["watchlist"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()))
        .unwrap_or_else(|| DEFAULT_WATCHLIST.iter().map(|s| s.to_string()).collect())
}

// ── HTTP handlers ──────────────────────────────────────────────────────

fn fail(e: String) -> axum::response::Response {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))).into_response()
}

#[derive(Deserialize)]
pub struct Params {
    #[serde(default)]
    symbols: String,
    #[serde(default)]
    symbol: String,
    #[serde(default)]
    range: String,
    #[serde(default)]
    q: String,
}

pub async fn quotes_handler(Query(p): Query<Params>) -> axum::response::Response {
    let symbols: Vec<String> = p.symbols.split(',').filter_map(clean_symbol).collect();
    match quotes(&symbols).await { Ok(v) => Json(v).into_response(), Err(e) => fail(e) }
}

pub async fn chart_handler(Query(p): Query<Params>) -> axum::response::Response {
    let Some(sym) = clean_symbol(&p.symbol) else { return StatusCode::BAD_REQUEST.into_response() };
    match chart(&sym, &p.range).await { Ok(v) => Json(v).into_response(), Err(e) => fail(e) }
}

pub async fn search_handler(Query(p): Query<Params>) -> axum::response::Response {
    if p.q.trim().is_empty() { return Json(json!([])).into_response(); }
    match search(p.q.trim()).await { Ok(v) => Json(v).into_response(), Err(e) => fail(e) }
}

pub async fn news_handler(Query(p): Query<Params>) -> axum::response::Response {
    match news(&p.q, 12).await { Ok(v) => Json(v).into_response(), Err(e) => fail(e) }
}

pub async fn financials_handler(Query(p): Query<Params>) -> axum::response::Response {
    let Some(sym) = clean_symbol(&p.symbol) else { return StatusCode::BAD_REQUEST.into_response() };
    match financials(&sym).await { Ok(v) => Json(v).into_response(), Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))).into_response() }
}

pub async fn get_watchlist() -> impl IntoResponse {
    Json(json!({ "watchlist": watchlist() }))
}

#[derive(Deserialize)]
pub struct WatchlistBody {
    watchlist: Vec<String>,
}

pub async fn put_watchlist(Json(b): Json<WatchlistBody>) -> axum::response::Response {
    let mut list: Vec<String> = b.watchlist.iter().filter_map(|s| clean_symbol(s)).collect();
    list.dedup();
    list.truncate(20);
    match std::fs::write(watchlist_path(), json!({ "watchlist": list }).to_string()) {
        Ok(()) => Json(json!({ "watchlist": list })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_are_cleaned() {
        assert_eq!(clean_symbol(" brk-b "), Some("BRK-B".into()));
        assert_eq!(clean_symbol("^GSPC"), Some("^GSPC".into()));
        assert_eq!(clean_symbol("AAPL&range=max"), None);
        assert_eq!(clean_symbol(""), None);
    }

    #[test]
    fn news_titles_lose_the_source_suffix() {
        let xml = "<rss><channel><item><title>Apple hits a record - Reuters</title><link>https://n.example/a</link><pubDate>Fri, 20 Nov 2026 15:35:00 GMT</pubDate><source url=\"https://reuters.com\">Reuters</source></item></channel></rss>";
        let items = parse_news_rss(xml, 5);
        assert_eq!(items[0]["title"], "Apple hits a record");
        assert_eq!(items[0]["source"], "Reuters");
        assert!(items[0]["published"].as_i64().is_some());
    }

    #[test]
    fn facts_become_yearly_rows() {
        let facts = json!({ "entityName": "Apple Inc.", "facts": { "us-gaap": {
            "Revenues": { "units": { "USD": [ { "val": 1.0, "frame": "CY2019" } ] } },
            "RevenueFromContractWithCustomerExcludingAssessedTax": { "units": { "USD": [
                { "val": 365.0, "frame": "CY2021" }, { "val": 90.0, "frame": "CY2022Q1" }, { "val": 394.0, "frame": "CY2022" }
            ] } },
            "NetIncomeLoss": { "units": { "USD": [ { "val": 99.0, "frame": "CY2022" } ] } }
        } } });
        let subs = json!({ "filings": { "recent": {
            "form": ["4", "10-K"], "filingDate": ["2026-11-01", "2026-10-30"],
            "accessionNumber": ["x", "0000320193-26-000100"], "primaryDocument": ["a.xml", "aapl-20260926.htm"], "primaryDocDescription": ["", "10-K"]
        } } });
        let s = summarize_facts(&facts, &subs, 320193);
        let years = s["years"].as_array().unwrap();
        assert_eq!(years.last().unwrap()["revenue"], 394.0);
        assert_eq!(years.last().unwrap()["netIncome"], 99.0);
        assert_eq!(s["filings"].as_array().unwrap().len(), 1);
        assert_eq!(s["filings"][0]["url"], "https://www.sec.gov/Archives/edgar/data/320193/000032019326000100/aapl-20260926.htm");
    }
}
