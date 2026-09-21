use serde_json::{json, Value};
use chrono::Utc;
use tokio::sync::{mpsc, oneshot};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::convert::Infallible;
use crate::sync_util::Unpoison;
mod prompts;
mod trace;
mod orientation;
mod harness_turn;

use trace::trace as llm_trace;

/// Append one structured correlation record to the agent JSONL log. The
/// per-turn detail (request/tool_call/tool_result/finish/…) is written by
/// `trace::trace`; this wrapper only emits the run-scoped lifecycle events
/// (turn_start, provider_resolved) so a run can be correlated across the
/// frontend request, the SSE stream, and the trace.
fn log_agent_event(chat_id: &str, run_id: &str, event: &str, payload: Value) {
    let record = json!({
        "ts": Utc::now().to_rfc3339(),
        "chat_id": chat_id,
        "run_id": run_id,
        "event": event,
        "payload": payload,
    });
    if let Ok(line) = serde_json::to_string(&record) {
        let path = crate::paths::agent_log_path();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap_or_else(|_| std::fs::File::create("/dev/null").unwrap());
        use std::io::Write;
        let _ = writeln!(file, "{}", line);
    }
}

/// Sensible output-token ceiling per model family. Anthropic *requires*
/// `max_tokens` in every request (the API 400s without it), and other providers
/// apply a sensible cap when one is supplied. Mirrors the Python
/// `providers._max_tokens_for`.
fn max_tokens_for(model_id: &str) -> u64 {
    let mid = model_id.to_lowercase();
    if mid.contains("claude-sonnet-4") || mid.contains("claude-opus-4") || mid.contains("claude-4") {
        return 64000;
    }
    if mid.contains("claude-3-5") || mid.contains("claude-3.5") {
        return 8192;
    }
    if mid.contains("claude") {
        return 8192;
    }
    if mid.contains("deepseek-flash") || mid.contains("deepseek-v4-flash") || mid.contains("deepseek-v4.1-flash") {
        return 65536;
    }
    // z-ai/glm-5.x ("zWork Ultimate" via OpenRouter) supports a large output
    // window; cap at a generous default like other frontier models.
    if mid.contains("glm-5.2") || mid.contains("glm-5.3") || mid.contains("zwork-ultimate") {
        return 16384;
    }
    // OpenAI / OpenAI-compatible: a safe general default.
    16384
}

/// Map a router-facing model id ("zwork-pro" / "zwork-flash", as registered in
/// Settings) to the real upstream model the zWork Cloud Router serves.
/// Explicit ids only — unknown ids fall back to flash WITH a log line, never
/// a silent substring guess (`contains("pro")` mis-mapped ids like
/// "grok-4-pro-fast" that happen to contain "pro").
fn router_real_model(model_id: &str) -> String {
    match model_id {
        // Hosted lineup (all served via OpenRouter on the router's OpenAI
        // path). Legacy v4 spellings keep their PRODUCT TIER: v4-flash was
        // flash, v4.1-flash/v4-pro were pro.
        "zwork-pro" | "deepseek-v4-pro" | "deepseek-v4.1-flash" => "z-ai/glm-5.3-flash".to_string(),
        "zwork-flash" | "deepseek-v4-flash" => "deepseek/deepseek-v4-flash-0731".to_string(),
        "zwork-ultimate" => "deepseek/deepseek-v4.1-flash".to_string(),
        other => {
            tracing::warn!(
                "[agent] unknown router model id '{other}' — falling back to deepseek/deepseek-v4-flash-0731"
            );
            "deepseek/deepseek-v4-flash-0731".to_string()
        }
    }
}

/// True when a provider error is actually "the conversation is too long for
/// the model's context window" — a 400 in disguise that is RECOVERABLE by
/// compacting history, unlike other permanent 400s (malformed request shape,
/// unbalanced tool_use/tool_result pairing, auth). Matches the phrasings used
/// by OpenAI-compatible APIs, Anthropic, and the zWork router envelope.
fn is_context_overflow_error(message: &str, raw: Option<&str>) -> bool {
    let hay = format!(
        "{} {}",
        message.to_ascii_lowercase(),
        raw.unwrap_or("").to_ascii_lowercase()
    );
    hay.contains("context_length_exceeded")
        || hay.contains("context length")
        || hay.contains("maximum context")
        || hay.contains("context window")
        || hay.contains("prompt is too long")
        || hay.contains("too many tokens")
        || hay.contains("input is too long")
}

/// Classify a provider error message as transient (retryable) or permanent.
///
/// The `ProviderError` event carries only a string message — no HTTP status
/// code — so classification is pattern-based. Transient errors (429 rate
/// limits, 503 service unavailable, connection timeouts) warrant a retry with
/// exponential backoff. Permanent errors (400 bad request, 401 auth failure)
/// should be surfaced to the user, not retried blindly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// Retryable: 429, 503, connection errors, timeouts, overloaded.
    Transient,
    /// Not retryable: 400, 401, 403, content filter, malformed request.
    Permanent,
}

/// Does this desktop-tool error message indicate a CuaDriver permission
/// problem (the classic "granted to zWork, not CuaDriver" trap, or the driver
/// being absent/blocked)? Used to decide whether to emit a user-facing
/// `permission_recovery` event alongside the model-facing tool error.
///
/// Matches the telltale phrases produced across the Cua stack:
/// - the empty-AX-tree error (`cua/mod.rs:350-359`: "missing the macOS
///   Accessibility permission", "grant it to CuaDriver"),
/// - the driver spawn/timeout errors (`mcp_client.rs`: "did not respond
///   within 30s", "process exited without responding"),
/// - the Share-Window "No content produced" / Screen-Recording errors.
pub(crate) fn is_cuadriver_permission_error(message: &str) -> bool {
    let h = message.to_ascii_lowercase();
    h.contains("cuadriver")
        || h.contains("cua-driver")
        || h.contains("accessibility permission")
        || h.contains("screen recording")
        || h.contains("did not respond within")
        || h.contains("process exited without responding")
        || h.contains("no content produced")
}

/// Build a ready-to-render user-facing message for the `permission_recovery`
/// event, derived from the model-facing tool error. Returns a short,
/// actionable instruction rather than the raw (often verbose) tool error.
pub(crate) fn cuadriver_recovery_message(tool_error: &str) -> String {
    let h = tool_error.to_ascii_lowercase();
    // The most common case: AX tree came back empty → Accessibility grant is
    // missing on CuaDriver. This phrase is unique to that error.
    if h.contains("accessibility permission") || h.contains("accessibility tree came back empty") {
        return "Desktop automation needs Accessibility permission granted to \
                CuaDriver (not zWork). Open System Settings → Privacy & Security \
                → Accessibility and toggle CuaDriver on, then retry."
            .to_string();
    }
    // Driver is absent or blocked from spawning — usually means it's not
    // installed, or its grants were revoked.
    if h.contains("did not respond within")
        || h.contains("process exited without responding")
        || h.contains("install cuadriver")
    {
        return "CuaDriver.app isn't running. Install it from trycua/cua on \
                GitHub, or if it's installed, grant it Accessibility permission \
                in System Settings → Privacy & Security, then retry."
            .to_string();
    }
    if h.contains("screen recording") {
        return "Desktop capture needs Screen Recording permission granted to \
                CuaDriver (not zWork). Open System Settings → Privacy & Security \
                → Screen Recording and toggle CuaDriver on, then retry."
            .to_string();
    }
    // Generic fallback — still names CuaDriver, which is the key correction.
    "Desktop automation failed — this is almost always a macOS permission \
     issue on CuaDriver.app. In System Settings → Privacy & Security, grant \
     Accessibility (and Screen Recording) to CuaDriver, not zWork, then retry."
        .to_string()
}

/// Convenience wrapper used by tests (production callers always have a `raw`
/// body and use `classify_provider_error_with_raw` directly).
#[allow(dead_code)]
pub fn classify_provider_error(message: &str) -> ErrorClass {
    classify_provider_error_with_raw(message, None)
}

/// Classify with the optional raw response body. The cloud router wraps every
/// per-provider failure as a 502 `router_upstreams_failed: <detail>` envelope —
/// including permanent client errors like a 400 invalid_request_error. The bare
/// `message` ("upstream HTTP 502 Bad Gateway") looks transient, but the wrapped
/// body reveals the real upstream status. This peeks inside that envelope so a
/// 400/401/403 wrapped in a 502 is classified as Permanent (no retry) instead
/// of being pointlessly retried 3× against a doomed malformed request.
pub fn classify_provider_error_with_raw(message: &str, raw: Option<&str>) -> ErrorClass {
    let lower = message.to_ascii_lowercase();
    let raw_lower = raw.unwrap_or("").to_ascii_lowercase();

    // Router-wrapped permanent upstream errors: the envelope is 502, but the
    // embedded body carries a definitive non-retryable status from the actual
    // model provider. Detect these BEFORE the 5xx-transient rules below so
    // they short-circuit to Permanent. (Only inspect when we are actually
    // looking at a router envelope — otherwise 400/401/403 substrings in the
    // top-level message would be transient-classified first.)
    if raw_lower.contains("router_upstreams_failed") {
        if raw_lower.contains("400")
            || raw_lower.contains("invalid_request_error")
            || raw_lower.contains("bad request")
            || raw_lower.contains("401")
            || raw_lower.contains("unauthorized")
            || raw_lower.contains("gateway_access_denied")
            || raw_lower.contains("403")
            || raw_lower.contains("forbidden")
        {
            return ErrorClass::Permanent;
        }
    }

    // Transient: rate limits, service unavailable, connection issues.
    if lower.contains("429")
        || lower.contains("too many requests")
        || lower.contains("rate limit")
        || lower.contains("503")
        || lower.contains("service unavailable")
        || lower.contains("overloaded")
        || lower.contains("connection")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connect failed")
        || lower.contains("stream read error")
        || lower.contains("temporarily unavailable")
        || lower.contains("try again")
        // 5xx gateway errors are transient: the reverse proxy (nginx,
        // Cloudflare, the zwork_router) couldn't reach a healthy upstream.
        // 502 Bad Gateway is the canonical case — the proxy got an invalid
        // response from the model server, almost always resolves on retry
        // within seconds. 504 Gateway Timeout is the same family. 500 is
        // included too: model servers commonly 500 on a transient internal
        // crash and recover. (400/401/403 below remain permanent.)
        || lower.contains("500")
        || lower.contains("internal server error")
        || lower.contains("502")
        || lower.contains("bad gateway")
        || lower.contains("504")
        || lower.contains("gateway timeout")
    {
        return ErrorClass::Transient;
    }
    // Everything else is permanent: 400 bad request, 401 auth, 403 forbidden,
    // content filter, request_body_too_large, invalid api key, etc.
    ErrorClass::Permanent
}

/// Translate a raw provider error (status line + optional response body) into a
/// message the user can actually act on.
///
/// The streaming layer surfaces errors as a bare `"upstream HTTP 502 Bad
/// Gateway"` — the `raw` body (e.g. the router's `router_upstreams_failed`) is
/// captured separately and, without this helper, never reaches the UI. This
/// recognizes the known router/provider error codes and returns clear text;
/// unknown errors fall through to the original message so nothing is hidden.
pub fn friendly_upstream_error(message: &str, raw: Option<&str>, retries_exhausted: bool) -> String {
    let lower = message.to_ascii_lowercase();
    let raw_lower = raw.unwrap_or("").to_ascii_lowercase();

    // The zWork router wraps EVERY per-provider failure as a 502
    // `router_upstreams_failed: <failures>` — including permanent client-side
    // errors like a 400 invalid_request_error or 401 auth failure. Before
    // claiming "all providers unavailable", inspect the wrapped failure body
    // for a permanent upstream status: if DeepSeek returned 400/401/403, that
    // is the real cause and retrying will not help. The router's 502 envelope
    // is a transport detail, not the user-facing truth.
    if raw_lower.contains("router_upstreams_failed") {
        // Permanent upstream errors embedded inside the router's 502 envelope.
        // Format: `router_upstreams_failed: ProviderName:model 400 {error...}`
        // or `... 401 {error...}` / `... 403 {error...}`.
        if raw_lower.contains("400")
            || raw_lower.contains("invalid_request_error")
            || raw_lower.contains("bad request")
        {
            // Surface the actual provider message — it is specific and
            // actionable (e.g. "messages.4: tool_use ids found without
            // tool_result blocks immediately after"). Trim the router
            // envelope prefix so the user sees the real cause, not the
            // transport wrapper.
            let detail = extract_upstream_detail(raw).unwrap_or_default();
            return format!(
                "The model provider rejected the request as invalid{}{}. {}",
                if retries_exhausted { " after retries" } else { "" },
                if detail.is_empty() { String::new() } else { format!(": {}", detail) },
                "This is a request-shape problem, not a transient outage — retrying won't help. Try starting a new chat or rephrasing."
            );
        }
        if raw_lower.contains("401")
            || raw_lower.contains("unauthorized")
            || raw_lower.contains("gateway_access_denied")
        {
            return "Authentication failed — the model provider rejected the API key. Check your API key in Settings.".to_string();
        }
        if raw_lower.contains("403") || raw_lower.contains("forbidden") {
            return "Access denied by the model provider. Your key may not have access to the requested model.".to_string();
        }

        // Genuine all-upstreams-failed: no permanent status embedded, so this
        // really is a cloud-side outage (every provider returned a transient
        // error or was unreachable).
        let detail = raw
            .map(|r| {
                let t = r.trim();
                if t.is_empty() {
                    String::new()
                } else {
                    format!(" ({t})")
                }
            })
            .unwrap_or_default();
        return format!(
            "All model providers are currently unavailable{}{}. The cloud router \
             reported that every upstream failed. This is usually temporary — \
             please try again in a few minutes.",
            detail,
            if retries_exhausted {
                " after multiple retries"
            } else {
                ""
            }
        );
    }

    // Generic gateway/proxy failures (504 Gateway Timeout, 500 Internal).
    if lower.contains("504") || lower.contains("gateway timeout") {
        return format!(
            "The model provider timed out responding{}. Please try again.",
            if retries_exhausted { " after multiple retries" } else { "" }
        );
    }

    // 429 rate limit — surfaced as permanent after retries are exhausted.
    if lower.contains("429") || lower.contains("rate limit") || lower.contains("too many requests") {
        return "You've hit the model provider's rate limit. Please wait a moment and try again.".to_string();
    }

    // 401/403 auth — the router key or provider key is rejected.
    if lower.contains("401") || lower.contains("unauthorized") || lower.contains("gateway_access_denied") {
        return "Authentication failed — your model provider key or cloud token was rejected. Check your API key in Settings.".to_string();
    }
    if lower.contains("403") || lower.contains("forbidden") {
        return "Access denied by the model provider. Your key may not have access to the requested model.".to_string();
    }

    // Connection-level failures (DNS, TLS, refused).
    if lower.contains("connect failed") || lower.contains("connection") {
        return format!(
            "Couldn't reach the model provider{}. Check your internet connection and try again.",
            if retries_exhausted { " after multiple retries" } else { "" }
        );
    }

    // Fall through: surface the original message + body if we have one, so
    // nothing is hidden. The original already carries the status code.
    match raw {
        Some(body) if !body.trim().is_empty() && body.trim() != message => {
            format!("{message} — {}", body.trim())
        }
        _ => message.to_string(),
    }
}

/// Extract the human-readable detail from a router-wrapped failure body.
///
/// The router envelope looks like:
///   `router_upstreams_failed: ProviderName:model_id 400 {"error":{"message":"..."}}`
/// The user does not need the `router_upstreams_failed:` prefix or the
/// `ProviderName:model_id 400 ` routing prefix — only the provider's actual
/// error message. This strips the envelope and returns the JSON `message`
/// field when present (the actionable part), falling back to the trimmed body
/// after the prefix when the JSON shape is unexpected.
fn extract_upstream_detail(raw: Option<&str>) -> Option<String> {
    let body = raw?.trim();
    // Strip the `router_upstreams_failed:` envelope prefix.
    let after_prefix = match body.find("router_upstreams_failed:") {
        Some(idx) => body[idx + "router_upstreams_failed:".len()..].trim(),
        None => body,
    };
    // The remaining text is `ProviderName:model_id <status> {json}`. Find the
    // first `{` — everything from there is the provider's JSON error body.
    let json_start = after_prefix.find('{')?;
    let json_str = &after_prefix[json_start..];
    let parsed: serde_json::Value = serde_json::from_str(json_str).ok()?;
    // Anthropic / OpenAI error shape: {"error":{"message":"..."}}
    parsed
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
        .or_else(|| Some(json_str.trim_end_matches('}').to_string()))
}

/// Keyword-detect the kind of artifact a message likely wants and return the
/// steering instruction the Python backend appended to the prompt. Mirrors
/// `server._artifact_hint`.
fn artifact_hint(message: &str) -> String {
    let t = message.to_lowercase();
    let hint = if ["document", "doc", "brief", "report", "note", "summary", "outline", "write a", "draft a", "make a document"]
        .iter().any(|k| t.contains(k)) {
        "The user's request clearly wants a document. Create a sidebar document of kind doc. Do not wrap it in code fences. Do not emit the words Text, Open, or undefined."
    } else if ["table", "sheet", "spreadsheet", "csv", "tsv", "rows", "columns"]
        .iter().any(|k| t.contains(k)) {
        "The user's request clearly wants a table or spreadsheet. Create a sidebar document of kind sheet. Do not wrap it in code fences. Do not emit the words Text, Open, or undefined."
    } else if ["chart", "graph", "plot", "visualization", "visualise", "visualize"]
        .iter().any(|k| t.contains(k)) {
        "The user's request clearly wants a graph. Create a sidebar document of kind graph. Do not wrap it in code fences. Do not emit the words Text, Open, or undefined."
    } else if ["code snippet", "script", "example code", "runnable example"]
        .iter().any(|k| t.contains(k)) {
        "The user's request clearly wants a code snippet. Create a sidebar document of kind code. Do not wrap it in code fences. Do not emit the words Text, Open, or undefined."
    } else {
        "The user's request may or may not want a document. If the output is best represented as an editable deliverable, create one. If you create one, do not wrap it in code fences and do not emit the words Text, Open, or undefined."
    };
    hint.to_string()
}

/// Run a quick web search on the message and format the results as grounding
/// context for the system prompt. Returns None on any failure so the turn
/// proceeds without grounding rather than erroring.
async fn web_search_grounding(message: &str) -> Option<String> {
    let query = message.split_whitespace().take(80).collect::<Vec<_>>().join(" ");
    if query.trim().is_empty() {
        return None;
    }
    // Reuse the existing web_search tool so the query/parse logic stays in one place.
    let params = json!({ "query": query, "max_results": 5 });
    let results = crate::tools::search::execute_web_search(&params).await.ok()?;
    // The tool returns a formatted string; surface it verbatim as grounding.
    if results.trim().is_empty() {
        None
    } else {
        Some(results)
    }
}

fn pending_permission_gates() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn approve_gate(gate_id: &str) -> bool {
    let mut map = pending_permission_gates().lock_unpoisoned();
    if let Some(tx) = map.remove(gate_id) {
        let _ = tx.send(true);
        true
    } else {
        false
    }
}

pub fn reject_gate(gate_id: &str) -> bool {
    let mut map = pending_permission_gates().lock_unpoisoned();
    if let Some(tx) = map.remove(gate_id) {
        let _ = tx.send(false);
        true
    } else {
        false
    }
}

// ── Pending interactive questions (ask_question / ask_user) ──────────────────
// In-flight questions keyed by a unique question id (NOT chat_id), mirroring the
// permission-gate pattern. Tool calls run concurrently as parallel spawned
// tasks, so keying by chat_id alone would let a second ask_question overwrite
// the first's oneshot::Sender — dropping it, misrouting the user's answer, and
// hanging the overwritten question until its 5-minute timeout. Keying by a
// unique id lets concurrent questions coexist; the frontend's single-question
// UX (one `pendingQuestion` per chat) is preserved by `answer_pending_question`
// resolving the most recent question for a chat when no explicit id is given.
fn pending_questions() -> &'static Mutex<HashMap<String, oneshot::Sender<String>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, oneshot::Sender<String>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Map chat_id → the question id most recently registered for it, so the
/// legacy single-question answer route (no explicit question id) resolves the
/// question the user is actually looking at.
fn current_question_for_chat() -> &'static Mutex<HashMap<String, String>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a pending question. Called by the /answer-question route.
/// If `question_id` is provided, resolves that specific question; otherwise
/// resolves the most-recently-registered question for the chat (the one the
/// single-question frontend is displaying).
pub fn answer_pending_question(chat_id: &str, answer: &str, question_id: Option<&str>) -> bool {
    let mut map = pending_questions().lock_unpoisoned();
    let key = match question_id {
        Some(qid) => qid.to_string(),
        None => {
            let cur = current_question_for_chat().lock_unpoisoned();
            match cur.get(chat_id) {
                Some(qid) => qid.clone(),
                None => return false,
            }
        }
    };
    if let Some(tx) = map.remove(&key) {
        let _ = tx.send(answer.to_string());
        // Clean up the current-question pointer if it pointed at this one.
        let mut cur = current_question_for_chat().lock_unpoisoned();
        if cur.get(chat_id).map(|s| s.as_str()) == Some(key.as_str()) {
            cur.remove(chat_id);
        }
        true
    } else {
        false
    }
}

/// Register a pending question (called from the tool dispatcher). Returns the
/// generated question id so the caller can emit it in the ask_question SSE
/// event for the frontend to echo back on answer.
pub fn register_pending_question(chat_id: &str, tx: oneshot::Sender<String>) -> String {
    let question_id = format!("q_{}", uuid::Uuid::new_v4().simple());
    {
        let mut map = pending_questions().lock_unpoisoned();
        map.insert(question_id.clone(), tx);
    }
    // Track this as the chat's current question so the legacy answer route
    // (no question_id) resolves it.
    {
        let mut cur = current_question_for_chat().lock_unpoisoned();
        cur.insert(chat_id.to_string(), question_id.clone());
    }
    question_id
}

/// Drop a pending question (e.g. on timeout).
pub fn clear_pending_question(question_id: &str) {
    let mut map = pending_questions().lock_unpoisoned();
    map.remove(question_id);
}

// ── Per-run approved-commands allowlist ──────────────────────────────────────
// When the user approves a run_command (via ask_user_for_permission), the
// normalized command is added here so subsequent identical calls skip the
// destructive gate — mirroring Python's run.approved_commands.
fn approved_commands() -> &'static Mutex<HashMap<String, std::collections::HashSet<String>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, std::collections::HashSet<String>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Add a command to the per-chat approved list.
pub fn approve_command(chat_id: &str, command: &str) {
    let normalized = normalize_command(command);
    let mut map = approved_commands().lock_unpoisoned();
    map.entry(chat_id.to_string()).or_default().insert(normalized);
}

/// Check whether a command was already approved for this chat.
pub fn is_command_approved(chat_id: &str, command: &str) -> bool {
    let normalized = normalize_command(command);
    let map = approved_commands().lock_unpoisoned();
    map.get(chat_id).map(|set| set.contains(&normalized)).unwrap_or(false)
}

/// Strip a command down to its program + first arg so trivial env-var /
/// whitespace differences don't defeat the allowlist.
fn normalize_command(command: &str) -> String {
    command.trim().split_whitespace().take(2).collect::<Vec<_>>().join(" ")
}

/// Clear a chat's approved-commands (called when a run ends).
pub fn clear_approved_commands(chat_id: &str) {
    let mut map = approved_commands().lock_unpoisoned();
    map.remove(chat_id);
}


/// Run one chat turn on the pi harness (`harness_turn`).
#[allow(clippy::too_many_arguments)]
pub fn run_agent_turn(
    chat_id: String,
    run_id: String,
    model_id: String,
    user_message: String,
    attachments: Vec<crate::server::Attachment>,
    project_id: String,
    plan_mode: bool,
    auto_approve: bool,
    artifact_mode: bool,
    web_search_enabled: bool,
    extra_system_prompt: Option<String>,
) -> impl futures_util::Stream<Item = Result<Value, Infallible>> + Send {
    harness_turn::run_agent_turn(
        chat_id, run_id, model_id, user_message, attachments, project_id,
        plan_mode, auto_approve, artifact_mode, web_search_enabled, extra_system_prompt,
    )
}

/// Spawn a bounded, READ-ONLY sub-agent for `task` (see
/// `harness_turn::spawn_subagent`).
pub async fn spawn_subagent(
    chat_id: &str,
    parent_run_id: &str,
    task: &str,
    model_id: &str,
    tx: &mpsc::Sender<Value>,
) -> Result<String, String> {
    harness_turn::spawn_subagent(chat_id, parent_run_id, task, model_id, tx).await
}

/// RAII guard that unregisters a chat's run from the watchdog when the agent
/// turn ends (normally or via panic), preventing stale handles.
struct RunGuard(String);
impl Drop for RunGuard {
    fn drop(&mut self) {
        crate::watchdog::unregister_run(&self.0);
        // Clear per-run approved commands so they don't leak into the next run.
        clear_approved_commands(&self.0);
    }
}

struct DoomLoopDetector {
    last_calls: Vec<(String, Value)>,
}

impl DoomLoopDetector {
    fn new() -> Self {
        Self {
            last_calls: Vec::new(),
        }
    }

    fn push(&mut self, name: &str, input: &Value) -> bool {
        self.last_calls.push((name.to_string(), input.clone()));
        if self.last_calls.len() > 3 {
            self.last_calls.remove(0);
        }
        if self.last_calls.len() == 3 {
            let first = &self.last_calls[0];
            let second = &self.last_calls[1];
            let third = &self.last_calls[2];
            if first.0 == second.0 && second.0 == third.0 && first.1 == second.1 && second.1 == third.1 {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_classify_provider_error_transient() {
        // Rate limiting / overloaded — the most common transient failure.
        assert_eq!(classify_provider_error("upstream HTTP 429 Too Many Requests"), ErrorClass::Transient);
        assert_eq!(classify_provider_error("rate limit exceeded"), ErrorClass::Transient);
        assert_eq!(classify_provider_error("Too many requests"), ErrorClass::Transient);
        // Service unavailable / 503 — server-side transient.
        assert_eq!(classify_provider_error("upstream HTTP 503"), ErrorClass::Transient);
        assert_eq!(classify_provider_error("The service is overloaded"), ErrorClass::Transient);
        // 5xx gateway errors — proxy couldn't reach a healthy upstream.
        // 502 Bad Gateway is the canonical transient gateway failure.
        assert_eq!(classify_provider_error("upstream HTTP 502 Bad Gateway"), ErrorClass::Transient);
        assert_eq!(classify_provider_error("502 Bad Gateway"), ErrorClass::Transient);
        assert_eq!(classify_provider_error("bad gateway"), ErrorClass::Transient);
        // 504 Gateway Timeout — proxy timed out waiting for upstream.
        assert_eq!(classify_provider_error("upstream HTTP 504 Gateway Timeout"), ErrorClass::Transient);
        // 500 Internal Server Error — transient upstream crash.
        assert_eq!(classify_provider_error("upstream HTTP 500 Internal Server Error"), ErrorClass::Transient);
        // Connection failures — network-level transient.
        assert_eq!(classify_provider_error("upstream connect failed: connection refused"), ErrorClass::Transient);
        assert_eq!(classify_provider_error("stream read error: unexpected EOF"), ErrorClass::Transient);
        // Timeouts.
        assert_eq!(classify_provider_error("request timed out after 300s"), ErrorClass::Transient);
        assert_eq!(classify_provider_error("operation timeout"), ErrorClass::Transient);
        // Retry hints from provider.
        assert_eq!(classify_provider_error("API temporarily unavailable, try again later"), ErrorClass::Transient);
    }

    #[test]
    fn test_classify_provider_error_permanent() {
        // 400 Bad Request — request_body_too_large from vision attachments.
        assert_eq!(classify_provider_error("upstream HTTP 400 Bad Request"), ErrorClass::Permanent);
        assert_eq!(classify_provider_error("request_body_too_large"), ErrorClass::Permanent);
        // 401 Auth — invalid API key.
        assert_eq!(classify_provider_error("upstream HTTP 401 Unauthorized"), ErrorClass::Permanent);
        assert_eq!(
            classify_provider_error("invalid x-api-key"),
            ErrorClass::Permanent
        );
        // 403 Forbidden.
        assert_eq!(classify_provider_error("upstream HTTP 403 Forbidden"), ErrorClass::Permanent);
        // Content filter / refusal.
        assert_eq!(classify_provider_error("content_policy_violation"), ErrorClass::Permanent);
        // Malformed SSE — not transient, retrying the same payload won't help.
        assert_eq!(classify_provider_error("malformed SSE JSON frame"), ErrorClass::Permanent);
        // Tool not found — Composio routing error.
        assert_eq!(
            classify_provider_error("Tool NOTION_FETCH_ALL_BLOCK_CONTENTS not found"),
            ErrorClass::Permanent
        );
    }

    #[test]
    fn test_friendly_upstream_error_router_upstreams_failed() {
        // The actual reported case: 502 + router_upstreams_failed body.
        let msg = friendly_upstream_error(
            "upstream HTTP 502 Bad Gateway",
            Some("router_upstreams_failed: "),
            true,
        );
        assert!(
            msg.contains("All model providers are currently unavailable"),
            "router 502 should be friendly, got: {msg}"
        );
        assert!(
            msg.contains("after multiple retries"),
            "retries_exhausted should be reflected, got: {msg}"
        );
    }

    #[test]
    fn test_friendly_upstream_error_504_timeout() {
        let msg = friendly_upstream_error(
            "upstream HTTP 504 Gateway Timeout",
            None,
            false,
        );
        assert!(msg.contains("timed out"), "504 should mention timeout, got: {msg}");
    }

    #[test]
    fn test_friendly_upstream_error_401_auth() {
        // The 401 gateway_access_denied seen in the trace log.
        let msg = friendly_upstream_error(
            "upstream HTTP 401 Unauthorized",
            Some("gateway_access_denied"),
            false,
        );
        assert!(
            msg.contains("Authentication failed"),
            "401 should be auth-friendly, got: {msg}"
        );
    }

    #[test]
    fn test_friendly_upstream_error_unknown_falls_through() {
        // Unknown errors keep their original message + body so nothing is hidden.
        let msg = friendly_upstream_error(
            "upstream HTTP 418 I'm a teapot",
            Some("short and stout"),
            false,
        );
        assert!(msg.contains("418"), "fallthrough should keep status: {msg}");
        assert!(msg.contains("short and stout"), "fallthrough should keep body: {msg}");
    }

    #[test]
    fn test_classify_router_wrapped_400_is_permanent() {
        // The actual bug: the router wraps DeepSeek's 400 invalid_request_error
        // as a 502 envelope. The bare message ("upstream HTTP 502 Bad Gateway")
        // looks transient, but the wrapped body reveals a permanent 400.
        // This MUST classify as Permanent so we don't retry a doomed request.
        let raw = "router_upstreams_failed: DeepSeek:deepseek-v4-flash 400 \
            {\"error\":{\"message\":\"messages.4: tool_use ids found without \
            tool_result blocks\",\"type\":\"invalid_request_error\"}}";
        assert_eq!(
            classify_provider_error_with_raw("upstream HTTP 502 Bad Gateway", Some(raw)),
            ErrorClass::Permanent,
            "router-wrapped 400 must NOT be retried"
        );
        // Same for router-wrapped 401.
        let raw_401 = "router_upstreams_failed: DeepSeek:deepseek-v4-flash 401 \
            {\"error\":{\"message\":\"invalid api key\",\"type\":\"authentication_error\"}}";
        assert_eq!(
            classify_provider_error_with_raw("upstream HTTP 502 Bad Gateway", Some(raw_401)),
            ErrorClass::Permanent,
            "router-wrapped 401 must NOT be retried"
        );
        // But a router envelope with no permanent status remains transient
        // (e.g. all providers genuinely returned 503/timeout).
        let raw_transient = "router_upstreams_failed: DeepSeek:deepseek-v4-flash unreachable";
        assert_eq!(
            classify_provider_error_with_raw("upstream HTTP 502 Bad Gateway", Some(raw_transient)),
            ErrorClass::Transient,
            "router-wrapped transient failures should still retry"
        );
    }

    #[test]
    fn test_friendly_upstream_error_router_wrapped_400() {
        // The exact error from the bug report: the user should see the real
        // cause (the 400 invalid_request_error), NOT "all providers unavailable".
        let raw = "router_upstreams_failed: DeepSeek:deepseek-v4-flash 400 \
            {\"error\":{\"message\":\"messages.4: `tool_use` ids were found without \
            `tool_result` blocks immediately after: call_00_XeMcWVdzAiMldkyzZIXy5135. \
            Each `tool_use` block must have a corresponding `tool_result` block in \
            the next message.\",\"type\":\"invalid_request_error\",\"param\":null,\
            \"code\":\"invalid_request_error\"}}";
        let msg = friendly_upstream_error("upstream HTTP 502 Bad Gateway", Some(raw), true);
        assert!(
            !msg.contains("All model providers are currently unavailable"),
            "router-wrapped 400 must not claim providers are down, got: {msg}"
        );
        assert!(
            msg.contains("rejected the request as invalid"),
            "router-wrapped 400 should explain it's a request problem, got: {msg}"
        );
        assert!(
            msg.contains("tool_use"),
            "router-wrapped 400 should surface the actual provider message, got: {msg}"
        );
        assert!(
            msg.contains("retrying won't help"),
            "router-wrapped 400 should tell user not to retry, got: {msg}"
        );
    }

    #[test]
    fn test_extract_upstream_detail() {
        // Full envelope with Anthropic-style error JSON.
        let raw = "router_upstreams_failed: DeepSeek:deepseek-v4-flash 400 \
            {\"error\":{\"message\":\"messages.4: tool_use ids missing\",\"type\":\"invalid_request_error\"}}";
        let detail = extract_upstream_detail(Some(raw));
        assert_eq!(
            detail.as_deref(),
            Some("messages.4: tool_use ids missing"),
            "should extract the actionable provider message, got: {detail:?}"
        );
        // Empty envelope.
        assert_eq!(extract_upstream_detail(Some("router_upstreams_failed: ")), None);
        // No envelope prefix at all — fall back to JSON parse of the whole body.
        let raw_no_prefix = "{\"error\":{\"message\":\"bad input\"}}";
        assert_eq!(
            extract_upstream_detail(Some(raw_no_prefix)).as_deref(),
            Some("bad input")
        );
        // Not JSON at all.
        assert_eq!(extract_upstream_detail(Some("not json")), None);
    }

    #[test]
    fn test_doom_loop_detector() {
        let mut detector = DoomLoopDetector::new();
        
        // Push different calls
        assert!(!detector.push("read_file", &json!({"path": "a.rs"})));
        assert!(!detector.push("read_file", &json!({"path": "b.rs"})));
        assert!(!detector.push("read_file", &json!({"path": "a.rs"})));
        
        // Push duplicate calls consecutively
        let mut detector = DoomLoopDetector::new();
        assert!(!detector.push("read_file", &json!({"path": "a.rs"})));
        assert!(!detector.push("read_file", &json!({"path": "a.rs"})));
        // The third duplicate call must trigger a doom loop!
        assert!(detector.push("read_file", &json!({"path": "a.rs"})));
    }
}
