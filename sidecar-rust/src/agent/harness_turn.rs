//! zWork turn runner on the pi harness.
//!
//! Runs one chat turn through `harness::Agent` (pi's agent loop, provider
//! adapters and tool executor) instead of the hand-rolled loop in
//! `agent/mod.rs`. Everything outside this module is unchanged: the same
//! SSE events in the same order, the same chatstore persistence, the same
//! permission gates, tool traces, doom-loop guard and turn cap.
//!
//! zWork's existing tools (`tools::execute_tool`) are wrapped as
//! `AgentTool`s so the model sees the same tool menu; their `activity` /
//! `tool_result` frames are forwarded stamped with the tool-call id exactly
//! as before.

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::harness::agent_types::{
    AgentMessage, AgentTool, AgentToolResult, AgentToolUpdateCallback, DynTool, ReplayPolicy, StreamFn,
    ToolExecutionMode, ToolFuture,
};
use crate::harness::compaction as hcompaction;
use crate::harness::providers::catalog;
use crate::harness::overflow as hoverflow;
use crate::harness::types::{
    AbortSignal, Api, AssistantContent, AssistantMessage, AssistantMessageEvent, InputType, Message, Model,
    StopReason, TextContent, ImageContent, Usage, UserContent,
};
use crate::sync_util::Unpoison;
use crate::tools::{evaluate_tool_risk, execute_tool, get_tool_schemas, Risk};
use crate::{chatstore, settings};

use super::{
    artifact_hint, classify_provider_error_with_raw, friendly_upstream_error, is_command_approved, llm_trace,
    log_agent_event, orientation, prompts, router_real_model,
    run_state, web_search_grounding, DoomLoopDetector, ErrorClass, RunGuard,
};

const DEFAULT_MAX_TURNS: u32 = 80;
const GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
const MAX_TRANSIENT_RETRIES: u32 = 3;

/// Context window used for auto-compaction: the model's own window, capped at
/// 200k — every turn re-sends the whole history, so compacting at 200k keeps
/// latency and cost sane even on 1M-window models. `ZWORK_CONTEXT_WINDOW`
/// replaces the cap.
fn context_window_for(model_window: u64) -> u64 {
    let cap = match std::env::var("ZWORK_CONTEXT_WINDOW").ok().and_then(|v| v.trim().parse::<u64>().ok()) {
        Some(n) if n > 0 => return n,
        _ => 200_000,
    };
    model_window.min(cap)
}

fn max_turns() -> u32 {
    match std::env::var("ZWORK_MAX_TURNS") {
        Ok(v) => v.trim().parse::<u32>().ok().filter(|&n| n > 0).unwrap_or(DEFAULT_MAX_TURNS),
        Err(_) => DEFAULT_MAX_TURNS,
    }
}

// ---------------------------------------------------------------------------
// Per-run shared state
// ---------------------------------------------------------------------------

/// State shared between the event listener, the hooks and the wrapped tools
/// for the duration of one run.
struct TurnShared {
    chat_id: String,
    run_id: String,
    tx: mpsc::Sender<Value>,
    /// Chatstore row the current generation streams into. Rotates when a
    /// queued message is consumed mid-run (steer / follow-up / next-run):
    /// the flat store can't interleave, so each consumed message closes the
    /// current assistant row and opens a fresh one.
    assistant_msg_id: Mutex<String>,
    auto_approve: bool,
    /// Reasoning effort picked in the prompt bar (`low`…`max`), if any.
    effort: Option<String>,
    max_turns: u32,
    /// Display text streamed so far (persisted on every delta, as before).
    accumulated_text: Mutex<String>,
    /// Activity blocks (`{id,label,done}`) persisted alongside the text.
    activities: Mutex<Vec<Value>>,
    /// Serializes chatstore writes from concurrently running tools.
    db_lock: tokio::sync::Mutex<()>,
    turn: AtomicU32,
    doomed: AtomicBool,
    hit_turn_cap: AtomicBool,
    thinking_open: AtomicBool,
    doom: Mutex<DoomLoopDetector>,
    /// Tool-call args by id, so `ToolExecutionEnd` can build a trace entry.
    call_args: Mutex<HashMap<String, Value>>,
    /// Trace entries for the current turn, flushed on `TurnEnd`.
    traces: Mutex<Vec<Value>>,
    /// Running token/cost usage for this run; each `MessageEnd` adds its
    /// delta and re-emits the total.
    usage: Mutex<Usage>,
}

impl TurnShared {
    async fn send(&self, v: Value) {
        let _ = self.tx.send(v).await;
    }

    /// Send one bus-ordered event, stamped with its bus seq (re-attach
    /// cursor protocol — see `map_harness_events`).
    async fn send_seq(&self, seq: u64, mut v: Value) {
        if let Some(map) = v.as_object_mut() {
            map.insert("seq".into(), json!(seq));
        }
        self.send(v).await;
    }

    fn turn(&self) -> u32 {
        self.turn.load(Ordering::SeqCst)
    }

    /// Persist the assistant row (text + activities). Serialized so parallel
    /// tools don't contend on SQLite.
    async fn persist(&self) {
        let text = self.accumulated_text.lock_unpoisoned().clone();
        let activities = self.activities.lock_unpoisoned().clone();
        let row = self.assistant_row();
        let _guard = self.db_lock.lock().await;
        let _ = chatstore::update_message(&self.chat_id, &row, Some(json!(text)), Some(activities));
    }

    /// Current assistant row id (cloned so no lock is held across awaits).
    fn assistant_row(&self) -> String {
        self.assistant_msg_id.lock_unpoisoned().clone()
    }

    /// A queued message (steer / follow-up / next-run) was consumed and its
    /// entry committed mid-run: project it into the flat chatstore and rotate
    /// the display to a fresh assistant row. Flat append order then reads
    /// `user → assistant(part 1) → user(queued) → assistant(part 2)`, which
    /// matches the live wire and keeps the next turn's seeded history
    /// faithful. The usage baseline resets so row 2 doesn't re-attribute
    /// row 1's tokens (per-chat totals only ever see each delta once).
    async fn consume_queued_message(&self, text: &str) {
        close_thinking(self).await;
        let new_row = {
            let _guard = self.db_lock.lock().await;
            chatstore::append_message(&self.chat_id, "user", json!(text));
            chatstore::append_message(&self.chat_id, "assistant", json!(""))
                .map(|m| m.id)
                .unwrap_or_default()
        };
        if new_row.is_empty() {
            return;
        }
        *self.assistant_msg_id.lock_unpoisoned() = new_row.clone();
        *self.accumulated_text.lock_unpoisoned() = String::new();
        *self.activities.lock_unpoisoned() = Vec::new();
        *self.usage.lock_unpoisoned() = Usage::empty();
        let _ = self
            .send(json!({ "type": "user_message", "text": text, "assistant_id": new_row }))
            .await;
    }

    /// The single permission gate for every tool: ask the user before a
    /// destructive call. `true` = go ahead. A bash command the user already
    /// approved this run (via `ask_user_for_permission`) skips the prompt.
    async fn permission_gate(&self, tool: &str, risk: Risk, tc_id: &str, params: &Value) -> bool {
        let Risk::Destructive { reason } = risk else {
            return true;
        };
        let already_approved = tool == "bash"
            && params.get("command").and_then(|v| v.as_str()).is_some_and(|c| is_command_approved(&self.chat_id, c));
        if self.auto_approve || already_approved {
            return true;
        }
        let (gate_id, gate_rx) = super::run_state::open_gate(&self.chat_id, tool, &reason, tc_id);
        self.send(json!({
            "type": "permission",
            "tool": tool,
            "reason": reason,
            "blocked": true,
            "gate_id": gate_id,
            "tool_use_id": tc_id
        }))
        .await;
        // Long safety timeout so an unanswered prompt (UI closed, SSE stream
        // dropped) can't hang the loop forever; expiry auto-denies.
        let outcome = tokio::time::timeout(GATE_TIMEOUT, gate_rx).await;
        super::run_state::drop_gate(&gate_id);
        match outcome {
            Ok(Ok(approved)) => approved,
            Ok(Err(_)) => false,
            Err(_) => {
                self.send(json!({
                    "type": "status",
                    "text": "Permission request timed out after 10 minutes and was auto-denied."
                }))
                .await;
                false
            }
        }
    }

    /// Report a call the user declined; returns the error the model sees.
    async fn denied(&self, tool: &str, tc_id: &str) -> String {
        let msg = "Permission denied by user. Action aborted.".to_string();
        self.send(json!({ "type": "tool_result", "tool": tool, "ok": false, "message": msg, "tool_use_id": tc_id }))
            .await;
        llm_trace(&self.chat_id, self.turn(), "tool_result", json!({ "name": tool, "ok": false, "len": msg.len(), "preview": msg, "denied": true }));
        msg
    }

    fn upsert_activity(&self, entry: Value) {
        let mut acts = self.activities.lock_unpoisoned();
        let id = entry.get("id").cloned().unwrap_or(Value::Null);
        if let Some(pos) = acts.iter().position(|x| x["id"] == id) {
            acts[pos] = entry;
        } else {
            acts.push(entry);
        }
    }
}

// ---------------------------------------------------------------------------
// Legacy tool adapter
// ---------------------------------------------------------------------------

/// One of zWork's own tools (desktop, browser, research, tasks, memory, …)
/// or a Composio app action, dispatched through `tools::execute_tool`, whose
/// activity/tool_result frames are forwarded stamped with the tool-call id.
struct NativeTool {
    name: String,
    description: String,
    parameters: Value,
    shared: Arc<TurnShared>,
}

impl NativeTool {
    fn from_schema(schema: &Value, shared: Arc<TurnShared>) -> Option<Self> {
        let name = schema.get("name")?.as_str()?.to_string();
        let description = schema.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string();
        let parameters = schema
            .get("parameters")
            .or_else(|| schema.get("input_schema"))
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        Some(Self { name, description, parameters, shared })
    }

    async fn run(&self, tc_id: &str, params: Value, signal: Option<&AbortSignal>) -> Result<AgentToolResult, String> {
        let shared = self.shared.clone();
        let turn = shared.turn();
        llm_trace(&shared.chat_id, turn, "tool_dispatch", json!({ "id": tc_id, "name": self.name, "input": params }));

        if !shared.permission_gate(&self.name, evaluate_tool_risk(&self.name, &params), tc_id, &params).await {
            return Err(shared.denied(&self.name, tc_id).await);
        }

        let (running, finished) = step_labels(&self.name, &params);
        let mut stream = Box::pin(execute_tool(&self.name, params, &shared.chat_id));
        let mut result_txt = String::new();
        let mut result_ok = true;
        loop {
            let next = match signal {
                Some(sig) => tokio::select! {
                    _ = sig.cancelled() => return Err("Tool aborted".into()),
                    n = stream.next() => n,
                },
                None => stream.next().await,
            };
            let Some(evt) = next else { break };
            let mut evt = match evt {
                Ok(e) => e,
                Err(never) => match never {},
            };
            match evt.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "activity" => {
                    let done = evt.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
                    evt["label"] = json!(if done { &finished } else { &running });
                    shared.upsert_activity(json!({
                        "id": evt.get("id").cloned().unwrap_or(Value::Null),
                        "label": evt["label"].clone(),
                        "done": done,
                    }));
                    shared.persist().await;
                    // Stamp the model's tool_use_id so the frontend can
                    // correlate this activity with the `tool_use` part.
                    evt["tool_use_id"] = json!(tc_id);
                    shared.send(evt).await;
                }
                "tool_result" => {
                    result_txt = evt.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    result_ok = evt.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
                    evt["tool_use_id"] = json!(tc_id);
                    shared.send(evt).await;
                    // CuaDriver permission-failure recovery card (see
                    // `is_cuadriver_permission_error`).
                    if !result_ok
                        && self.name.starts_with("desktop_")
                        && super::is_cuadriver_permission_error(&result_txt)
                    {
                        shared
                            .send(json!({
                                "type": "permission_recovery",
                                "tool_use_id": tc_id,
                                "kind": "cuadriver_permissions",
                                "message": super::cuadriver_recovery_message(&result_txt),
                            }))
                            .await;
                    }
                }
                _ => shared.send(evt).await,
            }
        }

        llm_trace(
            &shared.chat_id,
            turn,
            "tool_result",
            json!({
                "name": self.name,
                "ok": result_ok,
                "len": result_txt.len(),
                "preview": result_txt.chars().take(200).collect::<String>(),
            }),
        );
        if result_ok {
            Ok(AgentToolResult::text(result_txt))
        } else {
            Err(result_txt)
        }
    }
}

impl AgentTool for NativeTool {
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters(&self) -> Value {
        self.parameters.clone()
    }
    fn execute<'a>(
        &'a self,
        tool_call_id: &'a str,
        params: Value,
        signal: Option<&'a AbortSignal>,
        _on_update: AgentToolUpdateCallback,
    ) -> ToolFuture<'a> {
        Box::pin(self.run(tool_call_id, params, signal))
    }
}

// ---------------------------------------------------------------------------
// pi core tools (read/bash/edit/write/grep/find/ls) with zWork gating
// ---------------------------------------------------------------------------

/// A harness [`AgentTool`] (pi core tool or MCP connector tool) run through
/// zWork's permission gate and event plumbing:
/// `activity` start/finish frames, streamed bash output as `status` lines,
/// and a `tool_result` frame, all stamped with the tool-call id.
struct GatedTool {
    inner: DynTool,
    shared: Arc<TurnShared>,
    /// Ask before every call, with this reason (connector tools that the
    /// server does not declare read-only).
    confirm: Option<String>,
}

impl GatedTool {
    fn new(inner: DynTool, shared: &Arc<TurnShared>) -> Self {
        GatedTool { inner, shared: shared.clone(), confirm: None }
    }

    fn connector(tool: Arc<crate::connectors::mcp::McpTool>, shared: &Arc<TurnShared>) -> Self {
        let effect = if tool.destructive { "can delete or overwrite data" } else { "can make changes" };
        let confirm = (!tool.read_only).then(|| format!("{} {effect} in {}", tool.title, tool.server));
        GatedTool { inner: tool, shared: shared.clone(), confirm }
    }

    fn is_connector(&self) -> bool {
        self.inner.name().starts_with(crate::connectors::mcp::TOOL_PREFIX)
    }

    /// Activity labels for this call: what it is doing while it runs, and
    /// what it did once finished. Connector tools use their own title.
    fn step_labels(&self, params: &Value) -> (String, String) {
        if self.is_connector() {
            (format!("Using {}", self.inner.label()), format!("Used {}", self.inner.label()))
        } else {
            step_labels(self.inner.name(), params)
        }
    }

    fn risk(&self, params: &Value) -> Risk {
        match &self.confirm {
            Some(reason) => Risk::Destructive { reason: reason.clone() },
            None => evaluate_tool_risk(self.inner.name(), params),
        }
    }

    async fn run(&self, tc_id: &str, params: Value, signal: Option<&AbortSignal>, _on_update: AgentToolUpdateCallback) -> Result<AgentToolResult, String> {
        let shared = self.shared.clone();
        let name = self.inner.name().to_string();
        let turn = shared.turn();
        llm_trace(&shared.chat_id, turn, "tool_dispatch", json!({ "id": tc_id, "name": name, "input": params }));

        if !shared.permission_gate(&name, self.risk(&params), tc_id, &params).await {
            return Err(shared.denied(&name, tc_id).await);
        }

        let activity_id = format!("tool_{}_{}", name, uuid::Uuid::new_v4().simple());
        let (label, finished) = self.step_labels(&params);
        shared.upsert_activity(json!({ "id": activity_id, "label": label, "done": false }));
        shared.persist().await;
        shared
            .send(json!({ "type": "activity", "id": activity_id, "label": label, "done": false, "tool_use_id": tc_id }))
            .await;

        // Stream bash output as `status` lines:
        // each update carries the full accumulated output, so only the
        // newly completed lines are forwarded.
        let tx = shared.tx.clone();
        let seen = Arc::new(Mutex::new(0usize));
        let forward: AgentToolUpdateCallback = Arc::new(move |partial: AgentToolResult| {
            let text = partial.text_content();
            let mut seen = seen.lock_unpoisoned();
            if text.len() <= *seen {
                return;
            }
            let fresh = &text[*seen..];
            let Some(last_nl) = fresh.rfind('\n') else { return };
            let complete = &fresh[..last_nl];
            *seen += last_nl + 1;
            for line in complete.lines() {
                let line = line.trim_end();
                if line.is_empty() {
                    continue;
                }
                let _ = tx.try_send(json!({ "type": "status", "text": line }));
            }
        });
        let outcome = self.inner.execute(tc_id, params, signal, forward).await;

        let (ok, text) = match &outcome {
            Ok(r) => (true, r.text_content()),
            Err(e) => (false, e.clone()),
        };
        shared.upsert_activity(json!({ "id": activity_id, "label": finished, "done": true }));
        shared.persist().await;
        shared
            .send(json!({ "type": "activity", "id": activity_id, "label": finished, "done": true, "tool_use_id": tc_id }))
            .await;
        shared
            .send(json!({ "type": "tool_result", "tool": name, "ok": ok, "message": text, "tool_use_id": tc_id }))
            .await;
        llm_trace(
            &shared.chat_id,
            turn,
            "tool_result",
            json!({ "name": name, "ok": ok, "len": text.len(), "preview": text.chars().take(200).collect::<String>() }),
        );
        outcome
    }
}

/// System-prompt section for connected MCP servers: which are live and any
/// usage instructions they sent during `initialize`. Stable across turns, so
/// it stays inside the cached prefix.
fn mcp_prompt_block(mcp: &crate::connectors::mcp::Toolset) -> String {
    if mcp.tools.is_empty() {
        return String::new();
    }
    let mut servers: Vec<(&str, usize)> = Vec::new();
    for tool in &mcp.tools {
        match servers.iter_mut().find(|(s, _)| *s == tool.server) {
            Some((_, n)) => *n += 1,
            None => servers.push((&tool.server, 1)),
        }
    }
    let mut out = String::from(
        "\n\n## Connectors (MCP)\nThese services are connected. Their tools are named `mcp__<connector>__<tool>`; \
         prefer them over the browser or shell when they cover the task.\n",
    );
    for (server, n) in servers {
        out += &format!("- {server}: {n} tool{}\n", if n == 1 { "" } else { "s" });
    }
    for (server, text) in &mcp.instructions {
        let text: String = text.chars().take(2000).collect();
        out += &format!("\n### {server}\n{}\n", text.trim());
    }
    out
}

/// Plain-language step labels, (while running, once finished). The people
/// reading these don't know what `bash` or `update_todos` means, so each
/// says what happened in their terms: "Read expenses.csv", "Ran Python
/// script clean.py", "Updated the plan".
fn step_labels(name: &str, params: &Value) -> (String, String) {
    let arg = |k: &str| params.get(k).and_then(|v| v.as_str()).unwrap_or("").trim();
    let file = |k: &str| {
        let path = arg(k);
        readable_name(std::path::Path::new(path).file_name().and_then(|f| f.to_str()).unwrap_or(path))
    };
    let pair = |doing: &str, done: &str, what: String| {
        if what.is_empty() {
            (doing.to_string(), done.to_string())
        } else {
            (format!("{doing} {what}"), format!("{done} {what}"))
        }
    };
    match name {
        "read" => pair("Reading", "Read", file("path")),
        "write" => pair("Writing", "Wrote", file("path")),
        "edit" => pair("Editing", "Edited", file("path")),
        "bash" => pair("Running", "Ran", command_summary(arg("command"))),
        "grep" => pair("Searching files for", "Searched files for", quoted(arg("pattern"))),
        "find" => pair("Looking for files matching", "Looked for files matching", quoted(arg("pattern"))),
        "ls" => pair("Looking in", "Looked in", if arg("path").is_empty() { "the folder".into() } else { file("path") }),
        "update_todos" => pair("Updating the plan", "Updated the plan", String::new()),
        "web_search" => pair("Searching the web for", "Searched the web for", quoted(arg("query"))),
        "browser_navigate" => pair("Opening", "Opened", arg("url").to_string()),
        "extract_document" => pair("Reading", "Read", file("path")),
        "spawn_agent" => pair("Handing off a subtask", "Handed off a subtask", String::new()),
        "save_memory" => pair("Saving to memory", "Saved to memory", String::new()),
        "read_skill" => pair("Loading a skill", "Loaded a skill", String::new()),
        "ask_user" | "ask_question" | "ask_user_for_permission" => pair("Asking you", "Asked you", String::new()),
        "manage_tasks" => pair("Updating tasks", "Updated tasks", String::new()),
        "manage_events" => pair("Updating the calendar", "Updated the calendar", String::new()),
        "manage_schedules" => pair("Setting up a schedule", "Set up a schedule", String::new()),
        "post_to_inbox" => pair("Posting to your inbox", "Posted to your inbox", String::new()),
        "get_stock_data" => pair("Looking up market data", "Looked up market data", String::new()),
        "search_papers" => pair("Searching papers for", "Searched papers for", quoted(arg("query"))),
        "review_paper" => pair("Reviewing the paper", "Reviewed the paper", String::new()),
        "write_research_paper" => pair("Writing the paper", "Wrote the paper", String::new()),
        "format_citation" => pair("Formatting citations", "Formatted citations", String::new()),
        "check_novelty" => pair("Checking prior work", "Checked prior work", String::new()),
        "deploy_web_app" => pair("Publishing the web app", "Published the web app", String::new()),
        "send_telegram_message" => pair("Sending a Telegram message", "Sent a Telegram message", String::new()),
        n if n.starts_with("browser_") => pair("Using the browser", "Used the browser", String::new()),
        n if n.starts_with("desktop_") => pair("Using your computer", "Used your computer", String::new()),
        // App actions arrive as `GMAIL_SEND_EMAIL`: "Using Gmail: send email".
        n if n.contains('_') && !n.chars().any(|c| c.is_ascii_lowercase()) => {
            let (app, action) = n.split_once('_').unwrap_or((n, ""));
            let app = app.chars().next().map(|c| c.to_string()).unwrap_or_default() + &app[1..].to_lowercase();
            let what = format!("{app}: {}", action.replace('_', " ").to_lowercase());
            (format!("Using {what}"), format!("Used {what}"))
        }
        n => {
            let words = n.replace('_', " ");
            (format!("Running {words}"), format!("Ran {words}"))
        }
    }
}

fn quoted(s: &str) -> String {
    if s.is_empty() { String::new() } else { format!("\"{}\"", s.chars().take(60).collect::<String>()) }
}

/// Drops the 32-hex id the uploads folder prefixes to attached files, so
/// "a1b2…_expenses.csv" reads as the name the user gave it.
fn readable_name(text: &str) -> String {
    static UPLOAD_ID: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\b[0-9a-f]{32}_").unwrap());
    UPLOAD_ID.replace_all(text, "").into_owned()
}

/// The part of a shell command worth showing: leading `cd … &&` hops are
/// dropped, and a script run reads as "Python script clean.py".
fn command_summary(command: &str) -> String {
    let line = command.lines().next().unwrap_or("");
    let mut rest = line.trim();
    while let Some(head) = rest.split("&&").next() {
        let head = head.trim();
        let hop = head.starts_with("cd ") || head.starts_with("source ") || head.starts_with("export ") || head.starts_with("mkdir ");
        if !hop || !rest.contains("&&") {
            break;
        }
        rest = rest.splitn(2, "&&").nth(1).unwrap_or("").trim();
    }
    let mut words = rest.split_whitespace().peekable();
    if words.peek() == Some(&"uv") {
        words.next();
        if words.peek() == Some(&"run") {
            words.next();
        }
    }
    let program = words.peek().copied().unwrap_or("");
    let lang = match program.rsplit('/').next().unwrap_or(program) {
        p if p.starts_with("python") => Some("Python"),
        "node" => Some("Node"),
        _ => None,
    };
    if let Some(lang) = lang {
        words.next();
        // `python3 script.py`, not `python3 -c "…"` or a heredoc.
        let script = words.next().filter(|w| {
            let ext = w.rsplit('.').next().unwrap_or("");
            w.contains('.') && matches!(ext, "py" | "js" | "mjs" | "cjs" | "ts")
        });
        return match script {
            Some(script) => format!("{lang} script {}", readable_name(script.rsplit('/').next().unwrap_or(script))),
            None => format!("a {lang} snippet"),
        };
    }
    let rest = readable_name(rest);
    let mut shown: String = rest.chars().take(60).collect();
    if shown.len() < rest.len() {
        shown.push('…');
    }
    if shown.is_empty() { "a command".into() } else { format!("a command: {shown}") }
}

impl AgentTool for GatedTool {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn label(&self) -> &str {
        self.inner.label()
    }
    fn description(&self) -> &str {
        self.inner.description()
    }
    fn parameters(&self) -> Value {
        self.inner.parameters()
    }
    fn prepare_arguments(&self, args: Value) -> Result<Value, String> {
        self.inner.prepare_arguments(args)
    }
    fn execute<'a>(
        &'a self,
        tool_call_id: &'a str,
        params: Value,
        signal: Option<&'a AbortSignal>,
        on_update: AgentToolUpdateCallback,
    ) -> ToolFuture<'a> {
        Box::pin(self.run(tool_call_id, params, signal, on_update))
    }
    fn replay(&self) -> ReplayPolicy {
        self.inner.replay()
    }
    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        self.inner.execution_mode()
    }
    fn prompt_snippet(&self) -> Option<&str> {
        self.inner.prompt_snippet()
    }
    fn prompt_guidelines(&self) -> Vec<String> {
        self.inner.prompt_guidelines()
    }
}

// ---------------------------------------------------------------------------
// Durable runtime drive (pi AgentHarness) — M4 cutover path
// ---------------------------------------------------------------------------

/// Expose one zWork-gated tool to the durable runtime. Execution, permission
/// gating and event forwarding are the tool's own (identical to the agent
/// loop path); the adapter only supplies the durable wrapper: declaration,
/// replay policy, and an executor over the runtime's gate signal and update
/// callback.
fn runtime_tool_from(tool: DynTool) -> std::sync::Arc<crate::harness::runtime::tool_exec::RuntimeTool> {
    use crate::harness::runtime::tool_exec::{RuntimeTool, ToolExecution};
    let declaration = crate::harness::types::Tool {
        name: tool.name().to_string(),
        description: tool.description().to_string(),
        parameters: tool.parameters(),
    };
    let replay = match tool.replay() {
        ReplayPolicy::Safe => crate::harness::runtime::tool_exec::ReplayPolicy::Safe,
        ReplayPolicy::Never => crate::harness::runtime::tool_exec::ReplayPolicy::Never,
    };
    let execute: crate::harness::runtime::tool_exec::ExecuteFn = {
        let tool = tool.clone();
        Arc::new(move |execution: ToolExecution| {
            let tool = tool.clone();
            Box::pin(async move {
                let on_update: AgentToolUpdateCallback = {
                    let update = execution.update.clone();
                    Arc::new(move |partial: AgentToolResult| update(&partial, false))
                };
                tool.execute(
                    &execution.tool_call_id,
                    execution.args,
                    Some(&execution.signal),
                    on_update,
                )
                .await
            })
        })
    };
    Arc::new(RuntimeTool { declaration, replay, execute })
}

/// Text of a committed user entry, if this entry is one (assistant
/// settlements, compactions and custom entries project differently).
pub(crate) fn entry_user_text(entry: &crate::harness::session::types::Entry) -> Option<String> {
    use crate::harness::session::types::EntryBody;
    let EntryBody::Message { message, .. } = &entry.body else { return None };
    message
        .as_llm()
        .and_then(|m| m.as_user())
        .map(|u| u.content.text())
        .filter(|text| !text.is_empty())
}

/// Map durable harness events onto the zWork wire (same events, same order
/// as the agent-loop listener). Breaks on `run_end`; exits when the bus
/// closes. Enforces the runaway turn cap by aborting the operation durably.
///
/// Bus-ordered events carry their `seq` on the wire so a client that drops
/// mid-stream can re-attach via `GET /api/chats/:id/run/live?after=<seq>`
/// and replay exactly the gap (bridge-level events — chat/meta/done/end —
/// have no bus seq and stay unsequenced).
async fn map_harness_events(
    shared: Arc<TurnShared>,
    lane: std::sync::Arc<crate::harness::runtime::lane::Lane>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<(u64, crate::harness::runtime::events::HarnessEvent)>,
) {
    use crate::harness::runtime::events::HarnessEvent;
    let max_turns = shared.max_turns;
    // The prompt's own user entry is the first user entry on the bus (the
    // mapper subscribes before `prompt`; seeded history committed earlier and
    // is never seen). The bridge persisted that row at turn start, so only
    // LATER user entries — queue consumptions — project.
    let mut seen_prompt_entry = false;
    while let Some((seq, event)) = events.recv().await {
        match event {
            HarnessEvent::TurnStart { .. } => {
                let turn = shared.turn.fetch_add(1, Ordering::SeqCst) + 1;
                shared.send_seq(seq, json!({ "type": "status", "text": "Thinking" })).await;
                // Legacy semantics: stop after completing `max_turns` turns
                // (0 = unbounded). Here the cap aborts the durable operation
                // as the (max+1)-th turn starts, which reconciles cleanly.
                if max_turns > 0 && turn > max_turns {
                    shared.hit_turn_cap.store(true, Ordering::SeqCst);
                    if let Some(operation_id) = lane.current_operation_id().ok().flatten() {
                        let _ = lane.request_operation_abort(&operation_id).await;
                    }
                }
            }
            HarnessEvent::MessageUpdate { event, .. } => {
                handle_stream_event(&shared, event, seq).await;
            }
            HarnessEvent::MessageEnd { message, recovery, .. } => {
                if recovery == Some(true) {
                    recover_assistant_text(&shared, &message).await;
                }
                record_assistant_end(&shared, &message, seq).await;
            }
            HarnessEvent::EntryAdded { entry, recovery, .. } => {
                if recovery == Some(true) {
                    continue;
                }
                let Some(text) = entry_user_text(&entry) else { continue };
                if !seen_prompt_entry {
                    seen_prompt_entry = true;
                    continue;
                }
                shared.consume_queued_message(&text).await;
            }
            HarnessEvent::ToolEnd { tool_call_id, tool_name, result, is_error, .. } => {
                push_tool_trace(&shared, &tool_call_id, &tool_name, &result, is_error);
            }
            HarnessEvent::QueueUpdate { queues, .. } => {
                shared
                    .send_seq(seq, json!({
                        "type": "queue",
                        "items": queues
                            .iter()
                            .map(run_state::queued_item_wire)
                            .collect::<Vec<_>>(),
                    }))
                    .await;
            }
            HarnessEvent::CompactionStart { reason, .. } => {
                shared
                    .send_seq(seq, json!({ "type": "compaction", "status": "started", "reason": compaction_reason(&reason) }))
                    .await;
            }
            HarnessEvent::CompactionEnd { reason, outcome, .. } => {
                use crate::harness::runtime::events::StructuralOutcome as Out;
                let status = match outcome {
                    Out::Completed { .. } => "complete",
                    Out::Declined => "declined",
                    Out::Failed { .. } | Out::Aborted => "failed",
                };
                shared
                    .send_seq(seq, json!({ "type": "compaction", "status": status, "reason": compaction_reason(&reason) }))
                    .await;
            }
            HarnessEvent::TurnEnd { .. } => flush_traces(&shared).await,
            HarnessEvent::RunEnd { .. } => break,
            _ => {}
        }
    }
}

/// Wire name for a structural reason (matches the bridge-level compaction
/// event vocabulary the frontend already handles).
fn compaction_reason(reason: &crate::harness::runtime::events::StructuralReason) -> &'static str {
    use crate::harness::runtime::events::StructuralReason as R;
    match reason {
        R::Manual => "manual",
        R::Threshold => "threshold",
        R::Overflow => "overflow",
    }
}

/// One durable attempt: a fresh per-run session (crash-resumable artifact
/// under `~/.zwork/sessions/`), the harness facade over it, the doom-loop
/// guard on the hook registry, the event mapper, and the prompt driven to
/// settlement. Mid-run threshold + overflow compaction run as durable
/// structural procedures (M6); pre-run and the post-failure overflow retry
/// stay bridge-level.
#[allow(clippy::too_many_arguments)]
async fn run_durable_once(
    shared: &Arc<TurnShared>,
    model: &Model,
    model_product_id: &str,
    api_key: &str,
    system_prompt: &str,
    prompt_message: AgentMessage,
    history: &[AgentMessage],
    tools: &[DynTool],
    stream_fn: StreamFn,
) -> Option<crate::harness::session::types::OperationResultRecord> {
    use crate::harness::runtime::harness::{Harness, HarnessOptions};
    use crate::harness::runtime::types::RetryPolicySnapshot;
    use crate::harness::session::sqlite::SqliteSessionRepo;
    use crate::harness::session::types::HarnessStreamOptionsSnapshot;

    let repo = SqliteSessionRepo::new(crate::paths::home_dir().join("sessions"));
    let session_id = format!("{}__{}", shared.chat_id, uuid::Uuid::new_v4().simple());
    let session = match repo.create(&session_id, None) {
        Ok(session) => session,
        Err(error) => {
            let _ = shared.send(json!({ "type": "error", "text": format!("Failed to open durable session: {error}") })).await;
            return None;
        }
    };
    // Run metadata for resume-on-restart: enough to rebuild the provider
    // context (credentials re-resolve from settings at resume time; the
    // api key itself is never persisted). App namespace, not pi.*.
    {
        use crate::harness::session::values::value;
        let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let writes = [
            ("turn.chat_id", json!(shared.chat_id)),
            ("turn.run_id", json!(shared.run_id)),
            ("turn.model_id", json!(model_product_id)),
            ("turn.system_prompt", json!(system_prompt)),
            ("turn.cwd", json!(cwd)),
            ("turn.auto_approve", json!(shared.auto_approve)),
            ("turn.effort", json!(shared.effort.clone().unwrap_or_default())),
            ("turn.assistant_msg_id", json!(shared.assistant_row())),
        ];
        for (key, payload) in writes {
            if let Ok(address) = value("zwork", key) {
                let _ = session.set_value(&address, payload).await;
            }
        }
    }
    prune_completed_sessions(&repo, &shared.chat_id, &session_id);

    let provider = model.provider.clone();
    let model_id = model.id.clone();
    let source_model = model.clone();
    let mut config = crate::harness::runtime::types::RuntimeConfig::default();
    config.system_prompt = Some(system_prompt.to_string());
    config.context_window = Some(model.context_window);
    config.model_source = Some(Arc::new(move |p: &str, m: &str| {
        (p == provider && m == model_id).then(|| source_model.clone())
    }));
    config.stream = Some(stream_fn);
    config.stream_options = HarnessStreamOptionsSnapshot {
        api_key: Some(api_key.to_string()),
        max_tokens: Some(model.max_tokens),
        max_retries: Some(MAX_TRANSIENT_RETRIES),
        session_id: Some(shared.chat_id.clone()),
        ..Default::default()
    };
    // pi's defaults: back off 2s, 4s, 8s... so a dropped stream or a 529
    // has time to clear before the next attempt.
    config.retry_policy = RetryPolicySnapshot {
        enabled: true,
        max_retries: MAX_TRANSIENT_RETRIES,
        base_delay_ms: 2_000,
        ..Default::default()
    };
    // Durable compaction (M6): mid-run threshold + overflow compactions
    // run as structural procedures in the session (crash-safe, first-class
    // CompactionEntry, reloads stop re-compacting); pre-run and the
    // post-failure overflow retry stay bridge-level.
    config.compaction = hcompaction::CompactionSettings::default();
    // Parallel tool batches (several spawn_agent calls in one turn run
    // concurrently — the runtime's run_parallel). Off by default: bash and
    // write calls interleave, so it's an explicit opt-in.
    if std::env::var("ZWORK_PARALLEL_TOOLS").map(|v| v.trim() == "1").unwrap_or(false) {
        config.tool_execution = crate::harness::session::types::ToolExecutionMode::Parallel;
    }
    config.tools = Arc::new(tools.iter().map(|t| runtime_tool_from(t.clone())).collect());

    let (harness, open) = match Harness::create(
        session,
        HarnessOptions {
            provider: model.provider.clone(),
            model_id: model.id.clone(),
            thinking_level: thinking_level_for(&model, shared.effort.as_deref()),
            active_tool_names: tools.iter().map(|t| t.name().to_string()).collect(),
            config,
        },
    ) {
        Ok(created) => created,
        Err(error) => {
            let _ = shared.send(json!({ "type": "error", "text": format!("Durable harness failed to open: {error}") })).await;
            return None;
        }
    };
    debug_assert!(open.is_empty(), "fresh sessions must not carry open operations");

    let lane = match harness.lane("main").await {
        Ok(lane) => lane,
        Err(error) => {
            let _ = shared.send(json!({ "type": "error", "text": format!("Durable lane failed to open: {error}") })).await;
            return None;
        }
    };
    for message in history {
        if let Err(error) = lane.append_message(message.clone()).await {
            let _ = shared.send(json!({ "type": "error", "text": format!("Failed to seed history: {error}") })).await;
            return None;
        }
    }

    // Doom-loop guard on the durable registry (same rule as the agent-loop
    // hook): the same tool call three turns running blocks the call and
    // terminates the run; the post-run section emits the recovery text.
    {
        let shared = shared.clone();
        harness.hooks.on_before_tool(Arc::new(move |_ctx, event| {
            let doomed = shared.doom.lock_unpoisoned().push(&event.tool_name, &event.args);
            if !doomed && !shared.doomed.load(Ordering::SeqCst) {
                return Ok(None);
            }
            shared.doomed.store(true, Ordering::SeqCst);
            Ok(Some(crate::harness::runtime::hooks::BeforeToolResult {
                args: None,
                block: Some(crate::harness::runtime::hooks::ToolBlock {
                    reason: "Stopped: this exact action was repeated without progress.".into(),
                    terminate: Some(true),
                }),
            }))
        }));
    }

    // Re-attach surface: while this run is live, `GET /api/chats/:id/run/live`
    // streams the bus (cursor-based) and Stop can durably abort the open
    // operation.
    run_state::register_run(&shared.chat_id, run_state::LiveRun {
        run_id: shared.run_id.clone(),
        session_id: session_id.clone(),
        bus: harness.events.clone(),
        lane: lane.clone(),
        harness: harness.clone(),
        started_at: run_state::now_ms(),
    });

    let mapper = tokio::spawn(map_harness_events(
        shared.clone(),
        lane.clone(),
        harness.events.subscribe(None),
    ));

    let record = harness.prompt("main", vec![prompt_message]).await.ok();
    // Drain trailing events (usage / turn_end / run_end race the settle).
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), mapper).await;
    harness.close().await;
    run_state::unregister_run(&shared.chat_id, &session_id);
    record
}

/// Drive the turn on the durable runtime with the same overflow recovery as
/// the agent-loop path: on a context-overflow failure, compact the history
/// (bridge level, cheap tier) and retry once on a fresh session. Returns
/// whether an overflow compaction happened.
#[allow(clippy::too_many_arguments)]
async fn drive_durable(
    shared: &Arc<TurnShared>,
    model: &Model,
    model_product_id: &str,
    compaction_model: &Model,
    api_key: &str,
    stream_fn: StreamFn,
    system_prompt: &str,
    prompt_message: AgentMessage,
    mut history: Vec<AgentMessage>,
    tools: &[DynTool],
) -> bool {
    let mut compacted_on_overflow = false;
    loop {
        let record = run_durable_once(
            shared,
            model,
            model_product_id,
            api_key,
            system_prompt,
            prompt_message.clone(),
            &history,
            tools,
            stream_fn.clone(),
        )
        .await;

        let Some(record) = record else { return compacted_on_overflow };
        if record.status != crate::harness::session::types::TerminalStatus::Failed {
            return compacted_on_overflow;
        }
        let error_message = record.error.map(|e| e.message).unwrap_or_default();
        let mut probe = AssistantMessage::pending(model);
        probe.stop_reason = StopReason::Error;
        probe.error_message = Some(error_message.clone());
        if hoverflow::is_context_overflow(&probe, Some(model.context_window)) && !compacted_on_overflow {
            compacted_on_overflow = true;
            llm_trace(&shared.chat_id, shared.turn(), "context_overflow_compaction", json!({ "error": error_message }));
            match compact_history(shared, compaction_model, api_key, &stream_fn, &history).await {
                Some(compacted) => {
                    history = compacted;
                    continue;
                }
                None => {
                    llm_trace(&shared.chat_id, shared.turn(), "context_overflow_compaction_failed", json!({}));
                }
            }
        }
        let exhausted = classify_provider_error_with_raw(&error_message, None) == ErrorClass::Transient;
        let friendly = friendly_upstream_error(&error_message, None, exhausted);
        let _ = shared.send(json!({ "type": "error", "text": friendly })).await;
        return compacted_on_overflow;
    }
}

/// Bridge-level history compaction on the cheap tier (pre-run and overflow).
/// Same behavior as the agent-loop `ZworkHooks::compact`.
async fn compact_history(
    shared: &Arc<TurnShared>,
    compaction_model: &Model,
    api_key: &str,
    stream_fn: &StreamFn,
    messages: &[AgentMessage],
) -> Option<Vec<AgentMessage>> {
    let settings = hcompaction::CompactionSettings::default();
    let prep = hcompaction::prepare_compaction(messages, settings)?;
    let opts = hcompaction::SummarizationOptions {
        api_key: Some(api_key.to_string()),
        signal: None,
        session_id: Some(shared.chat_id.clone()),
        max_retries: Some(2),
        ..Default::default()
    };
    match hcompaction::compact(&prep, compaction_model, None, &opts, stream_fn).await {
        Ok(result) => {
            let compacted = hcompaction::apply_compaction(messages, &result);
            let after = hcompaction::estimate_context_tokens(&compacted).tokens;
            shared
                .send(json!({
                    "type": "compaction",
                    "status": "complete",
                    "before_tokens": result.tokens_before,
                    "after_tokens": after,
                    "model": compaction_model.id,
                }))
                .await;
            llm_trace(
                &shared.chat_id,
                shared.turn(),
                "compaction",
                json!({ "before_tokens": result.tokens_before, "after_tokens": after, "model": compaction_model.id }),
            );
            Some(compacted)
        }
        Err(e) => {
            llm_trace(&shared.chat_id, shared.turn(), "compaction_error", json!({ "error": e }));
            shared.send(json!({ "type": "compaction", "status": "failed", "error": e })).await;
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Wire emission (shared by the durable event mapper)
// ---------------------------------------------------------------------------

async fn close_thinking(shared: &TurnShared) {
    if shared.thinking_open.swap(false, Ordering::SeqCst) {
        shared.send(json!({ "type": "thinking_end" })).await;
    }
}

/// One streamed assistant block: text deltas, thinking deltas, tool calls.
async fn handle_stream_event(shared: &TurnShared, event: AssistantMessageEvent, seq: u64) {
    match event {
        AssistantMessageEvent::TextDelta { delta, .. } => {
            if delta.is_empty() {
                return;
            }
            shared.accumulated_text.lock_unpoisoned().push_str(&delta);
            shared.persist().await;
            shared.send_seq(seq, json!({ "type": "delta", "text": delta })).await;
        }
        AssistantMessageEvent::ThinkingDelta { delta, .. } => {
            if delta.is_empty() {
                return;
            }
            shared.thinking_open.store(true, Ordering::SeqCst);
            shared.send_seq(seq, json!({ "type": "thinking_delta", "text": delta })).await;
        }
        AssistantMessageEvent::ThinkingEnd { .. } => close_thinking(shared).await,
        AssistantMessageEvent::ToolcallEnd { tool_call, .. } => {
            // A tool_use part implicitly closes the preceding thinking
            // segment in the frontend timeline.
            close_thinking(shared).await;
            // Text streamed before a tool call is process narration, not
            // the answer. Drop it from the persisted display text so a
            // reloaded chat shows only the final answer (the text after
            // the last tool call); the frontend mirrors this by demoting
            // the same text into its process panel.
            let had_narration = {
                let mut text = shared.accumulated_text.lock_unpoisoned();
                if text.is_empty() { false } else { text.clear(); true }
            };
            if had_narration {
                shared.persist().await;
            }
            shared.call_args.lock_unpoisoned().insert(tool_call.id.clone(), tool_call.arguments.clone());
            shared
                .send_seq(seq, json!({
                    "type": "tool_use",
                    "id": tool_call.id,
                    "name": tool_call.name,
                    "input": tool_call.arguments
                }))
                .await;
        }
        _ => {}
    }
}

/// A recovery-settled message carries its full committed text; no deltas
/// ever streamed it, so the display text is seeded (replaced) from the
/// message itself. Empty recoveries keep whatever the pre-crash deltas
/// already persisted. Live (non-recovery) ends keep delta-driven semantics.
async fn recover_assistant_text(shared: &TurnShared, message: &AgentMessage) {
    let Some(am) = message.as_assistant() else { return };
    let text = am.text();
    if !text.is_empty() {
        *shared.accumulated_text.lock_unpoisoned() = text;
    }
    shared.persist().await;
}

/// A settled assistant message: finish trace, usage ledger + wire totals.
async fn record_assistant_end(shared: &TurnShared, message: &AgentMessage, seq: u64) {
    close_thinking(shared).await;
    let Some(am) = message.as_assistant() else { return };
    llm_trace(
        &shared.chat_id,
        shared.turn(),
        "finish",
        json!({
            "stop_reason": am.stop_reason.as_str(),
            "usage": am.usage,
            "tool_calls": am.tool_calls().len(),
            "error": am.error_message,
        }),
    );
    let total = {
        let mut u = shared.usage.lock_unpoisoned();
        *u = u.add(&am.usage);
        u.clone()
    };
    {
        let _guard = shared.db_lock.lock().await;
        let _ = chatstore::record_usage(&shared.chat_id, &shared.assistant_row(), &total, &am.usage);
    }
    shared
        .send_seq(seq, json!({
            "type": "usage",
            "prompt_tokens": total.input + total.cache_read + total.cache_write,
            "completion_tokens": total.output,
            "total_tokens": total.total_tokens,
            "cost_usd": total.cost.total,
            "cache_read_tokens": total.cache_read,
            "cache_write_tokens": total.cache_write,
        }))
        .await;
}

fn push_tool_trace(shared: &TurnShared, tool_call_id: &str, tool_name: &str, result: &AgentToolResult, is_error: bool) {
    let args = shared.call_args.lock_unpoisoned().remove(tool_call_id).unwrap_or_else(|| json!({}));
    let text = result.text_content();
    shared.traces.lock_unpoisoned().push(chatstore::tool_trace_entry(tool_name, &args, !is_error, &text));
}

/// Persist this turn's tool trace so the NEXT run can rebuild "what was
/// done earlier in this chat".
async fn flush_traces(shared: &TurnShared) {
    let traces: Vec<Value> = std::mem::take(&mut *shared.traces.lock_unpoisoned());
    if !traces.is_empty() {
        let _guard = shared.db_lock.lock().await;
        chatstore::append_tool_trace(&shared.chat_id, &shared.assistant_row(), traces);
    }
}

// ---------------------------------------------------------------------------
// Model / credential resolution
// ---------------------------------------------------------------------------

struct Resolved {
    api_key: String,
    base_url: String,
    /// models.dev provider id (`anthropic`, `openrouter`, …) or `zwork_router`.
    provider: String,
    /// Protocol pinned by the user (custom endpoint + declared shape) or by a
    /// zWork-owned endpoint. `None` lets the catalog pick per model.
    api: Option<Api>,
    real_model_id: String,
    provider_display_name: String,
    configured: bool,
}

impl Resolved {
    /// Protocol family for logs and the compaction-model picker.
    fn shape(&self) -> &'static str {
        match self.api {
            Some(Api::AnthropicMessages) => "anthropic",
            _ if self.provider == "anthropic" => "anthropic",
            _ => "openai",
        }
    }
}

fn resolve_model(model_id: &str, s: &settings::Settings) -> Resolved {
    let unconfigured = |provider: &str, base_url: &str, api: Option<Api>, real_model_id: String, display: &str| Resolved {
        api_key: String::new(),
        base_url: base_url.to_string(),
        provider: provider.to_string(),
        api,
        real_model_id,
        provider_display_name: display.to_string(),
        configured: false,
    };
    let from_cred = |cred: crate::server::Credentials, api: Option<Api>, real_model_id: String, display: String| Resolved {
        api_key: cred.api_key,
        base_url: cred.base_url,
        provider: cred.provider,
        api,
        real_model_id,
        provider_display_name: display,
        configured: true,
    };

    if model_id == "__claude_code__" {
        let cc_model = crate::server::read_claude_code_model().unwrap_or_default();
        let real = if cc_model.is_empty() || cc_model == "(default)" { "claude-sonnet-4-5".to_string() } else { cc_model };
        return match crate::server::resolve("claude_code", s, "") {
            Some(cred) => from_cred(cred, Some(Api::AnthropicMessages), real, "local credentials".into()),
            None => unconfigured("anthropic", "https://api.anthropic.com", Some(Api::AnthropicMessages), real, "local credentials"),
        };
    }
    if let Some(m) = s.custom_models.iter().find(|m| m.id == model_id) {
        let real = if m.model_id == "(default)" || m.model_id.is_empty() { "claude-sonnet-4-5".to_string() } else { m.model_id.clone() };
        let declared = catalog::api_for_shape(&m.shape);
        return match crate::server::resolve(&m.credential, s, &m.base_url_override) {
            // A user-supplied endpoint speaks whatever the user declared; a
            // catalog endpoint speaks what the catalog says for this model.
            Some(cred) => {
                let api = if cred.custom_endpoint { declared.or(Some(cred.api)) } else { None };
                from_cred(cred, api, real, m.credential.clone())
            }
            None => unconfigured(&m.credential, &m.base_url_override, declared, real, &m.credential),
        };
    }
    let real = router_real_model(model_id);
    match crate::server::resolve("zwork_router", s, "") {
        Some(cred) => from_cred(cred, Some(Api::OpenAICompletions), real, "zWork Cloud Router".into()),
        None => unconfigured("zwork_router", "https://api.tryzwork.app/api", Some(Api::OpenAICompletions), real, "zWork Cloud Router"),
    }
}

/// What a hosted-router call belongs to. The router groups calls by run id:
/// the first call of a run counts against the user's message quota and the
/// rest are continuations. Version, OS and trigger feed the admin dashboard
/// (versions in use, platforms, scheduled vs interactive use).
struct RouterTag<'a> {
    run_id: &'a str,
    chat_id: &'a str,
    project_id: &'a str,
    /// `schedule`, `chat` or `background` (titles and other side calls).
    trigger: &'a str,
}

/// Scheduled runs are the ones the scheduler starts (`sched_…` run ids).
fn trigger_for(run_id: &str) -> &'static str {
    if run_id.starts_with("sched_") { "schedule" } else { "chat" }
}

fn router_headers(tag: &RouterTag) -> BTreeMap<String, String> {
    let mut h = BTreeMap::from([
        ("x-zwork-run-id".to_string(), tag.run_id.to_string()),
        ("x-zwork-trigger".to_string(), tag.trigger.to_string()),
        ("x-zwork-app-version".to_string(), env!("CARGO_PKG_VERSION").to_string()),
        ("x-zwork-os".to_string(), std::env::consts::OS.to_string()),
    ]);
    for (k, v) in [("x-zwork-chat-id", tag.chat_id), ("x-zwork-project-id", tag.project_id)] {
        if !v.is_empty() {
            h.insert(k.to_string(), v.to_string());
        }
    }
    h
}

fn build_model(r: &Resolved, model_id: &str, tag: Option<&RouterTag>) -> Model {
    let mut model = catalog::build_model(
        &catalog::global(),
        catalog::Target { provider: &r.provider, model_id, base_url: &r.base_url, api: r.api },
    );
    model.context_window = context_window_for(model.context_window);
    if r.provider == "zwork_router" {
        configure_router_model(&mut model);
    }
    // Router / gateway keys aren't Anthropic keys: they authenticate with a
    // bearer token in addition to x-api-key (matches the legacy loop).
    if model.api == Api::AnthropicMessages && !r.api_key.is_empty() && !r.api_key.starts_with("sk-ant-") {
        model.headers = Some(BTreeMap::from([("authorization".to_string(), format!("Bearer {}", r.api_key))]));
    }
    if let (true, Some(tag)) = (r.provider == "zwork_router", tag) {
        model.headers.get_or_insert_with(BTreeMap::new).extend(router_headers(tag));
    }
    model
}

/// The managed router speaks OpenAI Chat Completions and forwards to
/// OpenRouter, so effort goes out as OpenRouter's `reasoning.effort` (each
/// upstream maps it to the nearest level it supports). Every tier reasons.
/// The model id is a tier alias: rewrite legacy pinned ids (older installs
/// stored upstream ids) and mark Pro text-only (GLM 5.3 takes no images, so
/// the harness turns them into placeholders instead of a 400).
fn configure_router_model(model: &mut Model) {
    use crate::harness::types::{MaxTokensField, OpenAICompletionsCompat, ThinkingFormat};
    model.id = router_real_model(&model.id);
    model.api = Api::OpenAICompletions;
    model.reasoning = true;
    model.input = if model.id == "zwork-pro" {
        vec![InputType::Text]
    } else {
        vec![InputType::Text, InputType::Image]
    };
    model.compat = Some(OpenAICompletionsCompat {
        supports_store: Some(false),
        supports_developer_role: Some(false),
        supports_reasoning_effort: Some(true),
        max_tokens_field: Some(MaxTokensField::MaxTokens),
        thinking_format: Some(ThinkingFormat::Openrouter),
        ..Default::default()
    });
}

/// One-shot completion on the user's default model — for side features
/// (refactor, paper pipeline) that need text back, not an agent run.
/// Names a new chat from its first message ("Q3 expenses cleanup") in the
/// background, so the sidebar doesn't show the prompt cut off mid-sentence.
/// Keeps the first-line title if the model is unavailable.
fn spawn_title(chat_id: String, model_id: String, first_message: String, tx: mpsc::Sender<Value>) {
    tokio::spawn(async move {
        let prompt: String = first_message.chars().take(2000).collect();
        // Bounded: this task holds the turn's event stream open until it ends.
        // Generous token cap: reasoning models spend some before answering.
        let call = complete_text_on(Some(&model_id), TITLE_PROMPT, &prompt, 400);
        let Ok(Ok(raw)) = tokio::time::timeout(std::time::Duration::from_secs(20), call).await else { return };
        let Some(title) = clean_title(&raw) else { return };
        // The user may have renamed it while we waited.
        let Some(chat) = chatstore::get(&chat_id) else { return };
        if chat.title != chatstore::auto_title(&first_message) {
            return;
        }
        if chatstore::rename(&chat_id, &title).is_some() {
            let _ = tx.send(json!({ "type": "chat", "id": chat_id, "title": title })).await;
        }
    });
}

const TITLE_PROMPT: &str = "Write a short title (2 to 6 words) for a conversation that starts with the user's message below. \
Plain words, sentence case, no quotes, no trailing punctuation, no emoji. Reply with the title only.";

fn clean_title(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    let line = line
        .trim_start_matches(|c: char| c == '#' || c == '*' || c.is_whitespace())
        .trim_start_matches("Title:")
        .trim()
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '*' | '“' | '”' | '.'))
        .trim();
    if line.is_empty() || line.chars().count() > 60 {
        return None;
    }
    Some(line.to_string())
}

pub async fn complete_text(system: &str, prompt: &str, max_tokens: u64) -> Result<String, String> {
    complete_text_on(None, system, prompt, max_tokens).await
}

/// `complete_text` on `preferred` when it has credentials, else the default
/// model, else the first model the user has a key for — so side features
/// work for BYOK users whose default is still the (unconfigured) router.
async fn complete_text_on(preferred: Option<&str>, system: &str, prompt: &str, max_tokens: u64) -> Result<String, String> {
    let s = settings::load();
    let default = if s.default_model.is_empty() { "zwork-flash" } else { s.default_model.as_str() };
    let resolved = preferred
        .into_iter()
        .chain([default])
        .chain(s.custom_models.iter().map(|m| m.id.as_str()))
        .map(|id| resolve_model(id, &s))
        .find(|r| r.configured)
        .ok_or_else(|| "No model credentials configured. Add an API key in Settings.".to_string())?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let tag = RouterTag { run_id: &run_id, chat_id: "", project_id: "", trigger: "background" };
    let model = build_model(&resolved, &resolved.real_model_id, Some(&tag));
    let context = crate::harness::transcript::normalize_context(Some(system), None, vec![Message::user_text(prompt)]);
    let options = crate::harness::types::StreamOptions {
        api_key: Some(resolved.api_key.clone()),
        max_tokens: Some(max_tokens.min(model.max_tokens)),
        max_retries: MAX_TRANSIENT_RETRIES,
        ..Default::default()
    };
    let reply = crate::harness::providers::complete(model, context, options).await;
    match reply.stop_reason {
        StopReason::Error | StopReason::Aborted => Err(reply.error_message.unwrap_or_else(|| "LLM request failed".into())),
        _ => Ok(reply
            .content
            .iter()
            .filter_map(|b| b.as_text().map(|t| t.text.as_str()))
            .collect::<Vec<_>>()
            .join("")),
    }
}

/// Reasoning effort for a turn: the effort picked in the prompt bar when there
/// is one, else `ZWORK_THINKING=off|low|medium|high…`, else medium. Models
/// that don't reason get none.
fn thinking_level_for(model: &Model, effort: Option<&str>) -> crate::harness::types::ThinkingLevel {
    use crate::harness::types::ThinkingLevel as L;
    if !model.reasoning {
        return L::Off;
    }
    let env = std::env::var("ZWORK_THINKING").unwrap_or_default();
    let chosen = effort.filter(|e| !e.trim().is_empty()).unwrap_or(env.as_str());
    match chosen.trim().to_ascii_lowercase().as_str() {
        "off" | "none" | "0" => L::Off,
        "minimal" => L::Minimal,
        "low" => L::Low,
        "high" => L::High,
        "xhigh" | "extra" => L::Xhigh,
        "max" => L::Max,
        _ => L::Medium,
    }
}

// ---------------------------------------------------------------------------
// History conversion
// ---------------------------------------------------------------------------

/// Convert persisted chat rows into harness messages. Consecutive same-role
/// rows are merged and empty assistant rows dropped so the transcript
/// alternates cleanly (what `repair_history_alternation` did for the legacy
/// loop).
fn history_to_messages(rows: &[chatstore::ChatMessage], model: &Model) -> Vec<AgentMessage> {
    let mut out: Vec<AgentMessage> = Vec::new();
    for row in rows {
        let text = chatstore::content_to_text(&row.content);
        match row.role.as_str() {
            "user" => {
                if let Some(AgentMessage::Llm(Message::User(prev))) = out.last_mut() {
                    let merged = format!("{}\n\n{}", prev.content.text(), text);
                    prev.content = crate::harness::types::UserMessageContent::Text(merged);
                    continue;
                }
                out.push(AgentMessage::user_text(text));
            }
            "assistant" => {
                if text.trim().is_empty() {
                    continue;
                }
                if let Some(AgentMessage::Llm(Message::Assistant(prev))) = out.last_mut() {
                    prev.content.push(AssistantContent::Text(TextContent { text: format!("\n\n{text}"), text_signature: None }));
                    continue;
                }
                let mut am = AssistantMessage::pending(model);
                am.content.push(AssistantContent::Text(TextContent { text, text_signature: None }));
                am.stop_reason = StopReason::Stop;
                am.timestamp = row.created_at as i64;
                out.push(AgentMessage::Llm(Message::Assistant(am)));
            }
            _ => {}
        }
    }
    // The model expects the transcript to start with a user message.
    while matches!(out.first(), Some(AgentMessage::Llm(Message::Assistant(_)))) {
        out.remove(0);
    }
    out
}

/// Anthropic-style content blocks (from `prompts::build_user_content`) to
/// harness user content.
fn blocks_to_user_content(blocks: &Value) -> Vec<UserContent> {
    let mut out = Vec::new();
    if let Some(arr) = blocks.as_array() {
        for b in arr {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        out.push(UserContent::text(t));
                    }
                }
                Some("image") => {
                    let src = b.get("source").cloned().unwrap_or(Value::Null);
                    let data = src.get("data").and_then(|d| d.as_str()).unwrap_or("").to_string();
                    let mime = src.get("media_type").and_then(|m| m.as_str()).unwrap_or("image/png").to_string();
                    if !data.is_empty() {
                        out.push(UserContent::Image(ImageContent { data, mime_type: mime }));
                    }
                }
                _ => {}
            }
        }
    } else if let Some(s) = blocks.as_str() {
        out.push(UserContent::text(s));
    }
    out
}

// ---------------------------------------------------------------------------
// Turn runner
// ---------------------------------------------------------------------------

/// Run one chat turn on the pi harness. Same signature and wire protocol as
/// the legacy `agent::run_agent_turn`.
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
    effort: Option<String>,
) -> impl futures_util::Stream<Item = Result<Value, Infallible>> {
    let (tx, rx) = mpsc::channel(100);

    let run_chat_id = chat_id.clone();
    let turn_handle = tokio::spawn(async move {
        let _guard = RunGuard(chat_id.clone());
        let s = settings::load();
        // A fresh id per turn: the router counts a run's first call against
        // the quota, so reusing the chat id would make later turns free.
        let run_id = if run_id.is_empty() { uuid::Uuid::new_v4().to_string() } else { run_id };
        log_agent_event(&chat_id, &run_id, "turn_start", json!({
            "model_id": model_id,
            "project_id": project_id,
            "plan_mode": plan_mode,
            "auto_approve": auto_approve,
            "attachment_count": attachments.len(),
            "harness": "pi",
        }));

        // ── Chat row + user message ─────────────────────────────────────
        let mut chat = match chatstore::get(&chat_id) {
            Some(c) => c,
            None => chatstore::create("New chat", &model_id, &project_id),
        };
        // Everything downstream persists against the row we actually
        // resolved/created (a caller may pass an unknown id; the wire
        // `chat` event tells it the real one) — not the id it asked for.
        let chat_id = chat.id.clone();
        let is_dup = chat
            .messages
            .last()
            .map_or(false, |m| m.role == "user" && chatstore::content_to_text(&m.content) == user_message);
        if !is_dup && (!user_message.is_empty() || !attachments.is_empty()) {
            chatstore::append_message(&chat.id, "user", json!(user_message));
            if let Some(refreshed) = chatstore::get(&chat.id) {
                chat = refreshed;
            }
        }
        let _ = tx.send(json!({ "type": "chat", "id": chat.id, "title": chat.title })).await;
        let first_message = !is_dup && chat.messages.iter().filter(|m| m.role == "user").count() == 1;
        if first_message && !user_message.trim().is_empty() {
            spawn_title(chat.id.clone(), model_id.clone(), user_message.clone(), tx.clone());
        }

        // ── Credentials / model ─────────────────────────────────────────
        let resolved = resolve_model(&model_id, &s);
        log_agent_event(&chat_id, &run_id, "provider_resolved", json!({
            "provider": resolved.provider_display_name,
            "base_url": resolved.base_url,
            "shape": resolved.shape(),
            "real_model_id": resolved.real_model_id,
        }));
        let _ = tx
            .send(json!({
                "type": "meta",
                "provider": resolved.provider_display_name,
                "resolved_model": resolved.real_model_id,
                "upstream_provider": resolved.shape(),
            }))
            .await;
        if !resolved.configured {
            let _ = tx
                .send(json!({
                    "type": "needs_setup",
                    "message": "No model credentials are configured. Add an API key in Settings to start chatting."
                }))
                .await;
            let _ = tx.send(json!({ "type": "done" })).await;
            let _ = tx.send(json!({ "type": "end" })).await;
            return;
        }
        let tag = RouterTag { run_id: &run_id, chat_id: &chat_id, project_id: &project_id, trigger: trigger_for(&run_id) };
        let model = build_model(&resolved, &resolved.real_model_id, Some(&tag));
        let compaction_model = {
            let id = compaction_model_id(resolved.shape(), &resolved.real_model_id);
            build_model(&resolved, &id, Some(&tag))
        };

        // ── System prompt (unchanged from the legacy loop) ──────────────
        let user_name = crate::server::display_name();
        let os_name = std::env::consts::OS.to_string();
        let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| ".".to_string());
        let skills_list = crate::skills::format_for_system_prompt();
        let skills = crate::skills::list_skills();
        let example_slug = skills.first().map(|s| s.slug.as_str()).unwrap_or("frontend-design");
        let include_desktop = cfg!(target_os = "macos");
        let include_academic = true;

        let composio_schemas = crate::connectors::composio::all_tool_schemas().await;
        let composio_apps = crate::connectors::composio::connected_apps().await;
        let connected_apps_block = crate::connectors::composio::build_connected_apps_block(&composio_schemas, &composio_apps);
        let mcp = crate::connectors::mcp::toolset().await;

        let (project_name, project_md) = if !project_id.is_empty() {
            let dir = crate::paths::project_dir(&project_id);
            let name = std::fs::read_to_string(dir.join("project.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .unwrap_or_default();
            let ctx = std::fs::read_to_string(dir.join("context.md")).unwrap_or_default();
            (name, ctx)
        } else {
            (String::new(), String::new())
        };

        let system_prompt = settings::build_system_prompt(
            &resolved.real_model_id,
            &resolved.provider_display_name,
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
        let context_files = crate::harness::context_files::load(std::path::Path::new(&cwd));
        let system_prompt = system_prompt
            + &crate::harness::context_files::prompt_block(&context_files)
            + &mcp_prompt_block(&mcp);
        let browser_connected = crate::browser_bridge::extension_connected().await;
        let system_prompt = format!(
            "{system_prompt}\n\n## Live environment status\n{}",
            if browser_connected {
                "- Chrome browser bridge: CONNECTED. Your browser_* tools are LIVE and drive the user's real Chrome (signed-in sessions, no login walls). For ANY task involving a website, web app, web form, login-gated page, or anything browser-based, USE the browser_* tools (browser_navigate / browser_snapshot / browser_click / browser_type / browser_eval). Do not claim you cannot browse, and do not guess URLs from memory — navigate to a real URL or snapshot and click real links."
            } else {
                "- Chrome browser bridge: NOT connected. browser_* tools will fail until the user opens Chrome with the zbctl extension loaded and zWork running. If the task needs the browser, tell the user to connect it rather than guessing."
            }
        );

        // ── Per-turn extras → latest user message (system prompt stays
        // byte-stable for prompt caching) ───────────────────────────────
        let mut turn_extras: Vec<String> = Vec::new();
        if artifact_mode {
            turn_extras.push(format!("## Artifact mode\n{}", artifact_hint(&user_message)));
        }
        if web_search_enabled {
            if let Some(grounding) = web_search_grounding(&user_message).await {
                turn_extras.push(format!(
                    "## News headlines (recent, may be incomplete)\n{}\n\n\
                     These are Google News headlines only — not verified facts, and possibly \
                     incomplete. For factual detail or page content, fetch the actual page \
                     (browser_navigate / browser_snapshot) instead of relying on the headlines; \
                     if you can't, say so rather than guessing.",
                    grounding
                ));
            }
        }
        if !attachments.is_empty() {
            let listing =
                attachments.iter().map(|a| format!("- {} → {}", a.name, a.path_or_url())).collect::<Vec<_>>().join("\n");
            turn_extras.push(format!("## Current interaction context\nThe user attached:\n{listing}"));
        }
        if let Some(extra) = &extra_system_prompt {
            if !extra.trim().is_empty() {
                turn_extras.push(extra.clone());
            }
        }
        if let Some(traces) = chatstore::render_tool_traces(&chat.messages) {
            turn_extras.insert(0, traces);
        }
        let max_turns = max_turns();
        let turn_ctx = orientation::turn_context_block(1, max_turns, &cwd);
        let mut prefix = vec![turn_ctx];
        prefix.extend(turn_extras);
        let prefix = prefix.join("\n\n");

        // History = everything before the message we're about to send.
        let history_rows: &[chatstore::ChatMessage] = match chat.messages.last() {
            Some(last) if last.role == "user" && chatstore::content_to_text(&last.content) == user_message => {
                &chat.messages[..chat.messages.len() - 1]
            }
            _ => &chat.messages[..],
        };
        let history = history_to_messages(history_rows, &model);

        // `/command args` → the prompt it stands for (the chat keeps what was typed).
        let prompt_text = crate::commands::expand(&user_message).unwrap_or_else(|| user_message.clone());
        let prompt_message: AgentMessage = if attachments.is_empty() {
            AgentMessage::user_text(format!("{prefix}\n\n{prompt_text}"))
        } else {
            let mut blocks = blocks_to_user_content(&prompts::build_user_content(&prompt_text, &attachments));
            blocks.push(UserContent::text(prefix));
            AgentMessage::Llm(Message::user_blocks(blocks))
        };

        // ── Assistant row + shared state ────────────────────────────────
        let assistant_msg_id = chatstore::append_message(&chat.id, "assistant", json!("")).map(|m| m.id).unwrap_or_default();
        let shared = Arc::new(TurnShared {
            chat_id: chat_id.clone(),
            run_id: run_id.clone(),
            tx: tx.clone(),
            assistant_msg_id: Mutex::new(assistant_msg_id),
            auto_approve,
            effort,
            max_turns,
            accumulated_text: Mutex::new(String::new()),
            activities: Mutex::new(Vec::new()),
            db_lock: tokio::sync::Mutex::new(()),
            turn: AtomicU32::new(0),
            doomed: AtomicBool::new(false),
            hit_turn_cap: AtomicBool::new(false),
            thinking_open: AtomicBool::new(false),
            doom: Mutex::new(DoomLoopDetector::new()),
            call_args: Mutex::new(HashMap::new()),
            traces: Mutex::new(Vec::new()),
            usage: Mutex::new(Usage::empty()),
        });

        // ── Tools ───────────────────────────────────────────────────────
        let mut schemas = get_tool_schemas(plan_mode);
        schemas.extend(composio_schemas);
        let mut tools: Vec<DynTool> = schemas
            .iter()
            .filter_map(|s| NativeTool::from_schema(s, shared.clone()))
            .map(|t| Arc::new(t) as DynTool)
            .collect();
        // pi core tools. Plan mode keeps only the read-only ones.
        let supports_images: crate::harness::tools::SupportsImagesFn = {
            let has_image = model.input.contains(&InputType::Image);
            Arc::new(move || has_image)
        };
        for tool in crate::harness::tools::create_coding_tools(std::path::Path::new(&cwd), Some(supports_images)) {
            if plan_mode && matches!(tool.name(), "bash" | "write" | "edit") {
                continue;
            }
            tools.push(Arc::new(GatedTool::new(tool, &shared)) as DynTool);
        }
        // Connector tools. Plan mode keeps the ones the server marks read-only.
        for tool in mcp.tools {
            if plan_mode && !tool.read_only {
                continue;
            }
            tools.push(Arc::new(GatedTool::connector(tool, &shared)) as DynTool);
        }
        // Stable name-sort so the tool list (and thus the tool-order
        // sensitive prompt-cache prefix) doesn't reshuffle across turns.
        tools.sort_by(|a, b| a.name().cmp(b.name()));

        // ── Drive (durable AgentHarness) ────────────────────────────────
        let stream_fn: StreamFn = Arc::new(crate::harness::providers::stream);
        // Pre-run compaction: a long-lived chat may already be over budget
        // before the first request of this turn.
        let mut seed_history = history;
        {
            let tokens = hcompaction::estimate_context_tokens(&seed_history).tokens;
            if hcompaction::should_compact(tokens, model.context_window, &hcompaction::CompactionSettings::default()) {
                if let Some(compacted) = compact_history(&shared, &compaction_model, &resolved.api_key, &stream_fn, &seed_history).await {
                    seed_history = compacted;
                }
            }
        }
        let compacted_on_overflow = drive_durable(
            &shared,
            &model,
            &model_id,
            &compaction_model,
            &resolved.api_key,
            stream_fn,
            &system_prompt,
            prompt_message,
            seed_history,
            &tools,
        )
        .await;

        if shared.doomed.load(Ordering::SeqCst) {
            // Emit a real assistant text so the persisted turn isn't empty
            // and the next user message starts from a clean state.
            let recovery = "I got stuck repeating the same action without making progress, \
                so I stopped to avoid burning your quota. This usually means a tool returned \
                more than I could usefully read. Try rephrasing — for example, narrow the \
                request (a specific sender, date, or subject) — or ask for one specific item \
                by name.";
            shared.accumulated_text.lock_unpoisoned().push_str(recovery);
            shared.persist().await;
            let _ = tx.send(json!({ "type": "delta", "text": recovery })).await;
            let _ = tx.send(json!({ "type": "error", "text": "Stopped a repeated-action loop before it ran away." })).await;
        }
        if shared.hit_turn_cap.load(Ordering::SeqCst) {
            let _ = tx.send(json!({
                "type": "error",
                "text": format!("Reached the {}-turn runaway cap and stopped to protect your request quota — the task wasn't converging on its own. Try rephrasing, switching models, or set ZWORK_MAX_TURNS (0 = unbounded).", max_turns)
            })).await;
        }

        log_agent_event(&chat_id, &shared.run_id, "turn_end", json!({
            "turns": shared.turn(),
            "doomed": shared.doomed.load(Ordering::SeqCst),
            "hit_turn_cap": shared.hit_turn_cap.load(Ordering::SeqCst),
            "compacted_on_overflow": compacted_on_overflow,
        }));
        let _ = tx.send(json!({ "type": "done" })).await;
        let _ = tx.send(json!({ "type": "end" })).await;
    });

    crate::watchdog::register_run(&run_chat_id, turn_handle);
    ReceiverStream::new(rx).map(Ok)
}

// ---------------------------------------------------------------------------
// Sub-agents (spawn_agent tool)
// ---------------------------------------------------------------------------

/// A pi core coding tool (bash/write/edit) exposed to a sub-agent.
/// Destructive actions are denied outright — sub-agents run unattended,
/// with no UI to answer a permission card — and forward progress lines as
/// `subagent_delta` status the way the parent's tools stream output.
struct SubagentPiTool {
    inner: DynTool,
    task_id: String,
    tx: mpsc::Sender<Value>,
}

impl AgentTool for SubagentPiTool {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn description(&self) -> &str {
        self.inner.description()
    }
    fn parameters(&self) -> Value {
        self.inner.parameters()
    }
    fn replay(&self) -> ReplayPolicy {
        self.inner.replay()
    }
    fn execute<'a>(
        &'a self,
        tc_id: &'a str,
        params: Value,
        signal: Option<&'a AbortSignal>,
        _on_update: AgentToolUpdateCallback,
    ) -> ToolFuture<'a> {
        let tool_name = self.inner.name().to_string();
        if let Risk::Destructive { reason } = evaluate_tool_risk(&tool_name, &params) {
            return Box::pin(async move {
                Err(format!(
                    "Denied: {reason}. Sub-agents cannot take destructive actions — report what needs doing and let the parent agent ask the user."
                ))
            });
        }
        let tx = self.tx.clone();
        let task_id = self.task_id.clone();
        let forward: AgentToolUpdateCallback = Arc::new(move |partial: AgentToolResult| {
            let text = partial.text_content();
            if !text.is_empty() {
                let _ = tx.try_send(json!({ "type": "subagent_delta", "task_id": task_id, "text": format!("{text}\n") }));
            }
        });
        self.inner.execute(tc_id, params, signal, forward)
    }
}

/// Depth-bound `spawn_agent` for sub-agents: one nesting level. Children of
/// a sub-agent get no spawn tool at all.
struct SubagentSpawnTool {
    chat_id: String,
    child_depth: u32,
    tx: mpsc::Sender<Value>,
}

impl AgentTool for SubagentSpawnTool {
    fn name(&self) -> &str {
        "spawn_agent"
    }
    fn description(&self) -> &str {
        "Spawn a sub-agent for parallel independent work. Returns the sub-agent's result."
    }
    fn parameters(&self) -> Value {
        json!({
            "name": "spawn_agent",
            "description": "Spawn a sub-agent for parallel independent work.",
            "parameters": {
                "type": "object",
                "properties": {
                    "description": { "type": "string", "description": "Short description of the task for the sub-agent" },
                    "model_id": { "type": "string", "description": "Optional model override for the sub-agent" }
                },
                "required": ["description"]
            }
        })
    }
    fn execute<'a>(
        &'a self,
        _id: &'a str,
        params: Value,
        _signal: Option<&'a AbortSignal>,
        _on_update: AgentToolUpdateCallback,
    ) -> ToolFuture<'a> {
        let chat_id = self.chat_id.clone();
        let child_depth = self.child_depth;
        let tx = self.tx.clone();
        Box::pin(async move {
            let desc = params.get("description").and_then(|v| v.as_str()).unwrap_or("task").to_string();
            let model_id = params.get("model_id").and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let s = crate::settings::load();
                    if !s.default_model.is_empty() { s.default_model } else { "deepseek-flash".to_string() }
                });
            match spawn_subagent_at_depth(&chat_id, &chat_id, &desc, &model_id, child_depth, &tx).await {
                Ok(result) => Ok(AgentToolResult::text(format!("Sub-agent completed the task. Result:\n\n{result}"))),
                Err(e) => Err(format!("Sub-agent failed: {e}")),
            }
        })
    }
}

/// Sub-agent runaway cap. Unattended work needs more headroom than the
/// old 12; 40 with an env override (0 = unbounded).
fn max_subagent_turns() -> u32 {
    match std::env::var("ZWORK_SUBAGENT_MAX_TURNS") {
        Ok(v) => v.trim().parse::<u32>().ok().filter(|&n| n > 0).unwrap_or(40),
        Err(_) => 40,
    }
}

/// How many times a sub-agent may spawn its own children (one nesting
/// level: a sub-agent can spawn sub-sub-agents, those cannot spawn).
const MAX_SUBAGENT_DEPTH: u32 = 1;

/// Read-only zWork tools a sub-agent may call, executed directly (not via the
/// streaming `execute_tool` dispatcher, which is what's running us).
struct SubagentDirectTool {
    schema: Value,
    name: String,
}

impl AgentTool for SubagentDirectTool {
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        self.schema.get("description").and_then(|d| d.as_str()).unwrap_or("")
    }
    fn parameters(&self) -> Value {
        self.schema.get("parameters").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} }))
    }
    fn execute<'a>(
        &'a self,
        _tool_call_id: &'a str,
        params: Value,
        _signal: Option<&'a AbortSignal>,
        _on_update: AgentToolUpdateCallback,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            let text = match self.name.as_str() {
                "web_search" => crate::tools::search::execute_web_search(&params).await?,
                "extract_document" => crate::tools::doc_extract::execute_extract_document(&params).await?,
                "search_papers" => {
                    let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
                    let max_results = params.get("max_results").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
                    let year_min = params.get("year_min").and_then(|v| v.as_u64()).map(|y| y as u32);
                    let year_max = params.get("year_max").and_then(|v| v.as_u64()).map(|y| y as u32);
                    let papers = crate::academic::search_academic_literature(query, max_results, year_min, year_max).await;
                    serde_json::to_string_pretty(&papers).unwrap_or_default()
                }
                "format_citation" => {
                    let paper = params.get("paper").unwrap_or(&Value::Null);
                    let style = params.get("style").and_then(|v| v.as_str()).unwrap_or("apa");
                    crate::academic::format_citation(paper, style)
                }
                other => return Err(format!("Sub-agents cannot use tool '{other}'")),
            };
            Ok(AgentToolResult::text(text))
        })
    }
}

/// The sub-agent on the durable runtime: read-only tools, same 12-turn cap
/// (enforced by a durable abort at the boundary), deltas streamed as
/// `subagent_delta`.
async fn spawn_subagent_durable(
    chat_id: &str,
    parent_run_id: &str,
    task_id: &str,
    task: &str,
    model: &Model,
    api_key: &str,
    tools: &[DynTool],
    system: &str,
    stream_fn: StreamFn,
    tx: &mpsc::Sender<Value>,
) -> Result<String, String> {
    use crate::harness::runtime::events::HarnessEvent;
    use crate::harness::runtime::harness::{Harness, HarnessOptions};
    use crate::harness::runtime::types::RetryPolicySnapshot;
    use crate::harness::session::sqlite::SqliteSessionRepo;
    use crate::harness::session::types::HarnessStreamOptionsSnapshot;

    let _ = parent_run_id;
    let repo = SqliteSessionRepo::new(crate::paths::home_dir().join("sessions"));
    let session_id = format!("subagent_{task_id}_{}", uuid::Uuid::new_v4().simple());
    let session = repo.create(&session_id, None).map_err(|e| format!("Failed to open durable session: {e}"))?;

    let provider = model.provider.clone();
    let model_id = model.id.clone();
    let source_model = model.clone();
    let mut config = crate::harness::runtime::types::RuntimeConfig::default();
    config.system_prompt = Some(system.to_string());
    config.context_window = Some(model.context_window);
    config.model_source = Some(Arc::new(move |p: &str, m: &str| {
        (p == provider && m == model_id).then(|| source_model.clone())
    }));
    config.stream = Some(stream_fn);
    config.stream_options = HarnessStreamOptionsSnapshot {
        api_key: Some(api_key.to_string()),
        max_retries: Some(2),
        ..Default::default()
    };
    config.retry_policy = RetryPolicySnapshot { enabled: true, max_retries: 2, base_delay_ms: 2_000, ..Default::default() };
    config.tools = Arc::new(tools.iter().map(|t| runtime_tool_from(t.clone())).collect());

    let (harness, _open) = Harness::create(
        session,
        HarnessOptions {
            provider: model.provider.clone(),
            model_id: model.id.clone(),
            thinking_level: thinking_level_for(&model, None),
            active_tool_names: tools.iter().map(|t| t.name().to_string()).collect(),
            config,
        },
    )
    .map_err(|e| format!("Durable harness failed to open: {e}"))?;
    let lane = harness.lane("main").await.map_err(|e| format!("Durable lane failed to open: {e}"))?;

    let mut events = harness.events.subscribe(None);
    let mapper_lane = lane.clone();
    let mapper_tx = tx.clone();
    let mapper_task_id = task_id.to_string();
    let mapper = tokio::spawn(async move {
        let accumulated = Arc::new(Mutex::new(String::new()));
        let mut turns: u32 = 0;
        while let Some((_seq, event)) = events.recv().await {
            match event {
                HarnessEvent::TurnStart { .. } => {
                    turns += 1;
                    if turns > max_subagent_turns() {
                        if let Some(operation_id) = mapper_lane.current_operation_id().ok().flatten() {
                            let _ = mapper_lane.request_operation_abort(&operation_id).await;
                        }
                    }
                }
                HarnessEvent::MessageUpdate {
                    event: AssistantMessageEvent::TextDelta { delta, .. },
                    ..
                } => {
                    if !delta.is_empty() {
                        accumulated.lock_unpoisoned().push_str(&delta);
                        let _ = mapper_tx.send(json!({ "type": "subagent_delta", "task_id": mapper_task_id, "text": delta })).await;
                    }
                }
                HarnessEvent::RunEnd { .. } => break,
                _ => {}
            }
        }
        accumulated
    });

    let record = harness.prompt("main", vec![AgentMessage::user_text(task)]).await;
    let accumulated = match tokio::time::timeout(std::time::Duration::from_secs(10), mapper).await {
        Ok(joined) => joined.unwrap_or_default(),
        Err(_) => Arc::new(Mutex::new(String::new())),
    };
    harness.close().await;

    let result = accumulated.lock_unpoisoned().clone();
    match record {
        Ok(record) if record.status != crate::harness::session::types::TerminalStatus::Failed => Ok(result),
        record => {
            let error = record
                .ok()
                .and_then(|r| r.error.map(|e| e.message))
                .unwrap_or_else(|| "sub-agent failed".to_string());
            if result.is_empty() {
                Err(friendly_upstream_error(&error, None, true))
            } else {
                llm_trace(chat_id, 0, "subagent_error", json!({ "task_id": task_id, "error": error }));
                Ok(result)
            }
        }
    }
}

/// Run a bounded sub-agent for `task` on the harness, streaming
/// `subagent_started` / `subagent_delta` / `subagent_done` to the parent's
/// SSE stream. Returns the sub-agent's full text output.
///
/// Rails: the pi coding tools (read/grep/find/ls always; bash/write/edit
/// with destructive actions denied — sub-agents run unattended) plus
/// web/document/academic lookups; interactive tools (ask_question) are
/// excluded. A depth-0 sub-agent may spawn one level of children
/// (`MAX_SUBAGENT_DEPTH`); grandchildren get no spawn tool.
pub async fn spawn_subagent(
    chat_id: &str,
    parent_run_id: &str,
    task: &str,
    model_id: &str,
    tx: &mpsc::Sender<Value>,
) -> Result<String, String> {
    spawn_subagent_at_depth(chat_id, parent_run_id, task, model_id, 0, tx).await
}

#[allow(clippy::too_many_arguments)]
pub async fn spawn_subagent_at_depth(
    chat_id: &str,
    parent_run_id: &str,
    task: &str,
    model_id: &str,
    depth: u32,
    tx: &mpsc::Sender<Value>,
) -> Result<String, String> {
    let task_id = format!("subagent_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let _ = tx.send(json!({ "type": "subagent_started", "task_id": task_id, "description": task })).await;

    let s = settings::load();
    let resolved = resolve_model(model_id, &s);
    if !resolved.configured {
        let _ = tx.send(json!({ "type": "subagent_done", "task_id": task_id, "error": "No credentials configured" })).await;
        return Err("No credentials configured".to_string());
    }
    // Helpers bill to the run that spawned them.
    let tag = RouterTag { run_id: parent_run_id, chat_id, project_id: "", trigger: trigger_for(parent_run_id) };
    let model = build_model(&resolved, &resolved.real_model_id, Some(&tag));

    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut tools: Vec<DynTool> = crate::harness::tools::create_coding_tools(&cwd, None)
        .into_iter()
        .map(|tool| {
            Arc::new(SubagentPiTool {
                inner: tool,
                task_id: task_id.clone(),
                tx: tx.clone(),
            }) as DynTool
        })
        .collect();
    for schema in get_tool_schemas(false) {
        let name = schema.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if matches!(name.as_str(), "web_search" | "extract_document" | "search_papers" | "format_citation") {
            tools.push(Arc::new(SubagentDirectTool { schema, name }) as DynTool);
        }
    }
    // One nesting level: a sub-agent (depth 0) may spawn children; their
    // children (depth >= MAX_SUBAGENT_DEPTH) get no spawn tool.
    let can_spawn_children = depth < MAX_SUBAGENT_DEPTH;
    if can_spawn_children {
        tools.push(Arc::new(SubagentSpawnTool {
            chat_id: chat_id.to_string(),
            child_depth: depth + 1,
            tx: tx.clone(),
        }) as DynTool);
    }
    tools.sort_by(|a, b| a.name().cmp(b.name()));

    let spawn_note = if can_spawn_children {
        "You may spawn one level of your own sub-agents for parallel work; they cannot spawn further."
    } else {
        "You cannot spawn further sub-agents."
    };
    let system = format!(
        "You are a focused sub-agent. Complete this task: {task}\n\n\
         You have the coding tools (read/ls/grep/find, bash/write/edit — destructive actions are \
         denied: report what needs doing instead), plus web and document lookups. {spawn_note} \
         Do the task, then stop. Be concise — your full text output is returned to the parent agent."
    );

    let stream_fn: StreamFn = Arc::new(crate::harness::providers::stream);
    match spawn_subagent_durable(chat_id, parent_run_id, &task_id, task, &model, &resolved.api_key, &tools, &system, stream_fn, tx).await {
        Ok(result) => {
            log_agent_event(chat_id, parent_run_id, "subagent_done", json!({ "task_id": task_id, "chars": result.len(), "depth": depth }));
            let _ = tx.send(json!({ "type": "subagent_done", "task_id": task_id, "result": result })).await;
            Ok(result)
        }
        Err(friendly) => {
            let _ = tx.send(json!({ "type": "subagent_done", "task_id": task_id, "error": friendly })).await;
            Err(friendly)
        }
    }
}

/// Pick the model id used for compaction summarization. Summarization is a
/// background chore that re-runs whenever the conversation crosses ~200k tokens,
/// so it should always run on a **cheap tier** rather than whatever expensive
/// model the user is driving the chat with. The endpoint/headers passed to
/// the summarizer are provider-level (one base_url + api_key
/// serves every model on that provider), so swapping only the model id lands the
/// request on the same provider's cheap tier — no new auth path, no new failure
/// mode.
///
/// Resolution order:
/// 1. `ZWORK_COMPACTION_MODEL` env override — pin an exact id if you want full
///    control (e.g. only one model is provisioned).
/// 2. The cheap tier of the main model's *family*, matched by keyword:
///    - deepseek / zwork-router → `deepseek-flash`
///    - claude / anthropic      → `claude-haiku-4-5-20251001`
///    - gemini                  → `gemini-2.5-flash`
///    - gpt                     → `gpt-4.1-mini`
/// 3. Unknown family → fall back to the main model unchanged (compaction still
///    works; it's just not cheaper). We never invent an id that might 404 on a
///    provider we don't recognize.
pub fn compaction_model_id(shape: &str, main_model: &str) -> String {
    if let Ok(pinned) = std::env::var("ZWORK_COMPACTION_MODEL") {
        let pinned = pinned.trim();
        if !pinned.is_empty() {
            return pinned.to_string();
        }
    }
    let m = main_model.to_ascii_lowercase();
    if m.starts_with("zwork-") {
        // Hosted tiers summarize on Flash, the cheapest.
        "zwork-flash".to_string()
    } else if m.contains("deepseek") || m.contains("v4-pro") || m.contains("v4-flash") {
        "deepseek-flash".to_string()
    } else if m.contains("claude") || shape == "anthropic" && m.is_empty() {
        "claude-haiku-4-5-20251001".to_string()
    } else if m.contains("gemini") {
        "gemini-2.5-flash".to_string()
    } else if m.contains("gpt") {
        "gpt-4.1-mini".to_string()
    } else {
        // Unknown provider: keep the main model so the request can't 404 on
        // a guessed id. Still correct, just not cheaper.
        main_model.to_string()
    }
}

// ---------------------------------------------------------------------------
// Resume-on-restart
// ---------------------------------------------------------------------------

/// Delete this chat's previously completed run sessions (best effort). A
/// crash leaves the newest session open for resume; everything settled is
/// debuggable history we don't need to keep forever.
fn prune_completed_sessions(repo: &crate::harness::session::sqlite::SqliteSessionRepo, chat_id: &str, keep: &str) {
    let prefix = format!("{chat_id}__");
    for meta in repo.list().unwrap_or_default() {
        if !meta.id.starts_with(&prefix) || meta.id == keep {
            continue;
        }
        // Completed ⇔ its lane state carries no current operation.
        let settled = repo
            .open(&meta.id)
            .ok()
            .and_then(|session| {
                crate::harness::runtime::restore::restore_session(&session)
                    .ok()
                    .map(|restored| restored.iter().all(|(_, snapshot)| snapshot.operation.is_none()))
            })
            .unwrap_or(false);
        if settled {
            let _ = repo.delete(&meta.id);
        }
    }
}

/// Scan `~/.zwork/sessions/` at sidecar startup and drive every interrupted
/// main-lane run to settlement (pi auto-resume). Cancelled operations
/// reconcile durably; interrupted assistant effects settle from their
/// committed frames without another provider call when possible, otherwise
/// the run continues from its durable state. Recovery output persists to
/// the crashed run's own chat row; a re-attached SSE client can watch it
/// live via the run registry.
pub async fn resume_interrupted_runs() {
    let repo = crate::harness::session::sqlite::SqliteSessionRepo::new(
        crate::paths::home_dir().join("sessions"),
    );
    let candidates: Vec<String> = repo
        .list()
        .unwrap_or_default()
        .into_iter()
        .map(|meta| meta.id)
        .filter(|id| !id.starts_with("subagent_"))
        .collect();
    for session_id in candidates {
        let resumed = resume_one_interrupted(&repo, &session_id).await;
        tracing::info!("resume scan: {session_id} -> {resumed}");
    }
}

async fn resume_one_interrupted(
    repo: &crate::harness::session::sqlite::SqliteSessionRepo,
    session_id: &str,
) -> &'static str {
    use crate::harness::runtime::harness::{Harness, HarnessOptions};
    use crate::harness::session::values::value;

    let session = match repo.open(session_id) {
        Ok(session) => session,
        Err(_) => return "unreadable",
    };
    // Metadata (written at run start) rebuilds the provider context.
    let read_str = |key: &str| -> Option<String> {
        let address = value("zwork", key).ok()?;
        session
            .get_value::<serde_json::Value>(&address)
            .ok()
            .flatten()
            .map(|(v, _)| v.as_str().map(String::from))
            .flatten()
    };
    let Some(chat_id) = read_str("turn.chat_id") else {
        return "no-metadata";
    };
    let model_product_id = read_str("turn.model_id").unwrap_or_default();
    let system_prompt = read_str("turn.system_prompt").unwrap_or_default();
    if model_product_id.is_empty() || system_prompt.is_empty() {
        return "incomplete-metadata";
    }
    // Sessions from before run ids were stored resume as a new run.
    let run_id = read_str("turn.run_id").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let restored = match crate::harness::runtime::restore::restore_session(&session) {
        Ok(restored) => restored,
        Err(_) => return "restore-failed",
    };
    if restored.iter().all(|(_, snapshot)| snapshot.operation.is_none()) {
        return "already-settled";
    }
    let (lane_name, snapshot) = match restored
        .iter()
        .find(|(_, snapshot)| snapshot.operation.is_some())
    {
        Some(found) => (found.0.clone(), found.1.clone()),
        None => return "already-settled",
    };
    let Some(operation) = &snapshot.operation else {
        return "already-settled";
    };
    let aborting = matches!(
        operation.state.scope().control,
        crate::harness::session::types::Control::CancelRequested { .. }
    );

    // Rebuild the provider context from current settings.
    let s = settings::load();
    let resolved = resolve_model(&model_product_id, &s);
    if !resolved.configured {
        return "no-credentials";
    }
    let tag = RouterTag { run_id: &run_id, chat_id: &chat_id, project_id: "", trigger: trigger_for(&run_id) };
    let model = build_model(&resolved, &resolved.real_model_id, Some(&tag));

    // A dead channel with the receiver DROPPED: every wire send fails
    // immediately (and is ignored), while chatstore persistence still
    // happens through the shared state. Keeping the receiver alive would
    // fill the bounded buffer and block the mapper forever.
    let (dead_tx, dead_rx) = mpsc::channel(1);
    drop(dead_rx);
    // Reuse the crashed run's assistant row (recorded in turn metadata) so
    // recovery updates the row the user already sees instead of appending a
    // fresh empty one; fall back to a new row when the id is unknown or the
    // row is gone. Seed display text/activities from that row so the first
    // persist doesn't erase what the pre-crash deltas already wrote.
    let persisted_msg_id = read_str("turn.assistant_msg_id").filter(|id| !id.is_empty());
    let existing_row = chatstore::get(&chat_id).and_then(|chat| {
        let id = persisted_msg_id.as_deref()?;
        chat.messages.iter().rev().find(|m| m.id == id).cloned()
    });
    let (assistant_msg_id, seed_text, seed_activities) = match existing_row {
        Some(row) => (row.id, chatstore::content_to_text(&row.content), row.activities),
        None => (
            chatstore::append_message(&chat_id, "assistant", json!(""))
                .map(|m| m.id)
                .unwrap_or_default(),
            String::new(),
            Vec::new(),
        ),
    };
    let shared = Arc::new(TurnShared {
        chat_id: chat_id.clone(),
        run_id: chat_id.clone(),
        tx: dead_tx,
        assistant_msg_id: Mutex::new(assistant_msg_id),
        auto_approve: read_str("turn.auto_approve").map(|v| v == "true").unwrap_or(false),
        effort: read_str("turn.effort").filter(|e| !e.is_empty()),
        max_turns: max_turns(),
        accumulated_text: Mutex::new(seed_text),
        activities: Mutex::new(seed_activities),
        db_lock: tokio::sync::Mutex::new(()),
        turn: AtomicU32::new(0),
        doomed: AtomicBool::new(false),
        hit_turn_cap: AtomicBool::new(false),
        thinking_open: AtomicBool::new(false),
        doom: Mutex::new(DoomLoopDetector::new()),
        call_args: Mutex::new(HashMap::new()),
        traces: Mutex::new(Vec::new()),
        usage: Mutex::new(Usage::empty()),
    });

    // Toolset: the same menu a live turn builds (plan-mode read-only not
    // reconstructed — resume runs with the full menu; the durable operation
    // state already carries which tools each step planned).
    let mut schemas = get_tool_schemas(false);
    schemas.extend(crate::connectors::composio::all_tool_schemas().await);
    let cwd = read_str("turn.cwd").unwrap_or_else(|| ".".into());
    let mut tools: Vec<DynTool> = schemas
        .iter()
        .filter_map(|schema| NativeTool::from_schema(schema, shared.clone()))
        .map(|t| Arc::new(t) as DynTool)
        .collect();
    let supports_images: crate::harness::tools::SupportsImagesFn = {
        let has_image = model.input.contains(&InputType::Image);
        Arc::new(move || has_image)
    };
    for tool in crate::harness::tools::create_coding_tools(std::path::Path::new(&cwd), Some(supports_images)) {
        tools.push(Arc::new(GatedTool::new(tool, &shared)) as DynTool);
    }
    for tool in crate::connectors::mcp::toolset().await.tools {
        tools.push(Arc::new(GatedTool::connector(tool, &shared)) as DynTool);
    }
    tools.sort_by(|a, b| a.name().cmp(b.name()));

    let provider = model.provider.clone();
    let model_key = model.id.clone();
    let source_model = model.clone();
    let mut config = crate::harness::runtime::types::RuntimeConfig::default();
    config.system_prompt = Some(system_prompt);
    config.context_window = Some(model.context_window);
    config.model_source = Some(Arc::new(move |p: &str, m: &str| {
        (p == provider && m == model_key).then(|| source_model.clone())
    }));
    config.stream = Some(Arc::new(crate::harness::providers::stream) as StreamFn);
    config.stream_options = crate::harness::session::types::HarnessStreamOptionsSnapshot {
        api_key: Some(resolved.api_key.clone()),
        max_tokens: Some(model.max_tokens),
        max_retries: Some(MAX_TRANSIENT_RETRIES),
        session_id: Some(chat_id.clone()),
        ..Default::default()
    };
    config.retry_policy = crate::harness::runtime::types::RetryPolicySnapshot {
        enabled: true,
        max_retries: MAX_TRANSIENT_RETRIES,
        base_delay_ms: 2_000,
        ..Default::default()
    };
    // Durable compaction (M6): mid-run threshold + overflow compactions
    // run as structural procedures in the session (crash-safe, first-class
    // CompactionEntry, reloads stop re-compacting); pre-run and the
    // post-failure overflow retry stay bridge-level.
    config.compaction = hcompaction::CompactionSettings::default();
    config.tools = Arc::new(tools.iter().map(|t| runtime_tool_from(t.clone())).collect());

    let (harness, _open) = match Harness::create(
        session,
        HarnessOptions {
            provider: model.provider.clone(),
            model_id: model.id.clone(),
            thinking_level: thinking_level_for(&model, shared.effort.as_deref()),
            active_tool_names: tools.iter().map(|t| t.name().to_string()).collect(),
            config,
        },
    ) {
        Ok(created) => created,
        Err(_) => return "harness-open-failed",
    };
    let lane = match harness.lane(&lane_name).await {
        Ok(lane) => lane,
        Err(_) => return "lane-open-failed",
    };

    // Recovery is observable too: an attached client polls
    // /api/chats/:id/run/live and watches the bus while resume settles.
    // try-register: a user turn that started meanwhile owns the slot.
    run_state::try_register_run(&chat_id, run_state::LiveRun {
        run_id: session_id.to_string(),
        session_id: session_id.to_string(),
        bus: harness.events.clone(),
        lane: lane.clone(),
        harness: harness.clone(),
        started_at: run_state::now_ms(),
    });

    let mapper = tokio::spawn(map_harness_events(
        shared.clone(),
        lane.clone(),
        harness.events.subscribe(None),
    ));
    let record = harness.resume(&lane_name).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), mapper).await;
    harness.close().await;
    run_state::unregister_run(&chat_id, session_id);

    if aborting {
        return "reconciled-aborted";
    }
    match record {
        Ok(record) if record.status == crate::harness::session::types::TerminalStatus::Completed => "resumed-completed",
        Ok(_) => "resumed-settled",
        Err(_) => "resume-failed",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn titles_are_cleaned_or_rejected() {
        use super::clean_title;
        assert_eq!(clean_title("\"Q3 expenses cleanup.\"\n").as_deref(), Some("Q3 expenses cleanup"));
        assert_eq!(clean_title("## Title: Weekly report").as_deref(), Some("Weekly report"));
        assert_eq!(clean_title("   \n"), None);
        assert_eq!(clean_title(&"word ".repeat(30)), None);
    }

    use super::*;

    #[test]
    fn step_labels_read_as_plain_language() {
        let done = |name: &str, params: Value| step_labels(name, &params).1;
        assert_eq!(done("read", json!({"path": "/w/Q3/expenses.csv"})), "Read expenses.csv");
        assert_eq!(
            done("read", json!({"path": "/w/uploads/db46d6782aba41aa854191eb82966f1a_expenses.csv"})),
            "Read expenses.csv"
        );
        assert_eq!(done("bash", json!({"command": "python3 -c \"import pandas\""})), "Ran a Python snippet");
        assert_eq!(done("update_todos", json!({})), "Updated the plan");
        assert_eq!(
            done("bash", json!({"command": "cd /w/outputs && python3 clean.py --in x.csv"})),
            "Ran Python script clean.py"
        );
        assert_eq!(done("bash", json!({"command": "python3 - <<'PY'\nprint(1)\nPY"})), "Ran a Python snippet");
        assert_eq!(done("bash", json!({"command": "ls -la"})), "Ran a command: ls -la");
        assert_eq!(done("browser_click", json!({})), "Used the browser");
        assert_eq!(done("detect_hardware", json!({})), "Ran detect hardware");
        assert_eq!(done("GMAIL_SEND_EMAIL", json!({})), "Used Gmail: send email");
    }

    fn row(role: &str, content: &str) -> chatstore::ChatMessage {
        chatstore::ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            role: role.into(),
            content: json!(content),
            created_at: 0,
            activities: vec![],
            tool_trace: vec![],
            usage: None,
        }
    }

    #[test]
    fn history_alternates_and_drops_empty_assistant() {
        let model = crate::harness::test_support::default_model();
        let rows = vec![
            row("assistant", "stray"),
            row("user", "hi"),
            row("assistant", ""),
            row("user", "again"),
            row("assistant", "ok"),
            row("assistant", "more"),
        ];
        let msgs = history_to_messages(&rows, &model);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].as_llm().and_then(|m| m.as_user()).unwrap().content.text(), "hi\n\nagain");
        assert_eq!(msgs[1].as_assistant().unwrap().text(), "ok\n\nmore");
    }

    #[test]
    fn blocks_convert_text_and_images() {
        let blocks = json!([
            { "type": "text", "text": "look" },
            { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "QUJD" } },
            { "type": "tool_result", "content": "ignored" }
        ]);
        let out = blocks_to_user_content(&blocks);
        assert_eq!(out.len(), 2);
        assert!(matches!(&out[1], UserContent::Image(i) if i.mime_type == "image/jpeg" && i.data == "QUJD"));
    }

    #[test]
    fn router_calls_carry_run_tags() {
        let r = Resolved {
            api_key: "zw_abc".into(),
            base_url: "https://api.tryzwork.app/api/".into(),
            provider: "zwork_router".into(),
            api: Some(Api::OpenAICompletions),
            real_model_id: "zwork-flash".into(),
            provider_display_name: "zWork Cloud Router".into(),
            configured: true,
        };
        let run_id = "sched_t1_ab12";
        let tag = RouterTag { run_id, chat_id: "c1", project_id: "", trigger: trigger_for(run_id) };
        let h = build_model(&r, &r.real_model_id, Some(&tag)).headers.unwrap();
        assert_eq!(h["x-zwork-run-id"], run_id);
        assert_eq!(h["x-zwork-trigger"], "schedule");
        assert_eq!(h["x-zwork-chat-id"], "c1");
        assert_eq!(h["x-zwork-os"], std::env::consts::OS);
        assert!(!h.contains_key("x-zwork-project-id"), "empty ids are left out");
        assert_eq!(trigger_for("3f2a"), "chat");
    }

    #[test]
    fn router_models_are_tier_aliases_with_effort() {
        use crate::harness::types::ThinkingFormat;
        let r = Resolved {
            api_key: "zw_abc".into(),
            base_url: "https://api.tryzwork.app/api/".into(),
            provider: "zwork_router".into(),
            // Older installs registered the router with the Anthropic shape
            // and pinned upstream ids.
            api: Some(Api::AnthropicMessages),
            real_model_id: "z-ai/glm-5.3-flash".into(),
            provider_display_name: "zWork Cloud Router".into(),
            configured: true,
        };
        let m = build_model(&r, &r.real_model_id, None);
        assert_eq!(m.id, "zwork-pro");
        assert_eq!(m.api, Api::OpenAICompletions);
        assert_eq!(m.base_url, "https://api.tryzwork.app/api");
        assert!(m.reasoning, "effort reaches the router");
        assert_eq!(m.input, vec![InputType::Text], "Pro is text-only");
        assert_eq!(m.compat.as_ref().and_then(|c| c.thinking_format), Some(ThinkingFormat::Openrouter));
        assert_eq!(thinking_level_for(&m, Some("xhigh")), crate::harness::types::ThinkingLevel::Xhigh);
        assert_eq!(thinking_level_for(&m, Some("max")), crate::harness::types::ThinkingLevel::Max);

        let ultra = build_model(&Resolved { real_model_id: "zwork-ultimate".into(), ..r }, "zwork-ultimate", None);
        assert_eq!(ultra.id, "zwork-ultra");
        assert!(ultra.input.contains(&InputType::Image));
        assert_eq!(router_real_model("something-else"), "zwork-flash");
    }

    #[test]
    fn anthropic_keys_keep_their_own_auth() {
        let r = Resolved {
            api_key: "sk-ant-x".into(),
            base_url: "".into(),
            provider: "anthropic".into(),
            api: None,
            real_model_id: "claude-sonnet-4-5".into(),
            provider_display_name: "Anthropic".into(),
            configured: true,
        };
        let tag = RouterTag { run_id: "r1", chat_id: "c1", project_id: "", trigger: "chat" };
        let m = build_model(&r, "claude-sonnet-4-5", Some(&tag));
        assert!(m.headers.is_none(), "run tags only go to the zWork router");
        assert_eq!(m.api, Api::AnthropicMessages);
        assert!(m.reasoning && m.max_tokens >= 64_000);
        assert!(m.context_window <= 200_000);
        let gateway = Resolved { api_key: "gw_x".into(), base_url: "https://gw.example/".into(), api: Some(Api::AnthropicMessages), ..r };
        let m = build_model(&gateway, "claude-sonnet-4-5", None);
        assert_eq!(m.headers.unwrap()["authorization"], "Bearer gw_x");
    }

    #[test]
    fn test_compaction_model_picks_cheap_tier() {
        // Clear any leftover so the default-branch assertions are deterministic.
        // (Env is process-global, so the override check below lives in THIS
        // single test rather than a sibling, avoiding a parallel-test race on
        // the shared var.)
        std::env::remove_var("ZWORK_COMPACTION_MODEL");

        // Each family maps to its cheap tier...
        assert_eq!(compaction_model_id("openai", "deepseek-v4-pro"), "deepseek-flash");
        assert_eq!(compaction_model_id("openai", "deepseek-flash"), "deepseek-flash");
        assert_eq!(compaction_model_id("openai", "deepseek-v4-flash"), "deepseek-flash");
        assert_eq!(compaction_model_id("anthropic", "claude-opus-4-8"), "claude-haiku-4-5-20251001");
        assert_eq!(compaction_model_id("openai", "gemini-2.5-pro"), "gemini-2.5-flash");
        assert_eq!(compaction_model_id("openai", "gpt-4.1"), "gpt-4.1-mini");
        // ...never the expensive main model.
        assert_ne!(compaction_model_id("anthropic", "claude-opus-4-8"), "claude-opus-4-8");
        // Unknown family keeps the main model (no invented id that could 404).
        assert_eq!(compaction_model_id("openai", "grok-4"), "grok-4");

        // Env override wins over family detection, then we restore default.
        std::env::set_var("ZWORK_COMPACTION_MODEL", "custom-flash-id");
        assert_eq!(compaction_model_id("anthropic", "claude-opus-4-8"), "custom-flash-id");
        std::env::remove_var("ZWORK_COMPACTION_MODEL");
    }
}
