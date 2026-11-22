//! The user's portfolio (entered by hand or imported from a broker CSV),
//! practice trading with $100k of pretend money at delayed prices, and price
//! alerts. All stored locally in one file; nothing is sent to a broker.
//! A 15-minute loop fills practice limit orders and fires alerts into the Inbox.

use super::{clean_symbol, num, quotes};
use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

const START_CASH: f64 = 100_000.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Holding {
    pub symbol: String,
    pub shares: f64,
    /// Average cost per share; unknown for some imports.
    pub cost: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: String,
    pub symbol: String,
    pub side: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub shares: f64,
    pub limit: Option<f64>,
    pub status: String,
    pub created: i64,
    pub filled_at: Option<i64>,
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Practice {
    pub cash: f64,
    pub start: f64,
    pub positions: Vec<Holding>,
    pub orders: Vec<Order>,
}

impl Default for Practice {
    fn default() -> Self {
        Practice { cash: START_CASH, start: START_CASH, positions: vec![], orders: vec![] }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Alert {
    pub id: String,
    pub symbol: String,
    pub above: Option<f64>,
    pub below: Option<f64>,
    pub created: i64,
    pub triggered: Option<i64>,
    pub price: Option<f64>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Store {
    #[serde(default)]
    pub holdings: Vec<Holding>,
    #[serde(default)]
    pub practice: Practice,
    #[serde(default)]
    pub alerts: Vec<Alert>,
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> std::path::PathBuf {
    crate::paths::home_dir().join("finance-portfolio.json")
}

pub fn load() -> Store {
    std::fs::read_to_string(path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Read, change and save under one lock so the loop and the page can't overwrite each other.
fn update<T>(f: impl FnOnce(&mut Store) -> T) -> Result<(T, Store), String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = load();
    let out = f(&mut s);
    let tmp = path().with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path()).map_err(|e| e.to_string())?;
    Ok((out, s))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Apply a fill to cash and positions. Pure; Err leaves the account unchanged.
pub fn fill(p: &mut Practice, symbol: &str, side: &str, shares: f64, price: f64) -> Result<(), String> {
    let total = shares * price;
    let i = p.positions.iter().position(|h| h.symbol == symbol);
    if side == "buy" {
        if total > p.cash + 1e-6 {
            return Err(format!("Not enough practice cash: this costs ${total:.2} and you have ${:.2}.", p.cash));
        }
        p.cash -= total;
        match i {
            Some(i) => {
                let h = &mut p.positions[i];
                let cost = h.cost.unwrap_or(price);
                h.cost = Some((cost * h.shares + total) / (h.shares + shares));
                h.shares += shares;
            }
            None => p.positions.push(Holding { symbol: symbol.into(), shares, cost: Some(price) }),
        }
    } else {
        let held = i.map(|i| p.positions[i].shares).unwrap_or(0.0);
        if shares > held + 1e-9 {
            return Err(format!("You hold {held} shares of {symbol}, so you can't sell {shares}."));
        }
        p.cash += total;
        let i = i.unwrap();
        p.positions[i].shares -= shares;
        if p.positions[i].shares < 1e-9 {
            p.positions.remove(i);
        }
    }
    Ok(())
}

/// Does a limit order fill at this price?
pub fn limit_hits(side: &str, limit: f64, price: f64) -> bool {
    if side == "buy" { price <= limit } else { price >= limit }
}

/// Does this alert fire at this price?
pub fn alert_hits(a: &Alert, price: f64) -> bool {
    a.above.is_some_and(|x| price >= x) || a.below.is_some_and(|x| price <= x)
}

async fn price_of(symbol: &str) -> Result<f64, String> {
    let q = quotes(&[symbol.to_string()]).await?;
    q.first().and_then(|q| num(&q["price"])).ok_or_else(|| format!("No price for {symbol} right now."))
}

async fn prices(symbols: Vec<String>) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for c in symbols.chunks(20) {
        for q in quotes(c).await.unwrap_or_default() {
            if let (Some(s), Some(p)) = (q["symbol"].as_str(), num(&q["price"])) {
                out.insert(s.to_string(), p);
            }
        }
    }
    out
}

// ── Handlers ───────────────────────────────────────────────────────────

fn err(code: StatusCode, e: impl ToString) -> axum::response::Response {
    (code, Json(json!({ "error": e.to_string() }))).into_response()
}

pub async fn get_portfolio() -> impl IntoResponse {
    Json(json!({ "holdings": load().holdings }))
}

#[derive(Deserialize)]
pub struct HoldingsBody {
    holdings: Vec<Holding>,
}

pub async fn put_portfolio(Json(b): Json<HoldingsBody>) -> axum::response::Response {
    // Same symbol twice (two accounts): add the shares, weight the cost.
    let mut merged: Vec<Holding> = Vec::new();
    for h in b.holdings {
        let Some(sym) = clean_symbol(&h.symbol) else { continue };
        if !(h.shares.is_finite() && h.shares > 0.0) {
            continue;
        }
        let cost = h.cost.filter(|c| c.is_finite() && *c >= 0.0);
        match merged.iter_mut().find(|m| m.symbol == sym) {
            Some(m) => {
                m.cost = m.cost.zip(cost).map(|(a, b)| (a * m.shares + b * h.shares) / (m.shares + h.shares));
                m.shares += h.shares;
            }
            None => merged.push(Holding { symbol: sym, shares: h.shares, cost }),
        }
    }
    merged.truncate(500);
    match update(|s| s.holdings = merged) {
        Ok((_, s)) => Json(json!({ "holdings": s.holdings })).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

pub async fn get_practice() -> impl IntoResponse {
    Json(load().practice)
}

#[derive(Deserialize)]
pub struct OrderBody {
    symbol: String,
    side: String,
    #[serde(rename = "type")]
    kind: String,
    shares: f64,
    limit: Option<f64>,
}

pub async fn place_order(Json(b): Json<OrderBody>) -> axum::response::Response {
    let Some(symbol) = clean_symbol(&b.symbol) else { return err(StatusCode::BAD_REQUEST, "Give a ticker like AAPL.") };
    if !matches!(b.side.as_str(), "buy" | "sell") || !matches!(b.kind.as_str(), "market" | "limit") {
        return err(StatusCode::BAD_REQUEST, "Orders are buy or sell, market or limit.");
    }
    if !(b.shares.is_finite() && b.shares > 0.0 && b.shares <= 1e7) {
        return err(StatusCode::BAD_REQUEST, "Enter a number of shares above zero.");
    }
    let limit = b.limit.filter(|l| l.is_finite() && *l > 0.0);
    if b.kind == "limit" && limit.is_none() {
        return err(StatusCode::BAD_REQUEST, "A limit order needs a limit price.");
    }
    let price = match price_of(&symbol).await {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_GATEWAY, e),
    };
    let mut order = Order { id: uuid::Uuid::new_v4().to_string(), symbol: symbol.clone(), side: b.side.clone(), kind: b.kind.clone(), shares: b.shares, limit, status: "open".into(), created: now(), filled_at: None, price: None, note: None };
    let fills_now = b.kind == "market" || limit_hits(&b.side, limit.unwrap_or(0.0), price);
    let res = update(|s| {
        if fills_now {
            match fill(&mut s.practice, &symbol, &b.side, b.shares, price) {
                Ok(()) => {
                    order.status = "filled".into();
                    order.filled_at = Some(now());
                    order.price = Some(price);
                }
                Err(e) => {
                    order.status = "rejected".into();
                    order.note = Some(e);
                }
            }
        }
        s.practice.orders.insert(0, order);
        s.practice.orders.truncate(200);
    });
    match res {
        Ok((_, s)) => Json(s.practice).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

pub async fn cancel_order(Path(id): Path<String>) -> axum::response::Response {
    match update(|s| {
        if let Some(o) = s.practice.orders.iter_mut().find(|o| o.id == id && o.status == "open") {
            o.status = "cancelled".into();
        }
    }) {
        Ok((_, s)) => Json(s.practice).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

pub async fn reset_practice() -> axum::response::Response {
    match update(|s| s.practice = Practice::default()) {
        Ok((_, s)) => Json(s.practice).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

pub async fn get_alerts() -> impl IntoResponse {
    Json(load().alerts)
}

#[derive(Deserialize)]
pub struct AlertBody {
    symbol: String,
    above: Option<f64>,
    below: Option<f64>,
}

pub fn add_alert(symbol: &str, above: Option<f64>, below: Option<f64>) -> Result<Vec<Alert>, String> {
    let symbol = clean_symbol(symbol).ok_or("Give a ticker like AAPL.")?;
    let ok = |x: Option<f64>| x.filter(|v| v.is_finite() && *v > 0.0);
    let (above, below) = (ok(above), ok(below));
    if above.is_none() && below.is_none() {
        return Err("Say a price to watch for: above or below.".into());
    }
    let a = Alert { id: uuid::Uuid::new_v4().to_string(), symbol, above, below, created: now(), triggered: None, price: None };
    update(|s| {
        s.alerts.insert(0, a);
        s.alerts.truncate(100);
    })
    .map(|(_, s)| s.alerts)
}

pub async fn post_alert(Json(b): Json<AlertBody>) -> axum::response::Response {
    match add_alert(&b.symbol, b.above, b.below) {
        Ok(a) => Json(a).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

pub async fn delete_alert(Path(id): Path<String>) -> axum::response::Response {
    match update(|s| s.alerts.retain(|a| a.id != id)) {
        Ok((_, s)) => Json(s.alerts).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// For the chat tool.
pub async fn alert_text(args: &Value) -> String {
    let symbol = args["symbol"].as_str().unwrap_or("");
    match add_alert(symbol, num(&args["above"]), num(&args["below"])) {
        Err(e) => e,
        Ok(list) => {
            let a = &list[0];
            let when = match (a.above, a.below) {
                (Some(x), Some(y)) => format!("goes above ${x} or below ${y}"),
                (Some(x), None) => format!("goes above ${x}"),
                (None, Some(y)) => format!("falls below ${y}"),
                _ => String::new(),
            };
            format!("Alert set: you'll get an Inbox message when {} {when}. Prices are checked every 15 minutes; manage alerts on the Finance tab's Portfolio page.", a.symbol)
        }
    }
}

/// Holdings as text, so the chat can answer "how is my portfolio doing?".
pub async fn holdings_text() -> String {
    let s = load();
    if s.holdings.is_empty() && s.practice.positions.is_empty() {
        return "No holdings yet. They can be added on the Finance tab's Portfolio page (by hand or from a broker CSV).".into();
    }
    let syms: Vec<String> = s.holdings.iter().chain(&s.practice.positions).map(|h| h.symbol.clone()).collect();
    let px = prices(syms).await;
    let lines = |hs: &[Holding]| -> (Vec<String>, f64, f64) {
        let (mut value, mut cost) = (0.0, 0.0);
        let rows = hs
            .iter()
            .map(|h| {
                let p = px.get(&h.symbol).copied();
                let v = p.map(|p| p * h.shares);
                value += v.unwrap_or(0.0);
                cost += h.cost.map(|c| c * h.shares).unwrap_or(0.0);
                let gain = v.zip(h.cost).map(|(v, c)| format!(", gain {:+.1}%", (v / (c * h.shares) - 1.0) * 100.0)).unwrap_or_default();
                format!("- {} {} shares, now ${}{gain}", h.symbol, h.shares, v.map(|v| format!("{v:.0}")).unwrap_or("–".into()))
            })
            .collect();
        (rows, value, cost)
    };
    let mut out = String::new();
    if !s.holdings.is_empty() {
        let (rows, v, c) = lines(&s.holdings);
        out.push_str(&format!("Real portfolio (entered by the user): value ${v:.0}, cost ${c:.0}\n{}\n", rows.join("\n")));
    }
    if !s.practice.positions.is_empty() || s.practice.cash != s.practice.start {
        let (rows, v, _) = lines(&s.practice.positions);
        out.push_str(&format!("Practice account (pretend money): cash ${:.0}, positions ${v:.0}, total ${:.0} vs ${:.0} start\n{}\n", s.practice.cash, s.practice.cash + v, s.practice.start, rows.join("\n")));
    }
    out
}

// ── Background check ───────────────────────────────────────────────────

/// Every 15 minutes: fill practice limit orders that the price reached and fire alerts.
pub async fn watch_loop() {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(15 * 60));
    loop {
        tick.tick().await;
        if let Err(e) = check_once().await {
            tracing::warn!("finance watch: {e}");
        }
    }
}

async fn check_once() -> Result<(), String> {
    let s = load();
    let mut syms: Vec<String> = s.alerts.iter().filter(|a| a.triggered.is_none()).map(|a| a.symbol.clone()).chain(s.practice.orders.iter().filter(|o| o.status == "open").map(|o| o.symbol.clone())).collect();
    syms.sort();
    syms.dedup();
    if syms.is_empty() {
        return Ok(());
    }
    let px = prices(syms).await;
    let (msgs, _) = update(|s| {
        let mut msgs: Vec<(String, String)> = Vec::new();
        for a in s.alerts.iter_mut().filter(|a| a.triggered.is_none()) {
            let Some(&p) = px.get(&a.symbol) else { continue };
            if alert_hits(a, p) {
                a.triggered = Some(now());
                a.price = Some(p);
                let what = if a.above.is_some_and(|x| p >= x) { format!("rose above ${}", a.above.unwrap()) } else { format!("fell below ${}", a.below.unwrap_or(0.0)) };
                msgs.push((format!("{} {what}", a.symbol), format!("{} is at ${p:.2}. You asked to hear when it {what}.", a.symbol)));
            }
        }
        let open: Vec<usize> = s.practice.orders.iter().enumerate().filter(|(_, o)| o.status == "open").map(|(i, _)| i).collect();
        for i in open {
            let o = s.practice.orders[i].clone();
            let Some(&p) = px.get(&o.symbol) else { continue };
            if !limit_hits(&o.side, o.limit.unwrap_or(0.0), p) {
                continue;
            }
            let res = fill(&mut s.practice, &o.symbol, &o.side, o.shares, p);
            let o = &mut s.practice.orders[i];
            match res {
                Ok(()) => {
                    o.status = "filled".into();
                    o.filled_at = Some(now());
                    o.price = Some(p);
                    msgs.push((format!("Practice order filled: {} {} {}", o.side, o.shares, o.symbol), format!("Your practice limit order to {} {} {} at ${:.2} filled at ${p:.2}.", o.side, o.shares, o.symbol, o.limit.unwrap_or(p))));
                }
                Err(e) => {
                    o.status = "rejected".into();
                    o.note = Some(e);
                }
            }
        }
        msgs
    })?;
    for (title, body) in msgs {
        crate::inboxstore::create(crate::inboxstore::CreateParams { task_id: None, chat_id: None, kind: Some("finance".into()), title, body: Some(body), pending_action: None, files: vec![] });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buys_average_cost_and_sells_free_cash() {
        let mut p = Practice::default();
        fill(&mut p, "AAPL", "buy", 10.0, 100.0).unwrap();
        fill(&mut p, "AAPL", "buy", 10.0, 200.0).unwrap();
        assert_eq!(p.positions[0].cost, Some(150.0));
        assert_eq!(p.cash, START_CASH - 3000.0);
        assert!(fill(&mut p, "AAPL", "sell", 21.0, 1.0).is_err());
        assert!(fill(&mut p, "MSFT", "buy", 1000.0, 1000.0).is_err());
        fill(&mut p, "AAPL", "sell", 20.0, 175.0).unwrap();
        assert!(p.positions.is_empty());
        assert_eq!(p.cash, START_CASH + 500.0);
    }

    #[test]
    fn limits_and_alerts_trigger_on_the_right_side() {
        assert!(limit_hits("buy", 100.0, 99.0) && !limit_hits("buy", 100.0, 101.0));
        assert!(limit_hits("sell", 100.0, 101.0) && !limit_hits("sell", 100.0, 99.0));
        let a = Alert { id: "".into(), symbol: "X".into(), above: Some(110.0), below: Some(90.0), created: 0, triggered: None, price: None };
        assert!(alert_hits(&a, 111.0) && alert_hits(&a, 89.0) && !alert_hits(&a, 100.0));
    }
}
