//! Model Context Protocol (MCP) runtime.
//!
//! Reads configured stdio MCP servers from `~/.zwork/mcp.json` (Claude-Desktop
//! shape: `{"mcpServers": {name: {command, args, env}}}}`), speaks JSON-RPC
//! 2.0 over the child's stdio to list their tools, and exposes them to the
//! agent as `mcp__<server>__<tool>` tools.
//!
//! Each operation spawns the server fresh (initialize → list/call → drop).
//! This is simpler and more robust than managing long-lived sessions: a
//! crashing or hanging server can never wedge the registry, and there's no
//! reconnection logic to get right.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

pub const TOOL_PREFIX: &str = "mcp__";

/// One configured MCP server.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct McpServerSpec {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Path to the MCP config file (`~/.zwork/mcp.json`).
fn config_path() -> std::path::PathBuf {
    crate::paths::home_dir().join("mcp.json")
}

/// Load all enabled server specs from the config file. Returns `[]` if the
/// file is missing or malformed.
pub fn load_config() -> Vec<McpServerSpec> {
    let raw = match std::fs::read_to_string(config_path()) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let servers = parsed.get("mcpServers").and_then(|s| s.as_object());
    let servers = match servers {
        Some(s) => s,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for (name, entry) in servers {
        let command = entry.get("command").and_then(|c| c.as_str()).unwrap_or("");
        if command.is_empty() {
            continue;
        }
        let args: Vec<String> = entry.get("args")
            .and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let env: HashMap<String, String> = entry.get("env")
            .and_then(|e| e.as_object())
            .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default();
        let enabled = entry.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true);
        out.push(McpServerSpec {
            name: name.clone(),
            command: command.to_string(),
            args,
            env,
            enabled,
        });
    }
    out
}

/// A live connection to one MCP server, owning the child process.
struct Connection {
    child: Child,
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    stdout: tokio::sync::Mutex<BufReader<tokio::process::ChildStdout>>,
}

impl Connection {
    /// Spawn a server and perform the MCP initialize handshake. Returns `Err`
    /// if the process won't start or the handshake times out (10s).
    async fn connect(spec: &McpServerSpec) -> Result<Self, String> {
        let mut cmd = Command::new(&spec.command);
        cmd.args(&spec.args);
        // Start with the current env, then layer the server's env on top.
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn '{}': {}", spec.command, e))?;
        // Drain stderr so it can't fill the OS pipe buffer and deadlock the server.
        if let Some(stderr) = child.stderr.take() {
            let server_name = spec.name.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut buf = String::new();
                use tokio::io::AsyncBufReadExt;
                loop {
                    buf.clear();
                    match reader.read_line(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            tracing::debug!("mcp[{}]: {}", server_name, buf.trim());
                        }
                    }
                }
            });
        }
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let conn = Connection {
            child,
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(BufReader::new(stdout)),
        };
        // Initialize handshake.
        let init = json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "zWork", "version": env!("CARGO_PKG_VERSION")}
            }
        });
        let _ = conn.send_and_receive(&init, 0).await?;
        // Notify initialized.
        conn.notify("notifications/initialized").await?;
        Ok(conn)
    }

    async fn notify(&self, method: &str) -> Result<(), String> {
        let notif = json!({ "jsonrpc": "2.0", "method": method });
        let line = serde_json::to_string(&notif).map_err(|e| e.to_string())?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Send a request and read the matching response (matched by id). Skips
    /// notifications and log messages until the response arrives. Times out
    /// after `secs` seconds.
    async fn send_and_receive(&self, request: &Value, secs: u64) -> Result<Value, String> {
        let id = request.get("id").cloned().unwrap_or(json!(0));
        let line = serde_json::to_string(request).map_err(|e| e.to_string())?;
        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
            stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
            stdin.flush().await.map_err(|e| e.to_string())?;
        }
        let mut stdout = self.stdout.lock().await;
        let mut buf = String::new();
        let result = timeout(Duration::from_secs(secs), async {
            loop {
                buf.clear();
                let n = stdout.read_line(&mut buf).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("MCP server closed stdout".to_string());
                }
                let trimmed = buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let msg: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue, // skip non-JSON lines
                };
                // Match the response by id; ignore notifications (no id).
                if msg.get("id") == Some(&id) {
                    if let Some(err) = msg.get("error") {
                        return Err(format!("MCP error: {}", err));
                    }
                    return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        })
        .await;
        match result {
            Ok(r) => r,
            Err(_) => Err("MCP request timed out".to_string()),
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // Best-effort kill on drop so we never leak a server process.
        let _ = self.child.start_kill();
    }
}

/// List the tools of a single server. Spawns, lists, drops.
async fn list_server_tools(spec: &McpServerSpec) -> (Vec<Value>, Option<String>) {
    let conn = match Connection::connect(spec).await {
        Ok(c) => c,
        Err(e) => return (Vec::new(), Some(e)),
    };
    let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
    let result = match conn.send_and_receive(&req, 10).await {
        Ok(r) => r,
        Err(e) => return (Vec::new(), Some(e)),
    };
    let tools = result.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    (tools, None)
}

/// Build the `mcp__<server>__<tool>` schemas the agent advertises.
pub fn all_tool_schemas() -> Vec<Value> {
    let mut schemas = Vec::new();
    for spec in load_config() {
        if !spec.enabled {
            continue;
        }
        // Use a blocking runtime spawn since list is async but callers are sync.
        let server_name = spec.name.clone();
        let (tools, _err) = block_on_sync(list_server_tools_inner(spec.clone()));
        for t in tools {
            let tool_name = t.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if tool_name.is_empty() {
                continue;
            }
            let prefixed = format!("{}{}__{}", TOOL_PREFIX, server_name, tool_name);
            schemas.push(json!({
                "name": prefixed,
                "description": t.get("description").cloned().unwrap_or_else(|| json!("MCP tool")),
                "parameters": t.get("inputSchema").cloned().unwrap_or_else(|| json!({"type":"object","properties":{}})),
            }));
        }
    }
    schemas
}

async fn list_server_tools_inner(spec: McpServerSpec) -> (Vec<Value>, Option<String>) {
    list_server_tools(&spec).await
}

/// The live status of each configured server, for the `/api/mcp/servers` UI.
pub fn server_status() -> Vec<Value> {
    let specs = load_config();
    let mut out = Vec::new();
    for spec in specs {
        let (tool_count, ready, error) = if spec.enabled {
            let (tools, err) = block_on_sync(list_server_tools_inner(spec.clone()));
            let ready = err.is_none();
            (tools.len(), ready, err)
        } else {
            (0, false, Some("disabled".to_string()))
        };
        out.push(json!({
            "name": spec.name,
            "command": spec.command,
            "args": spec.args,
            "connected": ready,
            "ready": ready,
            "tool_count": tool_count,
            "error": error.unwrap_or_default(),
        }));
    }
    out
}

/// Execute a `mcp__<server>__<tool>` call. Spawns the server, sends
/// `tools/call`, returns the result shaped like a tool result
/// (`{isError, content:[{type,text}]}`).
pub async fn call_tool(prefixed_name: &str, params: Value) -> Value {
    let parts = match split_tool_name(prefixed_name) {
        Some(p) => p,
        None => return json!({
            "isError": true,
            "content": [{"type":"text","text": format!("not an MCP tool: {}", prefixed_name)}]
        }),
    };
    let (server_name, tool_name) = parts;
    let spec = match load_config().into_iter().find(|s| s.name == server_name && s.enabled) {
        Some(s) => s,
        None => return json!({
            "isError": true,
            "content": [{"type":"text","text": format!("MCP server '{}' not configured", server_name)}]
        }),
    };
    match call_server_tool(spec, &tool_name, params).await {
        Ok(v) => v,
        Err(e) => json!({"isError": true, "content": [{"type":"text","text": format!("MCP {}: {}", server_name, e)}]}),
    }
}

async fn call_server_tool(spec: McpServerSpec, tool_name: &str, params: Value) -> Result<Value, String> {
    let conn = Connection::connect(&spec).await?;
    let req = json!({
        "jsonrpc":"2.0","id":1,"method":"tools/call",
        "params": {"name": tool_name, "arguments": params}
    });
    let result = conn.send_and_receive(&req, 120).await?;
    // The MCP tools/call result already has the {isError, content[]} shape —
    // return it as-is.
    Ok(result)
}

/// Split `mcp__<server>__<tool>` into `(server, tool)`. Returns `None` if the
/// name isn't a valid MCP tool name.
pub fn split_tool_name(prefixed: &str) -> Option<(String, String)> {
    let rest = prefixed.strip_prefix(TOOL_PREFIX)?;
    let sep = rest.find("__")?;
    if sep == 0 || sep >= rest.len() - 2 {
        return None;
    }
    Some((rest[..sep].to_string(), rest[sep + 2..].to_string()))
}

// ── Runtime plumbing ─────────────────────────────────────────────────────────
// `all_tool_schemas` / `server_status` are called from sync contexts (the
// schema builder, the route handlers). They need a Tokio runtime to `.await`
// the async server I/O. The route handlers already run on the server's async
// runtime, so we reach for its current handle. `call_tool` is async.

static HANDLE_FALLBACK: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();

/// A runtime handle we can block on. Prefers the currently-running Tokio
/// runtime; if there isn't one (shouldn't happen, but defend against it),
/// spins up a dedicated one.
fn runtime_handle() -> tokio::runtime::Handle {
    if let Ok(h) = tokio::runtime::Handle::try_current() {
        return h;
    }
    let rt = HANDLE_FALLBACK.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("mcp-runtime")
            .build()
            .expect("failed to build MCP runtime")
    });
    rt.handle().clone()
}

/// Block on an async future from a sync context, using `block_in_place` on the
/// current multi-thread runtime worker.
fn block_on_sync<T>(fut: impl std::future::Future<Output = T> + Send + 'static) -> T
where
    T: Send + 'static,
{
    let handle = runtime_handle();
    let join = handle.spawn(fut);
    tokio::task::block_in_place(|| handle.block_on(async { join.await.expect("MCP task panicked") }))
}


