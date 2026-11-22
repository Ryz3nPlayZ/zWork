//! The S&P 500 as one table: today's price and move, market cap and a few
//! fundamentals, for the heatmap, the movers list and the screener.
//! Prices come from Yahoo's spark endpoint; shares, revenue, profit, EPS and
//! dividends from SEC EDGAR "frames" (one value per company per period, all
//! companies in one file), so the whole table costs ~60 requests and is cached.

use super::{cached, num, quotes, sec_json, spark_many};
use axum::{response::IntoResponse, Json};
use chrono::Datelike;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

const SP500: &str = include_str!("sp500.tsv");

pub struct Member {
    pub symbol: &'static str,
    pub name: &'static str,
    pub sector: &'static str,
    pub industry: &'static str,
    pub cik: u64,
}

pub fn members() -> Vec<Member> {
    SP500
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .filter_map(|l| {
            let mut f = l.split('\t');
            Some(Member { symbol: f.next()?, name: f.next()?, sector: f.next()?, industry: f.next()?, cik: f.next()?.trim().parse().ok()? })
        })
        .collect()
}

/// cik → value from one frames file. Missing file → empty map (the column shows "–").
async fn frame(concept: &str, unit: &str, period: &str) -> HashMap<u64, f64> {
    let url = format!("https://data.sec.gov/api/xbrl/frames/{concept}/{unit}/{period}.json");
    let body = sec_json(&url, 86_400).await.unwrap_or(Value::Null);
    body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| Some((d["cik"].as_u64()?, num(&d["val"])?)))
        .collect()
}

/// The larger of two maps per key: companies report total revenue under either tag.
fn max_merge(a: HashMap<u64, f64>, b: HashMap<u64, f64>) -> HashMap<u64, f64> {
    let mut out = a;
    for (k, v) in b {
        let e = out.entry(k).or_insert(v);
        if v > *e {
            *e = v;
        }
    }
    out
}

pub struct Fundamentals {
    shares: HashMap<u64, f64>,
    rev: HashMap<u64, f64>,
    rev_prev: HashMap<u64, f64>,
    net: HashMap<u64, f64>,
    eps: HashMap<u64, f64>,
    dps: HashMap<u64, f64>,
}

async fn fundamentals(year: i32) -> Fundamentals {
    let (y, p) = (format!("CY{year}"), format!("CY{}", year - 1));
    let rev_tag = "us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax";
    let (shares, r1, r2, q1, q2, net, eps, dps, paid) = tokio::join!(
        // shortcut: diluted weighted-average shares, not today's count; off by recent buybacks. Fine for a heatmap and a screener.
        frame("us-gaap/WeightedAverageNumberOfDilutedSharesOutstanding", "shares", &y),
        frame("us-gaap/Revenues", "USD", &y),
        frame(rev_tag, "USD", &y),
        frame("us-gaap/Revenues", "USD", &p),
        frame(rev_tag, "USD", &p),
        frame("us-gaap/NetIncomeLoss", "USD", &y),
        frame("us-gaap/EarningsPerShareDiluted", "USD-per-shares", &y),
        frame("us-gaap/CommonStockDividendsPerShareDeclared", "USD-per-shares", &y),
        frame("us-gaap/CommonStockDividendsPerShareCashPaid", "USD-per-shares", &y),
    );
    Fundamentals { shares, rev: max_merge(r1, r2), rev_prev: max_merge(q1, q2), net, eps, dps: max_merge(dps, paid) }
}

/// One screener row. Pure so it can be tested.
pub fn row(m: &Member, q: Option<&Value>, f: &Fundamentals, ytd: Option<&Vec<(i64, f64)>>) -> Value {
    let price = q.and_then(|q| num(&q["price"]));
    let rev = f.rev.get(&m.cik).copied();
    let eps = f.eps.get(&m.cik).copied();
    let pct = |a: Option<f64>, b: Option<f64>| a.zip(b).filter(|(_, b)| *b > 0.0).map(|(a, b)| (a / b - 1.0) * 100.0);
    let last = ytd.and_then(|s| s.last()).map(|p| p.1);
    json!({
        "symbol": m.symbol,
        "name": m.name,
        "sector": m.sector,
        "industry": m.industry,
        "price": price,
        "changePct": q.and_then(|q| num(&q["changePct"])),
        "marketCap": price.zip(f.shares.get(&m.cik).copied()).map(|(p, s)| p * s),
        "pe": price.zip(eps).filter(|(_, e)| *e > 0.0).map(|(p, e)| p / e),
        "revenueGrowth": pct(rev, f.rev_prev.get(&m.cik).copied()),
        "netMargin": f.net.get(&m.cik).copied().zip(rev).filter(|(_, r)| *r > 0.0).map(|(n, r)| n / r * 100.0),
        "dividendYield": price.zip(f.dps.get(&m.cik).copied()).filter(|(p, _)| *p > 0.0).map(|(p, d)| d / p * 100.0),
        // ~21 trading days back is a month.
        "change1m": pct(last, ytd.and_then(|s| s.len().checked_sub(22).map(|i| s[i].1))),
        // shortcut: YTD from the first close of the year, not last year's close; off by one day's move.
        "changeYtd": pct(last, ytd.and_then(|s| s.first()).map(|p| p.1)),
    })
}

pub async fn universe() -> Result<Value, String> {
    cached("finance:universe", Duration::from_secs(300), || async {
        let ms = members();
        let symbols: Vec<String> = ms.iter().map(|m| m.symbol.to_string()).collect();
        // Last full calendar year that's been reported by nearly everyone (10-Ks land by March).
        let now = chrono::Utc::now();
        let year = if now.month() >= 4 { now.year() - 1 } else { now.year() - 2 };
        let chunks: Vec<Vec<String>> = symbols.chunks(20).map(|c| c.to_vec()).collect();
        let quote_lists = futures_util::stream::iter(chunks).map(|c| async move { quotes(&c).await.unwrap_or_default() }).buffer_unordered(4).collect::<Vec<_>>();
        let (quote_lists, f, ytd) = tokio::join!(quote_lists, fundamentals(year), spark_many(&symbols, "ytd", "1d"));
        let by_sym: HashMap<String, Value> = quote_lists.into_iter().flatten().filter_map(|q| Some((q["symbol"].as_str()?.to_string(), q))).collect();
        let rows: Vec<Value> = ms.iter().map(|m| row(m, by_sym.get(m.symbol), &f, ytd.get(m.symbol))).collect();
        let complete = by_sym.len() * 10 >= ms.len() * 9 && !f.shares.is_empty();
        if by_sym.is_empty() {
            return Err("Prices for the S&P 500 aren't available right now.".into());
        }
        Ok(json!({ "asOf": now.timestamp(), "complete": complete, "fiscalYear": year, "rows": rows }))
    })
    .await
}

pub async fn universe_handler() -> axum::response::Response {
    match universe().await {
        Ok(v) => Json(v).into_response(),
        Err(e) => super::fail(e),
    }
}

/// The screener as text for the chat: the matching rows, best first.
pub async fn screen_text(sector: &str, sort: &str, ascending: bool, limit: usize) -> String {
    let u = match universe().await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut rows: Vec<&Value> = u["rows"].as_array().into_iter().flatten().filter(|r| sector.is_empty() || r["sector"].as_str().is_some_and(|s| s.eq_ignore_ascii_case(sector))).collect();
    let key = if sort.is_empty() { "marketCap" } else { sort };
    // Rows without the value go last either way.
    rows.retain(|r| num(&r[key]).is_some());
    rows.sort_by(|a, b| {
        let (a, b) = (num(&a[key]).unwrap_or(0.0), num(&b[key]).unwrap_or(0.0));
        if ascending { a.total_cmp(&b) } else { b.total_cmp(&a) }
    });
    if rows.is_empty() {
        return format!("No S&P 500 companies match (sector '{sector}'). Sectors: Information Technology, Health Care, Financials, Consumer Discretionary, Communication Services, Industrials, Consumer Staples, Energy, Utilities, Real Estate, Materials.");
    }
    rows.iter()
        .take(limit)
        .map(|r| {
            let f = |k: &str, d: usize| num(&r[k]).map(|v| format!("{v:.d$}")).unwrap_or_else(|| "–".into());
            format!("{} {}: ${} ({}% today), cap ${}B, P/E {}, rev growth {}%, net margin {}%, yield {}%, YTD {}%", r["symbol"].as_str().unwrap_or(""), r["name"].as_str().unwrap_or(""), f("price", 2), f("changePct", 2), num(&r["marketCap"]).map(|c| format!("{:.0}", c / 1e9)).unwrap_or("–".into()), f("pe", 1), f("revenueGrowth", 1), f("netMargin", 1), f("dividendYield", 2), f("changeYtd", 1))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_has_the_whole_index() {
        let ms = members();
        assert!(ms.len() > 490, "{}", ms.len());
        assert!(ms.iter().any(|m| m.symbol == "AAPL" && m.cik == 320193));
    }

    #[test]
    fn row_math() {
        let m = Member { symbol: "AAPL", name: "Apple", sector: "Information Technology", industry: "", cik: 1 };
        let one = |v: f64| HashMap::from([(1u64, v)]);
        let f = Fundamentals { shares: one(10.0), rev: one(120.0), rev_prev: one(100.0), net: one(30.0), eps: one(5.0), dps: one(2.0) };
        let q = json!({ "price": 100.0, "changePct": 1.5 });
        let ytd: Vec<(i64, f64)> = (0..30).map(|i| (i, if i == 0 { 50.0 } else { 80.0 + i as f64 * 0.0 })).chain([(31, 100.0)]).collect();
        let r = row(&m, Some(&q), &f, Some(&ytd));
        assert_eq!(r["marketCap"], 1000.0);
        assert_eq!(r["pe"], 20.0);
        assert!((r["revenueGrowth"].as_f64().unwrap() - 20.0).abs() < 1e-9);
        assert_eq!(r["netMargin"], 25.0);
        assert_eq!(r["dividendYield"], 2.0);
        assert_eq!(r["changeYtd"], 100.0);
        assert_eq!(r["change1m"], 25.0);
        // No price: nothing that depends on it.
        let r = row(&m, None, &f, None);
        assert!(r["marketCap"].is_null() && r["pe"].is_null() && r["changeYtd"].is_null());
    }
}
