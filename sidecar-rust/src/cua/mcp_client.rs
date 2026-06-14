// MCP over stdio client for cua-driver.
// Speaks JSON-RPC 2.0 newline-delimited JSON to the `cua-driver mcp` subprocess.
use serde_json::{json, Value};
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
    /// Resolve cua-driver binary.
    /// Priority:
    /// 1. Bundled as Tauri resource (Contents/Resources/binaries/cua-driver)
    /// 2. Next to our own executable (dev layout)
    /// 3. ~/.local/bin/cua-driver (user install)
    /// 4. $PATH (fallback)
    fn find_cua_binary() -> String {
        // Check for cua-driver in Tauri app bundle resources
        if let Ok(exe) = std::env::current_exe() {
            // exe is at .../Contents/MacOS/zwork-backend (bundled)
            // resources are at .../Contents/Resources/binaries/
            if let Some(macos_dir) = exe.parent() {
                // Bundled: ../Resources/binaries/cua-driver
                let resources_bin = macos_dir
                    .parent()  // MacOS -> Contents
                    .map(|p| p.join("Resources").join("binaries").join("cua-driver"));
                if let Some(ref path) = resources_bin {
                    if path.exists() {
                        return path.to_string_lossy().to_string();
                    }
                }
                // Dev: next to our executable (both in sidecar-rust/target/ or binaries/)
                let next_to_exe = macos_dir.join("cua-driver");
                if next_to_exe.exists() {
                    return next_to_exe.to_string_lossy().to_string();
                }
            }
        }
        // Check ~/.local/bin
        if let Some(home) = dirs::home_dir() {
            let local = home.join(".local").join("bin").join("cua-driver");
            if local.exists() {
                return local.to_string_lossy().to_string();
            }
        }
        // Fallback to PATH
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

        // Initialize MCP session
        let _ = client.initialize().await?;
        Ok(client)
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

    /// Send a JSON-RPC request and return the `result` field.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut id_lock = self.next_id.lock().await;
        let id = *id_lock;
        *id_lock += 1;
        drop(id_lock);

        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        self.send_and_receive(&request).await
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

        // Read stdout line by line until we find our response.
        loop {
            let mut line = String::new();
            let read = {
                let mut stdout = self.stdout.lock().await;
                stdout.read_line(&mut line).await
                    .map_err(|e| format!("Read error: {}", e))?
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
