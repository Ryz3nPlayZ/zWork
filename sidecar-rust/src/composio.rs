//! Composio integration: connect user apps (Gmail, Calendar, Slack, …) and
//! expose their actions as tools prefixed `composio__`.
//!
//! All Composio API calls are proxied through the zWork cloud server
//! (api.tryzwork.app) so the platform API key never touches the client. The
//! local sidecar only forwards the user's `zwork_router` bearer token — the
//! cloud service (`cloud-src/api`) owns the real Composio SDK interaction.

use serde_json::{json, Value};
use std::time::Duration;

/// Prefix for every Composio-exposed tool name.
pub const TOOL_PREFIX: &str = "composio__";

/// Base URL for the zWork cloud Composio proxy. Overridable for dev/test.
fn cloud_base() -> String {
    std::env::var("ZWORK_CLOUD_API_BASE")
        .unwrap_or_else(|_| "https://api.tryzwork.app/api/composio".to_string())
}

/// Load the zWork cloud auth token from persisted settings.
fn cloud_token() -> String {
    let s = crate::settings::load();
    s.api_keys.get("zwork_router").cloned().unwrap_or_default()
}

/// A configured reqwest client with the user's bearer token attached.
/// Returns `None` when there is no token to send (caller should report
/// "not configured" rather than making an unauthenticated request).
fn authed_client() -> Option<reqwest::Client> {
    let token = cloud_token();
    if token.is_empty() {
        return None;
    }
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token)) {
        headers.insert(reqwest::header::AUTHORIZATION, v);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(30))
        .build()
        .ok()
}

/// Whether Composio is reachable for this user — i.e. a cloud token exists.
pub fn is_configured() -> bool {
    !cloud_token().is_empty()
}

/// `GET /status` → full status block echoed to the Connectors UI.
pub async fn status() -> Value {
    // Unconfigured users still get a well-formed payload so the frontend can
    // render the grid and prompt for setup.
    if !is_configured() {
        return json!({
            "enabled": false,
            "configured": false,
            "available": false,
            "connected_apps": [],
            "tool_count": 0,
            "user_id": "",
        });
    }
    let client = match authed_client() {
        Some(c) => c,
        None => {
            return json!({
                "enabled": false, "configured": false, "available": false,
                "connected_apps": [], "tool_count": 0, "user_id": "",
            })
        }
    };
    match client.get(format!("{}/status", cloud_base())).send().await {
        Ok(resp) if resp.status().is_success() => {
            resp.json::<Value>().await.unwrap_or_else(|_| json!({
                "enabled": true, "configured": true, "available": true,
                "connected_apps": [], "tool_count": 0, "user_id": "",
            }))
        }
        _ => json!({
            "enabled": true, "configured": true, "available": false,
            "connected_apps": [], "tool_count": 0, "user_id": "",
        }),
    }
}

/// `GET /accounts` → `{ "accounts": [...] }`.
pub async fn accounts() -> Value {
    let Some(client) = authed_client() else {
        return json!({ "accounts": [] });
    };
    match client
        .get(format!("{}/accounts", cloud_base()))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            resp.json::<Value>().await.unwrap_or_else(|_| json!({ "accounts": [] }))
        }
        _ => json!({ "accounts": [] }),
    }
}

/// `POST /connect` with `{ "app": <name> }` → `{ "url": <oauth redirect> }`.
///
/// Errors are surfaced as a human-readable `String` so the route handler can
/// turn them into a 4xx with a useful message.
pub async fn connect(app: &str) -> Result<Value, String> {
    let client = authed_client().ok_or_else(|| {
        "Sign in to zWork Cloud to connect integrations.".to_string()
    })?;
    let resp = client
        .post(format!("{}/connect", cloud_base()))
        .json(&json!({ "app": app }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach zWork Cloud: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        // Translate the cloud's structured errors into a user-facing message.
        if status.as_u16() == 404 || body.contains("auth_config_not_found") {
            return Err(format!(
                "{} is not yet configured. Please contact support to enable this integration.",
                app
            ));
        }
        return Err(format!(
            "Failed to get connect link for {}: {} {}",
            app,
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        ));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("Invalid response from zWork Cloud: {}", e))
}

/// `POST /disconnect` with `{ "app": <name> }` → `{ "ok": true, "connected_apps": [...] }`.
pub async fn disconnect(app: &str) -> Result<Value, String> {
    let client = authed_client().ok_or_else(|| {
        "Sign in to zWork Cloud to manage integrations.".to_string()
    })?;
    let resp = client
        .post(format!("{}/disconnect", cloud_base()))
        .json(&json!({ "app": app }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach zWork Cloud: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Failed to disconnect {}: {}",
            app,
            resp.status().as_u16()
        ));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("Invalid response from zWork Cloud: {}", e))
}

/// Static, curated app catalogue so the Connectors page grid renders even
/// before the user has a token. Mirrors the cloud's `composio_apps` list so
/// the two stay in sync.
pub fn apps() -> Value {
    // (id, name, icon, color)
    let apps: &[(&str, &str, &str, &str)] = &[
        ("gmail", "Gmail", "mail", "#EA4335"),
        ("googlecalendar", "Google Calendar", "calendar", "#4285F4"),
        ("slack", "Slack", "hash", "#4A154B"),
        ("notion", "Notion", "book-open", "#000000"),
        ("googledrive", "Google Drive", "folder", "#0F9D58"),
        ("github", "GitHub", "git-branch", "#24292F"),
        ("jira", "Jira", "layers", "#0052CC"),
        ("trello", "Trello", "layout-grid", "#0079BF"),
        ("todoist", "Todoist", "check-square", "#E44332"),
        ("linear", "Linear", "zap", "#5E6AD2"),
        ("asana", "Asana", "target", "#F06A6A"),
        ("hubspot", "HubSpot", "circle-dot", "#FF7A59"),
    ];
    let apps: Vec<Value> = apps
        .iter()
        .map(|(id, name, icon, color)| {
            json!({ "id": id, "name": name, "icon": icon, "color": color })
        })
        .collect();
    json!({ "apps": apps })
}

/// Build the `{connected_apps_block}` substitution for the system prompt from
/// already-fetched tool schemas and the user's connected-app list. Empty when
/// nothing is connected, so the prompt section simply collapses. This mirrors
/// Python's `settings._connected_apps_block`.
pub fn build_connected_apps_block(schemas: &[Value], connected_apps: &[String]) -> String {
    if schemas.is_empty() || connected_apps.is_empty() {
        return String::new();
    }
    let tool_names: Vec<&str> = schemas
        .iter()
        .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
        .collect();
    let app_list = connected_apps
        .iter()
        .map(|a| {
            // Title-case the slug: "googlecalendar" → "Googlecalendar"
            let mut c = a.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let shown: Vec<String> = tool_names.iter().take(20).map(|n| format!("`{}`", n)).collect();
    let extra = if tool_names.len() > 20 {
        format!("\n  - ...and {} more", tool_names.len() - 20)
    } else {
        String::new()
    };

    // App-specific intent→tool examples, matching the Python implementation.
    let lower: Vec<String> = connected_apps.iter().map(|a| a.to_lowercase()).collect();
    let mut examples: Vec<&str> = Vec::new();
    if lower.iter().any(|a| a == "gmail") {
        examples.extend(&[
            "  - \"check my email\" / \"any new emails?\" → a `composio__GMAIL_*` tool (read/search)",
            "  - \"send an email to X about Y\" → `composio__GMAIL_SEND_EMAIL`",
        ]);
    }
    if lower.iter().any(|a| a == "googlecalendar") {
        examples.extend(&[
            "  - \"what's on my calendar\" / \"any meetings today?\" → `composio__GOOGLECALENDAR_GET_EVENTS`",
            "  - \"schedule a meeting\" / \"add to calendar\" → `composio__GOOGLECALENDAR_CREATE_EVENT`",
        ]);
    }
    if lower.iter().any(|a| a == "slack") {
        examples.extend(&[
            "  - \"send a Slack message\" / \"message X on Slack\" → `composio__SLACK_SEND_MESSAGE`",
            "  - \"check Slack\" / \"read channel messages\" → `composio__SLACK_GET_MESSAGES`",
        ]);
    }
    if lower.iter().any(|a| a == "notion") {
        examples.extend(&[
            "  - \"search my Notion\" / \"find in Notion\" → `composio__NOTION_SEARCH_PAGES`",
            "  - \"create a Notion page\" → `composio__NOTION_CREATE_PAGE`",
        ]);
    }
    if lower.iter().any(|a| a == "github") {
        examples.push("  - \"create an issue\" / \"open a PR\" → use the matching `composio__GITHUB_*` tool");
    }
    if lower.iter().any(|a| matches!(a.as_str(), "jira" | "linear" | "trello" | "asana")) {
        examples.push("  - \"create a ticket\" / \"check my tasks\" → use the matching `composio__` tool for that app");
    }

    let examples_block = if examples.is_empty() {
        String::new()
    } else {
        format!("\nExamples:\n{}", examples.join("\n"))
    };

    format!(
        "\n## Connected Apps (Composio)\n\
         The user has connected these apps: {app_list}. Prefer the matching `composio__*` tool \
         when the user asks to do something with one of them. Available Composio tools:\n  - {tools}{extra}{examples_block}",
        app_list = app_list,
        tools = shown.join("\n  - "),
        extra = extra,
        examples_block = examples_block,
    )
}

/// Fetch the connected-app list (active apps only) for prompt building.
pub async fn connected_apps() -> Vec<String> {
    let v = status().await;
    v.get("connected_apps")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str().map(|x| x.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Fetch the connected-app tool catalogue from the cloud so the agent loop
/// can advertise `composio__*` tools to the model. Returns `[]` when the
/// user has no token or no apps are connected.
pub async fn all_tool_schemas() -> Vec<Value> {
    let Some(client) = authed_client() else {
        return Vec::new();
    };
    let resp = match client
        .get(format!("{}/tools", cloud_base()))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    body.get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Execute a `composio__<slug>` tool against the cloud proxy. The result is
/// shaped like a tool result (`{ "isError": bool, "content": [...] }`) so the
/// agent loop can forward it directly.
pub async fn call_tool(prefixed_name: &str, params: Value) -> Value {
    if !prefixed_name.starts_with(TOOL_PREFIX) {
        return json!({
            "isError": true,
            "content": [{ "type": "text", "text": format!("not a Composio tool: {}", prefixed_name) }]
        });
    }
    let slug = &prefixed_name[TOOL_PREFIX.len()..];
    let Some(client) = authed_client() else {
        return json!({
            "isError": true,
            "content": [{ "type": "text", "text":
                "Composio is not configured. Sign in to zWork Cloud and connect an app." }]
        });
    };
    let endpoint = format!("{}/tools/execute/{}", cloud_base(), slug);
    match client.post(&endpoint).json(&params).send().await {
        Ok(resp) if resp.status().is_success() => {
            resp.json::<Value>().await.unwrap_or_else(|_| json!({
                "isError": true,
                "content": [{ "type": "text", "text": "Composio returned an invalid response" }]
            }))
        }
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            json!({
                "isError": true,
                "content": [{ "type": "text", "text":
                    format!("Composio {}: {} {}", slug, status.as_u16(),
                            body.chars().take(300).collect::<String>()) }]
            })
        }
        Err(e) => json!({
            "isError": true,
            "content": [{ "type": "text", "text": format!("Composio {}: {}", slug, e) }]
        }),
    }
}
