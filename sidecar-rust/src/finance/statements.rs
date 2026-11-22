//! Income statement, balance sheet and cash flow from a company's SEC XBRL
//! facts, annual or quarterly, plus the full filing list.
//!
//! Periods come from net income. A quarter's flow (revenue, cash flow) is its
//! 3-month fact when one was filed; otherwise it's the year-to-date fact ending
//! that quarter minus the one ending the quarter before (how 10-Qs report cash
//! flow, and how a Q4 falls out of the 10-K). Balance-sheet items are the value
//! on the period's last day.

use super::{cik_for, fail, num, sec_data, Params, REVENUE_TAGS};
use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
struct Period {
    label: String,
    frame: String,
    start: String,
    end: String,
}

fn facts<'a>(all: &'a Value, tag: &str, unit: &str) -> Vec<&'a Value> {
    all["facts"]["us-gaap"][tag]["units"][unit].as_array().map(|a| a.iter().collect()).unwrap_or_default()
}

fn days(a: &str, b: &str) -> i64 {
    let d = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
    d(a).zip(d(b)).map(|(a, b)| (b - a).num_days()).unwrap_or(0)
}

/// "2025-09-27" → "Sep 2025". Quarters are named by the month they end, so fiscal and calendar years can't be confused.
fn month(end: &str) -> String {
    chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d").map(|d| d.format("%b %Y").to_string()).unwrap_or_else(|_| end.into())
}

fn periods(all: &Value, quarterly: bool) -> Vec<Period> {
    let mut out: Vec<Period> = Vec::new();
    for f in facts(all, "NetIncomeLoss", "USD") {
        let (Some(frame), Some(start), Some(end)) = (f["frame"].as_str(), f["start"].as_str(), f["end"].as_str()) else { continue };
        let is_q = frame.len() == 8 && frame.as_bytes()[6] == b'Q';
        let is_y = frame.len() == 6;
        if quarterly && is_q {
            out.push(Period { label: month(end), frame: frame.into(), start: start.into(), end: end.into() });
        } else if is_y {
            if quarterly {
                // The fourth quarter only exists inside the annual report.
                out.push(Period { label: month(end), frame: String::new(), start: start.into(), end: end.into() });
            } else {
                out.push(Period { label: frame[2..6].into(), frame: frame.into(), start: start.into(), end: end.into() });
            }
        }
    }
    out.sort_by(|a, b| a.end.cmp(&b.end));
    // A quarterly frame and a 10-K both ending the same day: keep the real quarter.
    out.dedup_by(|b, a| {
        let same = a.end == b.end;
        if same && a.frame.is_empty() {
            *a = b.clone();
        }
        same
    });
    let keep = if quarterly { 8 } else { 6 };
    let skip = out.len().saturating_sub(keep);
    out.into_iter().skip(skip).collect()
}

/// A flow value (revenue, cash flow) for one period.
fn flow(all: &Value, tag: &str, unit: &str, p: &Period, prev_end: Option<&str>, quarterly: bool) -> Option<f64> {
    let fs = facts(all, tag, unit);
    if !p.frame.is_empty() {
        if let Some(v) = fs.iter().find(|f| f["frame"].as_str() == Some(&p.frame)).and_then(|f| num(&f["val"])) {
            return Some(v);
        }
    }
    if !quarterly {
        // Annual without a frame match: the ~12-month fact ending that day.
        return fs.iter().filter(|f| f["end"].as_str() == Some(&p.end) && f["start"].as_str().is_some_and(|s| (330..400).contains(&days(s, &p.end)))).filter_map(|f| num(&f["val"])).last();
    }
    if unit != "USD" {
        return None; // per-share values don't subtract
    }
    let prev_end = prev_end?;
    // Year-to-date ending this quarter, minus year-to-date (same start) ending last quarter.
    for f in fs.iter().filter(|f| f["end"].as_str() == Some(&p.end)) {
        let Some(start) = f["start"].as_str() else { continue };
        if days(start, &p.end) < 100 {
            continue;
        }
        if let Some(before) = fs.iter().find(|g| g["start"].as_str() == Some(start) && g["end"].as_str() == Some(prev_end)) {
            return Some(num(&f["val"])? - num(&before["val"])?);
        }
        // No year-to-date for last quarter (common for net income): the year minus its three filed quarters.
        let quarters: Vec<f64> = fs
            .iter()
            .filter(|g| g["start"].as_str().is_some_and(|s| s >= start && (80..100).contains(&days(s, g["end"].as_str().unwrap_or("")))) && g["end"].as_str().is_some_and(|e| e < p.end.as_str()))
            .filter_map(|g| Some((g["end"].as_str()?, num(&g["val"])?)))
            .collect::<std::collections::BTreeMap<_, _>>()
            .into_values()
            .collect();
        if days(start, &p.end) > 330 && quarters.len() == 3 {
            return Some(num(&f["val"])? - quarters.iter().sum::<f64>());
        }
    }
    None
}

/// A balance-sheet value on the period's last day, from the latest filing that reported it.
fn instant(all: &Value, tag: &str, p: &Period) -> Option<f64> {
    facts(all, tag, "USD").into_iter().filter(|f| f["start"].is_null() && f["end"].as_str() == Some(&p.end)).max_by_key(|f| f["filed"].as_str().unwrap_or("").to_string()).and_then(|f| num(&f["val"]))
}

enum Src {
    Flow(&'static [&'static str], &'static str),
    Instant(&'static [&'static str]),
}

fn series(all: &Value, src: &Src, ps: &[Period], quarterly: bool) -> Vec<Option<f64>> {
    ps.iter()
        .enumerate()
        .map(|(i, p)| {
            let prev = i.checked_sub(1).map(|j| ps[j].end.as_str());
            // For tags that mean the same thing, take the largest reported (total revenue over a sub-line).
            let vals: Vec<f64> = match src {
                Src::Flow(tags, unit) => tags.iter().filter_map(|t| flow(all, t, unit, p, prev, quarterly)).collect(),
                Src::Instant(tags) => return tags.iter().find_map(|t| instant(all, t, p)),
            };
            vals.into_iter().reduce(f64::max)
        })
        .collect()
}

fn ratio(a: &[Option<f64>], b: &[Option<f64>]) -> Vec<Option<f64>> {
    a.iter().zip(b).map(|(a, b)| a.zip(*b).filter(|(_, b)| *b != 0.0).map(|(a, b)| a / b * 100.0)).collect()
}
fn minus(a: &[Option<f64>], b: &[Option<f64>]) -> Vec<Option<f64>> {
    a.iter().zip(b).map(|(a, b)| a.zip(*b).map(|(a, b)| a - b)).collect()
}

/// Pure: XBRL company facts → statement sections. Tested on a fixture below.
pub fn build(all: &Value, quarterly: bool) -> Value {
    let ps = periods(all, quarterly);
    let s = |src: Src| series(all, &src, &ps, quarterly);
    let usd = |tags| Src::Flow(tags, "USD");
    let revenue = s(usd(REVENUE_TAGS));
    let cost = s(usd(&["CostOfRevenue", "CostOfGoodsAndServicesSold"]));
    let gross_reported = s(usd(&["GrossProfit"]));
    let gross: Vec<Option<f64>> = gross_reported.iter().zip(minus(&revenue, &cost)).map(|(g, d)| g.or(d)).collect();
    let op = s(usd(&["OperatingIncomeLoss"]));
    let net = s(usd(&["NetIncomeLoss"]));
    let ocf = s(usd(&["NetCashProvidedByUsedInOperatingActivities"]));
    let capex = s(usd(&["PaymentsToAcquirePropertyPlantAndEquipment"]));
    let assets = s(Src::Instant(&["Assets"]));
    let equity = s(Src::Instant(&["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]));
    let liab_reported = s(Src::Instant(&["Liabilities"]));
    let liabilities: Vec<Option<f64>> = liab_reported.iter().zip(minus(&assets, &equity)).map(|(l, d)| l.or(d)).collect();
    let row = |label: &str, kind: &str, values: Vec<Option<f64>>| json!({ "label": label, "kind": kind, "values": values });
    let sections = vec![
        json!({ "title": "Income statement", "rows": [
            row("Revenue", "usd", revenue.clone()),
            row("Cost of revenue", "usd", cost),
            row("Gross profit", "usd", gross.clone()),
            row("Research and development", "usd", s(usd(&["ResearchAndDevelopmentExpense"]))),
            row("Sales, general and admin", "usd", s(usd(&["SellingGeneralAndAdministrativeExpense"]))),
            row("Operating income", "usd", op.clone()),
            row("Net income", "usd", net.clone()),
            row("Earnings per share (diluted)", "eps", s(Src::Flow(&["EarningsPerShareDiluted"], "USD/shares"))),
        ]}),
        json!({ "title": "Margins", "rows": [
            row("Gross margin", "pct", ratio(&gross, &revenue)),
            row("Operating margin", "pct", ratio(&op, &revenue)),
            row("Net margin", "pct", ratio(&net, &revenue)),
        ]}),
        json!({ "title": "Balance sheet", "rows": [
            row("Cash and equivalents", "usd", s(Src::Instant(&["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]))),
            row("Total assets", "usd", assets),
            row("Total liabilities", "usd", liabilities),
            row("Long-term debt", "usd", s(Src::Instant(&["LongTermDebtNoncurrent", "LongTermDebt"]))),
            row("Shareholders' equity", "usd", equity),
        ]}),
        json!({ "title": "Cash flow", "rows": [
            row("Operating cash flow", "usd", ocf.clone()),
            row("Capital spending", "usd", capex.clone()),
            row("Free cash flow", "usd", minus(&ocf, &capex)),
            row("Stock buybacks", "usd", s(usd(&["PaymentsForRepurchaseOfCommonStock"]))),
            row("Dividends paid", "usd", s(usd(&["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"]))),
        ]}),
    ];
    json!({
        "name": all["entityName"],
        "period": if quarterly { "quarterly" } else { "annual" },
        "periods": ps.iter().map(|p| p.label.clone()).collect::<Vec<_>>(),
        "ends": ps.iter().map(|p| p.end.clone()).collect::<Vec<_>>(),
        "starts": ps.iter().map(|p| p.start.clone()).collect::<Vec<_>>(),
        "sections": sections,
    })
}

/// The company's filings, newest first, with 8-K item numbers. Form 4s and other noise are left out.
pub fn filing_list(subs: &Value, cik: u64, n: usize) -> Vec<Value> {
    let recent = &subs["filings"]["recent"];
    let col = |k: &str| recent[k].as_array().cloned().unwrap_or_default();
    let (forms, dates, accs, docs, descs, items) = (col("form"), col("filingDate"), col("accessionNumber"), col("primaryDocument"), col("primaryDocDescription"), col("items"));
    let s = |c: &Vec<Value>, i: usize| c.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
    (0..forms.len())
        .filter(|&i| matches!(forms[i].as_str(), Some("10-K" | "10-Q" | "8-K" | "20-F" | "6-K" | "40-F" | "DEF 14A" | "S-1" | "S-3" | "424B2" | "SC 13D" | "SC 13G" | "10-K/A" | "10-Q/A" | "8-K/A")))
        .take(n)
        .map(|i| {
            let form = s(&forms, i);
            let desc = s(&descs, i);
            json!({
                "form": form,
                "date": s(&dates, i),
                "title": if desc.is_empty() { form.clone() } else { desc },
                "url": format!("https://www.sec.gov/Archives/edgar/data/{cik}/{}/{}", s(&accs, i).replace('-', ""), s(&docs, i)),
                "items": s(&items, i),
            })
        })
        .collect()
}

pub async fn statements(symbol: &str, quarterly: bool) -> Result<Value, String> {
    let (cik, title) = cik_for(symbol).await?;
    let (facts, _) = sec_data(cik).await;
    let mut out = build(&facts?, quarterly);
    out["symbol"] = json!(symbol);
    if out["name"].is_null() {
        out["name"] = json!(title);
    }
    Ok(out)
}

pub async fn statements_handler(Query(p): Query<Params>) -> axum::response::Response {
    let Some(sym) = super::clean_symbol(&p.symbol) else { return StatusCode::BAD_REQUEST.into_response() };
    match statements(&sym, p.range == "quarterly").await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))).into_response(),
    }
}

pub async fn filings_handler(Query(p): Query<Params>) -> axum::response::Response {
    let Some(sym) = super::clean_symbol(&p.symbol) else { return StatusCode::BAD_REQUEST.into_response() };
    let (cik, _) = match cik_for(&sym).await {
        Ok(c) => c,
        Err(e) => return (StatusCode::NOT_FOUND, Json(json!({ "error": e }))).into_response(),
    };
    match sec_data(cik).await.1 {
        Ok(subs) => Json(filing_list(&subs, cik, 40)).into_response(),
        Err(e) => fail(e),
    }
}

/// Statements as text for the chat.
pub async fn statements_text(symbol: &str, quarterly: bool) -> String {
    let Some(sym) = super::clean_symbol(symbol) else { return "Give a ticker like AAPL.".into() };
    match statements(&sym, quarterly).await {
        Err(e) => e,
        Ok(v) => {
            let periods: Vec<String> = v["periods"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(String::from)).collect();
            let mut out = format!("{} ({sym}) {} statements from SEC filings. Periods: {}\n", v["name"].as_str().unwrap_or(""), v["period"].as_str().unwrap_or(""), periods.join(", "));
            for sec in v["sections"].as_array().into_iter().flatten() {
                out.push_str(&format!("\n{}\n", sec["title"].as_str().unwrap_or("")));
                for r in sec["rows"].as_array().into_iter().flatten() {
                    let kind = r["kind"].as_str().unwrap_or("usd");
                    let vals: Vec<String> = r["values"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|x| match (num(x), kind) {
                            (None, _) => "–".into(),
                            (Some(n), "pct") => format!("{n:.1}%"),
                            (Some(n), "eps") => format!("${n:.2}"),
                            (Some(n), _) => format!("${:.2}B", n / 1e9),
                        })
                        .collect();
                    out.push_str(&format!("- {}: {}\n", r["label"].as_str().unwrap_or(""), vals.join(" | ")));
                }
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(start: Option<&str>, end: &str, val: f64, frame: Option<&str>) -> Value {
        let mut f = json!({ "end": end, "val": val, "filed": "2026-01-30" });
        if let Some(s) = start { f["start"] = json!(s); }
        if let Some(fr) = frame { f["frame"] = json!(fr); }
        f
    }

    #[test]
    fn quarters_fill_from_year_to_date_and_the_annual_report() {
        let ni = vec![
            fact(Some("2025-01-01"), "2025-03-31", 10.0, Some("CY2025Q1")),
            fact(Some("2025-04-01"), "2025-06-30", 11.0, Some("CY2025Q2")),
            fact(Some("2025-07-01"), "2025-09-30", 12.0, Some("CY2025Q3")),
            fact(Some("2025-01-01"), "2025-12-31", 50.0, Some("CY2025")),
        ];
        // Cash flow only as year-to-date, like a real 10-Q.
        let ocf = vec![
            fact(Some("2025-01-01"), "2025-03-31", 5.0, Some("CY2025Q1")),
            fact(Some("2025-01-01"), "2025-06-30", 12.0, None),
            fact(Some("2025-01-01"), "2025-09-30", 20.0, None),
            fact(Some("2025-01-01"), "2025-12-31", 30.0, Some("CY2025")),
        ];
        let all = json!({ "entityName": "Co", "facts": { "us-gaap": {
            "NetIncomeLoss": { "units": { "USD": ni } },
            "NetCashProvidedByUsedInOperatingActivities": { "units": { "USD": ocf } },
            "Assets": { "units": { "USD": [ fact(None, "2025-12-31", 900.0, Some("CY2025Q4I")) ] } },
        } } });
        let q = build(&all, true);
        assert_eq!(q["periods"], json!(["Mar 2025", "Jun 2025", "Sep 2025", "Dec 2025"]));
        let rows = |s: usize, r: usize| q["sections"][s]["rows"][r]["values"].clone();
        assert_eq!(rows(0, 6), json!([10.0, 11.0, 12.0, 17.0])); // net income; Q4 = 50 - 33
        assert_eq!(rows(3, 0), json!([5.0, 7.0, 8.0, 10.0])); // operating cash flow
        assert_eq!(rows(2, 1), json!([null, null, null, 900.0])); // assets on the last day
        let y = build(&all, false);
        assert_eq!(y["periods"], json!(["2025"]));
        assert_eq!(y["sections"][3]["rows"][0]["values"], json!([30.0]));
    }

    #[test]
    fn filings_keep_items_and_drop_form_4() {
        let subs = json!({ "filings": { "recent": {
            "form": ["4", "8-K"], "filingDate": ["2026-11-02", "2026-11-01"], "accessionNumber": ["a", "0001-26-1"],
            "primaryDocument": ["x.xml", "e.htm"], "primaryDocDescription": ["", ""], "items": ["", "2.02,9.01"]
        } } });
        let l = filing_list(&subs, 7, 10);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["items"], "2.02,9.01");
        assert_eq!(l[0]["title"], "8-K");
    }
}
