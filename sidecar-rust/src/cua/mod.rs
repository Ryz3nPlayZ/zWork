mod mcp_client;
mod types;

pub use types::{ActionResult, CaptureResult, PermissionStatus};

use mcp_client::McpClient;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::OnceCell;

/// Global persistent cua-driver connection. Initialized on first use.
static CUA: OnceCell<Arc<McpClient>> = OnceCell::const_new();

/// Get or initialize the cua-driver MCP client.
pub async fn client() -> Result<Arc<McpClient>, String> {
    CUA.get_or_try_init(|| async {
        let c = McpClient::connect().await?;
        Ok(Arc::new(c))
    })
    .await
    .map(|c| c.clone())
}

/// Per-app target cache: `app name -> (pid, window_id)`. Populated by
/// `capture` / `launch_app`. cua-driver scopes its element-index map per
/// (pid, window_id) and replaces it on the next snapshot, so we must reuse the
/// exact window_id a capture returned for subsequent element-index actions.
struct TargetCache {
    by_app: HashMap<String, (i64, i64)>,
    last_app: Option<String>,
}

fn cache() -> &'static std::sync::Mutex<TargetCache> {
    static CACHE: OnceLock<std::sync::Mutex<TargetCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        std::sync::Mutex::new(TargetCache {
            by_app: HashMap::new(),
            last_app: None,
        })
    })
}

/// Resolve an app name (e.g. "Safari", "Chrome") to a live pid via `list_apps`.
/// Case-insensitive exact match first, then substring ("Chrome" → "Google
/// Chrome"). Errors if the app isn't running (caller should `launch_app`).
async fn resolve_pid(app: &str) -> Result<i64, String> {
    let apps = list_apps().await?;
    let needle = app.to_lowercase();
    let mut exact: Option<(String, i64)> = None;
    let mut substr: Option<(String, i64)> = None;
    for a in &apps {
        let name = app_name_of(a);
        let pid = a.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);
        let running = a.get("running").and_then(|v| v.as_bool()).unwrap_or(pid > 0);
        if !running {
            continue;
        }
        if name.to_lowercase() == needle {
            exact = Some((name.clone(), pid));
            break;
        }
        if name.to_lowercase().contains(&needle) && substr.is_none() {
            substr = Some((name.clone(), pid));
        }
    }
    match exact.or(substr) {
        Some((_, pid)) if pid > 0 => Ok(pid),
        Some((name, _)) => Err(format!(
            "{name} is installed but not running. Use desktop_launch_app to start it."
        )),
        None => Err(format!(
            "No running app matches \"{app}\". Use desktop_list_apps to see options, \
             or desktop_launch_app to start it."
        )),
    }
}

/// Resolve `(pid, window_id)` for an element-indexed action. Requires a prior
/// `desktop_capture` (or `desktop_launch_app`) for the target app — the iron
/// workflow. If `app` is None, uses the last captured/launched app.
async fn resolve_target(app: Option<&str>) -> Result<(i64, i64), String> {
    let key = match app {
        Some(a) if !a.is_empty() => a.to_string(),
        _ => cache()
            .lock()
            .unwrap()
            .last_app
            .clone()
            .ok_or_else(|| {
                "No prior desktop_capture. Call desktop_capture(app=\"...\") first — \
                 element indices are only valid from the most recent capture."
                    .to_string()
            })?,
    };
    cache()
        .lock()
        .unwrap()
        .by_app
        .get(&key)
        .cloned()
        .ok_or_else(|| {
            format!(
                "No cached capture for \"{key}\". Call desktop_capture(app=\"{key}\") first \
                 — element indices are only valid from the most recent capture."
            )
        })
}

/// Coerce an action result (click/type/key/etc.) into the ActionResult shape.
/// The MCP layer already turns JSON-RPC errors into Err, so reaching this with
/// a Value means the call succeeded; we read any detail fields defensively.
fn parse_action(result: Value, action: &str) -> Result<ActionResult, String> {
    Ok(ActionResult {
        ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(true),
        message: result
            .get("message")
            .and_then(|v| v.as_str())
            .or_else(|| result.get("status").and_then(|v| v.as_str()))
            .unwrap_or("ok")
            .to_string(),
        action: action.to_string(),
    })
}

/// Resolve an on-screen `window_id` for `pid` via `list_windows`. The driver
/// requires `window_id` for both `get_window_state` and every element-indexed
/// action (element maps are scoped per window). Picks the first on-screen
/// window — v1 assumes a single primary window per app.
async fn resolve_window_id(c: &Arc<McpClient>, pid: i64) -> Result<i64, String> {
    let result = c
        .call("list_windows", json!({ "pid": pid, "on_screen_only": true }))
        .await?;
    let windows = result
        .as_array()
        .or_else(|| result.get("windows").and_then(|v| v.as_array()))
        .ok_or_else(|| {
            "list_windows returned no windows for this app. Open the app's \
             window (it may be minimized or on another Space) and retry."
                .to_string()
        })?;
    for w in windows {
        let wid = w
            .get("window_id")
            .or_else(|| w.get("id"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if wid > 0 {
            return Ok(wid);
        }
    }
    Err(
        "app has no on-screen window to capture. Restore/unminimize its window \
         and retry."
            .to_string(),
    )
}

/// Capture the accessibility tree of an app window (AX mode, no screenshot).
/// Returns a Markdown tree with `[element_index N]` tags the agent references
/// in click/type/set_value. Caches the window's (pid, window_id).
pub async fn capture(app: Option<&str>) -> Result<CaptureResult, String> {
    let app_name = match app {
        Some(a) if !a.is_empty() => a.to_string(),
        _ => {
            return Err(
                "desktop_capture requires an app name (e.g. \"Safari\").".to_string(),
            )
        }
    };
    let pid = resolve_pid(&app_name).await?;
    let c = client().await?;

    // get_window_state requires window_id — resolve one via list_windows first.
    let window_id = resolve_window_id(&c, pid).await?;

    let result = c
        .call(
            "get_window_state",
            json!({ "pid": pid, "window_id": window_id, "capture_mode": "ax" }),
        )
        .await?;

    // Cache the resolved (pid, window_id) so subsequent element-index actions
    // reuse the same window's element map without re-resolving.
    {
        let mut cache = cache().lock().unwrap();
        cache.by_app.insert(app_name.clone(), (pid, window_id));
        cache.last_app = Some(app_name.clone());
    }

    let window_title = result
        .get("window_title")
        .and_then(|v| v.as_str())
        .or_else(|| result.get("title").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let full_tree = result
        .get("tree_markdown")
        .and_then(|v| v.as_str())
        .or_else(|| result.get("markdown").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            // Unknown shape — surface the raw payload so the agent isn't blind.
            serde_json::to_string_pretty(&result).unwrap_or_default()
        });

    // Cap the tree at roughly MAX_CAPTURE_ELEMENTS to keep the payload out of
    // the agent's context window. Dense apps (Slack, Electron, big pages) can
    // return thousands of `[element_index N]` lines — uncapped, a single
    // capture fills or overflows the context. We count elements by the
    // `[element_index N]` tag and truncate at the cap, reporting how many were
    // dropped so the agent knows indices beyond the cut are unavailable.
    let element_count = count_elements(&full_tree);
    let (tree_markdown, truncated) = truncate_tree(&full_tree, MAX_CAPTURE_ELEMENTS);

    Ok(CaptureResult {
        app: app_name,
        window_title,
        tree_markdown,
        truncated,
        element_count,
    })
}

/// Maximum number of `[element_index N]` elements kept in a capture's tree.
/// Mirrors Hermes Agent's default cap (100) — dense Electron apps can emit
/// 500+ AX nodes, and uncapped a single capture blows the agent's context.
const MAX_CAPTURE_ELEMENTS: usize = 100;

/// Count `[element_index N]` tags in the tree.
fn count_elements(tree: &str) -> u32 {
    tree.matches("[element_index").count() as u32
}

/// Truncate the tree to at most `max_elements` element tags. The cut lands on a
/// line boundary after the max-th element so we never split a tag. If the tree
/// fits, it's returned unchanged with `truncated: false`.
fn truncate_tree(tree: &str, max_elements: usize) -> (String, bool) {
    if count_elements(tree) as usize <= max_elements {
        return (tree.to_string(), false);
    }
    let mut seen = 0;
    let mut cut_byte = tree.len();
    for (idx, line) in tree.lines().enumerate() {
        if line.contains("[element_index") {
            seen += 1;
            if seen == max_elements {
                // Keep this line; truncate starts on the next line. Find the
                // byte offset of the start of the next line.
                let mut consumed: usize = tree
                    .lines()
                    .take(idx + 1)
                    .map(|l| l.len() + 1) // +1 for the newline
                    .sum();
                // lines() drops trailing newlines; clamp to tree length.
                if consumed > tree.len() {
                    consumed = tree.len();
                }
                cut_byte = consumed;
                break;
            }
        }
    }
    let mut head = tree[..cut_byte].to_string();
    let dropped = count_elements(tree) - count_elements(&head);
    if dropped > 0 {
        head.push_str(&format!(
            "\n… truncated: {dropped} more elements not shown (capture capped at \
             {max_elements}). Scroll or narrow the target to see them.\n"
        ));
    }
    (head, dropped > 0)
}

/// Click an element by its index from the last capture of `app` (or the last
/// captured app if `app` is None).
pub async fn click(element: u32, app: Option<&str>) -> Result<ActionResult, String> {
    let (pid, window_id) = resolve_target(app).await?;
    let c = client().await?;
    let mut params = json!({ "pid": pid, "element_index": element });
    if window_id > 0 {
        params["window_id"] = json!(window_id);
    }
    let result = c.call("click", params).await?;
    parse_action(result, "click")
}

/// Type text into the focused field, or a specific field if `element` is given.
/// Prefer `desktop_set_value` for dropdowns/sliders.
pub async fn type_text(
    text: &str,
    element: Option<u32>,
    app: Option<&str>,
) -> Result<ActionResult, String> {
    let (pid, window_id) = resolve_target(app).await?;
    let c = client().await?;
    let mut params = json!({ "pid": pid, "text": text });
    if let Some(e) = element {
        params["element_index"] = json!(e);
        if window_id > 0 {
            params["window_id"] = json!(window_id);
        }
    }
    let result = c.call("type_text", params).await?;
    parse_action(result, "type")
}

/// Press a key or key combination. `keys` uses "+" separators, e.g. "cmd+l",
/// "cmd+shift+g", "return", "escape". Single key → press_key; combo → hotkey.
/// A cached window_id routes combos through the NSMenu path, which delivers
/// menu equivalents (cmd+t, cmd+w, …) to native apps like Safari/Finder.
///
/// Catastrophic macOS combos (empty Trash, log out, lock screen, force-quit)
/// are hard-blocked before they reach the driver — independent of any approval
/// mode. These are irreversible one-keystroke accidents, not intentional work.
pub async fn key(keys: &str, app: Option<&str>) -> Result<ActionResult, String> {
    let (pid, window_id) = resolve_target(app).await?;
    let parts: Vec<&str> = keys
        .split('+')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("keys is empty".to_string());
    }
    if let Some(reason) = blocked_key_combo(&parts) {
        return Err(reason.to_string());
    }
    let c = client().await?;
    let result = if parts.len() == 1 {
        let mut params = json!({ "pid": pid, "key": parts[0] });
        if window_id > 0 {
            params["window_id"] = json!(window_id);
        }
        c.call("press_key", params).await?
    } else {
        let mut params = json!({ "pid": pid, "keys": parts });
        if window_id > 0 {
            params["window_id"] = json!(window_id);
        }
        c.call("hotkey", params).await?
    };
    parse_action(result, "key")
}

/// Return a human-readable reason if `parts` is a catastrophic macOS combo that
/// must never be pressed, else `None`. Comparison is order- and case-insensitive
/// over the normalized key set.
fn blocked_key_combo(parts: &[&str]) -> Option<&'static str> {
    let mut norm: Vec<String> = parts
        .iter()
        .map(|p| p.to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    norm.sort();
    norm.dedup();
    let key: Vec<&str> = norm.iter().map(|s| s.as_str()).collect();
    let matches = |combo: &[&str]| -> bool {
        let mut c: Vec<&str> = combo.to_vec();
        c.sort();
        c.dedup();
        key == c
    };
    // Order of variants matters only for the returned reason.
    let blocklist: &[(&[&str], &str)] = &[
        // Empty the Trash (Finder) — irreversible data loss in one keystroke.
        (&["cmd", "shift", "backspace"], "blocked: empty-Trash combo (cmd+shift+backspace)"),
        // Force-delete / put-back-bypass.
        (&["cmd", "option", "backspace"], "blocked: force-delete combo (cmd+option+backspace)"),
        // Log out / force log out — kills the user's session instantly.
        (&["cmd", "shift", "q"], "blocked: log-out combo (cmd+shift+q)"),
        (&["cmd", "option", "shift", "q"], "blocked: force-log-out combo (cmd+option+shift+q)"),
        // Lock screen — harmless alone but commonly mis-fired mid-automation.
        (&["cmd", "ctrl", "q"], "blocked: lock-screen combo (cmd+ctrl+q)"),
    ];
    for (combo, reason) in blocklist {
        if matches(combo) {
            return Some(reason);
        }
    }
    None
}

/// Scroll a direction by `amount` ticks (clamped 1–50). left/right scroll
/// horizontally.
pub async fn scroll(direction: &str, amount: i32, app: Option<&str>) -> Result<ActionResult, String> {
    let (pid, window_id) = resolve_target(app).await?;
    let amount = amount.clamp(1, 50);
    let c = client().await?;
    let mut params = json!({ "pid": pid, "direction": direction, "by": "line", "amount": amount });
    if window_id > 0 {
        params["window_id"] = json!(window_id);
    }
    let result = c.call("scroll", params).await?;
    parse_action(result, "scroll")
}

/// Set a value on a UI element directly (AXValue / AXPress). The safe way to
/// pick a `<select>` option or move a slider — no focus reliance, no keystrokes.
pub async fn set_value(element: u32, value: &str, app: Option<&str>) -> Result<ActionResult, String> {
    let (pid, window_id) = resolve_target(app).await?;
    if window_id == 0 {
        return Err(
            "desktop_set_value needs a window_id from a prior desktop_capture. \
             Capture the app first."
                .to_string(),
        );
    }
    let c = client().await?;
    let params = json!({ "pid": pid, "window_id": window_id, "element_index": element, "value": value });
    let result = c.call("set_value", params).await?;
    parse_action(result, "set_value")
}

/// Launch an app (backgrounded). Caches the returned pid + first window so the
/// agent can act without a separate capture.
pub async fn launch_app(app: &str) -> Result<ActionResult, String> {
    let c = client().await?;
    let result = c.call("launch_app", json!({ "name": app })).await?;
    let pid = result.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);
    let first_window = result
        .get("windows")
        .and_then(|v| v.as_array())
        .and_then(|wins| wins.first())
        .and_then(|w| {
            w.get("window_id")
                .or_else(|| w.get("id"))
                .and_then(|v| v.as_i64())
        })
        .unwrap_or(0);
    if pid > 0 {
        let mut cache = cache().lock().unwrap();
        cache.by_app.insert(app.to_string(), (pid, first_window));
        cache.last_app = Some(app.to_string());
    }
    parse_action(result, "launch_app")
}

/// List running + installed apps. Defensive about the driver's response shape
/// (bare array or `{apps: [...]}`).
pub async fn list_apps() -> Result<Vec<Value>, String> {
    let c = client().await?;
    let result = c.call("list_apps", json!({})).await?;
    if let Some(arr) = result.as_array() {
        return Ok(arr.clone());
    }
    if let Some(arr) = result.get("apps").and_then(|v| v.as_array()) {
        return Ok(arr.clone());
    }
    Ok(vec![result])
}

/// Wait locally (no driver round-trip).
pub async fn wait(seconds: f64) -> Result<ActionResult, String> {
    tokio::time::sleep(std::time::Duration::from_secs_f64(seconds)).await;
    Ok(ActionResult {
        ok: true,
        message: format!("waited {seconds:.1}s"),
        action: "wait".to_string(),
    })
}

/// TCC permission status reported by the driver's own identity
/// (`com.trycua.driver`). With `prompt: true`, raises the system permission
/// dialogs attributed to the driver — the correct grant path. Returns
/// `driver_ok: false` (with an `error`) if the driver can't be reached, so the
/// caller always gets a uniform shape.
pub async fn check_permissions(prompt: bool) -> Result<PermissionStatus, String> {
    let c = match client().await {
        Ok(c) => c,
        Err(e) => {
            return Ok(PermissionStatus {
                driver_ok: false,
                accessibility: false,
                screen_recording: false,
                source: String::new(),
                error: e,
            })
        }
    };
    let result = match c.call("check_permissions", json!({ "prompt": prompt })).await {
        Ok(r) => r,
        Err(e) => {
            return Ok(PermissionStatus {
                driver_ok: false,
                accessibility: false,
                screen_recording: false,
                source: String::new(),
                error: e,
            })
        }
    };
    Ok(PermissionStatus {
        driver_ok: true,
        accessibility: result
            .get("accessibility")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        screen_recording: result
            .get("screen_recording")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        source: result
            .get("source")
            .map(|s| match s.as_str() {
                // Some driver versions send source as a bare string.
                Some(text) => text.to_string(),
                // 0.5.x sends an object: {attribution, executable, pid, ...}.
                None => s
                    .get("attribution")
                    .and_then(|a| a.as_str())
                    .map(|a| a.to_string())
                    .unwrap_or_else(|| s.to_string()),
            })
            .unwrap_or_default(),
        error: String::new(),
    })
}

/// Read an app's display name from a `list_apps` entry, checking the likely
/// field names defensively (driver shape not guaranteed at write time).
fn app_name_of(a: &Value) -> String {
    a.get("name")
        .or_else(|| a.get("display_name"))
        .or_else(|| a.get("bundle_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}
