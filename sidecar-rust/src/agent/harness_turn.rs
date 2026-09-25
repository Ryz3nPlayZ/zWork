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
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;

use crate::harness::agent_types::{
    AgentMessage, AgentTool, AgentToolResult, AgentToolUpdateCallback, DynTool, ReplayPolicy, StreamFn,
    ToolExecutionMode, ToolFuture,
};
use crate::harness::compaction as hcompaction;
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
    log_agent_event, max_tokens_for, orientation, pending_permission_gates, prompts, router_real_model,
    web_search_grounding, DoomLoopDetector, ErrorClass, RunGuard,
};

const DEFAULT_MAX_TURNS: u32 = 80;
const GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
const MAX_TRANSIENT_RETRIES: u32 = 3;

/// Context window used for auto-compaction. Kept at 200k regardless of the
/// provider's advertised window: every turn re-sends the whole history, so
/// compacting at 200k keeps latency and cost sane even on 1M-window models.
fn context_window_for(_model_id: &str) -> u64 {
    match std::env::var("ZWORK_CONTEXT_WINDOW").ok().and_then(|v| v.trim().parse::<u64>().ok()) {
        Some(n) if n > 0 => n,
        _ => 200_000,
    }
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
    assistant_msg_id: String,
    auto_approve: bool,
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

    fn turn(&self) -> u32 {
        self.turn.load(Ordering::SeqCst)
    }

    /// Persist the assistant row (text + activities). Serialized so parallel
    /// tools don't contend on SQLite.
    async fn persist(&self) {
        let text = self.accumulated_text.lock_unpoisoned().clone();
        let activities = self.activities.lock_unpoisoned().clone();
        let _guard = self.db_lock.lock().await;
        let _ = chatstore::update_message(&self.chat_id, &self.assistant_msg_id, Some(json!(text)), Some(activities));
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

/// A zWork tool (from `tools::get_tool_schemas` / Composio / MCP) exposed to
/// the harness. Execution goes through `tools::execute_tool`; permission
/// gating and event forwarding match the legacy loop exactly.
struct LegacyTool {
    name: String,
    description: String,
    parameters: Value,
    shared: Arc<TurnShared>,
}

impl LegacyTool {
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

    /// Ask the user before a destructive action. `Ok(true)` = go ahead.
    async fn permission_gate(&self, tc_id: &str, params: &Value) -> bool {
        let shared = &self.shared;
        let Risk::Destructive { reason } = evaluate_tool_risk(&self.name, params) else {
            return true;
        };
        // A command the user already approved this run (via
        // ask_user_for_permission) skips the gate entirely.
        let already_approved = self.name == "run_command"
            && params
                .get("command")
                .and_then(|v| v.as_str())
                .map(|c| is_command_approved(&shared.chat_id, c))
                .unwrap_or(false);
        if shared.auto_approve || already_approved {
            return true;
        }
        let gate_id = format!("gate_{}", uuid::Uuid::new_v4().simple());
        shared
            .send(json!({
                "type": "permission",
                "tool": self.name,
                "reason": reason,
                "blocked": true,
                "gate_id": gate_id,
                "tool_use_id": tc_id
            }))
            .await;
        let (gate_tx, gate_rx) = oneshot::channel();
        pending_permission_gates().lock_unpoisoned().insert(gate_id.clone(), gate_tx);
        // Long safety timeout so an unanswered prompt (UI closed, SSE stream
        // dropped) can't hang the loop forever; expiry auto-denies.
        match tokio::time::timeout(GATE_TIMEOUT, gate_rx).await {
            Ok(Ok(approved)) => approved,
            Ok(Err(_)) => false,
            Err(_) => {
                shared
                    .send(json!({
                        "type": "status",
                        "text": "Permission request timed out after 10 minutes and was auto-denied."
                    }))
                    .await;
                false
            }
        }
    }

    async fn run(&self, tc_id: &str, params: Value, signal: Option<&AbortSignal>) -> Result<AgentToolResult, String> {
        let shared = self.shared.clone();
        let turn = shared.turn();
        llm_trace(&shared.chat_id, turn, "tool_dispatch", json!({ "id": tc_id, "name": self.name, "input": params }));

        if !self.permission_gate(tc_id, &params).await {
            let msg = "Permission denied by user. Action aborted.".to_string();
            shared
                .send(json!({
                    "type": "tool_result",
                    "tool": self.name,
                    "ok": false,
                    "message": msg,
                    "tool_use_id": tc_id
                }))
                .await;
            llm_trace(
                &shared.chat_id,
                turn,
                "tool_result",
                json!({ "name": self.name, "ok": false, "len": msg.len(), "preview": msg, "denied": true }),
            );
            return Err(msg);
        }

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
                    shared.upsert_activity(json!({
                        "id": evt.get("id").cloned().unwrap_or(Value::Null),
                        "label": evt.get("label").cloned().unwrap_or(Value::Null),
                        "done": evt.get("done").and_then(|v| v.as_bool()).unwrap_or(false),
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

impl AgentTool for LegacyTool {
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

/// Legacy tools superseded by pi's core tools. Filtered out of the menu so
/// the model sees exactly one way to touch files and the shell.
const SUPERSEDED_LEGACY_TOOLS: &[&str] =
    &["read_file", "write_file", "replace_file_content", "run_command", "grep_search", "list_dir"];

/// Legacy → pi tool names, applied to the system prompt so its workflow
/// guidance references the tools the model actually has.
const TOOL_RENAMES: &[(&str, &str)] = &[
    ("replace_file_content", "edit"),
    ("run_command", "bash"),
    ("write_file", "write"),
    ("read_file", "read"),
    ("grep_search", "grep"),
    ("list_dir", "ls"),
];

/// Rewrite the legacy tool references in `prompt` for the pi toolset. The
/// per-tool signature lines are replaced wholesale (their parameters differ);
/// everything else is a plain name swap.
fn rewrite_prompt_for_pi_tools(prompt: &str) -> String {
    const LEGACY_LINES: &[&str] = &[
        "- `read_file(path)` — read a text file. Always inspect existing code before editing.",
        "- `replace_file_content(path, target_content, replacement_content, start_line?, end_line?)` — replace a target substring in a file. Preferred for edits.",
        "- `grep_search(query, path?, is_regex?, case_insensitive?)` — search recursively for query or regex in files. Excludes build/dependency dirs.",
        "- `list_dir(path)` — list immediate contents of a directory.",
        "- `write_file(path, content)` — create or overwrite a file with the ENTIRE contents. Parent dirs auto-created.",
        "- `run_command(command, cwd?, background?)` — run shell. Set `background=true` for servers; foreground has 180s timeout.",
    ];
    const PI_LINES: &str = "\
- `read(path, offset?, limit?)` — read a file (text, or an image the model can see). Always inspect existing code before editing. Long files are truncated; use offset/limit to page.
- `edit(path, oldText, newText)` — replace an exact, unique text span in a file. Preferred for targeted edits; `oldText` must match exactly once.
- `grep(pattern, path?, glob?, ignoreCase?, literal?, context?, limit?)` — regex search across files (honours .gitignore).
- `find(pattern, path?, limit?)` — find files by glob pattern (e.g. `**/*.rs`), honours .gitignore.
- `ls(path?, limit?)` — list a directory's contents.
- `write(path, content)` — create or overwrite a file with the ENTIRE contents. Parent dirs auto-created.
- `bash(command, timeout?)` — run a shell command in the workspace; stdout+stderr are returned (tail-truncated, full output saved to a temp file). Long-lived servers: redirect output and background them (`nohup cmd > server.log 2>&1 &`) or use `deploy_web_app`.";
    let mut out = prompt.to_string();
    let mut first = true;
    for line in LEGACY_LINES {
        if out.contains(line) {
            out = out.replace(line, if first { PI_LINES } else { "" });
            first = false;
        }
    }
    // Collapse the blank lines left by the removed signature lines.
    while out.contains("\n\n\n") {
        out = out.replace("\n\n\n", "\n\n");
    }
    out = out.replace(
        "start it in the background with `run_command(..., background=true)` OR `deploy_web_app(...)`",
        "start it in the background with `bash` (`nohup cmd > server.log 2>&1 &`) OR `deploy_web_app(...)`",
    );
    out = out.replace("read_file, list_dir, read_skill", "read, ls, grep, find, read_skill");
    out = out.replace("foreground has 180s timeout", "pass `timeout` for long commands");
    for (from, to) in TOOL_RENAMES {
        out = out.replace(from, to);
    }
    out
}

/// A pi core tool run through zWork's permission gate and event plumbing:
/// `activity` start/finish frames, streamed bash output as `status` lines,
/// and a `tool_result` frame, all stamped with the tool-call id.
struct GatedPiTool {
    inner: DynTool,
    shared: Arc<TurnShared>,
}

impl GatedPiTool {
    /// Map a pi tool call onto the legacy risk evaluator's vocabulary.
    fn risk(&self, params: &Value) -> Risk {
        match self.inner.name() {
            "bash" => evaluate_tool_risk("run_command", &json!({ "command": params.get("command").cloned().unwrap_or(Value::Null) })),
            "write" | "edit" => evaluate_tool_risk("write_file", &json!({ "path": params.get("path").cloned().unwrap_or(Value::Null) })),
            _ => Risk::Safe,
        }
    }

    async fn permission_gate(&self, tc_id: &str, params: &Value) -> bool {
        let shared = &self.shared;
        let Risk::Destructive { reason } = self.risk(params) else {
            return true;
        };
        let already_approved = self.inner.name() == "bash"
            && params
                .get("command")
                .and_then(|v| v.as_str())
                .map(|c| is_command_approved(&shared.chat_id, c))
                .unwrap_or(false);
        if shared.auto_approve || already_approved {
            return true;
        }
        let gate_id = format!("gate_{}", uuid::Uuid::new_v4().simple());
        shared
            .send(json!({
                "type": "permission",
                "tool": self.inner.name(),
                "reason": reason,
                "blocked": true,
                "gate_id": gate_id,
                "tool_use_id": tc_id
            }))
            .await;
        let (gate_tx, gate_rx) = oneshot::channel();
        pending_permission_gates().lock_unpoisoned().insert(gate_id.clone(), gate_tx);
        match tokio::time::timeout(GATE_TIMEOUT, gate_rx).await {
            Ok(Ok(approved)) => approved,
            Ok(Err(_)) => false,
            Err(_) => {
                shared
                    .send(json!({
                        "type": "status",
                        "text": "Permission request timed out after 10 minutes and was auto-denied."
                    }))
                    .await;
                false
            }
        }
    }

    async fn run(&self, tc_id: &str, params: Value, signal: Option<&AbortSignal>, _on_update: AgentToolUpdateCallback) -> Result<AgentToolResult, String> {
        let shared = self.shared.clone();
        let name = self.inner.name().to_string();
        let turn = shared.turn();
        llm_trace(&shared.chat_id, turn, "tool_dispatch", json!({ "id": tc_id, "name": name, "input": params }));

        if !self.permission_gate(tc_id, &params).await {
            let msg = "Permission denied by user. Action aborted.".to_string();
            shared
                .send(json!({ "type": "tool_result", "tool": name, "ok": false, "message": msg, "tool_use_id": tc_id }))
                .await;
            llm_trace(&shared.chat_id, turn, "tool_result", json!({ "name": name, "ok": false, "len": msg.len(), "preview": msg, "denied": true }));
            return Err(msg);
        }

        let activity_id = format!("tool_{}_{}", name, uuid::Uuid::new_v4().simple());
        let label = activity_label(&name, &params);
        shared.upsert_activity(json!({ "id": activity_id, "label": label, "done": false }));
        shared.persist().await;
        shared
            .send(json!({ "type": "activity", "id": activity_id, "label": label, "done": false, "tool_use_id": tc_id }))
            .await;

        // Stream bash output as `status` lines, the way run_command did:
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
        shared.upsert_activity(json!({ "id": activity_id, "label": format!("Finished {name}"), "done": true }));
        shared.persist().await;
        shared
            .send(json!({ "type": "activity", "id": activity_id, "label": format!("Finished {name}"), "done": true, "tool_use_id": tc_id }))
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

fn activity_label(name: &str, params: &Value) -> String {
    let arg = |k: &str| params.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match name {
        "bash" => format!("Running: {}", arg("command").lines().next().unwrap_or("").chars().take(80).collect::<String>()),
        "read" => format!("Reading {}", arg("path")),
        "write" => format!("Writing {}", arg("path")),
        "edit" => format!("Editing {}", arg("path")),
        "grep" => format!("Searching for {}", arg("pattern")),
        "find" => format!("Finding {}", arg("pattern")),
        "ls" => format!("Listing {}", if arg("path").is_empty() { "." } else { arg("path") }),
        _ => format!("Running {name}"),
    }
}

impl AgentTool for GatedPiTool {
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

/// Map durable harness events onto the zWork wire (same events, same order
/// as the agent-loop listener). Breaks on `run_end`; exits when the bus
/// closes. Enforces the runaway turn cap by aborting the operation durably.
async fn map_harness_events(
    shared: Arc<TurnShared>,
    lane: std::sync::Arc<crate::harness::runtime::lane::Lane>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<(u64, crate::harness::runtime::events::HarnessEvent)>,
) {
    use crate::harness::runtime::events::HarnessEvent;
    let max_turns = shared.max_turns;
    while let Some((_seq, event)) = events.recv().await {
        match event {
            HarnessEvent::TurnStart { .. } => {
                let turn = shared.turn.fetch_add(1, Ordering::SeqCst) + 1;
                shared.send(json!({ "type": "status", "text": "Thinking" })).await;
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
                handle_stream_event(&shared, event).await;
            }
            HarnessEvent::MessageEnd { message, .. } => {
                record_assistant_end(&shared, &message).await;
            }
            HarnessEvent::ToolEnd { tool_call_id, tool_name, result, is_error, .. } => {
                push_tool_trace(&shared, &tool_call_id, &tool_name, &result, is_error);
            }
            HarnessEvent::TurnEnd { .. } => flush_traces(&shared).await,
            HarnessEvent::RunEnd { .. } => break,
            _ => {}
        }
    }
}

/// One durable attempt: a fresh per-run session (crash-resumable artifact
/// under `~/.zwork/sessions/`), the harness facade over it, the doom-loop
/// guard on the hook registry, the event mapper, and the prompt driven to
/// settlement. Mid-run threshold compaction stays disabled until the
/// structural procedures land (M6); pre-run and overflow compaction stay at
/// the bridge level, exactly as before.
#[allow(clippy::too_many_arguments)]
async fn run_durable_once(
    shared: &Arc<TurnShared>,
    model: &Model,
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
        max_tokens: Some(super::max_tokens_for(&model.id)),
        max_retries: Some(MAX_TRANSIENT_RETRIES),
        session_id: Some(shared.chat_id.clone()),
        ..Default::default()
    };
    config.retry_policy = RetryPolicySnapshot {
        enabled: true,
        max_retries: MAX_TRANSIENT_RETRIES,
        ..Default::default()
    };
    config.compaction = hcompaction::CompactionSettings { enabled: false, ..Default::default() };
    config.tools = Arc::new(tools.iter().map(|t| runtime_tool_from(t.clone())).collect());

    let (harness, open) = match Harness::create(
        session,
        HarnessOptions {
            provider: model.provider.clone(),
            model_id: model.id.clone(),
            thinking_level: crate::harness::types::ThinkingLevel::Off,
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

    let mapper = tokio::spawn(map_harness_events(
        shared.clone(),
        lane.clone(),
        harness.events.subscribe(None),
    ));

    let record = harness.prompt("main", vec![prompt_message]).await.ok();
    // Drain trailing events (usage / turn_end / run_end race the settle).
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), mapper).await;
    harness.close().await;
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
async fn handle_stream_event(shared: &TurnShared, event: AssistantMessageEvent) {
    match event {
        AssistantMessageEvent::TextDelta { delta, .. } => {
            if delta.is_empty() {
                return;
            }
            shared.accumulated_text.lock_unpoisoned().push_str(&delta);
            shared.persist().await;
            shared.send(json!({ "type": "delta", "text": delta })).await;
        }
        AssistantMessageEvent::ThinkingDelta { delta, .. } => {
            if delta.is_empty() {
                return;
            }
            shared.thinking_open.store(true, Ordering::SeqCst);
            shared.send(json!({ "type": "thinking_delta", "text": delta })).await;
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
                .send(json!({
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

/// A settled assistant message: finish trace, usage ledger + wire totals.
async fn record_assistant_end(shared: &TurnShared, message: &AgentMessage) {
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
        let _ = chatstore::record_usage(&shared.chat_id, &shared.assistant_msg_id, &total, &am.usage);
    }
    shared
        .send(json!({
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
        chatstore::append_tool_trace(&shared.chat_id, &shared.assistant_msg_id, traces);
    }
}

// ---------------------------------------------------------------------------
// Model / credential resolution
// ---------------------------------------------------------------------------

struct Resolved {
    api_key: String,
    base_url: String,
    shape: String,
    real_model_id: String,
    provider_display_name: String,
}

fn resolve_model(model_id: &str, s: &settings::Settings) -> Resolved {
    let (api_key, base_url, shape, real_model_id, provider_display_name) = if model_id == "__claude_code__" {
        let cc_model = crate::server::read_claude_code_model().unwrap_or_default();
        let real_model =
            if cc_model.is_empty() || cc_model == "(default)" { "claude-3-5-sonnet-latest".to_string() } else { cc_model };
        if let Some(cred) = crate::server::resolve("claude_code", s, "") {
            (cred.api_key, cred.base_url, cred.shape, real_model, "local credentials".to_string())
        } else {
            ("".into(), "https://api.anthropic.com".into(), "anthropic".into(), real_model, "local credentials".into())
        }
    } else if let Some(m) = s.custom_models.iter().find(|m| m.id == model_id) {
        let real_model = if m.model_id == "(default)" || m.model_id.is_empty() {
            "claude-3-5-sonnet-latest".to_string()
        } else {
            m.model_id.clone()
        };
        let provider_name = m.credential.clone();
        if let Some(cred) = crate::server::resolve(&m.credential, s, &m.base_url_override) {
            (cred.api_key, cred.base_url, m.shape.clone(), real_model, provider_name)
        } else {
            ("".into(), m.base_url_override.clone(), m.shape.clone(), real_model, provider_name)
        }
    } else {
        let real_model = router_real_model(model_id);
        if let Some(cred) = crate::server::resolve("zwork_router", s, "") {
            (cred.api_key, cred.base_url, "anthropic".into(), real_model, "zWork Cloud Router".into())
        } else {
            ("".into(), "https://api.tryzwork.app/api".into(), "anthropic".into(), real_model, "zWork Cloud Router".into())
        }
    };
    Resolved { api_key, base_url, shape, real_model_id, provider_display_name }
}

fn build_model(r: &Resolved, model_id: &str) -> Model {
    let api = if r.shape == "anthropic" { Api::AnthropicMessages } else { Api::OpenAICompletions };
    let mut headers = BTreeMap::new();
    // Router / gateway keys aren't Anthropic keys: they authenticate with a
    // bearer token in addition to x-api-key (matches the legacy loop).
    if api == Api::AnthropicMessages && !r.api_key.is_empty() && !r.api_key.starts_with("sk-ant-") {
        headers.insert("authorization".to_string(), format!("Bearer {}", r.api_key));
    }
    Model {
        id: model_id.to_string(),
        name: model_id.to_string(),
        api,
        provider: r.provider_display_name.clone(),
        base_url: r.base_url.trim_end_matches('/').to_string(),
        reasoning: false,
        thinking_level_map: None,
        input: vec![InputType::Text, InputType::Image],
        cost: crate::harness::pricing::model_cost_for(model_id),
        prompt_cache: Some(true),
        context_window: context_window_for(model_id),
        max_tokens: max_tokens_for(model_id),
        headers: if headers.is_empty() { None } else { Some(headers) },
        compat: None,
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
) -> impl futures_util::Stream<Item = Result<Value, Infallible>> {
    let (tx, rx) = mpsc::channel(100);

    let run_chat_id = chat_id.clone();
    let turn_handle = tokio::spawn(async move {
        let _guard = RunGuard(chat_id.clone());
        let s = settings::load();
        let run_id = if run_id.is_empty() { chat_id.clone() } else { run_id };
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

        // ── Credentials / model ─────────────────────────────────────────
        let resolved = resolve_model(&model_id, &s);
        log_agent_event(&chat_id, &run_id, "provider_resolved", json!({
            "provider": resolved.provider_display_name,
            "base_url": resolved.base_url,
            "shape": resolved.shape,
            "real_model_id": resolved.real_model_id,
        }));
        let _ = tx
            .send(json!({
                "type": "meta",
                "provider": resolved.provider_display_name,
                "resolved_model": resolved.real_model_id,
                "upstream_provider": resolved.shape,
            }))
            .await;
        if resolved.api_key.trim().is_empty() {
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
        let model = build_model(&resolved, &resolved.real_model_id);
        let compaction_model = {
            let id = compaction_model_id(&resolved.shape, &resolved.real_model_id);
            build_model(&resolved, &id)
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

        let composio_schemas = crate::composio::all_tool_schemas().await;
        let composio_apps = crate::composio::connected_apps().await;
        let connected_apps_block = crate::composio::build_connected_apps_block(&composio_schemas, &composio_apps);
        let mcp_schemas = crate::mcp::all_tool_schemas();

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
        let system_prompt = rewrite_prompt_for_pi_tools(&system_prompt);
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

        let prompt_message: AgentMessage = if attachments.is_empty() {
            AgentMessage::user_text(format!("{prefix}\n\n{user_message}"))
        } else {
            let mut blocks = blocks_to_user_content(&prompts::build_user_content(&user_message, &attachments));
            blocks.push(UserContent::text(prefix));
            AgentMessage::Llm(Message::user_blocks(blocks))
        };

        // ── Assistant row + shared state ────────────────────────────────
        let assistant_msg_id = chatstore::append_message(&chat.id, "assistant", json!("")).map(|m| m.id).unwrap_or_default();
        let shared = Arc::new(TurnShared {
            chat_id: chat_id.clone(),
            run_id: run_id.clone(),
            tx: tx.clone(),
            assistant_msg_id,
            auto_approve,
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
        schemas.extend(mcp_schemas);
        schemas.retain(|s| {
            let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("");
            !SUPERSEDED_LEGACY_TOOLS.contains(&name)
        });
        let mut tools: Vec<DynTool> = schemas
            .iter()
            .filter_map(|s| LegacyTool::from_schema(s, shared.clone()))
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
            tools.push(Arc::new(GatedPiTool { inner: tool, shared: shared.clone() }) as DynTool);
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

const MAX_SUBAGENT_TURNS: u32 = 12;

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
    config.retry_policy = RetryPolicySnapshot { enabled: true, max_retries: 2, ..Default::default() };
    config.tools = Arc::new(tools.iter().map(|t| runtime_tool_from(t.clone())).collect());

    let (harness, _open) = Harness::create(
        session,
        HarnessOptions {
            provider: model.provider.clone(),
            model_id: model.id.clone(),
            thinking_level: crate::harness::types::ThinkingLevel::Off,
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
                    if turns > MAX_SUBAGENT_TURNS {
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

/// Run a bounded, READ-ONLY sub-agent for `task` on the harness, streaming
/// `subagent_started` / `subagent_delta` / `subagent_done` to the parent's
/// SSE stream. Returns the sub-agent's full text output.
///
/// Rails: pi read/grep/find/ls plus web/document/academic lookups only; no
/// bash/write/edit, no nested spawn_agent; hard cap of 12 turns.
pub async fn spawn_subagent(
    chat_id: &str,
    parent_run_id: &str,
    task: &str,
    model_id: &str,
    tx: &mpsc::Sender<Value>,
) -> Result<String, String> {
    let task_id = format!("subagent_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let _ = tx.send(json!({ "type": "subagent_started", "task_id": task_id, "description": task })).await;

    let s = settings::load();
    let resolved = resolve_model(model_id, &s);
    if resolved.api_key.trim().is_empty() {
        let _ = tx.send(json!({ "type": "subagent_done", "task_id": task_id, "error": "No credentials configured" })).await;
        return Err("No credentials configured".to_string());
    }
    let model = build_model(&resolved, &resolved.real_model_id);

    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut tools: Vec<DynTool> = crate::harness::tools::create_coding_tools(&cwd, None)
        .into_iter()
        .filter(|t| matches!(t.name(), "read" | "grep" | "find" | "ls"))
        .collect();
    for schema in get_tool_schemas(false) {
        let name = schema.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if matches!(name.as_str(), "web_search" | "extract_document" | "search_papers" | "format_citation") {
            tools.push(Arc::new(SubagentDirectTool { schema, name }) as DynTool);
        }
    }
    tools.sort_by(|a, b| a.name().cmp(b.name()));

    let system = format!(
        "You are a focused sub-agent. Complete this task: {task}\n\n\
         You have READ-ONLY tools (read/ls/grep/find, web and document lookups). Do the task, then stop. \
         Be concise — your full text output is returned to the parent agent."
    );

    let stream_fn: StreamFn = Arc::new(crate::harness::providers::stream);
    match spawn_subagent_durable(chat_id, parent_run_id, &task_id, task, &model, &resolved.api_key, &tools, &system, stream_fn, tx).await {
        Ok(result) => {
            log_agent_event(chat_id, parent_run_id, "subagent_done", json!({ "task_id": task_id, "chars": result.len() }));
            let _ = tx.send(json!({ "type": "subagent_done", "task_id": task_id, "result": result })).await;
            Ok(result)
        }
        Err(friendly) => {
            let _ = tx.send(json!({ "type": "subagent_done", "task_id": task_id, "error": friendly })).await;
            Err(friendly)
        }
    }
}

/// Pick the model id used for compaction summarization./// Pick the model id used for compaction summarization. Summarization is a
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
    if m.contains("deepseek") || m.contains("v4-pro") || m.contains("v4-flash") {
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn prompt_rewrite_swaps_tool_names_and_signatures() {
        let prompt = "- `read_file(path)` — read a text file. Always inspect existing code before editing.\n\
- `list_dir(path)` — list immediate contents of a directory.\n\
Use `grep_search` to locate, `read_file` to read, then `write_file` or `replace_file_content`. Use `run_command` for shell.\n\
Only read-only tools are available: read_file, list_dir, read_skill, extract_document, web_search.";
        let out = rewrite_prompt_for_pi_tools(prompt);
        for legacy in SUPERSEDED_LEGACY_TOOLS {
            assert!(!out.contains(legacy), "{legacy} still referenced in:\n{out}");
        }
        assert!(out.contains("- `bash(command, timeout?)`"));
        assert!(out.contains("Use `grep` to locate, `read` to read, then `write` or `edit`. Use `bash` for shell."));
        assert!(out.contains("read, ls, grep, find, read_skill"));
        assert!(!out.contains("\n\n\n"));
    }

    #[test]
    fn router_keys_get_bearer_header() {
        let r = Resolved {
            api_key: "zw_abc".into(),
            base_url: "https://api.tryzwork.app/api/".into(),
            shape: "anthropic".into(),
            real_model_id: "claude-sonnet-4-5".into(),
            provider_display_name: "zWork Cloud Router".into(),
        };
        let m = build_model(&r, &r.real_model_id);
        assert_eq!(m.api, Api::AnthropicMessages);
        assert_eq!(m.base_url, "https://api.tryzwork.app/api");
        assert_eq!(m.headers.unwrap()["authorization"], "Bearer zw_abc");
        let anthropic = Resolved { api_key: "sk-ant-x".into(), ..r };
        assert!(build_model(&anthropic, "claude-sonnet-4-5").headers.is_none());
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
