use serde_json::{json, Value};
use chrono::Utc;
use tokio::sync::{mpsc, oneshot};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::convert::Infallible;
use futures_util::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use crate::settings;
use crate::chatstore;
mod prompts;
mod llm;
mod compaction;
mod orientation;

use prompts::convert_input_messages;
use llm::{stream_llm, trace as llm_trace, LlmEvent};
use crate::tools::{execute_tool, evaluate_tool_risk, get_tool_schemas, Risk};

/// Append one structured correlation record to the agent JSONL log. The
/// per-turn detail (request/tool_call/tool_result/finish/…) is written by
/// `llm::trace`; this wrapper only emits the run-scoped lifecycle events
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
    if mid.contains("deepseek-v4-flash") {
        return 65536;
    }
    // OpenAI / OpenAI-compatible: a safe general default.
    16384
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

pub fn classify_provider_error(message: &str) -> ErrorClass {
    let lower = message.to_ascii_lowercase();
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
    let mut map = pending_permission_gates().lock().unwrap();
    if let Some(tx) = map.remove(gate_id) {
        let _ = tx.send(true);
        true
    } else {
        false
    }
}

pub fn reject_gate(gate_id: &str) -> bool {
    let mut map = pending_permission_gates().lock().unwrap();
    if let Some(tx) = map.remove(gate_id) {
        let _ = tx.send(false);
        true
    } else {
        false
    }
}

// ── Pending interactive questions (ask_question / ask_user) ──────────────────
// One in-flight question per chat_id, mirroring the permission-gate pattern.
// The tool blocks on a oneshot until the frontend POSTs the answer.
fn pending_questions() -> &'static Mutex<HashMap<String, oneshot::Sender<String>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, oneshot::Sender<String>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a pending question for a chat. Called by the /answer-question route.
pub fn answer_pending_question(chat_id: &str, answer: &str) -> bool {
    let mut map = pending_questions().lock().unwrap();
    if let Some(tx) = map.remove(chat_id) {
        let _ = tx.send(answer.to_string());
        true
    } else {
        false
    }
}

/// Register a pending question (called from the tool dispatcher).
pub fn register_pending_question(chat_id: &str, tx: oneshot::Sender<String>) {
    let mut map = pending_questions().lock().unwrap();
    map.insert(chat_id.to_string(), tx);
}

/// Drop a pending question (e.g. on timeout).
pub fn clear_pending_question(chat_id: &str) {
    let mut map = pending_questions().lock().unwrap();
    map.remove(chat_id);
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
    let mut map = approved_commands().lock().unwrap();
    map.entry(chat_id.to_string()).or_default().insert(normalized);
}

/// Check whether a command was already approved for this chat.
pub fn is_command_approved(chat_id: &str, command: &str) -> bool {
    let normalized = normalize_command(command);
    let map = approved_commands().lock().unwrap();
    map.get(chat_id).map(|set| set.contains(&normalized)).unwrap_or(false)
}

/// Strip a command down to its program + first arg so trivial env-var /
/// whitespace differences don't defeat the allowlist.
fn normalize_command(command: &str) -> String {
    command.trim().split_whitespace().take(2).collect::<Vec<_>>().join(" ")
}

/// Clear a chat's approved-commands (called when a run ends).
pub fn clear_approved_commands(chat_id: &str) {
    let mut map = approved_commands().lock().unwrap();
    map.remove(chat_id);
}


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
) -> impl futures_util::Stream<Item = Result<Value, Infallible>> {
    let (tx, rx) = mpsc::channel(100);

    let run_chat_id = chat_id.clone();
    let turn_handle = tokio::spawn(async move {
        // Ensure the run is unregistered even if the turn returns early or
        // panics, so a stale handle never blocks a future turn from being
        // registered/cancelled.
        let chat_id_for_cleanup = chat_id.clone();
        let _guard = RunGuard(chat_id_for_cleanup);

        let s = settings::load();
        let run_id = if run_id.is_empty() { chat_id.clone() } else { run_id };
        log_agent_event(&chat_id, &run_id, "turn_start", json!({
            "model_id": model_id,
            "project_id": project_id,
            "plan_mode": plan_mode,
            "auto_approve": auto_approve,
            "attachment_count": attachments.len(),
        }));
        
        // Load the chat history
        let mut chat = match chatstore::get(&chat_id) {
            Some(c) => c,
            None => {
                // Initialize the chat if missing
                chatstore::create("New chat", &model_id, &project_id)
            }
        };

        // Append the user message. We store the plain display text as the
        // message `content` — the frontend renders `message.content` as a
        // string, so storing Anthropic content blocks here crashed it (React
        // #31: "object with keys {text,type}"). The multimodal content-blocks
        // form is built separately below, only for the model payload.
        let user_display = user_message.clone();
        let is_dup = chat.messages.last().map_or(false, |m| {
            m.role == "user" && chatstore::content_to_text(&m.content) == user_display
        });
        if !is_dup && (!user_message.is_empty() || !attachments.is_empty()) {
            chatstore::append_message(&chat.id, "user", json!(user_display));
            chat = chatstore::get(&chat.id).unwrap();
        }

        // Emit chat reconciliation event AFTER appending so the title — which
        // append_message auto-derives from the first user message — is current.
        // (Still the first event on the stream, so the frontend can map its
        // provisional tmp_ ID to the real server-assigned chat ID before any
        // tokens arrive.)
        let _ = tx.send(json!({
            "type": "chat",
            "id": chat.id,
            "title": chat.title
        })).await;
        
        // 1. Resolve credentials
        let (api_key, base_url, shape, real_model_id, provider_display_name) = if model_id == "__claude_code__" {
            let cc_model = crate::server::read_claude_code_model().unwrap_or_default();
            let real_model = if cc_model.is_empty() || cc_model == "(default)" {
                "claude-3-5-sonnet-latest".to_string()
            } else {
                cc_model
            };
            if let Some(cred) = crate::server::resolve("claude_code", &s, "") {
                (cred.api_key, cred.base_url, cred.shape, real_model, "local credentials".to_string())
            } else {
                ("".to_string(), "https://api.anthropic.com".to_string(), "anthropic".to_string(), real_model, "local credentials".to_string())
            }
        } else if let Some(m) = s.custom_models.iter().find(|m| m.id == model_id) {
            let real_model = if m.model_id == "(default)" || m.model_id.is_empty() {
                "claude-3-5-sonnet-latest".to_string()
            } else {
                m.model_id.clone()
            };
            let provider_name = m.credential.clone();
            if let Some(cred) = crate::server::resolve(&m.credential, &s, &m.base_url_override) {
                (cred.api_key, cred.base_url, m.shape.clone(), real_model, provider_name)
            } else {
                ("".to_string(), m.base_url_override.clone(), m.shape.clone(), real_model, provider_name)
            }
        } else {
            // Fallback: zwork_router default models
            let real_model = if model_id.contains("pro") {
                "deepseek-v4-pro".to_string()
            } else {
                "deepseek-v4-flash".to_string()
            };
            if let Some(cred) = crate::server::resolve("zwork_router", &s, "") {
                (cred.api_key, cred.base_url, "anthropic".to_string(), real_model, "zWork Cloud Router".to_string())
            } else {
                ("".to_string(), "https://api.tryzwork.app/api".to_string(), "anthropic".to_string(), real_model, "zWork Cloud Router".to_string())
            }
        };

        log_agent_event(&chat_id, &run_id, "provider_resolved", json!({
            "provider": provider_display_name,
            "base_url": base_url,
            "shape": shape,
            "real_model_id": real_model_id,
        }));

        // Surface the resolved provider/model to the frontend so the model
        // picker shows accurate info, and flag needs-setup when no credentials
        // are configured (the Python backend's no-model SSE path).
        let _ = tx.send(json!({
            "type": "meta",
            "provider": provider_display_name,
            "resolved_model": real_model_id,
            "upstream_provider": shape,
        })).await;

        if api_key.trim().is_empty() {
            let _ = tx.send(json!({
                "type": "needs_setup",
                "message": "No model credentials are configured. Add an API key in Settings to start chatting."
            })).await;
            let _ = tx.send(json!({ "type": "done" })).await;
            let _ = tx.send(json!({ "type": "end" })).await;
            return;
        }

        // 2. Build system prompt
        let user_name = crate::server::display_name();
        let os_name = std::env::consts::OS.to_string();
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

        let skills_list = crate::skills::format_for_system_prompt();
        let skills = crate::skills::list_skills();
        let example_slug = skills.first().map(|s| s.slug.as_str()).unwrap_or("frontend-design");

        // All tools are advertised every turn — non-technical users shouldn't
        // have to manage "scopes", and modern tool-calling models pick the
        // right tool from the full menu better than any keyword heuristic
        // (the frontier harnesses Goose, Claude Code, and opencode all bet
        // this way). `plan_mode` remains the only tool gate (read-only subset).
        // Per-tool-group workflow guidance lives in the system prompt instead.
        //
        // Desktop control (`desktop_*`) is macOS-only: it drives apps through
        // the macOS accessibility tree via the CuaDriver daemon, a notarized
        // .app with no Windows/Linux build. Advertising it elsewhere made the
        // model call `desktop_launch_app`, hit a driver-not-found error, and
        // burn turn after turn retrying — the "Chrome takes 20 minutes" bug on
        // non-macOS. Gating it out forces the model to `run_command` /
        // `browser_*` instead, which actually work cross-platform.
        let include_desktop = cfg!(target_os = "macos");
        let include_academic = true;

        // Fetch connected-app (Composio) tools once per turn so the model can
        // call `composio__*` actions. Empty when the user isn't connected, so
        // this is a no-op for the common case.
        let composio_schemas = crate::composio::all_tool_schemas().await;
        let composio_apps = crate::composio::connected_apps().await;
        let connected_apps_block =
            crate::composio::build_connected_apps_block(&composio_schemas, &composio_apps);
        // MCP tools from configured stdio servers (~/.zwork/mcp.json).
        let mcp_schemas = crate::mcp::all_tool_schemas();

        let get_scoped_schemas = |plan_mode_val: bool| -> Vec<Value> {
            let mut all = get_tool_schemas(plan_mode_val);
            all.extend(composio_schemas.clone());
            all.extend(mcp_schemas.clone());
            // Stable name-sort so the tool list (and thus the tool-order
            // sensitive prompt-cache prefix) doesn't reshuffle across turns
            // when MCP/Composio servers connect/disconnect mid-session.
            all.sort_by(|a, b| {
                a.get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
            });
            all
        };

        // Load the active project's name + context so the prompt reflects it.
        // The Python backend injects project.md context; here we read the same
        // project dir used by the /api/projects/* routes.
        let (project_name, project_md) = if !project_id.is_empty() {
            let dir = crate::paths::project_dir(&project_id);
            let name = std::fs::read_to_string(dir.join("project.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .unwrap_or_default();
            let ctx = std::fs::read_to_string(dir.join("context.md")).unwrap_or_default();
            (name, ctx)
        } else {
            (String::new(), String::new())
        };

        let system_prompt = settings::build_system_prompt(
            &real_model_id,
            &provider_display_name,
            &user_name,
            &os_name,
            &cwd,
            &project_name,
            &project_md,
            plan_mode,
            auto_approve,
            &skills_list,
            example_slug,
            include_desktop,
            include_academic,
            &connected_apps_block,
        );

        // Inject the LIVE environment status so the model actually knows its
        // browser/desktop tools are connected and ready. The tool schemas are
        // always advertised, but without this signal a model will often avoid
        // the browser_* tools ("not sure they're available") and fall back to
        // guessing URLs or claiming it can't browse — even when the zbctl
        // bridge shows Connected in Settings.
        let browser_connected = crate::browser_bridge::extension_connected().await;
        let mut system_prompt = format!(
            "{system_prompt}\n\n## Live environment status\n{}",
            if browser_connected {
                "- Chrome browser bridge: CONNECTED. Your browser_* tools are LIVE and drive the user's real Chrome (signed-in sessions, no login walls). For ANY task involving a website, web app, web form, login-gated page, or anything browser-based, USE the browser_* tools (browser_navigate / browser_snapshot / browser_click / browser_type / browser_eval). Do not claim you cannot browse, and do not guess URLs from memory — navigate to a real URL or snapshot and click real links."
            } else {
                "- Chrome browser bridge: NOT connected. browser_* tools will fail until the user opens Chrome with the zbctl extension loaded and zWork running. If the task needs the browser, tell the user to connect it rather than guessing."
            }
        );

        // Artifact mode: steer the model toward rich deliverables. The hint
        // keyword-detects the likely artifact kind (doc/sheet/graph/code) the
        // way the Python backend did, so the same phrasings produce artifacts.
        if artifact_mode {
            system_prompt.push_str("\n\n## Artifact mode\n");
            system_prompt.push_str(&artifact_hint(&user_message));
        }

        // Web-search grounding: when enabled, run a quick search on the
        // message and inject the results as grounding context (mirrors Python).
        if web_search_enabled {
            if let Some(grounding) = web_search_grounding(&user_message).await {
                system_prompt.push_str("\n\n## Web Search Results (Grounding Context)\n");
                system_prompt.push_str(&grounding);
            }
        }

        // Attachment framing: name and surface each attachment so the model
        // treats them as interaction context, not just inline bytes.
        if !attachments.is_empty() {
            let listing = attachments
                .iter()
                .map(|a| format!("- {} → {}", a.name, a.path_or_url()))
                .collect::<Vec<_>>()
                .join("\n");
            system_prompt.push_str(&format!(
                "\n\n## Current interaction context\nThe user attached:\n{listing}"
            ));
        }

        // Caller-supplied extra system-prompt block. Used by the scheduler to
        // inject scheduled-task identity, trigger description, and per-task
        // memory. Interactive (HTTP) turns pass `None` — no-op here.
        if let Some(extra) = &extra_system_prompt {
            if !extra.trim().is_empty() {
                system_prompt.push_str("\n\n");
                system_prompt.push_str(extra);
            }
        }

        let mut history_messages = Vec::new();
        // Insert system prompt first
        history_messages.push(json!({
            "role": "system",
            "content": system_prompt
        }));
        for msg in &chat.messages {
            history_messages.push(json!({
                "role": msg.role,
                "content": msg.content
            }));
        }
        // The current user turn may carry attachments (e.g. images) that the
        // stored display-string content cannot represent. When attachments are
        // present, replace the last user message's content with the full
        // content-block payload so the model actually receives them.
        if !attachments.is_empty() {
            let user_blocks = prompts::build_user_content(&user_message, &attachments);
            if let Some(last) = history_messages.last_mut() {
                if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                    last["content"] = user_blocks;
                }
            }
        }
        
        repair_history_alternation(&mut history_messages);
        let mut doom_loop_detector = DoomLoopDetector::new();
            
        // Main multi-turn executor loop. A "turn" is one model inference + its
        // tool executions. Multi-step desktop/browser work (capture → act →
        // re-capture → …) routinely needs 15–30+ turns. The loop terminates
        // *naturally* when the model stops emitting tool calls (task done), the
        // DoomLoopDetector halts exact-repeat loops, the user hits Stop, or a
        // stream error ends the turn.
        //
        // On top of those, a hard runaway cap is the last line of defense: a
        // buggy fallback or a model that never converges once burned the user's
        // entire request quota (199 turns → HTTP 429) before any guard fired.
        // 80 turns is generous headroom over what real tasks need. Override
        // with ZWORK_MAX_TURNS; set it to 0 for the old unbounded behaviour.
        let mut turn = 0u32;
        const DEFAULT_MAX_TURNS: u32 = 80;
        let max_turns: u32 = match std::env::var("ZWORK_MAX_TURNS") {
            Ok(v) => v
                .trim()
                .parse::<u32>()
                .ok()
                .filter(|&n| n > 0)
                .unwrap_or(DEFAULT_MAX_TURNS),
            Err(_) => DEFAULT_MAX_TURNS,
        };
        let mut hit_turn_cap = false;
        // Transient-error retry state. A 429 or 503 shouldn't kill the entire
        // task — retry up to 3 times with exponential backoff (1s, 2s, 4s).
        let mut transient_retries = 0u32;
        const MAX_TRANSIENT_RETRIES: u32 = 3;
        
        // Initialize the assistant response message
        let assistant_msg = chatstore::append_message(&chat.id, "assistant", json!(""));
        let assistant_msg_id = assistant_msg.map(|m| m.id).unwrap_or_default();
        
        let mut accumulated_text = String::new();
        let mut accumulated_activities = Vec::new();
        
        loop {
            turn += 1;
            if turn > max_turns {
                hit_turn_cap = true;
                break;
            }
            let _ = tx.send(json!({
                "type": "status",
                "text": "Thinking"
            })).await;
            
            let endpoint = if shape == "anthropic" {
                format!("{}/v1/messages", base_url)
            } else {
                format!("{}/chat/completions", base_url)
            };

            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("content-type", reqwest::header::HeaderValue::from_static("application/json"));

            use reqwest::header::HeaderValue;
            if shape == "anthropic" {
                let x_api_key = HeaderValue::try_from(api_key.clone()).unwrap_or_else(|_| HeaderValue::from_static(""));
                headers.insert("x-api-key", x_api_key);
                headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
                if !api_key.starts_with("sk-ant-") && !api_key.is_empty() {
                    let auth_str = format!("Bearer {}", api_key);
                    let auth_val = HeaderValue::try_from(auth_str).unwrap_or_else(|_| HeaderValue::from_static(""));
                    headers.insert("authorization", auth_val);
                }
            } else {
                let auth_str = format!("Bearer {}", api_key);
                let auth_val = HeaderValue::try_from(auth_str).unwrap_or_else(|_| HeaderValue::from_static(""));
                headers.insert("authorization", auth_val);
            }

            // Evict stale bulky tool results (old captures/snapshots) before
            // formatting the request. This is cost + latency hygiene, not
            // context survival: the model has a 1M-token window and captures
            // won't come close to exhausting it, but every turn re-sends the
            // full history, and the iron workflow re-captures after every state
            // change — so old captures/snapshots are stale (their
            // element_index tags no longer match the live UI), useless, and
            // expensive. Evicting them keeps each turn fast/cheap and stops the
            // model from acting on a stale index.
            compaction::evict_stale_bulky_results(&mut history_messages);

            // Opportunistic summarization compaction: once the conversation
            // crosses ~200k tokens (800k chars), summarize the middle history
            // into one message so the model never hits its context ceiling.
            // No-op below the threshold; a summarization failure is logged and
            // never aborts the turn (the model still gets the full history).
            //
            // Summarization always runs on the cheap tier of the main model's
            // provider (flash/haiku/mini) — NOT the model driving the chat — so
            // this background chore can't burn the expensive model's quota. The
            // endpoint/headers are provider-level (one key serves every model on
            // that base_url), so only the model id changes.
            let compaction_model =
                compaction::compaction_model_id(&shape, &real_model_id);
            let pre_len: usize = history_messages.iter()
                .map(|m| m.to_string().len())
                .sum();
            let compaction_result = compaction::compact_conversation_history(
                &mut history_messages,
                &endpoint,
                &headers,
                &shape,
                &compaction_model,
            )
            .await;
            match &compaction_result {
                Ok(()) => {
                    let post_len: usize = history_messages.iter()
                        .map(|m| m.to_string().len())
                        .sum();
                    // Only notify the UI if compaction actually shrank history.
                    if post_len < pre_len {
                        let _ = tx.send(json!({
                            "type": "compaction",
                            "status": "complete",
                            "before_chars": pre_len,
                            "after_chars": post_len,
                            "model": compaction_model,
                        })).await;
                    }
                }
                Err(e) => {
                    llm_trace(&chat_id, turn, "compaction_error", json!({ "error": e }));
                    let _ = tx.send(json!({
                        "type": "compaction",
                        "status": "failed",
                        "error": e,
                    })).await;
                }
            }

            // Inject the per-turn orientation block (Goose "moim" pattern) into
            // the latest user message. Volatile facts (time, cwd, git, budget)
            // go here rather than the system prompt so the cached system prefix
            // stays stable; the system prompt teaches the model how to read it.
            let turn_ctx = orientation::turn_context_block(turn, max_turns, &cwd);
            if let Some(last_user) = history_messages
                .iter_mut()
                .rev()
                .find(|m| m.get("role").and_then(|v| v.as_str()) == Some("user"))
            {
                if let Some(content) = last_user.get_mut("content") {
                    if let Some(s) = content.as_str() {
                        // Don't double-inject if a previous turn already prepended.
                        if !s.contains("<turn-context>") {
                            *content = json!(format!("{}\n\n{}", turn_ctx, s));
                        }
                    } else if let Some(arr) = content.as_array_mut() {
                        // Anthropic content-blocks shape: prepend a text block.
                        // Avoid duplicates across turns.
                        let already = arr.iter().any(|b| {
                            b.get("text")
                                .and_then(|t| t.as_str())
                                .map(|t| t.contains("<turn-context>"))
                                .unwrap_or(false)
                        });
                        if !already {
                            arr.insert(0, json!({ "type": "text", "text": turn_ctx }));
                        }
                    }
                }
            }

            // Format messages and tools payload
            let (system, convo) = convert_input_messages(&history_messages);
            
            let tools_payload = if shape == "anthropic" {
                let mut out = Vec::new();
                for t in get_scoped_schemas(plan_mode) {
                    out.push(json!({
                        "name": t["name"],
                        "description": t["description"],
                        "input_schema": t["parameters"]
                    }));
                }
                out
            } else {
                let mut out = Vec::new();
                for t in get_scoped_schemas(plan_mode) {
                    out.push(json!({
                        "type": "function",
                        "function": {
                            "name": t["name"],
                            "description": t["description"],
                            "parameters": t["parameters"]
                        }
                    }));
                }
                out
            };
            
            let body = if shape == "anthropic" {
                // Anthropic prompt caching: mark the (large, stable) system
                // prompt and tool catalog with `cache_control: ephemeral` so
                // subsequent turns pay the ~10% cache-read price instead of
                // full input cost. Only valid against the real Anthropic API.
                let caching_eligible = base_url.to_lowercase().contains("api.anthropic.com");
                let (system_field, tools_field): (Value, Value) = if caching_eligible {
                    let mut tools = tools_payload.clone();
                    if let Some(last) = tools.last_mut() {
                        last.as_object_mut()
                            .expect("tool entry is an object")
                            .insert("cache_control".to_string(), json!({"type": "ephemeral"}));
                    }
                    let sys_blocks = if system.is_empty() {
                        Value::Null
                    } else {
                        json!([{
                            "type": "text",
                            "text": system,
                            "cache_control": {"type": "ephemeral"}
                        }])
                    };
                    (sys_blocks, Value::Array(tools))
                } else {
                    (Value::String(system.clone()), Value::Array(tools_payload.clone()))
                };
                json!({
                    "model": real_model_id,
                    "system": system_field,
                    "messages": convo,
                    "stream": true,
                    "tools": tools_field,
                    "max_tokens": max_tokens_for(&real_model_id)
                })
            } else {
                let mut messages_payload = vec![json!({"role": "system", "content": system})];
                let converted_convo = prompts::convert_convo_for_openai(&convo);
                messages_payload.extend(converted_convo);
                json!({
                    "model": real_model_id,
                    "messages": messages_payload,
                    "stream": true,
                    "tools": tools_payload
                })
            };
            
            // Trace the outgoing request: model, message count, advertised
            // tools, and live browser status — so any later failure can be
            // correlated to exactly what the model was asked to do.
            {
                let schemas = get_scoped_schemas(plan_mode);
                let tool_names: Vec<&str> = schemas
                    .iter()
                    .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
                    .collect();
                llm_trace(
                    &chat_id,
                    turn,
                    "request",
                    json!({
                        "model": real_model_id,
                        "shape": shape,
                        "messages": convo.len(),
                        "tools": tool_names,
                        "browser_connected": browser_connected,
                        "plan_mode": plan_mode,
                    }),
                );
            }

            // Call upstream via the unified streaming layer: one parser per
            // provider wire format, loud errors, no silent frame/arg drops.
            let mut stream = stream_llm(endpoint, headers, body, shape.clone(), turn, chat_id.clone());
            let mut assistant_content_blocks: Vec<serde_json::Value> = Vec::new();
            let mut tool_calls = Vec::new();
            let mut turn_error: Option<String> = None;
            // Accumulator for streamed reasoning chunks within this turn.
            // Anthropic/DeepSeek emit reasoning as many small deltas; we
            // forward each delta live (so the UI can render a streaming
            // "thinking" dropdown) and flush the buffer when the segment ends.
            let mut reasoning_buffer = String::new();
            // Snapshot accumulated state for retry safety: if this turn hits a
            // transient error and we retry, we must undo any partial text that
            // was streamed to the DB before the error, otherwise the retried
            // turn's output appends to stale fragments and produces garbled text.
            let accumulated_text_len_snapshot = accumulated_text.len();
            let accumulated_activities_len_snapshot = accumulated_activities.len();

            while let Some(evt_res) = stream.next().await {
                let evt = match evt_res {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                match evt {
                    LlmEvent::TextDelta { text } => {
                        accumulated_text.push_str(&text);

                        if !text.is_empty() {
                            let mut merged = false;
                            if let Some(last_block) = assistant_content_blocks.last_mut() {
                                if last_block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                    if let Some(last_text) = last_block.get_mut("text") {
                                        if let Some(t_str) = last_text.as_str() {
                                            *last_text = json!(format!("{}{}", t_str, text));
                                            merged = true;
                                        }
                                    }
                                }
                            }
                            if !merged {
                                assistant_content_blocks.push(json!({
                                    "type": "text",
                                    "text": text
                                }));
                            }
                        }

                        // Update chat storage and stream to frontend
                        let _ = chatstore::update_message(
                            &chat_id,
                            &assistant_msg_id,
                            Some(json!(accumulated_text)),
                            Some(accumulated_activities.clone())
                        );
                        let _ = tx.send(json!({ "type": "delta", "text": text })).await;
                    }
                    LlmEvent::ReasoningDelta { text } => {
                        // Forward reasoning deltas to the UI so a streaming
                        // "thinking" dropdown can render chain-of-thought. The
                        // frontend treats `thinking_delta` events as a distinct
                        // segment kind (separate from visible `delta` text), so
                        // the model's reasoning never blends into the answer.
                        if !text.is_empty() {
                            reasoning_buffer.push_str(&text);
                            let _ = tx.send(json!({
                                "type": "thinking_delta",
                                "text": text
                            })).await;
                        }
                    }
                    LlmEvent::ThinkingBlock { thinking, signature } => {
                        // Preserve the extended-thinking block (with its
                        // signature) so it can be replayed on the next turn —
                        // Anthropic requires prior thinking blocks, signed, to
                        // be present when continuing a thinking-enabled turn.
                        let mut block = json!({
                            "type": "thinking",
                            "thinking": thinking,
                        });
                        if !signature.is_empty() {
                            block["signature"] = json!(signature);
                        }
                        assistant_content_blocks.push(block);
                        // Close the streamed thinking segment so the UI can
                        // finalize (and auto-collapse) its dropdown. A turn may
                        // produce reasoning via `ReasoningDelta` *or* a single
                        // assembled `ThinkingBlock`; either way this signals
                        // "thinking segment done".
                        if !reasoning_buffer.is_empty() {
                            reasoning_buffer.clear();
                            let _ = tx.send(json!({ "type": "thinking_end" })).await;
                        }
                    }
                    LlmEvent::ToolCall { id, name, input } => {
                        // Close any open reasoning segment before the tool call:
                        // a tool_use event implicitly terminates the preceding
                        // text/thinking segment in the frontend's parts[]
                        // timeline.
                        if !reasoning_buffer.is_empty() {
                            reasoning_buffer.clear();
                            let _ = tx.send(json!({ "type": "thinking_end" })).await;
                        }
                        tool_calls.push(json!({
                            "id": id.clone(),
                            "name": name.clone(),
                            "input": input.clone()
                        }));
                        assistant_content_blocks.push(json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input
                        }));
                        // Announce the tool call positionally so the frontend
                        // can open a `tool` part at the right point in the
                        // timeline — before the activity/tool_result frames
                        // arrive from the spawned execution task.
                        let _ = tx.send(json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input
                        })).await;
                    }
                    LlmEvent::Usage(_) | LlmEvent::Finish { .. } => {
                        // Diagnostic only; already traced inside stream_llm.
                    }
                    LlmEvent::ProviderError { message, .. } => {
                        // Don't emit yet — the retry logic below decides whether
                        // to retry (transient) or surface it (permanent).
                        turn_error = Some(message);
                    }
                    LlmEvent::Done => break,
                }
            }

            // A hard stream error ends the turn/task rather than executing any
            // partially-collected tool calls.
            if let Some(ref err_msg) = turn_error {
                if classify_provider_error(err_msg) == ErrorClass::Transient
                    && transient_retries < MAX_TRANSIENT_RETRIES
                {
                    transient_retries += 1;
                    let delay_ms = (1u64 << (transient_retries - 1)) * 1000; // 1s, 2s, 4s
                    let _ = tx.send(json!({
                        "type": "status",
                        "text": format!(
                            "Transient upstream error — retrying in {}s (attempt {}/{})…",
                            delay_ms / 1000, transient_retries, MAX_TRANSIENT_RETRIES
                        )
                    })).await;
                    llm_trace(
                        &chat_id,
                        turn,
                        "transient_retry",
                        json!({
                            "attempt": transient_retries,
                            "delay_ms": delay_ms,
                            "error": err_msg,
                        }),
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    // Undo any partial text/activities that were streamed to the
                    // DB before the transient error, otherwise the retry appends
                    // to stale fragments and produces garbled output.
                    accumulated_text.truncate(accumulated_text_len_snapshot);
                    accumulated_activities.truncate(accumulated_activities_len_snapshot);
                    if turn > 0 {
                        turn -= 1; // don't consume a turn slot on a retry
                    }
                    continue;
                }
                // Permanent error: surface it to the UI and break.
                let _ = tx.send(json!({ "type": "error", "text": err_msg })).await;
                break;
            }

            // Append assistant response to history
            history_messages.push(json!({
                "role": "assistant",
                "content": assistant_content_blocks
            }));

            // Tool calls arrive ONLY as structured `LlmEvent::ToolCall` events,
            // assembled complete by the unified streaming layer (see `llm/`).
            // There is no prose-scraping fallback: a tool name can never be
            // invented from the model's narration, so the phantom-tool-loop
            // class (browser_snapshot ×190 → quota 429) is structurally
            // impossible. No tool calls this turn ⇒ the task is done.
            if tool_calls.is_empty() {
                break;
            }
            
            // Doom Loop Check
            let mut is_doomed = false;
            for tc in &tool_calls {
                let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let params = tc.get("input").cloned().unwrap_or(json!({}));
                if doom_loop_detector.push(name, &params) {
                    is_doomed = true;
                    break;
                }
            }

            if is_doomed {
                // A doom loop means the model re-issued the same tool call
                // (name + input) three turns running — almost always a sign
                // that the tool result isn't giving it what it needs to make
                // progress (e.g. a 100 KB blob it can't extract signal from,
                // or a repeated `{}` against a tool that wants real args).
                // Killing the turn with only an error toast leaves a dead
                // empty assistant message in history; on resume the model has
                // nothing to build on and repeats. Instead: emit a real
                // assistant text that (a) tells the user what happened in
                // plain language and (b) replaces the empty assistant turn in
                // history so the next user message starts from a clean state.
                let recovery = "I got stuck repeating the same action without making progress, \
                    so I stopped to avoid burning your quota. This usually means a tool returned \
                    more than I could usefully read. Try rephrasing — for example, narrow the \
                    request (a specific sender, date, or subject) — or ask for one specific item \
                    by name.";
                let _ = tx.send(json!({
                    "type": "delta",
                    "text": recovery
                })).await;
                let _ = tx.send(json!({
                    "type": "error",
                    "text": "Stopped a repeated-action loop before it ran away."
                })).await;
                // Patch the just-pushed empty assistant turn in place so the
                // persisted history carries the recovery text instead of an
                // empty content array. `history_messages` is the running
                // conversation we persist at end of task.
                if let Some(last) = history_messages.last_mut() {
                    if last.get("role").and_then(|v| v.as_str()) == Some("assistant") {
                        *last = json!({
                            "role": "assistant",
                            "content": [{ "type": "text", "text": recovery }]
                        });
                    }
                }
                break;
            }

            // Execute tool calls and collect results concurrently
            let mut tool_results = Vec::new();
            let accumulated_activities_arc = std::sync::Arc::new(std::sync::Mutex::new(accumulated_activities));
            let db_lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
            
            let mut tasks = Vec::new();
            for tc in tool_calls {
                let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let params = tc.get("input").cloned().unwrap_or(json!({}));
                let tc_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                
                let tx = tx.clone();
                let accumulated_activities = accumulated_activities_arc.clone();
                let db_lock = db_lock.clone();
                let chat_id = chat_id.clone();
                let assistant_msg_id = assistant_msg_id.clone();
                let accumulated_text = accumulated_text.clone();
                let auto_approve = auto_approve;
                
                tasks.push(tokio::spawn(async move {
                    llm_trace(
                        &chat_id,
                        turn,
                        "tool_dispatch",
                        json!({ "id": tc_id, "name": name, "input": params }),
                    );

                    // Safety permissions gate check
                    let risk = evaluate_tool_risk(&name, &params);
                    let mut execute_allowed = true;
                    
                    if let Risk::Destructive { reason } = risk {
                        // A command the user already approved this run (via
                        // ask_user_for_permission) skips the gate entirely.
                        let already_approved = name == "run_command"
                            && params.get("command").and_then(|v| v.as_str())
                                .map(|c| is_command_approved(&chat_id, c))
                                .unwrap_or(false);
                        if !auto_approve && !already_approved {
                            let gate_id = format!("gate_{}", uuid::Uuid::new_v4().simple());

                            // Yield permission request
                            let _ = tx.send(json!({
                                "type": "permission",
                                "tool": name,
                                "reason": reason,
                                "blocked": true,
                                "gate_id": gate_id,
                                "tool_use_id": tc_id
                            })).await;
                            
                            let (gate_tx, gate_rx) = oneshot::channel();
                            {
                                let mut map = pending_permission_gates().lock().unwrap();
                                map.insert(gate_id.clone(), gate_tx);
                            }
                            
                            // Wait for user approval, with a long safety timeout so
                            // an unanswered prompt (UI closed, SSE stream dropped)
                            // can't hang the agent loop forever. On expiry we
                            // auto-deny and surface it to the user.
                            const GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
                            match tokio::time::timeout(GATE_TIMEOUT, gate_rx).await {
                                Ok(Ok(approved)) => {
                                    execute_allowed = approved;
                                }
                                Ok(Err(_)) => {
                                    // Gate dropped without a decision — deny.
                                    execute_allowed = false;
                                }
                                Err(_) => {
                                    let _ = tx.send(json!({
                                        "type": "status",
                                        "text": "Permission request timed out after 10 minutes and was auto-denied."
                                    })).await;
                                    execute_allowed = false;
                                }
                            }
                        }
                    }
                    
                    let mut final_result_txt = String::new();
                    let mut final_result_ok = true;
                    
                    if execute_allowed {
                        // Stream executing events
                        let mut tool_stream = execute_tool(&name, params, &chat_id);
                        
                        while let Some(t_evt_res) = tool_stream.next().await {
                            let t_evt = match t_evt_res {
                                Ok(e) => e,
                                Err(_) => continue,
                            };
                            let type_str = t_evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if type_str == "activity" {
                                // Update activity block under mutex
                                let act_id = t_evt.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                let act_label = t_evt.get("label").and_then(|v| v.as_str()).unwrap_or("");
                                let act_done = t_evt.get("done").and_then(|v| v.as_bool()).unwrap_or(false);

                                let entry = json!({
                                    "id": act_id,
                                    "label": act_label,
                                    "done": act_done
                                });

                                let current_activities = {
                                    let mut act_lock = accumulated_activities.lock().unwrap();
                                    if let Some(pos) = act_lock.iter().position(|x| x["id"] == act_id) {
                                        act_lock[pos] = entry;
                                    } else {
                                        act_lock.push(entry);
                                    }
                                    act_lock.clone()
                                };

                                // Serialize database updates using db_lock to avoid SQLite locks
                                {
                                    let _guard = db_lock.lock().await;
                                    let _ = chatstore::update_message(
                                        &chat_id,
                                        &assistant_msg_id,
                                        Some(json!(accumulated_text)),
                                        Some(current_activities)
                                    );
                                }
                                // Stamp the model's tool_use_id so the frontend
                                // can correlate this activity with the `tool_use`
                                // event that opened the tool part in its timeline.
                                let mut forwarded = t_evt;
                                forwarded["tool_use_id"] = json!(tc_id);
                                let _ = tx.send(forwarded).await;
                            } else if type_str == "tool_result" {
                                final_result_txt = t_evt.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                final_result_ok = t_evt.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
                                // Stamp the model's tool_use_id for correlation
                                // with the `tool_use` timeline part.
                                let mut forwarded = t_evt;
                                forwarded["tool_use_id"] = json!(tc_id);
                                let _ = tx.send(forwarded).await;
                            } else {
                                let _ = tx.send(t_evt).await;
                            }
                        }

                        llm_trace(
                            &chat_id,
                            turn,
                            "tool_result",
                            json!({
                                "name": name,
                                "ok": final_result_ok,
                                "len": final_result_txt.len(),
                                "preview": final_result_txt.chars().take(200).collect::<String>(),
                            }),
                        );
                    } else {
                        final_result_txt = "Permission denied by user. Action aborted.".to_string();
                        final_result_ok = false;
                        
                        let _ = tx.send(json!({
                            "type": "tool_result",
                            "tool": name,
                            "ok": false,
                            "message": final_result_txt,
                            "tool_use_id": tc_id
                        })).await;

                        llm_trace(
                            &chat_id,
                            turn,
                            "tool_result",
                            json!({ "name": name, "ok": false, "len": final_result_txt.len(), "preview": final_result_txt, "denied": true }),
                        );
                    }
                    
                    json!({
                        "type": "tool_result",
                        "tool_use_id": tc_id,
                        "content": final_result_txt,
                        "is_error": !final_result_ok
                    })
                }));
            }
            
            // Await all tasks concurrently
            let completed_results = futures_util::future::join_all(tasks).await;
            for res in completed_results {
                if let Ok(result_val) = res {
                    tool_results.push(result_val);
                }
            }
            
            // Extract accumulated_activities back to local variable
            accumulated_activities = {
                let lock = accumulated_activities_arc.lock().unwrap();
                lock.clone()
            };
            
            // Append tool results to history messages for next completion turn
            history_messages.push(json!({
                "role": "user",
                "content": tool_results
            }));
        }

        if hit_turn_cap {
            let _ = tx.send(json!({
                "type": "error",
                "text": format!("Reached the {}-turn runaway cap and stopped to protect your request quota — the task wasn't converging on its own. Try rephrasing, switching models, or set ZWORK_MAX_TURNS (0 = unbounded).", max_turns)
            })).await;
        }

        let _ = tx.send(json!({
            "type": "done"
        })).await;

        let _ = tx.send(json!({
            "type": "end"
        })).await;
    });

    // Register the turn so Stop can abort it. The RunGuard inside the task
    // unregisters on completion; this registration covers the live window.
    crate::watchdog::register_run(&run_chat_id, turn_handle);

    ReceiverStream::new(rx).map(Ok)
}

/// Spawn a sub-agent that runs a real, bounded, READ-ONLY agent loop to
/// complete a task, streaming `subagent_started` / `subagent_delta` /
/// `subagent_done` events to the parent's SSE stream. Returns the sub-agent's
/// final text result.
///
/// Safety rails (sub-agents are deliberately conservative, mirroring Python's
/// `auto_approve_destructive=False`):
///  - only non-destructive tools (read/list/search/web/academic);
///  - hard cap of 12 turns;
///  - no nested spawn_agent (would risk unbounded recursion).
pub async fn spawn_subagent(
    chat_id: &str,
    parent_run_id: &str,
    task: &str,
    model_id: &str,
    tx: &mpsc::Sender<Value>,
) -> Result<String, String> {
    use crate::agent::llm::{stream_llm, LlmEvent};
    use futures_util::StreamExt;

    let task_id = format!("subagent_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let _ = tx.send(json!({
        "type": "subagent_started",
        "task_id": task_id,
        "description": task,
    })).await;

    // Resolve the same model the parent uses.
    let s = settings::load();
    let (api_key, base_url, shape, real_model_id, provider_display_name) = if model_id == "__claude_code__" {
        let cc_model = crate::server::read_claude_code_model().unwrap_or_default();
        let real = if cc_model.is_empty() || cc_model == "(default)" { "claude-3-5-sonnet-latest".to_string() } else { cc_model };
        if let Some(cred) = crate::server::resolve("claude_code", &s, "") {
            (cred.api_key, cred.base_url, cred.shape, real, "local credentials".to_string())
        } else {
            ("".to_string(), "https://api.anthropic.com".to_string(), "anthropic".to_string(), real, "local credentials".to_string())
        }
    } else if let Some(m) = s.custom_models.iter().find(|m| m.id == model_id) {
        let real = if m.model_id.is_empty() || m.model_id == "(default)" { "claude-3-5-sonnet-latest".to_string() } else { m.model_id.clone() };
        if let Some(cred) = crate::server::resolve(&m.credential, &s, &m.base_url_override) {
            (cred.api_key, cred.base_url, m.shape.clone(), real, m.credential.clone())
        } else {
            return Err("No credentials for sub-agent model".to_string());
        }
    } else {
        let real = if model_id.contains("pro") { "deepseek-v4-pro".to_string() } else { "deepseek-v4-flash".to_string() };
        if let Some(cred) = crate::server::resolve("zwork_router", &s, "") {
            (cred.api_key, cred.base_url, "anthropic".to_string(), real, "zWork Cloud Router".to_string())
        } else {
            return Err("No credentials for sub-agent model".to_string());
        }
    };
    let _ = provider_display_name; // resolved but not surfaced for sub-agents

    if api_key.trim().is_empty() {
        let _ = tx.send(json!({"type": "subagent_done", "task_id": task_id, "error": "No credentials configured"})).await;
        return Err("No credentials configured".to_string());
    }

    // Read-only toolset: sub-agents must NOT mutate state.
    let readonly_schemas: Vec<Value> = get_tool_schemas(false).into_iter()
        .filter(|t| {
            matches!(
                t.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "read_file" | "list_dir" | "grep_search" | "web_search"
                | "search_papers" | "format_citation" | "extract_document"
            )
        })
        .collect();

    let system = format!(
        "You are a focused sub-agent. Complete this task: {}\n\n\
         You have READ-ONLY tools (read/list/search). Do the task, then stop. \
         Be concise — your full text output is returned to the parent agent.",
        task
    );
    let mut history: Vec<Value> = vec![json!({"role": "system", "content": system})];
    let user_msg = prompts::build_user_content(task, &[]);
    history.push(json!({"role": "user", "content": user_msg}));

    let endpoint = if shape == "anthropic" { format!("{}/v1/messages", base_url) } else { format!("{}/chat/completions", base_url) };
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("content-type", reqwest::header::HeaderValue::from_static("application/json"));
    if shape == "anthropic" {
        use reqwest::header::HeaderValue;
        headers.insert("x-api-key", HeaderValue::try_from(api_key.clone()).unwrap_or_else(|_| HeaderValue::from_static("")));
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    } else {
        use reqwest::header::HeaderValue;
        headers.insert("authorization", HeaderValue::try_from(format!("Bearer {}", api_key)).unwrap_or_else(|_| HeaderValue::from_static("")));
    }

    let mut accumulated = String::new();
    const MAX_SUBAGENT_TURNS: u32 = 12;

    for turn in 1..=MAX_SUBAGENT_TURNS {
        let (sys, convo) = prompts::convert_input_messages(&history);
        let tools_payload: Vec<Value> = if shape == "anthropic" {
            readonly_schemas.iter().map(|t| json!({"name": t["name"], "description": t["description"], "input_schema": t["parameters"]})).collect()
        } else {
            readonly_schemas.iter().map(|t| json!({"type":"function","function":{"name": t["name"], "description": t["description"], "parameters": t["parameters"]}})).collect()
        };
        let body = if shape == "anthropic" {
            json!({"model": real_model_id, "system": sys, "messages": convo, "stream": true, "tools": tools_payload, "max_tokens": max_tokens_for(&real_model_id)})
        } else {
            let mut msgs = vec![json!({"role":"system","content": sys})];
            msgs.extend(convo.clone());
            json!({"model": real_model_id, "messages": msgs, "stream": true, "tools": tools_payload})
        };

        let mut stream = stream_llm(endpoint.clone(), headers.clone(), body, shape.clone(), turn, chat_id.to_string());
        let mut text = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut assistant_blocks: Vec<Value> = Vec::new();
        while let Some(evt_res) = stream.next().await {
            match evt_res {
                Ok(LlmEvent::TextDelta { text: t }) => {
                    text.push_str(&t);
                    accumulated.push_str(&t);
                    let _ = tx.send(json!({"type":"subagent_delta","task_id": task_id, "text": t})).await;
                    // merge into last text block
                    if let Some(last) = assistant_blocks.last_mut() {
                        if last.get("type").and_then(|v| v.as_str()) == Some("text") {
                            if let Some(tt) = last.get_mut("text").and_then(|v| v.as_str()) {
                                let combined = format!("{}{}", tt, t);
                                *last.get_mut("text").unwrap() = json!(combined);
                                continue;
                            }
                        }
                    }
                    assistant_blocks.push(json!({"type":"text","text": t}));
                }
                Ok(LlmEvent::ToolCall { id, name, input }) => {
                    tool_calls.push(json!({"id": id, "name": name, "input": input}));
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }

        // Append the assistant turn to history.
        if !assistant_blocks.is_empty() && shape == "anthropic" {
            history.push(json!({"role":"assistant","content": assistant_blocks}));
        } else if !text.is_empty() {
            history.push(json!({"role":"assistant","content": text}));
        }
        if tool_calls.is_empty() {
            break; // no more work
        }

        // Execute the read-only tools and append results. Call the tool
        // functions directly (not through the streaming execute_tool
        // dispatcher) to avoid an opaque-type recursion cycle.
        for tc in &tool_calls {
            let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let input = tc.get("input").cloned().unwrap_or(json!({}));
            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let result = match name {
                "read_file" => crate::tools::fs::execute_read_file(&input).await,
                "list_dir" => crate::tools::fs::execute_list_dir(&input).await,
                "grep_search" => crate::tools::fs::execute_grep_search(&input).await,
                "web_search" => crate::tools::search::execute_web_search(&input).await,
                "extract_document" => crate::tools::doc_extract::execute_extract_document(&input).await,
                _ => Err(format!("Sub-agents cannot use tool '{}'", name)),
            };
            let final_msg = result.unwrap_or_else(|e| format!("Error: {}", e));
            if shape == "anthropic" {
                history.push(json!({"role":"user","content":[{"type":"tool_result","tool_use_id": id, "content": final_msg}]}));
            } else {
                history.push(json!({"role":"tool","tool_call_id": id, "content": final_msg}));
            }
        }
    }

    let _ = log_agent_event(chat_id, parent_run_id, "subagent_done", json!({"task_id": task_id, "chars": accumulated.len()}));
    let _ = tx.send(json!({"type":"subagent_done","task_id": task_id, "result": accumulated})).await;
    Ok(accumulated)
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

fn repair_history_alternation(messages: &mut Vec<Value>) {
    if messages.is_empty() {
        return;
    }
    let mut system_messages = Vec::new();
    let mut conversational = Vec::new();
    for msg in messages.drain(..) {
        if msg.get("role").and_then(|r| r.as_str()) == Some("system") {
            system_messages.push(msg);
        } else {
            conversational.push(msg);
        }
    }
    let mut repaired: Vec<Value> = Vec::new();
    for msg in conversational {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user").to_string();
        let content = msg.get("content").cloned().unwrap_or(json!(""));
        if let Some(last) = repaired.last_mut() {
            let last_role = last.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            if last_role == role {
                if role == "user" {
                    let mut merged_arr = Vec::new();
                    if let Some(arr) = last.get("content").and_then(|c| c.as_array()) {
                        merged_arr.extend(arr.clone());
                    } else {
                        merged_arr.push(json!({
                            "type": "text",
                            "text": last.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string()
                        }));
                    }
                    if let Some(arr) = content.as_array() {
                        merged_arr.extend(arr.clone());
                    } else {
                        merged_arr.push(json!({
                            "type": "text",
                            "text": content.as_str().unwrap_or("").to_string()
                        }));
                    }
                    last["content"] = json!(merged_arr);
                } else {
                    let last_str = last.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
                    let new_str = content.as_str().unwrap_or("").to_string();
                    last["content"] = json!(format!("{}\n\n{}", last_str, new_str));
                }
                continue;
            }
        }
        repaired.push(msg);
    }
    messages.extend(system_messages);
    messages.extend(repaired);
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
    fn test_repair_history_alternation() {
        let mut messages = vec![
            json!({
                "role": "system",
                "content": "sys-1"
            }),
            json!({
                "role": "user",
                "content": "user-1"
            }),
            json!({
                "role": "user",
                "content": "user-2"
            }),
            json!({
                "role": "assistant",
                "content": "assistant-1"
            }),
            json!({
                "role": "assistant",
                "content": "assistant-2"
            }),
            json!({
                "role": "user",
                "content": "user-3"
            }),
        ];

        repair_history_alternation(&mut messages);

        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[3]["role"], "user");

        // The user messages should be merged as content array blocks:
        let user1_2_content = &messages[1]["content"];
        assert!(user1_2_content.is_array());
        assert_eq!(user1_2_content[0]["text"], "user-1");
        assert_eq!(user1_2_content[1]["text"], "user-2");

        // The assistant messages should be merged as a single text:
        let assistant_content = messages[2]["content"].as_str().unwrap();
        assert!(assistant_content.contains("assistant-1"));
        assert!(assistant_content.contains("assistant-2"));
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
