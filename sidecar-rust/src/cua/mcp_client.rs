// MCP over stdio client for cua-driver.
// Speaks JSON-RPC 2.0 newline-delimited JSON to the `cua-driver mcp` subprocess.
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct McpClient {
    stdin: Arc<Mutex<ChildStdin>>,
    stdout: Arc<Mutex<BufReader<ChildStdout>>>,
    next_id: Arc<Mutex<u64>>,
    #[allow(dead_code)]
    child: Arc<Mutex<Child>>,
}

impl McpClient {
    /// Resolve the cua-driver binary.
    ///
    /// cua-driver is **not self-contained**: `cua-driver mcp` is a thin proxy
    /// that `open -a CuaDriver`-launches the CuaDriver.app **daemon**, which is
    /// the process that holds the Accessibility/Screen-Recording TCC grants.
    /// A copy of the bare Mach-O ripped out of its `.app` bundle is unusable —
    /// macOS kills it at exec (spctl: "signature modified") because the embedded
    /// signature only validates as part of the CuaDriver.app bundle. So the
    /// installed, notarized CuaDriver.app is the only working source.
    ///
    /// Priority:
    /// 1. `/Applications/CuaDriver.app` — canonical macOS install (notarized,
    ///    signed com.trycua.driver, holds TCC grants).
    /// 2. Next to our own executable (dev layout).
    /// 3. Bundled Tauri resource (degenerate fallback — usually signature-killed).
    /// 4. `cua-driver` on `$PATH` / `~/.local/bin` (user install).
    pub(crate) fn find_cua_binary() -> String {
        // 1. Canonical install — the driver's daemon + TCC grants live here.
        let canonical = std::path::PathBuf::from(
            "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
        );
        if canonical.exists() {
            return canonical.to_string_lossy().to_string();
        }

        // 2/3. Relative to our own executable (dev: next-to-exe; bundled: resource).
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let next_to_exe = dir.join("cua-driver");
                if next_to_exe.exists() {
                    return next_to_exe.to_string_lossy().to_string();
                }
                // Bundled: .../Contents/MacOS -> .../Contents/Resources/binaries/
                if let Some(contents) = dir.parent() {
                    let resource = contents
                        .join("Resources")
                        .join("binaries")
                        .join("cua-driver");
                    if resource.exists() {
                        return resource.to_string_lossy().to_string();
                    }
                }
            }
        }

        // 4. User install (e.g. ~/.local/bin/cua-driver → CuaDriver.app) on PATH.
        // NOTE: a dangling symlink (target uninstalled) returns `exists() ==
        // false`, which is correct — but we check `symlink_metadata` first so a
        // broken link is reported clearly instead of silently falling through
        // to the bare `cua-driver` name (which then fails spawn with a
        // misleading "No such file or directory").
        if let Some(home) = dirs::home_dir() {
            let local = home.join(".local").join("bin").join("cua-driver");
            match std::fs::symlink_metadata(&local) {
                Ok(_) if local.exists() => return local.to_string_lossy().to_string(),
                Ok(_) => {
                    // Symlink exists but its target does not — the user (or an
                    // uninstaller) removed CuaDriver.app but left the link.
                    // Surface this explicitly so the fix is obvious.
                    tracing::warn!(
                        "[cua-driver] {} is a broken symlink (its target is missing); \
                         install CuaDriver.app or remove the link",
                        local.display()
                    );
                }
                Err(_) => {}
            }
        }
        "cua-driver".to_string()
    }

    /// Start `cua-driver mcp` and initialize the MCP session.
    pub async fn connect() -> Result<Self, String> {
        // Resolve cua-driver binary — check bundled locations first, then PATH
        let bin = Self::find_cua_binary();

        let mut child = Command::new(&bin)
            .arg("mcp")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // Kill the driver when this handle drops (i.e. when the backend
            // exits), so we don't leak orphaned cua-driver processes.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start {}: {}", bin, e))?;

        let stdin = child.stdin.take().ok_or("No stdin handle")?;
        let stdout = child.stdout.take().ok_or("No stdout handle")?;
        let stderr = child.stderr.take().ok_or("No stderr handle")?;

        // Drain stderr in the background. If we don't read it, the driver's
        // stderr pipe buffer (≈64KB) can fill, blocking the driver on its next
        // stderr write — which stalls stdin processing and deadlocks the whole
        // MCP client. Forward lines to the tracing log for diagnostics.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // EOF — driver exited
                    Ok(_) => {
                        let trimmed = line.trim_end();
                        if !trimmed.is_empty() {
                            tracing::debug!("[cua-driver] {}", trimmed);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let client = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            stdout: Arc::new(Mutex::new(BufReader::new(stdout))),
            next_id: Arc::new(Mutex::new(1)),
            child: Arc::new(Mutex::new(child)),
        };

        // Initialize MCP session, then complete the MCP handshake. The driver
        // answers tool calls without this notification, but sending it is
        // spec-correct and avoids any version that gates on it.
        let _ = client.initialize().await?;
        let _ = client.notify("notifications/initialized").await;
        Ok(client)
    }

    /// Send a JSON-RPC notification (no id, no response expected).
    async fn notify(&self, method: &str) -> Result<(), String> {
        let notif = json!({ "jsonrpc": "2.0", "method": method });
        let line = serde_json::to_string(&notif)
            .map_err(|e| format!("Serialization error: {}", e))?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        stdin.flush().await.map_err(|e| format!("Flush error: {}", e))?;
        Ok(())
    }

    async fn initialize(&self) -> Result<Value, String> {
        let init = json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "zWork", "version": "0.5.0"}
            }
        });
        self.send_and_receive(&init).await
    }

    /// Invoke a driver tool. The driver speaks standard MCP, so tool invocations
    /// go through the `tools/call` method (`{name, arguments}`), not as bare
    /// top-level methods — bare method names return "Unknown method". The
    /// response is unwrapped: prefer `structuredContent` (machine-readable —
    /// where `check_permissions`'s booleans and `get_window_state`'s
    /// `tree_markdown` live), fall back to `content[].text` (JSON-parsed when
    /// possible), and turn an `isError` result into an `Err`.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut id_lock = self.next_id.lock().await;
        let id = *id_lock;
        *id_lock += 1;
        drop(id_lock);

        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": method,
                "arguments": params
            }
        });

        let result = self.send_and_receive(&request).await?;

        // Tool-level error → surface the message from content[].text.
        if result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
            let msg = result
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|c| c.first())
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("tool error");
            return Err(format!("cua-driver: {}", msg));
        }

        // Prefer structuredContent (machine-readable payload).
        if let Some(sc) = result.get("structuredContent") {
            return Ok(sc.clone());
        }
        // Fall back to content[].text, parsing as JSON if it looks structural.
        if let Some(text) = result
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
        {
            if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                return Ok(parsed);
            }
            return Ok(Value::String(text.to_string()));
        }
        Ok(result)
    }

    /// Write a JSON-RPC request to stdin and read the matching response from stdout.
    ///
    /// Lines are read in a loop because the server may emit JSON-RPC
    /// notifications (e.g. logging) on stdout that are not replies. We skip any
    /// line whose `id` does not match our request, and return on the first match.
    async fn send_and_receive(&self, request: &Value) -> Result<Value, String> {
        // Serialize request
        let req_str = serde_json::to_string(request)
            .map_err(|e| format!("Serialization error: {}", e))?;
        let expected_id = request.get("id").cloned();

        // Write to stdin (newline-delimited JSON)
        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(req_str.as_bytes()).await
                .map_err(|e| format!("Write error: {}", e))?;
            stdin.write_all(b"\n").await
                .map_err(|e| format!("Write error: {}", e))?;
            stdin.flush().await
                .map_err(|e| format!("Flush error: {}", e))?;
        }

        // Read stdout line by line until we find our response. Bounded by a
        // timeout: a driver binary that spawns but never answers (broken
        // install, missing macOS TCC grants blocking its event loop, or a hung
        // daemon) would otherwise block this turn forever.
        const READ_TIMEOUT: Duration = Duration::from_secs(30);
        loop {
            let mut line = String::new();
            let read = {
                let mut stdout = self.stdout.lock().await;
                match tokio::time::timeout(READ_TIMEOUT, stdout.read_line(&mut line)).await {
                    Ok(r) => r.map_err(|e| format!("Read error: {}", e))?,
                    Err(_) => {
                        return Err(
                            "cua-driver did not respond within 30s — it may be hung, \
                             missing macOS Accessibility/Screen Recording permissions, \
                             or an incompatible build."
                                .to_string(),
                        )
                    }
                }
            };

            // read_line returning 0 bytes means EOF: the driver closed stdout,
            // almost always because it crashed or was never granted the macOS
            // permissions (Accessibility / Screen Recording) it needs.
            if read == 0 {
                return Err(
                    "cua-driver process exited without responding. \
                     Verify cua-driver is installed and that Accessibility \
                     and Screen Recording permissions are granted."
                        .to_string(),
                );
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            // Skip non-JSON noise lines (banners, stray output) without failing.
            let response: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => {
                    tracing::debug!("[cua-driver] non-JSON stdout: {}", trimmed);
                    continue;
                }
            };

            // Only a message carrying our request id is our reply. Skip
            // notifications (no id) and replies to other in-flight requests.
            match response.get("id") {
                Some(id) if expected_id.as_ref() == Some(id) => {}
                _ => continue,
            }

            // Check for JSON-RPC error
            if let Some(err) = response.get("error") {
                let msg = err.get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("cua-driver error: {}", msg));
            }

            // Return the result
            return match response.get("result") {
                Some(r) => Ok(r.clone()),
                None => Err(format!("No result in response: {}", trimmed.chars().take(200).collect::<String>())),
            };
        }
    }
}
