//! Model Context Protocol client.
//!
//! Servers are configured in `~/.zwork/mcp.json` (any dialect — see
//! [`config`]) and connected lazily on the first turn that needs them. Each
//! server keeps one long-lived session: stdio children stay running,
//! HTTP sessions keep their `Mcp-Session-Id`, and the tool list is cached
//! until the server says it changed. A session that dies is reconnected on
//! next use; a server that fails to connect is left alone for a short
//! backoff so one broken entry cannot stall every turn.

pub mod config;
pub mod tool;
mod transport;

pub use config::ServerSpec;
pub use tool::{McpTool, TOOL_PREFIX};

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use transport::{Peer, RpcError, ServerInfo};

use crate::harness::types::AbortSignal;

/// First connect can include `npx` downloading the server.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(300);
/// How long a failed server is skipped before the next automatic attempt.
const RETRY_BACKOFF: Duration = Duration::from_secs(120);
const MAX_LIST_PAGES: usize = 50;

struct Session {
    /// The resolved spec this session was opened with.
    spec: ServerSpec,
    peer: Arc<Peer>,
    info: ServerInfo,
    tools: Vec<Arc<McpTool>>,
}

#[derive(Default)]
struct Slot {
    session: tokio::sync::Mutex<Option<Session>>,
    failure: Mutex<Option<Failure>>,
}

struct Failure {
    at: Instant,
    spec: ServerSpec,
    error: String,
}

fn slots() -> &'static Mutex<HashMap<String, Arc<Slot>>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Arc<Slot>>>> = OnceLock::new();
    SLOTS.get_or_init(Default::default)
}

fn slot(name: &str) -> Arc<Slot> {
    slots().lock().unwrap().entry(name.to_string()).or_default().clone()
}

/// Connect `spec` if it is not already live, refreshing a stale tool list.
/// `force` ignores the failure backoff (explicit user retry).
async fn ensure(spec: &ServerSpec, force: bool) -> Result<(), String> {
    let resolved = config::resolved(spec);
    let slot = slot(&spec.name);
    let mut session = slot.session.lock().await;

    if let Some(live) = session.as_mut().filter(|s| s.spec == resolved && s.peer.is_alive()) {
        if live.peer.take_tools_changed() {
            live.tools = list_tools(&spec.name, &live.peer).await.map_err(|e| live.peer.explain(&e))?;
        }
        return Ok(());
    }
    *session = None;

    if !force {
        if let Some(f) = slot.failure.lock().unwrap().as_ref() {
            if f.spec == resolved && f.at.elapsed() < RETRY_BACKOFF {
                return Err(f.error.clone());
            }
        }
    }

    let opened = async {
        let (peer, info) = transport::open(&resolved.transport, CONNECT_TIMEOUT).await?;
        let tools = list_tools(&spec.name, &peer).await.map_err(|e| peer.explain(&e))?;
        Ok::<_, String>(Session { spec: resolved.clone(), peer: Arc::new(peer), info, tools })
    }
    .await;
    match opened {
        Ok(s) => {
            tracing::info!(server = %spec.name, tools = s.tools.len(), "mcp: connected {} {}", s.info.name, s.info.version);
            *slot.failure.lock().unwrap() = None;
            *session = Some(s);
            Ok(())
        }
        Err(error) => {
            tracing::warn!(server = %spec.name, "mcp: connect failed: {error}");
            *slot.failure.lock().unwrap() = Some(Failure { at: Instant::now(), spec: resolved, error: error.clone() });
            Err(error)
        }
    }
}

async fn list_tools(server: &str, peer: &Peer) -> Result<Vec<Arc<McpTool>>, RpcError> {
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_LIST_PAGES {
        let params = cursor.as_ref().map_or_else(|| json!({}), |c| json!({ "cursor": c }));
        let page = peer.request("tools/list", params, LIST_TIMEOUT, None).await?;
        let entries = page.get("tools").and_then(Value::as_array).into_iter().flatten();
        tools.extend(entries.filter_map(|t| McpTool::from_listing(server, t)).map(Arc::new));
        cursor = page.get("nextCursor").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    Ok(tools)
}

/// Drop sessions for servers that were removed or disabled.
fn prune(keep: &[ServerSpec]) {
    slots().lock().unwrap().retain(|name, _| keep.iter().any(|s| &s.name == name));
}

/// What MCP contributes to one agent turn.
#[derive(Default)]
pub struct Toolset {
    pub tools: Vec<Arc<McpTool>>,
    /// `(server, instructions)` from each server's `initialize` reply.
    pub instructions: Vec<(String, String)>,
}

/// Connect every enabled server (concurrently) and collect their tools.
/// Servers that fail are skipped; their error shows in [`status`].
pub async fn toolset() -> Toolset {
    let specs: Vec<ServerSpec> = config::load().into_iter().filter(|s| s.enabled).collect();
    prune(&specs);
    futures_util::future::join_all(specs.iter().map(|s| ensure(s, false))).await;

    let mut set = Toolset::default();
    for spec in &specs {
        let slot = slot(&spec.name);
        let session = slot.session.lock().await;
        if let Some(s) = session.as_ref() {
            set.tools.extend(s.tools.iter().cloned());
            if let Some(text) = &s.info.instructions {
                set.instructions.push((spec.name.clone(), text.clone()));
            }
        }
    }
    set
}

/// Start configured servers in the background so the first turn is fast.
pub fn warm_up() {
    tokio::spawn(async {
        toolset().await;
    });
}

/// Run `tools/call` on `server`. Reconnects once if the session was lost
/// before the call went out; a read-only tool is also retried once if the
/// connection dropped mid-call (a write is not, since it may have run).
pub async fn call_tool(server: &str, tool: &str, args: Value, signal: Option<&AbortSignal>) -> Result<Value, String> {
    let params = json!({ "name": tool, "arguments": args });
    for attempt in 0..2 {
        let (peer, timeout, read_only) = {
            let slot = slot(server);
            let mut session = slot.session.lock().await;
            if !session.as_ref().is_some_and(|s| s.peer.is_alive()) {
                drop(session);
                let spec = config::load()
                    .into_iter()
                    .find(|s| s.name == server && s.enabled)
                    .ok_or_else(|| format!("the `{server}` connector is not configured or is turned off"))?;
                ensure(&spec, true).await?;
                session = slot.session.lock().await;
            }
            let s = session.as_ref().ok_or_else(|| format!("could not connect to `{server}`"))?;
            let timeout = s.spec.timeout_ms.map(Duration::from_millis).unwrap_or(DEFAULT_CALL_TIMEOUT);
            let read_only = s.tools.iter().any(|t| t.remote_name == tool && t.read_only);
            (s.peer.clone(), timeout, read_only)
        };
        match peer.request("tools/call", params.clone(), timeout, signal).await {
            Ok(result) => return Ok(result),
            Err(e) if e.is_connection_lost() && attempt == 0 && read_only => {
                tracing::warn!(server, tool, "mcp: connection lost mid-call, reconnecting: {e}");
                continue;
            }
            Err(e @ RpcError::Remote { .. }) => return Err(format!("{server} rejected the call: {e}")),
            Err(e) if e.is_connection_lost() => {
                return Err(format!(
                    "lost the connection to `{server}` during the call ({}). It may or may not have completed — check before retrying.",
                    peer.explain(&e)
                ))
            }
            Err(e) => return Err(format!("{server}: {e}")),
        }
    }
    Err(format!("could not reach `{server}`"))
}

// ── Status & management (HTTP API) ──────────────────────────────────────────

#[derive(Serialize)]
pub struct ToolSummary {
    pub name: String,
    pub description: String,
    pub read_only: bool,
}

#[derive(Serialize)]
pub struct ServerStatus {
    pub name: String,
    pub transport: &'static str,
    pub target: String,
    pub enabled: bool,
    /// `connected` | `connecting` | `error` | `idle` | `disabled`
    pub state: &'static str,
    pub error: Option<String>,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub tools: Vec<ToolSummary>,
    /// The spec as stored (placeholders unexpanded), for editing.
    pub config: Value,
}

/// Per-server state without connecting anything.
pub async fn status() -> Vec<ServerStatus> {
    let mut out = Vec::new();
    for spec in config::load() {
        let slot = slot(&spec.name);
        let mut st = ServerStatus {
            name: spec.name.clone(),
            transport: spec.transport.kind(),
            target: spec.transport.summary(),
            enabled: spec.enabled,
            state: if spec.enabled { "idle" } else { "disabled" },
            error: None,
            server_name: None,
            server_version: None,
            tools: Vec::new(),
            config: config::to_entry(&spec),
        };
        match slot.session.try_lock() {
            Err(_) => st.state = "connecting",
            Ok(session) => match session.as_ref().filter(|s| s.peer.is_alive()) {
                Some(s) => {
                    st.state = "connected";
                    st.server_name = Some(s.info.name.clone()).filter(|n| !n.is_empty());
                    st.server_version = Some(s.info.version.clone()).filter(|n| !n.is_empty());
                    st.tools = s
                        .tools
                        .iter()
                        .map(|t| ToolSummary {
                            name: t.remote_name.clone(),
                            description: crate::harness::agent_types::AgentTool::description(t.as_ref()).to_string(),
                            read_only: t.read_only,
                        })
                        .collect();
                }
                None if spec.enabled => {
                    if let Some(f) = slot.failure.lock().unwrap().as_ref() {
                        st.state = "error";
                        st.error = Some(f.error.clone());
                    }
                }
                None => {}
            },
        }
        out.push(st);
    }
    out
}

/// Connect one server now, ignoring backoff (the UI's "Retry"/"Connect").
pub async fn connect(name: &str) -> Result<(), String> {
    let spec = config::load().into_iter().find(|s| s.name == name).ok_or_else(|| format!("no connector named `{name}`"))?;
    ensure(&spec, true).await
}

fn forget(name: &str) {
    slots().lock().unwrap().remove(name);
}

pub fn validate_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err("connector names use letters, digits, `-` and `_` (max 40)".into())
    }
}

/// Add or replace a server (by name) and reconnect it on next use.
pub fn upsert(spec: ServerSpec) -> Result<(), String> {
    validate_name(&spec.name)?;
    let mut all = config::load();
    match all.iter_mut().find(|s| s.name == spec.name) {
        Some(existing) => *existing = spec.clone(),
        None => all.push(spec.clone()),
    }
    config::save(&all).map_err(|e| format!("could not save {}: {e}", config::config_path().display()))?;
    forget(&spec.name);
    Ok(())
}

pub fn remove(name: &str) -> Result<bool, String> {
    let mut all = config::load();
    let before = all.len();
    all.retain(|s| s.name != name);
    if all.len() == before {
        return Ok(false);
    }
    config::save(&all).map_err(|e| e.to_string())?;
    forget(name);
    Ok(true)
}

pub fn set_enabled(name: &str, enabled: bool) -> Result<bool, String> {
    let mut all = config::load();
    let Some(spec) = all.iter_mut().find(|s| s.name == name) else { return Ok(false) };
    spec.enabled = enabled;
    config::save(&all).map_err(|e| e.to_string())?;
    forget(name);
    Ok(true)
}

/// Servers configured in other apps (Claude, Cursor, VS Code, …), marking
/// the ones zWork already has.
pub fn discover() -> Value {
    let existing: Vec<String> = config::load().into_iter().map(|s| s.name).collect();
    let sources: Vec<Value> = config::discover()
        .into_iter()
        .map(|(src, specs)| {
            json!({
                "id": src.id,
                "label": src.label,
                "servers": specs.iter().map(|s| json!({
                    "name": s.name,
                    "transport": s.transport.kind(),
                    "target": s.transport.summary(),
                    "already_added": existing.contains(&s.name),
                    "config": config::to_entry(s),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({ "sources": sources })
}

/// Parse pasted JSON (any dialect, or a bare `{name: entry}` map) into specs.
pub fn parse_pasted(doc: &Value) -> Vec<ServerSpec> {
    let specs = config::parse_document(doc);
    if !specs.is_empty() {
        return specs;
    }
    doc.as_object()
        .map(|m| m.iter().filter_map(|(name, entry)| config::parse_entry(name, entry)).collect())
        .unwrap_or_default()
}
