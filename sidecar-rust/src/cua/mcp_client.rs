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
    /// 1. Next to our own executable (bundled as Tauri sidecar)
    /// 2. ~/.local/bin/cua-driver (user install)
    /// 3. $PATH (fallback)
    fn find_cua_binary() -> String {
        // Check for cua-driver next to our executable (bundled in Tauri binaries/)
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let bundled = dir.join("cua-driver");
                if bundled.exists() {
                    return bundled.to_string_lossy().to_string();
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
            .spawn()
            .map_err(|e| format!("Failed to start {}: {}", bin, e))?;

        let stdin = child.stdin.take().ok_or("No stdin handle")?;
        let stdout = child.stdout.take().ok_or("No stdout handle")?;

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

    /// Write a JSON-RPC request to stdin and read the response from stdout.
    async fn send_and_receive(&self, request: &Value) -> Result<Value, String> {
        // Serialize request
        let req_str = serde_json::to_string(request)
            .map_err(|e| format!("Serialization error: {}", e))?;

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

        // Read response line from stdout
        let mut line = String::new();
        {
            let mut stdout = self.stdout.lock().await;
            line.clear();
            stdout.read_line(&mut line).await
                .map_err(|e| format!("Read error: {}", e))?;
        }

        let line = line.trim();
        if line.is_empty() {
            return Err("Empty response from cua-driver".to_string());
        }

        let response: Value = serde_json::from_str(line)
            .map_err(|e| format!("JSON parse error ({}): {}", e, line.chars().take(100).collect::<String>()))?;

        // Check for JSON-RPC error
        if let Some(err) = response.get("error") {
            let msg = err.get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            return Err(format!("cua-driver error: {}", msg));
        }

        // Return the result
        match response.get("result") {
            Some(r) => Ok(r.clone()),
            None => Err(format!("No result in response: {}", line.chars().take(200).collect::<String>())),
        }
    }
}
