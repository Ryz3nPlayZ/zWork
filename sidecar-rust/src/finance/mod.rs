//! Finance tab and the finance chat's data: quotes, price history, news and
//! company financials, all from free keyless sources (Yahoo Finance's public
//! chart/search endpoints, Nasdaq's public quote API, Google News RSS, SEC EDGAR).

pub mod nasdaq;
pub mod portfolio;
pub mod statements;
pub mod universe;

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::future::Future;
use std::time::{Duration, Instant};

// Yahoo answers 429 to curl's and to full browser user agents from some IPs; this one passes.
const YAHOO_UA: &str = "Mozilla/5.0";
// The SEC asks automated clients to name themselves.
const SEC_UA: &str = "zWork/1.0 (desktop app; https://tryzwork.app)";
const DEFAULT_WATCHLIST: &[&str] = &["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];

fn http(ua: &str) -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).user_agent(ua).build().unwrap_or_default()
}

/// Responses are kept for `ttl` so switching tickers is instant and we stay under the
/// free services' rate limits. A failed refresh serves the stale copy if there is one.
pub async fn cached<F, Fut>(key: &str, ttl: Duration, fetch: F) -> Result<Value, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    static C: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
    let c = C.get_or_init(|| Mutex::new(HashMap::new()));
    let hit = c.lock().unwrap().get(key).cloned();
    if let Some((at, v)) = &hit {
        if at.elapsed() < ttl {
            return Ok(v.clone());
        }
    }
    match fetch().await {
        Ok(v) => {
            let mut map = c.lock().unwrap();
            // shortcut: crude cap; drops everything older than 10 min once it grows. Fine for one user.
            if map.len() > 400 {
                map.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(600));
            }
            map.insert(key.to_string(), (Instant::now(), v.clone()));
            Ok(v)
        }
        Err(e) => hit.map(|(_, v)| v).ok_or(e),
    }
}

pub async fn get_json(url: &str, ua: &str) -> Result<Value, String> {
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

pub fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

fn closes(result: &Value) -> Vec<(i64, f64)> {
    let ts = result["timestamp"].as_array().cloned().unwrap_or_default();
    let cs = result["indicators"]["quote"][0]["close"].as_array().cloned().unwrap_or_default();
    ts.iter().zip(cs.iter()).filter_map(|(t, c)| Some((t.as_i64()?, num(c)?))).collect()
}

/// Candles with open, high, low, close and volume; rows without a close are dropped.
fn candles(result: &Value) -> Vec<Value> {
    let ts = result["timestamp"].as_array().cloned().unwrap_or_default();
    let q = &result["indicators"]["quote"][0];
    let col = |k: &str| q[k].as_array().cloned().unwrap_or_default();
    let (o, h, l, c, v) = (col("open"), col("high"), col("low"), col("close"), col("volume"));
    ts.iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let close = num(c.get(i)?)?;
            let or = |col: &Vec<Value>| col.get(i).and_then(num).unwrap_or(close);
            Some(json!({ "t": t.as_i64()?, "o": or(&o), "h": or(&h), "l": or(&l), "c": close, "v": v.get(i).and_then(num).unwrap_or(0.0) }))
        })
        .collect()
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
    let url = format!("https://query1.finance.yahoo.com/v7/finance/spark?symbols={list}&range=1d&interval=15m");
    let body = cached(&url, Duration::from_secs(60), || get_json(&url, YAHOO_UA)).await?;
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
    let ttl = Duration::from_secs(if range == "1d" { 60 } else { 300 });
    let body = cached(&url, ttl, || get_json(&url, YAHOO_UA)).await;
    let result = body.as_ref().map(|b| b["chart"]["result"][0].clone()).unwrap_or(Value::Null);
    if !result["meta"].is_object() {
        // Daily history can come from Nasdaq when Yahoo is down or blocking us.
        if !matches!(range, "1d" | "5d") && !symbol.contains(['^', '=']) {
            if let Ok(q) = nasdaq::history(symbol, range).await {
                return Ok(q);
            }
        }
        return Err(body.err().unwrap_or_else(|| format!("No price data for {symbol}.")));
    }
    let pts = closes(&result);
    let mut q = quote_from(&result["meta"], &pts, if range == "1d" { "previousClose" } else { "chartPreviousClose" });
    q["range"] = json!(range);
    q["points"] = json!(candles(&result));
    Ok(q)
}

/// Daily closes over a range for several symbols at once (for compare charts, the
/// screener's 1-month and YTD moves, and portfolio history).
pub async fn spark_many(symbols: &[String], range: &str, interval: &str) -> HashMap<String, Vec<(i64, f64)>> {
    use futures_util::StreamExt;
    let chunks: Vec<Vec<String>> = symbols.chunks(20).map(|c| c.to_vec()).collect();
    let bodies: Vec<Value> = futures_util::stream::iter(chunks)
        .map(|chunk| async move {
            let list = chunk.iter().map(|s| s.replace('^', "%5E")).collect::<Vec<_>>().join(",");
            let url = format!("https://query1.finance.yahoo.com/v7/finance/spark?symbols={list}&range={range}&interval={interval}");
            cached(&url, Duration::from_secs(3600), || get_json(&url, YAHOO_UA)).await.unwrap_or(Value::Null)
        })
        .buffer_unordered(4)
        .collect()
        .await;
    let mut out = HashMap::new();
    for b in bodies {
        for r in b["spark"]["result"].as_array().into_iter().flatten() {
            if let Some(sym) = r["symbol"].as_str() {
                out.insert(sym.to_string(), closes(&r["response"][0]));
            }
        }
    }
    out
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
/// A company's headlines: Yahoo's per-ticker feed first, then Google News on its name,
/// with quote pages and repeats removed.
pub async fn ticker_news(symbol: &str, name: &str, max: usize) -> Result<Vec<Value>, String> {
    let url = reqwest::Url::parse_with_params(
        "https://query2.finance.yahoo.com/v1/finance/search",
        &[("q", symbol), ("quotesCount", "0"), ("newsCount", "12")],
    )
    .map_err(|e| e.to_string())?;
    let (yahoo, google) = tokio::join!(
        cached(url.as_str(), Duration::from_secs(600), || get_json(url.as_str(), YAHOO_UA)),
        news(if name.is_empty() { symbol } else { name }, 12)
    );
    let mut items: Vec<Value> = yahoo
        .map(|b| {
            b["news"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|n| json!({ "title": n["title"], "url": n["link"], "source": n["publisher"], "published": n["providerPublishTime"] }))
                .collect()
        })
        .unwrap_or_default();
    items.extend(google.unwrap_or_default());
    let mut out = clean_news(items, name, 40);
    // Yahoo's ticker feed mixes in general market stories; put the ones about this company first.
    let word = name.split_whitespace().next().unwrap_or(symbol).trim_end_matches([',', '.']).to_lowercase();
    let about = |n: &Value| {
        let t = n["title"].as_str().unwrap_or("").to_lowercase();
        t.contains(&word) || t.contains(&symbol.to_lowercase())
    };
    out.sort_by_key(|n| !about(n)); // stable, so each half stays newest first
    out.truncate(max);
    Ok(out)
}

/// Drops rows that are a quote or overview page rather than a story, and repeats of the same headline.
pub fn clean_news(items: Vec<Value>, name: &str, max: usize) -> Vec<Value> {
    const JUNK: &[&str] = &["stock price", "share price", "stock quote", "quote & history", "price & chart", "overview", "stock chart", "price today", "live chart"];
    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric() || *c == ' ').collect::<String>();
    let name_n = norm(name);
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Value> = items
        .into_iter()
        .filter(|n| {
            let t = norm(n["title"].as_str().unwrap_or(""));
            let key: String = t.split_whitespace().take(8).collect::<Vec<_>>().join(" ");
            t.split_whitespace().count() >= 4 && t != name_n && !JUNK.iter().any(|j| t.contains(&norm(j))) && seen.insert(key)
        })
        .collect();
    out.sort_by_key(|n| std::cmp::Reverse(n["published"].as_i64().unwrap_or(0)));
    out.truncate(max);
    out
}

pub async fn news(query: &str, max: usize) -> Result<Vec<Value>, String> {
    let q = if query.trim().is_empty() { "stock market when:1d".to_string() } else { format!("{} stock when:7d", query.trim()) };
    let url = reqwest::Url::parse_with_params("https://news.google.com/rss/search", &[("q", q.as_str()), ("hl", "en-US"), ("gl", "US"), ("ceid", "US:en")])
        .map_err(|e| e.to_string())?;
    let key = url.to_string();
    let v = cached(&key, Duration::from_secs(600), || async move {
        let resp = http("zWork/1.0 (+https://tryzwork.app)").get(url).send().await.map_err(|e| format!("Couldn't reach the news feed: {e}"))?;
        let xml = resp.text().await.map_err(|e| e.to_string())?;
        Ok(json!(parse_news_rss(&xml, 30)))
    })
    .await?;
    let mut items: Vec<Value> = v.as_array().cloned().unwrap_or_default();
    if query.trim().is_empty() {
        items = clean_news(items, "", max);
    }
    items.truncate(max);
    Ok(items)
}

// ── SEC EDGAR ──────────────────────────────────────────────────────────

fn cik_cache() -> &'static Mutex<HashMap<String, (u64, String)>> {
    static C: OnceLock<Mutex<HashMap<String, (u64, String)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn cik_for(symbol: &str) -> Result<(u64, String), String> {
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

pub const REVENUE_TAGS: &[&str] = &[
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

/// A company's XBRL facts (~4 MB) and filing list from EDGAR, kept for a day and six hours.
pub async fn sec_data(cik: u64) -> (Result<Value, String>, Result<Value, String>) {
    let (facts_url, subs_url) = (
        format!("https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010}.json"),
        format!("https://data.sec.gov/submissions/CIK{cik:010}.json"),
    );
    tokio::join!(
        cached(&facts_url, Duration::from_secs(86_400), || get_json(&facts_url, SEC_UA)),
        cached(&subs_url, Duration::from_secs(21_600), || get_json(&subs_url, SEC_UA))
    )
}

pub async fn sec_json(url: &str, ttl_secs: u64) -> Result<Value, String> {
    cached(url, Duration::from_secs(ttl_secs), || get_json(url, SEC_UA)).await
}

pub async fn financials(symbol: &str) -> Result<Value, String> {
    let (cik, title) = cik_for(symbol).await?;
    let (facts, subs) = sec_data(cik).await;
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

pub fn fail(e: String) -> axum::response::Response {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))).into_response()
}

#[derive(Deserialize)]
pub struct Params {
    #[serde(default)]
    pub symbols: String,
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub range: String,
    #[serde(default)]
    pub q: String,
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
    let res = match clean_symbol(&p.symbol) {
        Some(sym) => ticker_news(&sym, p.q.trim(), 15).await,
        None => news(&p.q, 15).await,
    };
    match res { Ok(v) => Json(v).into_response(), Err(e) => fail(e) }
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
    fn news_drops_quote_pages_and_repeats() {
        let n = |t: &str, at: i64| json!({ "title": t, "published": at });
        let out = clean_news(
            vec![
                n("Apple (AAPL) Stock Price & Chart", 5),
                n("Apple Inc.", 4),
                n("Apple beats on iPhone sales as services climb", 3),
                n("Apple beats on iPhone sales as services climb - Reuters", 2),
                n("Apple faces EU fine over App Store rules", 9),
            ],
            "Apple Inc.",
            10,
        );
        let titles: Vec<_> = out.iter().map(|x| x["title"].as_str().unwrap()).collect();
        assert_eq!(titles, ["Apple faces EU fine over App Store rules", "Apple beats on iPhone sales as services climb"]);
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
