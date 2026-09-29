//! MCP transports behind one JSON-RPC [`Peer`].
//!
//! * **stdio** — a persistent child process (own process group, killed with
//!   the peer) speaking newline-delimited JSON-RPC.
//! * **Streamable HTTP** — every message is a POST; replies come back as a
//!   JSON body or an SSE stream. Session and protocol-version headers are
//!   threaded through automatically.
//! * **legacy SSE** — a long-lived GET stream that first announces a POST
//!   `endpoint`, then carries every reply.
//!
//! All three feed the same dispatcher, which matches responses to pending
//! requests by id, answers the few server→client requests a tool-only client
//! needs (`ping`, `roots/list`), and records `tools/list_changed`.

use super::config::TransportSpec;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::harness::types::AbortSignal;

/// Newest revision we speak; servers may negotiate down.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
const STDERR_TAIL_LINES: usize = 40;

#[derive(Debug, Clone)]
pub enum RpcError {
    /// The server answered with a JSON-RPC error.
    Remote { code: i64, message: String },
    /// Non-success HTTP status from a remote server.
    Http(u16, String),
    /// The connection is gone (process exited, stream closed, network error).
    Transport(String),
    Timeout,
    Cancelled,
}

impl RpcError {
    /// Worth one reconnect-and-retry: the peer died or its session expired.
    pub fn is_connection_lost(&self) -> bool {
        matches!(self, RpcError::Transport(_) | RpcError::Http(404, _))
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::Remote { code, message } => write!(f, "{message} (code {code})"),
            RpcError::Http(401, _) | RpcError::Http(403, _) => {
                write!(f, "the server rejected our credentials — check the Authorization header or API key for this connector")
            }
            RpcError::Http(status, body) if body.is_empty() => write!(f, "HTTP {status}"),
            RpcError::Http(status, body) => write!(f, "HTTP {status}: {body}"),
            RpcError::Transport(reason) => f.write_str(reason),
            RpcError::Timeout => f.write_str("timed out waiting for the server"),
            RpcError::Cancelled => f.write_str("cancelled"),
        }
    }
}

type Reply = oneshot::Sender<Result<Value, RpcError>>;

/// State shared between a peer and its I/O tasks.
struct Shared {
    pending: Mutex<HashMap<u64, Reply>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    tools_changed: AtomicBool,
    /// Replies to server→client requests, routed through the writer.
    outbound: mpsc::UnboundedSender<Value>,
    stderr: Mutex<VecDeque<String>>,
    protocol_version: Mutex<Option<String>>,
    session_id: Mutex<Option<String>>,
}

impl Shared {
    fn new(outbound: mpsc::UnboundedSender<Value>) -> Arc<Self> {
        Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            tools_changed: AtomicBool::new(false),
            outbound,
            stderr: Mutex::new(VecDeque::new()),
            protocol_version: Mutex::new(None),
            session_id: Mutex::new(None),
        })
    }

    fn dispatch(&self, msg: Value) {
        if let Value::Array(batch) = msg {
            return batch.into_iter().for_each(|m| self.dispatch(m));
        }
        let method = msg.get("method").and_then(Value::as_str);
        match (method, msg.get("id")) {
            (Some(method), Some(id)) => {
                let _ = self.outbound.send(answer_server_request(method, id.clone()));
            }
            (Some("notifications/tools/list_changed"), None) => self.tools_changed.store(true, Ordering::SeqCst),
            (Some(_), None) => {}
            (None, Some(id)) => {
                let Some(id) = id.as_u64().or_else(|| id.as_str().and_then(|s| s.parse().ok())) else { return };
                let Some(reply) = self.pending.lock().unwrap().remove(&id) else { return };
                let outcome = match msg.get("error") {
                    Some(err) => Err(RpcError::Remote {
                        code: err.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                        message: err.get("message").and_then(Value::as_str).unwrap_or("unknown error").to_string(),
                    }),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = reply.send(outcome);
            }
            (None, None) => {}
        }
    }

    fn fail(&self, id: u64, err: RpcError) {
        if let Some(reply) = self.pending.lock().unwrap().remove(&id) {
            let _ = reply.send(Err(err));
        }
    }

    /// The connection is gone: fail everything in flight.
    fn close(&self, reason: &str) {
        self.alive.store(false, Ordering::SeqCst);
        let reason = self.with_stderr(reason);
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(RpcError::Transport(reason.clone())));
        }
    }

    fn note_stderr(&self, line: String) {
        let mut tail = self.stderr.lock().unwrap();
        if tail.len() == STDERR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }

    fn with_stderr(&self, reason: &str) -> String {
        let tail = self.stderr.lock().unwrap();
        if tail.is_empty() {
            return reason.to_string();
        }
        let lines: Vec<&str> = tail.iter().rev().take(8).map(String::as_str).collect::<Vec<_>>().into_iter().rev().collect();
        format!("{reason}\nserver output:\n{}", lines.join("\n"))
    }
}

/// A tool-only client has nothing to sample or elicit; answer what the spec
/// requires and decline the rest.
fn answer_server_request(method: &str, id: Value) -> Value {
    match method {
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "roots/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "roots": [] } }),
        _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("zWork does not support {method}") } }),
    }
}

/// Owns whatever keeps a connection alive; dropping it tears everything down.
enum Resource {
    Process { _guard: ProcessGuard },
    HttpSession { client: reqwest::Client, url: String, headers: BTreeMap<String, String> },
    None,
}

pub struct Peer {
    shared: Arc<Shared>,
    tasks: Vec<JoinHandle<()>>,
    resource: Resource,
}

impl Peer {
    pub fn is_alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    /// True once after the server announced its tool list changed.
    pub fn take_tools_changed(&self) -> bool {
        self.shared.tools_changed.swap(false, Ordering::SeqCst)
    }

    /// Append the server's recent stderr to an error, for diagnosis.
    pub fn explain(&self, err: &RpcError) -> String {
        self.shared.with_stderr(&err.to_string())
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        signal: Option<&AbortSignal>,
    ) -> Result<Value, RpcError> {
        if !self.is_alive() {
            return Err(RpcError::Transport("connection closed".into()));
        }
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.shared.pending.lock().unwrap().insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self.shared.outbound.send(msg).is_err() {
            self.shared.fail(id, RpcError::Transport("connection closed".into()));
        }
        let aborted = async {
            match signal {
                Some(s) => s.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let outcome = tokio::select! {
            r = rx => return r.unwrap_or_else(|_| Err(RpcError::Transport("connection closed".into()))),
            _ = tokio::time::sleep(timeout) => RpcError::Timeout,
            _ = aborted => RpcError::Cancelled,
        };
        self.shared.pending.lock().unwrap().remove(&id);
        self.notify("notifications/cancelled", json!({ "requestId": id, "reason": outcome.to_string() }));
        Err(outcome)
    }

    pub fn notify(&self, method: &str, params: Value) {
        let mut msg = json!({ "jsonrpc": "2.0", "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        let _ = self.shared.outbound.send(msg);
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.shared.close("connection closed");
        self.tasks.iter().for_each(JoinHandle::abort);
        // Streamable HTTP: tell the server the session is over.
        if let Resource::HttpSession { client, url, headers } = &self.resource {
            let session = self.shared.session_id.lock().unwrap().clone();
            if let (Some(session), Ok(rt)) = (session, tokio::runtime::Handle::try_current()) {
                let req = with_headers(client.delete(url), headers).header("mcp-session-id", session);
                rt.spawn(async move {
                    let _ = req.send().await;
                });
            }
        }
    }
}

/// What the server told us about itself during `initialize`.
#[derive(Debug, Clone, Default)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: String,
    pub instructions: Option<String>,
}

/// Connect and complete the MCP handshake.
pub async fn open(spec: &TransportSpec, timeout: Duration) -> Result<(Peer, ServerInfo), String> {
    match spec {
        TransportSpec::Stdio { command, args, env, cwd } => {
            let peer = spawn_stdio(command, args, env, cwd.as_deref())?;
            handshake(peer, timeout).await
        }
        TransportSpec::Http { url, headers, fallback_sse } => {
            let peer = streamable_http(url, headers)?;
            match initialize(&peer, timeout).await {
                Ok(info) => Ok((peer, info)),
                // A legacy SSE server rejects the POST handshake (404/405/…).
                Err(RpcError::Http(status, _)) if *fallback_sse && (400..500).contains(&status) && status != 401 && status != 403 => {
                    drop(peer);
                    handshake(legacy_sse(url, headers, timeout).await?, timeout).await
                }
                Err(e) => Err(peer.explain(&e)),
            }
        }
        TransportSpec::Sse { url, headers } => handshake(legacy_sse(url, headers, timeout).await?, timeout).await,
    }
}

async fn handshake(peer: Peer, timeout: Duration) -> Result<(Peer, ServerInfo), String> {
    match initialize(&peer, timeout).await {
        Ok(info) => Ok((peer, info)),
        Err(e) => Err(peer.explain(&e)),
    }
}

async fn initialize(peer: &Peer, timeout: Duration) -> Result<ServerInfo, RpcError> {
    let params = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "zWork", "version": env!("CARGO_PKG_VERSION") },
    });
    let result = peer.request("initialize", params, timeout, None).await?;
    let str_at = |ptr: &str| result.pointer(ptr).and_then(Value::as_str).unwrap_or_default().to_string();
    let info = ServerInfo {
        name: str_at("/serverInfo/name"),
        version: str_at("/serverInfo/version"),
        protocol_version: str_at("/protocolVersion"),
        instructions: result.get("instructions").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string),
    };
    *peer.shared.protocol_version.lock().unwrap() = Some(info.protocol_version.clone()).filter(|v| !v.is_empty());
    peer.notify("notifications/initialized", Value::Null);
    Ok(info)
}

// ── stdio ───────────────────────────────────────────────────────────────────

struct ProcessGuard {
    _child: tokio::process::Child,
    #[cfg(unix)]
    pgid: Option<i32>,
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        // `npx`/`uvx` launchers fork the real server; take the whole group
        // down, not just the launcher (`kill_on_drop` covers the child).
        #[cfg(unix)]
        if let Some(pgid) = self.pgid {
            let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pgid), nix::sys::signal::Signal::SIGTERM);
        }
    }
}

fn spawn_stdio(command: &str, args: &[String], env: &BTreeMap<String, String>, cwd: Option<&str>) -> Result<Peer, String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut cmd = if cfg!(windows) {
        // `npx` & co. are `.cmd` shims on Windows; only the shell resolves them.
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(command).args(args);
        c
    } else {
        let mut c = tokio::process::Command::new(command);
        c.args(args);
        c
    };
    cmd.envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| spawn_error(command, &e))?;
    let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(mut stdin), Some(stdout), Some(stderr)) = (stdin, stdout, stderr) else {
        return Err(format!("could not attach to `{command}`'s stdio"));
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let shared = Shared::new(tx);

    let writer = {
        let shared = shared.clone();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let mut line = msg.to_string();
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    shared.close("the server stopped accepting input");
                    break;
                }
            }
        })
    };
    let reader = {
        let shared = shared.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(msg) => shared.dispatch(msg),
                    // Servers that log to stdout: keep it for diagnostics.
                    Err(_) => shared.note_stderr(line.to_string()),
                }
            }
            shared.close("the server process exited");
        })
    };
    let stderr_tail = {
        let shared = shared.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                shared.note_stderr(line);
            }
        })
    };

    #[cfg(unix)]
    let pgid = child.id().map(|id| id as i32);
    Ok(Peer {
        shared,
        tasks: vec![writer, reader, stderr_tail],
        resource: Resource::Process {
            _guard: ProcessGuard {
                _child: child,
                #[cfg(unix)]
                pgid,
            },
        },
    })
}

/// "Not found" is the common failure for non-developers: say what to install.
fn spawn_error(command: &str, err: &std::io::Error) -> String {
    if err.kind() != std::io::ErrorKind::NotFound {
        return format!("could not start `{command}`: {err}");
    }
    let bin = std::path::Path::new(command).file_name().and_then(|n| n.to_str()).unwrap_or(command);
    let hint = match bin {
        "npx" | "node" | "npm" | "pnpm" => " — install Node.js from https://nodejs.org",
        "uvx" | "uv" => " — install uv from https://docs.astral.sh/uv/",
        "python" | "python3" | "pip" => " — install Python from https://python.org",
        "docker" => " — install Docker Desktop from https://docker.com",
        "bunx" | "bun" => " — install Bun from https://bun.sh",
        "deno" => " — install Deno from https://deno.com",
        _ => "",
    };
    format!("`{command}` was not found on this computer{hint}")
}

// ── Streamable HTTP ─────────────────────────────────────────────────────────

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("could not create HTTP client: {e}"))
}

fn with_headers(mut req: reqwest::RequestBuilder, headers: &BTreeMap<String, String>) -> reqwest::RequestBuilder {
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req
}

fn streamable_http(url: &str, headers: &BTreeMap<String, String>) -> Result<Peer, String> {
    reqwest::Url::parse(url).map_err(|e| format!("invalid server URL `{url}`: {e}"))?;
    let client = http_client()?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let shared = Shared::new(tx);

    let writer = {
        let (shared, client, url, headers) = (shared.clone(), client.clone(), url.to_string(), headers.clone());
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                // Each message is its own POST so parallel tool calls overlap.
                let (shared, client, url, headers) = (shared.clone(), client.clone(), url.clone(), headers.clone());
                tokio::spawn(async move { post_streamable(&shared, &client, &url, &headers, msg).await });
            }
        })
    };
    Ok(Peer {
        shared,
        tasks: vec![writer],
        resource: Resource::HttpSession { client, url: url.to_string(), headers: headers.clone() },
    })
}

async fn post_streamable(shared: &Shared, client: &reqwest::Client, url: &str, headers: &BTreeMap<String, String>, msg: Value) {
    let id = msg.get("id").and_then(Value::as_u64).filter(|_| msg.get("method").is_some());
    let fail = |err: RpcError| {
        if let Some(id) = id {
            shared.fail(id, err);
        }
    };
    let mut req = with_headers(client.post(url), headers)
        .header("accept", "application/json, text/event-stream")
        .json(&msg);
    if let Some(session) = shared.session_id.lock().unwrap().clone() {
        req = req.header("mcp-session-id", session);
    }
    if let Some(version) = shared.protocol_version.lock().unwrap().clone() {
        req = req.header("mcp-protocol-version", version);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return fail(RpcError::Transport(format!("could not reach {url}: {e}"))),
    };
    let status = resp.status();
    if let Some(session) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        *shared.session_id.lock().unwrap() = Some(session.to_string());
    }
    if status.as_u16() == 404 && shared.session_id.lock().unwrap().is_some() {
        return shared.close("the server ended the session");
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return fail(RpcError::Http(status.as_u16(), body.chars().take(300).collect()));
    }
    if status.as_u16() == 202 || status.as_u16() == 204 {
        return;
    }
    let is_sse = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("text/event-stream"));
    if is_sse {
        let mut parser = SseParser::default();
        let mut stream = resp.bytes_stream();
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else { break };
            for event in parser.push(&chunk) {
                if let Ok(msg) = serde_json::from_str::<Value>(&event.data) {
                    shared.dispatch(msg);
                }
            }
        }
        // Stream closed; anything still waiting on this POST never got an answer.
        fail(RpcError::Transport("the server closed the response stream early".into()));
    } else {
        match resp.json::<Value>().await {
            Ok(msg) => shared.dispatch(msg),
            Err(e) => fail(RpcError::Transport(format!("unreadable response from {url}: {e}"))),
        }
    }
}

// ── legacy SSE ──────────────────────────────────────────────────────────────

async fn legacy_sse(url: &str, headers: &BTreeMap<String, String>, timeout: Duration) -> Result<Peer, String> {
    use futures_util::StreamExt;
    let base = reqwest::Url::parse(url).map_err(|e| format!("invalid server URL `{url}`: {e}"))?;
    let client = http_client()?;
    let resp = with_headers(client.get(url), headers)
        .header("accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(RpcError::Http(status, resp.text().await.unwrap_or_default().chars().take(300).collect()).to_string());
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let shared = Shared::new(tx);
    let (endpoint_tx, endpoint_rx) = oneshot::channel::<String>();

    let reader = {
        let shared = shared.clone();
        tokio::spawn(async move {
            let mut endpoint_tx = Some(endpoint_tx);
            let mut parser = SseParser::default();
            let mut stream = resp.bytes_stream();
            while let Some(Ok(chunk)) = stream.next().await {
                for event in parser.push(&chunk) {
                    match event.name.as_deref() {
                        Some("endpoint") => {
                            if let Some(tx) = endpoint_tx.take() {
                                let _ = tx.send(event.data);
                            }
                        }
                        None | Some("message") => {
                            if let Ok(msg) = serde_json::from_str::<Value>(&event.data) {
                                shared.dispatch(msg);
                            }
                        }
                        Some(_) => {}
                    }
                }
            }
            shared.close("the server closed the event stream");
        })
    };

    let endpoint = match tokio::time::timeout(timeout, endpoint_rx).await {
        Ok(Ok(path)) => base.join(path.trim()).map_err(|e| format!("server sent an invalid endpoint: {e}"))?,
        _ => {
            reader.abort();
            return Err(format!("{url} did not announce an MCP endpoint (is this an MCP SSE server?)"));
        }
    };

    let writer = {
        let (shared, client, headers) = (shared.clone(), client.clone(), headers.clone());
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let id = msg.get("id").and_then(Value::as_u64).filter(|_| msg.get("method").is_some());
                let sent = with_headers(client.post(endpoint.clone()), &headers).json(&msg).send().await;
                let err = match sent {
                    Ok(r) if r.status().is_success() => continue,
                    Ok(r) => RpcError::Http(r.status().as_u16(), String::new()),
                    Err(e) => RpcError::Transport(format!("could not reach the server: {e}")),
                };
                if let Some(id) = id {
                    shared.fail(id, err);
                }
            }
        })
    };
    Ok(Peer { shared, tasks: vec![reader, writer], resource: Resource::None })
}

// ── SSE parsing ─────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
struct SseEvent {
    name: Option<String>,
    data: String,
}

/// Incremental `text/event-stream` parser that keeps event names (the
/// harness's provider decoder only needs `data:` and drops them).
#[derive(Default)]
struct SseParser {
    buf: Vec<u8>,
    name: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(SseEvent { name: self.name.take(), data: self.data.join("\n") });
                    self.data.clear();
                }
                self.name = None;
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => self.name = Some(value.to_string()),
                "data" => self.data.push(value.to_string()),
                _ => {}
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_handles_split_chunks_and_names() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: endpoint\r\ndata: /messages?sess").is_empty());
        let events = p.push(b"ion=1\r\n\r\ndata: {\"a\":1}\n\n: comment\n\n");
        assert_eq!(
            events,
            vec![
                SseEvent { name: Some("endpoint".into()), data: "/messages?session=1".into() },
                SseEvent { name: None, data: "{\"a\":1}".into() },
            ]
        );
    }

    #[tokio::test]
    async fn dispatch_resolves_pending_and_answers_pings() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let shared = Shared::new(tx);
        let (reply_tx, reply_rx) = oneshot::channel();
        shared.pending.lock().unwrap().insert(7, reply_tx);
        shared.dispatch(json!([
            { "jsonrpc": "2.0", "id": 7, "result": { "ok": true } },
            { "jsonrpc": "2.0", "id": "srv-1", "method": "ping" },
            { "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }
        ]));
        assert_eq!(reply_rx.await.unwrap().unwrap(), json!({ "ok": true }));
        assert_eq!(rx.recv().await.unwrap(), json!({ "jsonrpc": "2.0", "id": "srv-1", "result": {} }));
        assert!(shared.tools_changed.load(Ordering::SeqCst));
    }

    /// End-to-end over a real child process: a tiny shell MCP server.
    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_handshake_and_call() {
        let script = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"sh","version":"1"},"instructions":"be nice"}}\n' "$id" ;;
    *'"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
  esac
done"#;
        let spec = TransportSpec::Stdio { command: "sh".into(), args: vec!["-c".into(), script.into()], env: BTreeMap::new(), cwd: None };
        let (peer, info) = open(&spec, Duration::from_secs(5)).await.unwrap();
        assert_eq!((info.name.as_str(), info.instructions.as_deref()), ("sh", Some("be nice")));
        let tools = peer.request("tools/list", json!({}), Duration::from_secs(5), None).await.unwrap();
        assert_eq!(tools["tools"][0]["name"], "echo");
    }

    #[tokio::test]
    async fn missing_command_explains_what_to_install() {
        let spec = TransportSpec::Stdio { command: "/nonexistent/npx".into(), args: vec![], env: BTreeMap::new(), cwd: None };
        let err = open(&spec, Duration::from_secs(1)).await.err().unwrap();
        assert!(err.contains("nodejs.org"), "{err}");
    }
}
