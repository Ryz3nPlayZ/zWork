mod mcp_client;
mod types;

pub use types::{ActionResult, CaptureResult, PermissionStatus};

use mcp_client::McpClient;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Cached cua-driver connection. Held in a `Mutex<Option<..>>` (not a
/// `OnceCell`) so we can drop it on idle — see [`teardown_driver`].
static CUA: Mutex<Option<Arc<McpClient>>> = Mutex::const_new(None);

/// Get or initialize the cua-driver MCP client. Lazily connects on first use;
/// after [`teardown_driver`] clears the cache, the next call reconnects (which
/// relaunches the daemon via the proxy's default relaunch behavior).
pub async fn client() -> Result<Arc<McpClient>, String> {
    let mut guard = CUA.lock().await;
    if let Some(c) = guard.as_ref() {
        return Ok(c.clone());
    }
    let c = Arc::new(McpClient::connect().await?);
    *guard = Some(c.clone());
    Ok(c)
}

/// Timestamp of the most recent desktop *control* operation (capture, click,
/// type, key, scroll, set_value, launch_app). Read-only queries (list_apps,
/// check_permissions) don't count — only real control work should keep the
/// daemon alive. Read by [`idle_teardown_task`].
fn last_desktop_use() -> &'static std::sync::Mutex<Instant> {
    static V: OnceLock<std::sync::Mutex<Instant>> = OnceLock::new();
    V.get_or_init(|| std::sync::Mutex::new(Instant::now()))
}

/// Mark that a desktop control operation just happened, extending the idle
/// window before the daemon is torn down.
pub fn mark_desktop_use() {
    if let Ok(mut g) = last_desktop_use().lock() {
        *g = Instant::now();
    }
}

/// Run `cua-driver stop` to bring down the persistent CuaDriver daemon. The
/// daemon is a separate LaunchServices process (`open -a CuaDriver`), so
/// dropping our `cua-driver mcp` proxy (via `kill_on_drop` on the dropped
/// client) does NOT stop it — this command does. Idempotent and best-effort.
async fn stop_driver_process() {
    let bin = McpClient::find_cua_binary();
    let _ = tokio::process::Command::new(&bin)
        .arg("stop")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    tracing::info!("[cua] stopped driver daemon via `{bin} stop`");
}

/// Tear down the driver: drop the cached connection (kills our `cua-driver mcp`
/// proxy via `kill_on_drop`) and stop the persistent daemon. The next
/// `client()` call reconnects on demand. The daemon's idle cursor-overlay
/// render loop used to burn ~45% CPU (fixed upstream in cua-driver-rs 0.5.6,
/// PR #1865), but tearing down on task completion is still good hygiene — it
/// releases the process entirely instead of leaving it idle. Driven explicitly
/// by the agent via [`end_session`] (see the system prompt), with a long idle
/// backstop ([`idle_teardown_task`]) as a safety net for forgetful runs.
pub async fn teardown_driver() {
    {
        let mut guard = CUA.lock().await;
        *guard = None; // drop the Arc → kill_on_drop kills the mcp proxy
    }
    stop_driver_process().await;
}

/// Begin a desktop-control session: ensure the cua-driver daemon is up and
/// reachable. Called by the agent's `desktop_start_session` tool before the
/// first capture of a task. Idempotent — if already connected, returns
/// immediately. Also marks activity so the idle backstop doesn't immediately
/// tear down a freshly-started session.
pub async fn start_session() -> Result<(), String> {
    let _ = client().await?;
    // The daemon is legitimately up for this session, so refresh the cached
    // permission state (read-only — no prompt). This keeps the Settings badge
    // accurate without the status poll ever needing to launch the daemon.
    let _ = read_and_cache_perms(false).await;
    mark_desktop_use();
    Ok(())
}

/// End a desktop-control session: tear the driver down completely. Called by
/// the agent's `desktop_end_session` tool once ALL desktop work for the task is
/// finished. Idempotent — safe to call when nothing is connected.
pub async fn end_session() -> Result<(), String> {
    teardown_driver().await;
    Ok(())
}

/// Idle backstop: how long after the last desktop control op the daemon stays
/// alive before the background loop tears it down. This is a SAFETY NET only —
/// the primary lifecycle is the agent calling `desktop_start_session` /
/// `desktop_end_session` explicitly (see the system prompt). The backstop
/// catches a forgotten session: long enough to never interrupt an active
/// multi-step task (inter-turn inference can take 10–30s and a sub-task can run
/// minutes), but finite so a forgotten session eventually releases the daemon.
/// Override with `ZWORK_IDLE_TEARDOWN_SECS`; set 0 to disable the backstop.
fn idle_backstop_secs() -> u64 {
    std::env::var("ZWORK_IDLE_TEARDOWN_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(1800)
}

/// Background safety-net loop: tears the driver down once desktop control has
/// been idle for [`idle_backstop_secs`] — but only as a backstop. The agent is
/// expected to end the session explicitly via `desktop_end_session`; this only
/// fires if it doesn't. Spawned once at backend startup.
pub async fn idle_teardown_task() {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let backstop = idle_backstop_secs();
        if backstop == 0 {
            continue; // backstop disabled
        }
        let idle_secs = last_desktop_use()
            .lock()
            .map(|g| g.elapsed().as_secs())
            .unwrap_or(0);
        if idle_secs < backstop {
            continue;
        }
        // Only tear down if a connection is currently held (driver is up).
        let held = CUA.lock().await.is_some();
        if !held {
            continue;
        }
        tracing::info!(
            "[cua] desktop control idle for {idle_secs}s (backstop {backstop}s) — tearing down driver daemon"
        );
        teardown_driver().await;
    }
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
    mark_desktop_use();
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

    // Empty element tree means the AX read came back blank — almost always a
    // missing macOS Accessibility grant on CuaDriver (the daemon can see the
    // window exists but can't introspect its controls). Surface this as a hard
    // error instead of a silent empty success, so the model doesn't declare
    // victory on a screen it can't actually read and start hallucinating
    // navigation that never happened. (Cache stays populated — the (pid,
    // window_id) resolved fine; only the element tree was empty. Re-capturing
    // after granting permission overwrites it.)
    if element_count == 0 {
        return Err(format!(
            "Captured \"{app_name}\" but the accessibility tree came back empty \
             (0 elements). CuaDriver is almost certainly missing the macOS \
             Accessibility permission — grant it to CuaDriver in System Settings \
             → Privacy & Security → Accessibility, then retry. (A truly empty \
             window is rare; if this persists after granting, the app may expose \
             no on-screen controls.)"
        ));
    }

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
    mark_desktop_use();
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
    mark_desktop_use();
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
    mark_desktop_use();
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
    mark_desktop_use();
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
    mark_desktop_use();
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
///
/// Some stock macOS apps live outside `/Applications` and cua-driver's
/// name→bundle resolution can't find them by display name — notably Finder
/// (`/System/Library/CoreServices/Finder.app`), which returns the misleading
/// "No installed macOS app found for name 'Finder'." When cua-driver reports
/// that, fall back to `open -a <name>` (which LaunchServices resolves against
/// the full app registry, CoreServices included), then retry once so we still
/// get the pid/window to cache. The set of names that hit this is small and
/// fixed, so we pattern-match rather than maintaining a denylist.
pub async fn launch_app(app: &str) -> Result<ActionResult, String> {
    mark_desktop_use();
    let c = client().await?;
    let result = c.call("launch_app", json!({ "name": app })).await;

    // "No installed macOS app found" is cua-driver's name-resolution miss.
    // Stock macOS apps like Finder live under /System/Library/CoreServices and
    // aren't in cua-driver's app index, so resolve them via LaunchServices
    // (`open -a`) and retry the driver call — `open` will have brought the app
    // to the foreground, so the second call resolves to a running pid.
    let result = match result {
        Ok(r) => r,
        Err(msg) if needs_open_fallback(&msg, app) => {
            open_via_launchservices(app).await?;
            // Best-effort retry; ignore a second miss and let the caller see it.
            c.call("launch_app", json!({ "name": app })).await?
        }
        Err(e) => return Err(e),
    };

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

/// True if a cua-driver launch error is a name-resolution miss on an app that
/// `open -a` can still resolve (Finder, System Settings, and other stock macOS
/// apps living under /System). cua-driver phrases this as
/// "No installed macOS app found for name '<name>'." — we additionally require
/// the app to look like a known system app so we don't paper over genuine
/// missing-app errors for arbitrary user input.
fn needs_open_fallback(msg: &str, app: &str) -> bool {
    if !msg.contains("No installed macOS app found") {
        return false;
    }
    // Stock macOS apps whose display name LaunchServices resolves but cua-driver
    // doesn't. Keep this narrow — over-broad matching would hide real failures
    // (e.g. a typo'd app name).
    matches!(
        app.trim().to_lowercase().as_str(),
        "finder"
            | "system settings"
            | "system preferences"
            | "activity monitor"
            | "keychain access"
            | "disk utility"
            | "console"
            | "terminal"
            | "textedit"
            | "calculator"
            | "notes"
            | "stickies"
            | "preview"
            | "screenshot"
            | "migration assistant"
    )
}

/// Launch an app via LaunchServices (`open -a <name>`). `open` resolves against
/// the full app registry (including /System/Library/CoreServices), unlike
/// cua-driver's /Applications-scoped index. Non-blocking on the UI: `-g` keeps
/// the new app in the background so we don't yank focus away mid-task.
async fn open_via_launchservices(app: &str) -> Result<(), String> {
    let status = tokio::process::Command::new("open")
        .arg("-a")
        .arg(app)
        .arg("-g")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| format!("fallback `open -a {app}` failed to spawn: {e}"))?;
    if !status.success() {
        return Err(format!(
            "fallback `open -a {app}` exited non-zero (status {status}). The app may \
             not be resolvable by LaunchServices under that name."
        ));
    }
    Ok(())
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

/// Enumerate on-screen, layer-0 windows for the "Share Window" feature.
/// Returns `[{ window_id, pid, app_name, title, bounds }]` filtered to the
/// current Space. Excludes zWork's own windows so the user doesn't screenshot
/// the overlay or main window itself.
pub async fn list_on_screen_windows() -> Result<Vec<Value>, String> {
    let c = client().await?;
    let result = c
        .call("list_windows", json!({ "on_screen_only": true }))
        .await?;
    let windows = result
        .as_array()
        .or_else(|| result.get("windows").and_then(|v| v.as_array()))
        .cloned()
        .unwrap_or_default();
    // Filter out zWork's own windows (by app_name) so the picker doesn't show
    // the overlay or main window as a shareable target.
    let filtered: Vec<Value> = windows
        .into_iter()
        .filter(|w| {
            let app = w
                .get("app_name")
                .or_else(|| w.get("owner"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            !app.eq_ignore_ascii_case("zwork") && !app.eq_ignore_ascii_case("zWork")
        })
        .collect();
    Ok(filtered)
}

/// Capture a screenshot of a specific window (by window_id) as a PNG file.
/// Uses cua-driver's `get_window_state` with `capture_mode: "vision"` (screenshot
/// only, no AX walk) and `screenshot_out_file` to write the PNG to disk. Returns
/// the path to the written file. The caller reads + base64-encodes it for the
/// vision model.
pub async fn capture_window_screenshot(window_id: i64) -> Result<String, String> {
    // Resolve the pid for this window_id from list_windows.
    let c = client().await?;
    let win_result = c
        .call("list_windows", json!({ "on_screen_only": true }))
        .await?;
    let windows = win_result
        .as_array()
        .or_else(|| win_result.get("windows").and_then(|v| v.as_array()))
        .cloned()
        .unwrap_or_default();
    let pid = windows
        .iter()
        .find_map(|w| {
            let wid = w
                .get("window_id")
                .or_else(|| w.get("id"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            if wid == window_id {
                w.get("pid").and_then(|v| v.as_i64())
            } else {
                None
            }
        })
        .ok_or_else(|| format!("window_id {} not found among on-screen windows", window_id))?;

    // Write the screenshot to a temp file.
    let out_path = format!(
        "{}/zwork-share-{}.png",
        std::env::temp_dir().to_string_lossy(),
        uuid::Uuid::new_v4().simple()
    );
    // Call get_window_state with vision capture mode to produce the screenshot.
    // IMPORTANT: capture the result — the driver returns "No content produced
    // (neither AX tree nor screenshot succeeded)" as a *successful* result (not
    // as `isError`) when the vision capture fails, which is almost always a
    // missing macOS Screen Recording grant on CuaDriver. `call()` would swallow
    // that into an Ok(Value::String(...)); without inspecting it here we'd
    // surface only the generic "file missing" message below, hiding the real
    // cause from the user.
    let call_result = c
        .call(
            "get_window_state",
            json!({
                "pid": pid,
                "window_id": window_id,
                "capture_mode": "vision",
                "screenshot_out_file": out_path,
            }),
        )
        .await?;

    // Verify the file exists. If it doesn't, the vision capture failed —
    // surface the driver's own message (plus the Screen Recording hint) instead
    // of a generic "file not found".
    if !std::path::Path::new(&out_path).exists() {
        // `call()` unwraps content[].text into the returned Value; extract it
        // so the error is actionable.
        let result_text = match &call_result {
            Value::String(s) => s.clone(),
            other => other
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|c| c.first())
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
        };
        return Err(if result_text.contains("No content produced") {
            "CuaDriver couldn't capture this window (\"No content produced\"). \
             This almost always means CuaDriver is missing the macOS Screen \
             Recording permission — grant CuaDriver (not zWork) Screen Recording \
             in System Settings → Privacy & Security → Screen Recording, then \
             retry."
                .to_string()
        } else if !result_text.is_empty() {
            format!("cua-driver: {result_text}")
        } else {
            "screenshot capture did not produce a file — check Screen Recording \
             permission for CuaDriver"
                .to_string()
        });
    }
    Ok(out_path)
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

/// Cached last-known driver permission state. Read-only status checks
/// (`check_permissions(false)`) return this WITHOUT launching the driver
/// daemon. Launching the daemon merely to poll status keeps it alive, and the
/// daemon's screen-capture stream requests Screen Recording (+ audio) on every
/// cycle while ungranted — with the Settings page polling every 2s that became
/// an infinite "record screen and audio" prompt loop. The daemon is now
/// launched only by an explicit Grant (`check_permissions(true)`) or a real
/// desktop-control session, each of which refreshes this cache.
static LAST_PERMS: Mutex<Option<PermissionStatus>> = Mutex::const_new(None);

/// Read the driver's permission state via a live MCP `check_permissions` call
/// and cache it. Only called from the Grant path and [`start_session`], where
/// the daemon is legitimately up — never from the read-only status poll.
async fn read_and_cache_perms(prompt: bool) -> Result<PermissionStatus, String> {
    let c = client().await?;
    let result = c
        .call("check_permissions", json!({ "prompt": prompt }))
        .await?;
    let st = PermissionStatus {
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
    };
    *LAST_PERMS.lock().await = Some(st.clone());
    Ok(st)
}

/// TCC permission status reported by the driver's own identity
/// (`com.trycua.driver`), not zWork's. With `prompt: true`, launches the daemon
/// and raises the system dialogs attributed to the driver — the correct grant
/// path — then caches the result. With `prompt: false`, returns the last-known
/// state WITHOUT launching the daemon; polling must never keep the daemon alive
/// (see [`LAST_PERMS`]). Always returns a uniform shape.
pub async fn check_permissions(prompt: bool) -> Result<PermissionStatus, String> {
    // Read-only: never launch the daemon. Return the cached state, or a clear
    // "not running" status if we've never checked.
    if !prompt {
        return Ok(LAST_PERMS
            .lock()
            .await
            .clone()
            .unwrap_or(PermissionStatus {
                driver_ok: false,
                accessibility: false,
                screen_recording: false,
                source: String::new(),
                error: "CuaDriver isn't running. It starts when you use desktop control \
                        or click Grant."
                    .to_string(),
            }));
    }

    // Grant path: launch the daemon, raise its prompts, read + cache the state.
    match read_and_cache_perms(true).await {
        Ok(st) => Ok(st),
        Err(e) => Ok(PermissionStatus {
            driver_ok: false,
            accessibility: false,
            screen_recording: false,
            source: String::new(),
            error: e,
        }),
    }
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
