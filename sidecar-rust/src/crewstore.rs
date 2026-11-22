//! Crew: named helpers for one recurring job each. Stored in `crew.json`.
//! Each member has its own instructions, the connected apps it may use
//! (empty = all) and an avatar.

use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct CrewMember {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub instructions: String,
    /// Composio app slugs ("gmail"); empty = every connected app.
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Deserialize, Default)]
pub struct CrewPatch {
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub color: Option<String>,
    pub instructions: Option<String>,
    pub apps: Option<Vec<String>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn list() -> Vec<CrewMember> {
    fs::read_to_string(crate::paths::crew_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// The built-in helper behind the Finance tab. Not stored in crew.json and not listed.
pub const FINANCE_ID: &str = "finance";

fn finance_member() -> CrewMember {
    let instructions = format!(
        "Help with markets and companies: prices, earnings, filings, news, comparisons.\n\
- get_stock_data for prices and trends, get_company_financials for revenue, profit, EPS and SEC filings (US-listed companies), get_market_news for headlines. Use web_search and web_fetch for anything else: analyst commentary, the text of a filing, non-US companies.\n\
- Say how current the data is and link your sources.\n\
- To show a chart, write a fenced block with the language `chart` containing JSON: {{\"type\": \"line\" or \"bar\", \"title\": \"...\", \"x\": \"year\", \"series\": [\"revenue\", \"netIncome\"], \"unit\": \"$B\", \"data\": [{{\"year\": \"2024\", \"revenue\": 391.0, \"netIncome\": 93.7}}]}}. At most 60 points; scale big numbers to the unit.\n\
- This is research, not personal investment advice. Don't tell the user to buy or sell; lay out the facts, the risks and what to watch.\n\
- Crypto is not supported yet.\n\n\
The user's watchlist: {}.",
        crate::finance::watchlist().join(", ")
    );
    CrewMember { id: FINANCE_ID.into(), name: "zWork Finance".into(), instructions, ..Default::default() }
}

pub fn get(id: &str) -> Option<CrewMember> {
    if id.is_empty() { return None; }
    if id == FINANCE_ID { return Some(finance_member()); }
    list().into_iter().find(|m| m.id == id)
}

fn save(all: &[CrewMember]) -> Result<(), String> {
    let p = crate::paths::crew_path();
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn apply(m: &mut CrewMember, p: CrewPatch) {
    if let Some(v) = p.name { m.name = v.trim().to_string(); }
    if let Some(v) = p.avatar { m.avatar = v; }
    if let Some(v) = p.color { m.color = v; }
    if let Some(v) = p.instructions { m.instructions = v; }
    if let Some(v) = p.apps { m.apps = v.into_iter().map(|a| a.to_lowercase()).collect(); }
    m.updated_at = now_ms();
}

/// The system-prompt block for a member, or None.
pub fn prompt_block(m: &CrewMember) -> String {
    format!("## You are {}\nYou are a zWork crew member with one job. Follow these instructions:\n\n{}", m.name, m.instructions.trim())
}

/// Whether a composio tool (`composio__GMAIL_SEND`) belongs to the member's apps.
pub fn allows_tool(m: &CrewMember, tool: &str) -> bool {
    m.apps.is_empty() || m.apps.iter().any(|a| tool.starts_with(&format!("composio__{}_", a.to_uppercase())))
}

fn err(e: String) -> axum::response::Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e }))).into_response()
}

pub async fn list_crew() -> impl IntoResponse {
    Json(list())
}

pub async fn create_crew(Json(p): Json<CrewPatch>) -> axum::response::Response {
    if p.name.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "Give them a name." }))).into_response();
    }
    let mut m = CrewMember { id: uuid::Uuid::new_v4().simple().to_string(), created_at: now_ms(), ..Default::default() };
    apply(&mut m, p);
    let mut all = list();
    all.push(m.clone());
    match save(&all) { Ok(()) => Json(m).into_response(), Err(e) => err(e) }
}

pub async fn update_crew(Path(id): Path<String>, Json(p): Json<CrewPatch>) -> axum::response::Response {
    let mut all = list();
    let Some(m) = all.iter_mut().find(|m| m.id == id) else { return StatusCode::NOT_FOUND.into_response() };
    apply(m, p);
    let m = m.clone();
    match save(&all) { Ok(()) => Json(m).into_response(), Err(e) => err(e) }
}

pub async fn delete_crew(Path(id): Path<String>) -> axum::response::Response {
    let mut all = list();
    all.retain(|m| m.id != id);
    match save(&all) { Ok(()) => StatusCode::NO_CONTENT.into_response(), Err(e) => err(e) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_tools_by_app() {
        let m = CrewMember { apps: vec!["gmail".into()], ..Default::default() };
        assert!(allows_tool(&m, "composio__GMAIL_SEND_EMAIL"));
        assert!(!allows_tool(&m, "composio__SLACK_POST"));
        assert!(allows_tool(&CrewMember::default(), "composio__SLACK_POST"));
    }
}
