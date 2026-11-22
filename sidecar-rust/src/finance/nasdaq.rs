//! Nasdaq's public quote API (the one nasdaq.com's own pages call): daily history,
//! company profile, analyst ratings, earnings, insider and institutional ownership,
//! and the earnings and economic calendars. Keyless, but it wants a browser-like
//! user agent and an Accept header.

use super::{cached, fail, num, Params};
use axum::{extract::Query, response::IntoResponse, Json};
use chrono::{Datelike, Duration as Days, NaiveDate, Weekday};
use serde_json::{json, Value};
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async fn nq(path: String, ttl_secs: u64) -> Result<Value, String> {
    let url = format!("https://api.nasdaq.com/api/{path}");
    cached(&url, Duration::from_secs(ttl_secs), || async {
        let resp = super::http(UA)
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Nasdaq: {e}"))?;
        let v: Value = resp.json().await.map_err(|e| format!("Nasdaq sent something unreadable: {e}"))?;
        if v["data"].is_null() {
            return Err("Nasdaq has no data for that.".into());
        }
        Ok(v)
    })
    .await
}

/// "$1,234.50", "-3.2%", "1,234" → number. "N/A" and "" → None.
pub fn parse_num(v: &Value) -> Option<f64> {
    if let Some(n) = num(v) {
        return Some(n);
    }
    let s: String = v.as_str()?.chars().filter(|c| c.is_ascii_digit() || matches!(c, '.' | '-')).collect();
    s.parse().ok()
}

fn text(v: &Value) -> String {
    let s = v.as_str().unwrap_or("").trim();
    if s == "N/A" { String::new() } else { s.to_string() }
}

/// Strips tags and the common entities from Nasdaq's HTML-ish descriptions.
fn plain(s: &str) -> String {
    let no_tags = regex::Regex::new(r"<[^>]+>").unwrap().replace_all(s, " ");
    no_tags
        .replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&rsquo;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn md_y(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%m/%d/%Y").ok()
}

/// Daily candles from Nasdaq, shaped like `finance::chart`'s answer. Used when Yahoo fails.
pub async fn history(symbol: &str, range: &str) -> Result<Value, String> {
    let today = chrono::Utc::now().date_naive();
    let from = match range {
        "1mo" => today - Days::days(31),
        "3mo" => today - Days::days(92),
        "6mo" => today - Days::days(183),
        "ytd" => NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today),
        "1y" => today - Days::days(366),
        "2y" => today - Days::days(731),
        "5y" => today - Days::days(1827),
        _ => today - Days::days(7300),
    };
    let v = nq(format!("quote/{symbol}/historical?assetclass=stocks&fromdate={from}&limit=9999"), 900).await?;
    let mut pts: Vec<Value> = v["data"]["tradesTable"]["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let t = md_y(r["date"].as_str()?)?.and_hms_opt(14, 30, 0)?.and_utc().timestamp();
            let c = parse_num(&r["close"])?;
            let g = |k: &str| parse_num(&r[k]).unwrap_or(c);
            Some(json!({ "t": t, "o": g("open"), "h": g("high"), "l": g("low"), "c": c, "v": parse_num(&r["volume"]).unwrap_or(0.0) }))
        })
        .collect();
    pts.reverse();
    if pts.len() < 2 {
        return Err(format!("No price history for {symbol}."));
    }
    let first = pts[0]["c"].as_f64().unwrap_or(0.0);
    let last = pts[pts.len() - 1]["c"].as_f64().unwrap_or(0.0);
    Ok(json!({
        "symbol": symbol, "name": "", "currency": "USD", "price": last, "previousClose": first,
        "change": last - first, "changePct": if first != 0.0 { (last - first) / first * 100.0 } else { 0.0 },
        "range": range, "points": pts, "source": "nasdaq",
    }))
}

/// Who the company is, what analysts think, and the headline stats Yahoo's chart doesn't carry.
pub async fn profile(symbol: &str) -> Result<Value, String> {
    let (p, s, r, t) = tokio::join!(
        nq(format!("company/{symbol}/company-profile"), 86_400),
        nq(format!("quote/{symbol}/summary?assetclass=stocks"), 900),
        nq(format!("analyst/{symbol}/ratings"), 21_600),
        nq(format!("analyst/{symbol}/targetprice"), 21_600),
    );
    if p.is_err() && s.is_err() {
        return Err(p.err().unwrap_or_default());
    }
    let p = p.unwrap_or(Value::Null);
    let s = s.unwrap_or(Value::Null);
    let pd = |k: &str| text(&p["data"][k]["value"]);
    let sd = |k: &str| s["data"]["summaryData"][k]["value"].clone();
    let r = r.unwrap_or(Value::Null);
    let c = t.map(|t| t["data"]["consensusOverview"].clone()).unwrap_or(Value::Null);
    Ok(json!({
        "symbol": symbol,
        "name": pd("CompanyName"),
        "sector": pd("Sector"),
        "industry": pd("Industry"),
        "region": pd("Region"),
        "website": pd("CompanyUrl"),
        "description": plain(&pd("CompanyDescription")),
        "exchange": text(&sd("Exchange")),
        "marketCap": parse_num(&sd("MarketCap")),
        "volume": parse_num(&sd("ShareVolume")),
        "yearRange": text(&sd("FiftTwoWeekHighLow")),
        "dividend": parse_num(&sd("AnnualizedDividend")),
        "yield": parse_num(&sd("Yield")),
        "exDividend": text(&sd("ExDividendDate")),
        "analysts": {
            "rating": r["data"]["meanRatingType"],
            "target": parse_num(&c["priceTarget"]),
            "low": parse_num(&c["lowPriceTarget"]),
            "high": parse_num(&c["highPriceTarget"]),
            "buy": parse_num(&c["buy"]),
            "hold": parse_num(&c["hold"]),
            "sell": parse_num(&c["sell"]),
        },
    }))
}

/// The last quarters' EPS against the estimate, the next report date, and the latest
/// earnings press release (8-K item 2.02, exhibit 99.1) on EDGAR.
pub async fn earnings(symbol: &str) -> Result<Value, String> {
    let (hist, next, release) = tokio::join!(
        nq(format!("company/{symbol}/earnings-surprise"), 21_600),
        nq(format!("analyst/{symbol}/earnings-date"), 21_600),
        press_release(symbol),
    );
    let quarters: Vec<Value> = hist
        .as_ref()
        .ok()
        .and_then(|h| h["data"]["earningsSurpriseTable"]["rows"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|r| json!({
            "quarter": r["fiscalQtrEnd"], "date": r["dateReported"],
            "eps": parse_num(&r["eps"]), "estimate": parse_num(&r["consensusForecast"]), "surprisePct": parse_num(&r["percentageSurprise"]),
        }))
        .collect();
    if quarters.is_empty() && next.is_err() {
        return Err(hist.err().unwrap_or_else(|| "No earnings data.".into()));
    }
    Ok(json!({
        "symbol": symbol,
        "quarters": quarters,
        "next": next.ok().map(|n| plain(n["data"]["reportText"].as_str().unwrap_or(""))),
        "release": release.ok(),
    }))
}

async fn press_release(symbol: &str) -> Result<Value, String> {
    let (cik, _) = super::cik_for(symbol).await?;
    let subs = super::sec_json(&format!("https://data.sec.gov/submissions/CIK{cik:010}.json"), 21_600).await?;
    let r = &subs["filings"]["recent"];
    let col = |k: &str| r[k].as_array().cloned().unwrap_or_default();
    let (forms, items, accns, dates) = (col("form"), col("items"), col("accessionNumber"), col("filingDate"));
    let i = (0..forms.len())
        .find(|&i| forms[i] == "8-K" && items.get(i).and_then(|x| x.as_str()).is_some_and(|x| x.contains("2.02")))
        .ok_or("No earnings release on file.")?;
    let accn = accns[i].as_str().unwrap_or("").replace('-', "");
    let base = format!("https://www.sec.gov/Archives/edgar/data/{cik}/{accn}");
    let idx = super::sec_json(&format!("{base}/index.json"), 86_400).await?;
    let file = idx["directory"]["item"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["name"].as_str())
        .find(|n| n.to_lowercase().contains("ex99") && n.ends_with(".htm"))
        .ok_or("The release has no exhibit 99.1.")?;
    Ok(json!({ "date": dates[i], "url": format!("{base}/{file}") }))
}

/// Recent insider trades and the biggest institutional holders.
pub async fn ownership(symbol: &str) -> Result<Value, String> {
    let (ins, inst) = tokio::join!(
        nq(format!("company/{symbol}/insider-trades?limit=25&type=ALL"), 21_600),
        nq(format!("company/{symbol}/institutional-holdings?limit=15&type=TOTAL&sortColumn=marketValue&sortOrder=DESC"), 86_400),
    );
    if ins.is_err() && inst.is_err() {
        return Err(ins.err().unwrap_or_default());
    }
    let ins = ins.unwrap_or(Value::Null);
    let inst = inst.unwrap_or(Value::Null);
    let insiders: Vec<Value> = ins["data"]["transactionTable"]["table"]["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| json!({
            "name": r["insider"], "role": r["relation"], "date": r["lastDate"], "type": r["transactionType"],
            "shares": parse_num(&r["sharesTraded"]), "price": parse_num(&r["lastPrice"]), "held": parse_num(&r["sharesHeld"]),
        }))
        .collect();
    let holders: Vec<Value> = inst["data"]["holdingsTransactions"]["table"]["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| json!({
            "name": r["ownerName"], "date": r["date"], "shares": parse_num(&r["sharesHeld"]),
            "change": parse_num(&r["sharesChange"]), "changePct": parse_num(&r["sharesChangePCT"]), "value": parse_num(&r["marketValue"]).map(|v| v * 1000.0), // Nasdaq reports thousands
        }))
        .collect();
    Ok(json!({
        "symbol": symbol,
        "insiders": insiders,
        "holders": holders,
        "institutionalPct": parse_num(&inst["data"]["ownershipSummary"]["SharesOutstandingPCT"]["value"]),
    }))
}

/// Weekdays from today, `days` of them.
pub fn trading_days(from: NaiveDate, days: usize) -> Vec<NaiveDate> {
    (0..days * 2 + 4)
        .map(|i| from + Days::days(i as i64))
        .filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun))
        .take(days)
        .collect()
}

/// Earnings reports (largest companies first) and US economic releases over the next `days` weekdays.
pub async fn calendar(days: usize) -> Value {
    let dates = trading_days(chrono::Utc::now().date_naive(), days.clamp(1, 10));
    let fetches = dates.iter().map(|d| async move {
        let (e, x) = tokio::join!(nq(format!("calendar/earnings?date={d}"), 3600), nq(format!("calendar/economicevents?date={d}"), 3600));
        (d.to_string(), e.unwrap_or(Value::Null), x.unwrap_or(Value::Null))
    });
    let mut earnings = vec![];
    let mut economy = vec![];
    for (d, e, x) in futures_util::future::join_all(fetches).await {
        let mut rows: Vec<Value> = e["data"]["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| json!({
                "date": d, "symbol": r["symbol"], "name": r["name"],
                "time": match r["time"].as_str().unwrap_or("") { "time-pre-market" => "before open", "time-after-hours" => "after close", _ => "" },
                "estimate": parse_num(&r["epsForecast"]), "eps": parse_num(&r["eps"]), "surprisePct": parse_num(&r["surprise"]),
                "marketCap": parse_num(&r["marketCap"]),
            }))
            .collect();
        rows.sort_by(|a, b| b["marketCap"].as_f64().unwrap_or(0.0).total_cmp(&a["marketCap"].as_f64().unwrap_or(0.0)));
        rows.truncate(30);
        earnings.extend(rows);
        economy.extend(
            x["data"]["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| r["country"] == "United States")
                .map(|r| json!({
                    "date": d, "time": r["gmt"], "event": plain(r["eventName"].as_str().unwrap_or("")),
                    "actual": text(&r["actual"]), "consensus": text(&r["consensus"]), "previous": text(&r["previous"]),
                })),
        );
    }
    json!({ "earnings": earnings, "economy": economy })
}

fn sym(p: &Params) -> Result<String, axum::response::Response> {
    super::clean_symbol(&p.symbol).ok_or_else(|| fail("Give a ticker such as AAPL.".into()))
}

pub async fn profile_handler(Query(p): Query<Params>) -> axum::response::Response {
    let s = match sym(&p) { Ok(s) => s, Err(r) => return r };
    match profile(&s).await { Ok(v) => Json(v).into_response(), Err(e) => fail(e) }
}

pub async fn earnings_handler(Query(p): Query<Params>) -> axum::response::Response {
    let s = match sym(&p) { Ok(s) => s, Err(r) => return r };
    match earnings(&s).await { Ok(v) => Json(v).into_response(), Err(e) => fail(e) }
}

pub async fn ownership_handler(Query(p): Query<Params>) -> axum::response::Response {
    let s = match sym(&p) { Ok(s) => s, Err(r) => return r };
    match ownership(&s).await { Ok(v) => Json(v).into_response(), Err(e) => fail(e) }
}

pub async fn calendar_handler(Query(p): Query<Params>) -> axum::response::Response {
    Json(calendar(p.range.parse().unwrap_or(5)).await).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nasdaq_strings_become_numbers() {
        assert_eq!(parse_num(&json!("$1,234.50")), Some(1234.5));
        assert_eq!(parse_num(&json!("-3.54")), Some(-3.54));
        assert_eq!(parse_num(&json!("76.83%")), Some(76.83));
        assert_eq!(parse_num(&json!("N/A")), None);
        assert_eq!(parse_num(&json!(2.05)), Some(2.05));
    }

    #[test]
    fn descriptions_lose_html() {
        assert_eq!(plain("<p>Apple&#39;s &amp; <b>more</b></p>"), "Apple's & more");
    }

    #[test]
    fn calendar_skips_weekends() {
        let fri = NaiveDate::from_ymd_opt(2026, 11, 20).unwrap();
        let d = trading_days(fri, 3);
        assert_eq!(d.iter().map(|d| d.to_string()).collect::<Vec<_>>(), ["2026-11-20", "2026-11-23", "2026-11-24"]);
    }
}
