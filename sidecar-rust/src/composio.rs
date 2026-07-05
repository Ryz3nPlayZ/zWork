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
        Ok(resp) if resp.status().is_success() => resp.json::<Value>().await.unwrap_or_else(|_| {
            json!({
                "enabled": true, "configured": true, "available": true,
                "connected_apps": [], "tool_count": 0, "user_id": "",
            })
        }),
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
        Ok(resp) if resp.status().is_success() => resp
            .json::<Value>()
            .await
            .unwrap_or_else(|_| json!({ "accounts": [] })),
        _ => json!({ "accounts": [] }),
    }
}

/// `POST /connect` with `{ "app": <name> }` → `{ "url": <oauth redirect> }`.
///
/// Errors are surfaced as a human-readable `String` so the route handler can
/// turn them into a 4xx with a useful message.
pub async fn connect(app: &str) -> Result<Value, String> {
    let client = authed_client()
        .ok_or_else(|| "Sign in to zWork Cloud to connect integrations.".to_string())?;
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
    let client = authed_client()
        .ok_or_else(|| "Sign in to zWork Cloud to manage integrations.".to_string())?;
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
    let shown: Vec<String> = tool_names
        .iter()
        .take(20)
        .map(|n| format!("`{}`", n))
        .collect();
    let extra = if tool_names.len() > 20 {
        format!("\n  - ...and {} more", tool_names.len() - 20)
    } else {
        String::new()
    };

    // App-specific intent→tool examples. NOTE: real Composio tool names carry
    // a per-install UUID suffix (e.g. `NOTION_SEARCH_PAGES_f0e73709...`), so we
    // deliberately cite tool FAMILIES by `APP_*` wildcard rather than the bare
    // action name. The model must pick the exact name from the schema list
    // above — calling the bare name (`NOTION_SEARCH_PAGES`) yields a 404. This
    // is the regression that broke Notion in 0.5.0-beta.5.
    let lower: Vec<String> = connected_apps.iter().map(|a| a.to_lowercase()).collect();
    let mut examples: Vec<&str> = Vec::new();
    if lower.iter().any(|a| a == "gmail") {
        examples.extend(&[
            "  - \"check my email\" / \"any new emails?\" → a `composio__GMAIL_FETCH_EMAILS` (or `GMAIL_SEARCH_*`) tool; with no args it returns the latest messages",
            "  - \"send an email to X about Y\" → a `composio__GMAIL_SEND_*` tool",
            "  - to read one full message body, use `composio__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` with the messageId from a FETCH_EMAILS result",
        ]);
    }
    if lower.iter().any(|a| a == "googlecalendar") {
        examples.extend(&[
            "  - \"what's on my calendar\" / \"any meetings today?\" → a `composio__GOOGLECALENDAR_*` events-listing tool",
            "  - \"schedule a meeting\" / \"add to calendar\" → a `composio__GOOGLECALENDAR_*` create tool",
        ]);
    }
    if lower.iter().any(|a| a == "slack") {
        examples.extend(&[
            "  - \"send a Slack message\" / \"message X on Slack\" → a `composio__SLACK_SEND_*` tool",
            "  - \"check Slack\" / \"read channel messages\" → a `composio__SLACK_*` messages-listing tool",
        ]);
    }
    if lower.iter().any(|a| a == "notion") {
        examples.extend(&[
            "  - \"search my Notion\" / \"find in Notion\" → a `composio__NOTION_*SEARCH*` tool",
            "  - \"create a Notion page\" → a `composio__NOTION_*CREATE*` tool (you MUST supply the required params, e.g. title and parent_id)",
        ]);
    }
    if lower.iter().any(|a| a == "github") {
        examples.push(
            "  - \"create an issue\" / \"open a PR\" → use the matching `composio__GITHUB_*` tool",
        );
    }
    if lower
        .iter()
        .any(|a| matches!(a.as_str(), "jira" | "linear" | "trello" | "asana"))
    {
        examples.push("  - \"create a ticket\" / \"check my tasks\" → use the matching `composio__` tool for that app");
    }

    let examples_block = if examples.is_empty() {
        String::new()
    } else {
        format!("\nExamples:\n{}", examples.join("\n"))
    };

    // The catch-all rule: never invent a Composio tool name. Pick from the
    // catalogue above verbatim. This is the single most important rule for
    // Composio reliability — the model hallucinating bare names was the
    // direct cause of the beta.5 404 storm.
    let naming_rule = "\nIMPORTANT: Composio tool names end with a per-install UUID \
        (e.g. `NOTION_SEARCH_PAGES_f0e73709830f43f7a2837c90fefffd4a`). You MUST call them by the \
        EXACT name listed in the tool catalogue above — never by the bare `APP_ACTION` name, which \
        will 404. When in doubt, copy the literal name from the catalogue.\n\nCalling rules:\n  \
        - Read/list tools (FETCH_EMAILS, GET_EVENTS, SEARCH_*) accept empty input `{}` as \
        \"give me the latest reasonable batch\" — never re-call them with the same empty input \
        twice; if the first result didn't answer the question, narrow the query or read a specific \
        item by ID instead.\n  \
        - Write/create tools (SEND_EMAIL, CREATE_PAGE, CREATE_EVENT, CREATE_TASK) REQUIRE real \
        arguments. Do not call them with `{}`. Infer each required field from the user's request, \
        and if a required field genuinely isn't knowable, ASK the user instead of calling with \
        empty input — an empty create call always fails.\n  \
        - Results from list tools are SUMMARY envelopes (id + headers + snippet). Call the \
        matching FETCH_*_BY_ID tool to read a full body only when you actually need it.";

    format!(
        "\n## Connected Apps (Composio)\n\
         The user has connected these apps: {app_list}. Prefer the matching `composio__*` tool \
         when the user asks to do something with one of them. Available Composio tools:\n  - {tools}{extra}{examples_block}{naming_rule}",
        app_list = app_list,
        tools = shown.join("\n  - "),
        extra = extra,
        examples_block = examples_block,
        naming_rule = naming_rule,
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
    let resp = match client.get(format!("{}/tools", cloud_base())).send().await {
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

/// Soft cap on a single shaped Composio result. List payloads are summarized
/// to lightweight envelopes first (see `shape_email_list` / `shape_json`);
/// anything still above this after shaping is truncated with a note, so a
/// runaway list endpoint can never re-feed a 100 KB+ blob to the model in one
/// turn. The threshold is generous on purpose: most well-shaped responses fit
/// comfortably and we only ever trim the long tail.
const SHAPED_RESULT_CAP: usize = 8_000;

/// Execute a `composio__<slug>` tool against the cloud proxy. The result is
/// shaped like a tool result (`{ "isError": bool, "content": [...] }`) so the
/// agent loop can forward it directly.
///
/// Two things happen here that the raw cloud response does NOT do:
///   1. Bulky list endpoints are summarized into lightweight envelopes before
///      they re-enter the agent context — Gmail's `FETCH_EMAILS` returns full
///      HTML bodies + attachment metadata per message (90–170 KB routinely),
///      which drowned the model and triggered the duplicate-`{}` doom loop.
///      We keep the IDs and headers and drop the body, leaving the model free
///      to call `FETCH_MESSAGE_BY_MESSAGE_ID` for any message it actually
///      needs the body of.
///   2. Composio frequently reports failures inside a 200-OK body
///      (`{ "successful": false, "error": ... }` or `data.status_code >= 400`).
///      Those were being returned `isError:false`, so the model saw "success"
///      with an error string and re-tried with the same `input={}`. We lift
///      those to real `isError:true` so the model treats them as failures.
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

    let raw = match client.post(&endpoint).json(&params).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<Value>().await {
            Ok(v) => v,
            Err(_) => {
                return json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": "Composio returned an invalid response" }]
                })
            }
        },
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return json!({
                "isError": true,
                "content": [{ "type": "text", "text":
                    format!("Composio {}: {} {}", slug, status.as_u16(),
                            body.chars().take(300).collect::<String>()) }]
            });
        }
        Err(e) => {
            return json!({
                "isError": true,
                "content": [{ "type": "text", "text": format!("Composio {}: {}", slug, e) }]
            })
        }
    };

    // The cloud wraps every action result in `{ data: {...}, successful: bool,
    // error: ... }`. A 200 with `successful:false` (or `data.status_code` in
    // 4xx/5xx) is a body-level failure — surface it as a real error instead
    // of masquerading as success.
    let (raw_str, success_flag, err_str) = extract_cloud_envelope(&raw, slug);
    if !success_flag {
        return json!({
            "isError": true,
            "content": [{ "type": "text", "text":
                format!("Composio {} failed: {}", slug,
                        err_str.chars().take(400).collect::<String>()) }]
        });
    }

    // Shape bulky payloads into lightweight envelopes, then cap anything still
    // oversized. `raw` is consumed and rebuilt as the user-facing payload.
    let shaped = shape_result(slug, &raw, &raw_str);
    let capped = cap_result(&shaped);

    let is_error = capped.is_error;
    let text = capped.text;
    json!({
        "isError": is_error,
        "content": [{ "type": "text", "text": text }]
    })
}

/// Pull the `(payload_json_string, success, error_message)` triple out of a
/// raw Composio cloud response. The envelope is either
/// `{ "data": {...}, "successful": bool, "error": "..." }` (action success)
/// or `{ "isError": true, "content": [...] }` (already an error from our
/// transport layer — pass it through).
fn extract_cloud_envelope(raw: &Value, slug: &str) -> (String, bool, String) {
    // Already-shaped error from our transport layer.
    if raw.get("isError").and_then(|v| v.as_bool()) == Some(true) {
        let text = raw
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|b| b.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("Composio error")
            .to_string();
        return (text.clone(), false, text);
    }

    let successful = raw
        .get("successful")
        .and_then(|v| v.as_bool())
        .unwrap_or(true); // legacy payloads without the flag are treated as success
    let error_str = raw
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    // data.status_code >= 400 is also a body-level failure even if the cloud
    // forgot to set successful:false.
    let data_status = raw
        .get("data")
        .and_then(|d| d.get("status_code"))
        .and_then(|v| v.as_u64())
        .unwrap_or(200);
    let success = successful && data_status < 400;

    let payload_str = if let Some(data) = raw.get("data") {
        // Many Composio actions put the real payload under `data.data`; others
        // under `data.messages` / `data.items`. Stringify whatever's there.
        data.to_string()
    } else {
        raw.to_string()
    };
    let _ = slug;
    (payload_str, success, error_str)
}

/// One shaped result with metadata the agent loop needs.
struct Shaped {
    text: String,
    is_error: bool,
}

/// Cap a shaped result string to [`SHAPED_RESULT_CAP`] chars, keeping JSON
/// valid by truncating a *string field's contents* (not the JSON structure)
/// wherever possible. If we can't find a clean cut, fall back to a hard
/// truncation with an explicit note so the model knows the body was trimmed.
fn cap_result(shaped: &Shaped) -> Shaped {
    if shaped.text.len() <= SHAPED_RESULT_CAP {
        return Shaped {
            text: shaped.text.clone(),
            is_error: shaped.is_error,
        };
    }
    // Try to truncate inside the JSON: parse, walk for long string values,
    // trim each long string in place, re-serialize. Preserves structure.
    if let Ok(mut v) = serde_json::from_str::<Value>(&shaped.text) {
        trim_long_strings(&mut v, SHAPED_RESULT_CAP);
        let mut compact = serde_json::to_string(&v).unwrap_or_else(|_| shaped.text.clone());
        if compact.len() <= SHAPED_RESULT_CAP {
            return Shaped {
                text: compact,
                is_error: shaped.is_error,
            };
        }
        // Still over after trimming strings (deeply nested large arrays) —
        // hard-cut but mark it so the model isn't fooled into re-fetching.
        compact.truncate(SHAPED_RESULT_CAP);
        compact.push_str("…[truncated to fit context — original was larger; refine the query or paginate if you need more]");
        return Shaped {
            text: compact,
            is_error: shaped.is_error,
        };
    }
    // Non-JSON text: hard truncate with a clear marker.
    let mut t = shaped.text.clone();
    t.truncate(SHAPED_RESULT_CAP);
    t.push_str("…[truncated to fit context — original was larger]");
    Shaped {
        text: t,
        is_error: shaped.is_error,
    }
}

/// Recursively shorten any string value longer than `cap`, in place.
fn trim_long_strings(v: &mut Value, cap: usize) {
    match v {
        Value::String(s) => {
            if s.len() > cap / 2 {
                let keep = cap / 2;
                let head: String = s.chars().take(keep).collect();
                let tail_len = s.chars().count().saturating_sub(keep);
                *s = format!("{head}…[+{tail_len} chars omitted]");
            }
        }
        Value::Array(a) => {
            for item in a.iter_mut() {
                trim_long_strings(item, cap);
            }
        }
        Value::Object(o) => {
            for (_, val) in o.iter_mut() {
                trim_long_strings(val, cap);
            }
        }
        _ => {}
    }
}

/// Per-tool shaping. Returns a `Shaped` with the model-facing string. Falls
/// through to `shape_json` for any tool without a custom shaper — that one
/// drops known-bulky keys (`messageText`, `body`, `html`, `attachmentList`,
/// `attachments`, `raw`) and JSON-serializes the remainder.
fn shape_result(slug: &str, raw: &Value, raw_str: &str) -> Shaped {
    let upper = slug.to_uppercase();
    if upper.contains("GMAIL_FETCH_EMAILS") || upper.contains("GMAIL_SEARCH") {
        return shape_email_list(raw);
    }
    if upper.starts_with("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID")
        || upper.starts_with("GMAIL_FETCH_MAIL")
        || upper.starts_with("GMAIL_GET_MESSAGE")
    {
        return shape_single_message(raw);
    }
    shape_json(raw, raw_str)
}

/// Gmail list/search → array of `{ messageId, from, to, subject, date,
/// labelIds, snippet }`. The `messageText` (full HTML body, routinely 5–50 KB
/// each) and `attachmentList` are dropped — the model can call
/// `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` with the kept `messageId` for any body
/// it actually needs. Snippets are pre-truncated so a folder of long emails
/// can't blow the cap on its own.
fn shape_email_list(raw: &Value) -> Shaped {
    let messages = raw
        .get("data")
        .and_then(|d| d.get("messages"))
        .and_then(|m| m.as_array());

    let Some(messages) = messages else {
        // Unexpected shape — fall back to generic JSON shaping so we still
        // return *something* useful rather than an empty envelope.
        return shape_json(raw, &raw.to_string());
    };

    let count = messages.len();
    let envelopes: Vec<Value> = messages
        .iter()
        .take(50) // hard ceiling on listed messages; past 50 the model should refine the query
        .map(|m| {
            let snippet = m
                .get("messageText")
                .and_then(|t| t.as_str())
                .map(|s| {
                    // Strip HTML tags + collapse whitespace for a plain-text
                    // snippet. Cheaper than a real parser and good enough for
                    // a 200-char preview.
                    let plain = strip_html(s);
                    let plain = collapse_ws(&plain);
                    plain.chars().take(280).collect::<String>()
                })
                .unwrap_or_default();
            json!({
                "messageId": m.get("messageId").cloned().unwrap_or(Value::Null),
                "from": m.get("from").cloned().unwrap_or(Value::Null),
                "to": m.get("to").cloned().unwrap_or(Value::Null),
                "subject": m.get("subject").cloned().unwrap_or(Value::Null),
                "date": m.get("date").cloned().unwrap_or(Value::Null),
                "labelIds": m.get("labelIds").cloned().unwrap_or(Value::Null),
                "snippet": snippet,
            })
        })
        .collect();

    let total = envelopes.len();
    let note = if count > total {
        format!(
            "\n\nNote: {count} messages matched; showing first {total}. Refine the query \
             (date range, sender, subject) to see the rest. Call \
             `composio__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` with a `messageId` above to read \
             a full message body."
        )
    } else if total > 0 {
        format!(
            "\n\nNote: bodies were stripped to save context. Call \
             `composio__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` with a `messageId` above to read \
             the full message body."
        )
    } else {
        String::new()
    };

    Shaped {
        text: format!(
            "{{\"messages\":{},\"count\":{}}}",
            serde_json::to_string(&envelopes).unwrap_or_else(|_| "[]".into()),
            total
        ) + &note,
        is_error: false,
    }
}

/// Single-message fetches keep the body (that's the whole point of asking for
/// one message by ID) but still strip HTML to plain text and drop the
/// attachment metadata — a single Gmail HTML email easily runs 30 KB.
fn shape_single_message(raw: &Value) -> Shaped {
    let Some(data) = raw.get("data") else {
        return shape_json(raw, &raw.to_string());
    };
    // The single-message endpoint returns the message fields at `data.*` or
    // nested under `data.data` depending on the Composio version; handle both.
    let msg = if data.get("messageId").is_some() || data.get("messageText").is_some() {
        data.clone()
    } else if let Some(inner) = data.get("data") {
        inner.clone()
    } else {
        data.clone()
    };

    let body = msg
        .get("messageText")
        .and_then(|t| t.as_str())
        .map(|s| {
            let plain = strip_html(s);
            collapse_ws(&plain).chars().take(4_000).collect::<String>()
        })
        .unwrap_or_default();

    let envelope = json!({
        "messageId": msg.get("messageId").cloned().unwrap_or(Value::Null),
        "from": msg.get("from").cloned().unwrap_or(Value::Null),
        "to": msg.get("to").cloned().unwrap_or(Value::Null),
        "subject": msg.get("subject").cloned().unwrap_or(Value::Null),
        "date": msg.get("date").cloned().unwrap_or(Value::Null),
        "labelIds": msg.get("labelIds").cloned().unwrap_or(Value::Null),
        "body": body,
    });
    Shaped {
        text: serde_json::to_string(&envelope).unwrap_or_else(|_| "{}".into()),
        is_error: false,
    }
}

/// Generic JSON shaper for any Composio tool without a custom handler. Drops
/// the well-known bulky keys (full bodies / raw payloads / attachment blobs)
/// and serializes what's left. If the result is still large it'll be capped by
/// [`cap_result`] downstream.
fn shape_json(raw: &Value, raw_str: &str) -> Shaped {
    let mut v = raw.clone();
    let bulky_keys = [
        "messageText",
        "body",
        "html",
        "htmlBody",
        "raw",
        "attachmentList",
        "attachments",
        "content_raw",
    ];
    strip_keys(&mut v, &bulky_keys);
    Shaped {
        text: serde_json::to_string(&v).unwrap_or_else(|_| raw_str.to_string()),
        is_error: false,
    }
}

/// Recursively delete any object key in `keys` from a JSON tree, in place.
fn strip_keys(v: &mut Value, keys: &[&str]) {
    match v {
        Value::Object(o) => {
            let to_remove: Vec<String> = o
                .keys()
                .filter(|k| keys.contains(&k.as_str()))
                .cloned()
                .collect();
            for k in to_remove {
                o.remove(&k);
            }
            for (_, child) in o.iter_mut() {
                strip_keys(child, keys);
            }
        }
        Value::Array(a) => {
            for item in a.iter_mut() {
                strip_keys(item, keys);
            }
        }
        _ => {}
    }
}

/// Cheap HTML → plain-text: drop tags, decode the few entities that show up in
/// email preheaders. Not a full parser, but bodies are HTML-stripped again at
/// display time anyway — this is only for the snippet we put in context.
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out = out.replace("&nbsp;", " ");
    out = out.replace("&amp;", "&");
    out = out.replace("&lt;", "<");
    out = out.replace("&gt;", ">");
    out = out.replace("&quot;", "\"");
    out = out.replace("&#39;", "'");
    out
}

/// Collapse runs of whitespace into single spaces — HTML-stripped email text
/// is full of leftover newlines and indentation that bloats the snippet.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic but realistic Gmail FETCH_EMAILS payload matching the
    /// shape that caused the beta.5 doom loop: full HTML body + attachment
    /// metadata per message, multiple messages, ~30 KB+ each.
    fn gmail_list_payload(n: usize) -> Value {
        let big_html = format!(
            "<html><body><div>{}</div></body></html>",
            "Nextdoor alert: driver chases cyclist. ".repeat(400)
        );
        let messages: Vec<Value> = (0..n)
            .map(|i| {
                json!({
                    "messageId": format!("19f2fd73e55356{:02x}", i),
                    "from": format!("alerts+{}@example.com", i),
                    "to": "user@example.com",
                    "subject": format!("Message {}", i),
                    "date": "Thu, 4 Jul 2026 18:00:00 +0000",
                    "labelIds": ["INBOX", "UNREAD"],
                    "messageText": big_html,
                    "attachmentList": [
                        {"filename": "doc.pdf", "size": 123456, "attachmentId": "ANGjdJ8" },
                        {"filename": "image.png", "size": 98765, "attachmentId": "ANGjdK9" },
                    ],
                })
            })
            .collect();
        json!({ "data": { "messages": messages }, "successful": true })
    }

    #[test]
    fn email_list_is_summarized_to_envelopes() {
        let raw = gmail_list_payload(3);
        let shaped = shape_email_list(&raw);
        assert!(!shaped.is_error);

        // The envelopes must carry the IDs/headers but NOT the body or the
        // attachment metadata — those are what blew up the context.
        assert!(
            shaped.text.contains("19f2fd73e5535600"),
            "expected messageId in shaped output"
        );
        assert!(
            shaped.text.contains("alerts+1@example.com"),
            "expected sender envelope"
        );
        assert!(
            !shaped.text.contains("doc.pdf"),
            "attachment metadata must be stripped"
        );
        assert!(
            !shaped.text.contains("doc.pdf"),
            "attachment metadata must be stripped"
        );
        // The snippet is a plain-text preview of the body — that's the point
        // of keeping it. The full raw HTML markup must NOT appear, only its
        // bounded plain-text snippet.
        assert!(
            shaped.text.contains("snippet"),
            "envelope must carry a snippet field"
        );
        assert!(
            !shaped.text.contains("<html>"),
            "raw HTML markup must not leak into the envelope"
        );
    }

    #[test]
    fn email_list_envelope_is_small_vs_raw() {
        // 10 messages each with a ~16 KB HTML body ≈ 160 KB raw, the regime
        // that killed chat 9579e693 in beta.5. The shaped envelope must be a
        // small fraction of that.
        let raw = gmail_list_payload(10);
        let raw_size = raw.to_string().len();
        let shaped = shape_email_list(&raw);
        let shaped_size = shaped.text.len();
        assert!(
            raw_size > 100_000,
            "test fixture should produce a >100KB payload (was {raw_size})"
        );
        assert!(
            shaped_size < raw_size / 10,
            "shaped ({shaped_size}) should be <10% of raw ({raw_size})"
        );
    }

    #[test]
    fn single_message_keeps_stripped_body() {
        // FETCH_MESSAGE_BY_MESSAGE_ID is the tool the model calls to read one
        // body — so the body must survive (HTML-stripped + capped), unlike the
        // list endpoint which drops it entirely.
        let raw = json!({
            "data": {
                "messageId": "abc123",
                "from": "boss@work.com",
                "subject": "Re: that thing",
                "date": "Thu, 4 Jul 2026 19:00:00 +0000",
                "messageText": "<html><body><p>Please review the <b>Q3</b> report.</p></body></html>",
            },
            "successful": true,
        });
        let shaped = shape_single_message(&raw);
        assert!(shaped.text.contains("abc123"));
        assert!(
            shaped.text.contains("Please review the Q3 report."),
            "stripped body text must be preserved"
        );
        assert!(
            !shaped.text.contains("<html>"),
            "HTML tags must be stripped"
        );
    }

    #[test]
    fn cap_truncates_oversized_result() {
        // Force a result over the cap and confirm it gets cut down with a note
        // the model can act on. The soft-trim path replaces long string fields
        // with `…[+N chars omitted]`; the hard-cut fallback appends
        // `…[truncated…]`. Either marker is acceptable as long as it's present.
        let huge = json!({ "data": { "blob": "x".repeat(SHAPED_RESULT_CAP * 2) } });
        let shaped = shape_json(&huge, &huge.to_string());
        let capped = cap_result(&shaped);
        assert!(
            capped.text.len() <= SHAPED_RESULT_CAP + 200,
            "capped text ({}) must be near the cap ({})",
            capped.text.len(),
            SHAPED_RESULT_CAP
        );
        assert!(
            capped.text.contains("chars omitted") || capped.text.contains("truncated"),
            "expected a truncation/omission marker the model can act on; got: {}",
            &capped.text[..capped.text.len().min(200)]
        );
    }

    #[test]
    fn cloud_envelope_lifts_successful_false_to_error() {
        // The CREATE_NOTION_PAGE beta.5 failure returned 200-OK with
        // successful:false + missing-field error in `data`. This MUST surface
        // as isError, otherwise the model retries with the same empty input.
        let raw = json!({
            "data": {
                "message": "Invalid request data provided\n- Following fields are missing: {'title', 'parent_id'}",
                "status_code": 400,
            },
            "successful": false,
            "error": "Invalid request data provided",
        });
        let (_, success, err) = extract_cloud_envelope(&raw, "NOTION_CREATE_NOTION_PAGE");
        assert!(!success, "successful:false must be lifted to a real error");
        assert!(err.contains("Invalid request"));
    }

    #[test]
    fn cloud_envelope_passes_through_200_success() {
        let raw = json!({ "data": { "messages": [] }, "successful": true });
        let (payload, success, _err) = extract_cloud_envelope(&raw, "GMAIL_FETCH_EMAILS");
        assert!(success);
        assert!(payload.contains("messages"));
    }

    #[test]
    fn shape_result_routes_gmail_list_to_envelope() {
        let raw = gmail_list_payload(1);
        let shaped = shape_result("GMAIL_FETCH_EMAILS", &raw, &raw.to_string());
        assert!(!shaped.is_error);
        assert!(shaped.text.contains("messageId") || shaped.text.contains("messages"));
    }

    #[test]
    fn shape_result_routes_single_message_to_body_keeper() {
        let raw = json!({
            "data": {
                "messageId": "m1",
                "messageText": "<p>hello world</p>",
                "from": "a@b.com",
            },
            "successful": true,
        });
        let shaped = shape_result("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", &raw, &raw.to_string());
        assert!(shaped.text.contains("hello world"));
    }
}
