# zWork Desktop + Browser Control Integration Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace dctl's monolithic desktop/browser wrapper with direct cua-driver (desktop) and zbctl (browser) integrations, exposed through structured, self-documenting tool schemas that eliminate system prompt bloat.

**Architecture:**

```
zWork Rust sidecar
  │
  ├─ cua-driver (MCP over stdio)  → desktop_capture, desktop_click, desktop_type, desktop_scroll, desktop_key
  │   Persistent MCP session. Background input. Works on any macOS app including Safari/Chrome.
  │
  ├─ zbctl (WebSocket to Chrome Extension) → browser_navigate, browser_snapshot, browser_click, browser_type, browser_eval
  │   Connects to user's real Chrome with cookies/sessions intact. Solves the auth problem.
  │
  └─ Office doc tools (python-docx/openpyxl via subprocess) → docx_read, docx_append, xlsx_read, xlsx_write
      Kept from dctl's office layer. Called as Python subprocess from Rust.
```

**Key insight:** cua-driver handles interaction (click, type, scroll) everywhere. zbctl handles content reading (DOM text) in the browser where the user is signed in. The agent uses cua-driver to navigate and interact, and zbctl to read page content when the AX tree doesn't expose body text.

**Tech Stack:** Rust (Axum + Tokio), cua-driver (Rust binary, MCP over stdio), zbctl (Python/FastAPI + Chrome Extension, WebSocket), python-docx + openpyxl (subprocess)

**Current state before plan:**
- `sidecar-rust/src/tools/dctl.rs`: 73-line wrapper that calls dctl CLI via subprocess
- `sidecar-rust/src/tools/mod.rs`: 610 lines with generic `dctl_system`, `dctl_ui`, `dctl_browser`, `dctl_office` schemas
- `sidecar-rust/src/settings.rs`: system prompt template in `SYSTEM_PROMPT_TEMPLATE` constant
- dctl CLI: `/Programming/dctl/` — 7K LOC Python, not needed after this plan
- zbctl: `/Programming/zbctl/` — Python daemon + Chrome extension, keep and integrate
- cua-driver: installed at `/Users/zemuliu/.local/bin/cua-driver` v0.5.3

---

### Task 1: Add MCP client dependency and cua-driver connection module

**Objective:** Create a persistent MCP-over-stdio connection to cua-driver that the zWork sidecar holds for its lifetime.

**Files:**
- Create: `sidecar-rust/src/cua/mcp_client.rs` — MCP JSON-RPC 2.0 client over stdio
- Create: `sidecar-rust/src/cua/mod.rs` — cua-driver wrapper with high-level API
- Modify: `sidecar-rust/Cargo.toml` — add `tokio-tungstenite` if using WebSocket variant, or use `tokio::process` for stdio

**Step 1: Add dependencies to Cargo.toml**

```toml
# In [dependencies] section of sidecar-rust/Cargo.toml
serde_json = "1.0.120"  # already present
```

No new Cargo deps needed. MCP-over-stdio uses `tokio::process::Command` with piped stdin/stdout, which is already in Tokio. JSON-RPC 2.0 is just JSON with `"jsonrpc": "2.0"` envelope — serde_json handles it.

**Step 2: Create `sidecar-rust/src/cua/mcp_client.rs`**

```rust
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct McpClient {
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: Arc<Mutex<u64>>,
    child: Arc<Mutex<Child>>,
}

impl McpClient {
    /// Start cua-driver with `cua-driver mcp` and return a connected client.
    pub async fn connect() -> Result<Self, String> {
        let mut child = Command::new("cua-driver")
            .arg("mcp")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start cua-driver: {}", e))?;

        let stdin = child.stdin.take()
            .ok_or("No stdin handle")?;

        // Initialize MCP session
        let mut client = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            next_id: Arc::new(Mutex::new(1)),
            child: Arc::new(Mutex::new(child)),
        };

        client.initialize().await?;
        Ok(client)
    }

    async fn initialize(&self) -> Result<(), String> {
        let init_msg = json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "zWork", "version": "0.5.0"}
            }
        });
        self.send_and_receive(&init_msg).await?;
        Ok(())
    }

    /// Send a JSON-RPC request and wait for the matching response.
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

    async fn send_and_receive(&self, request: &Value) -> Result<Value, String> {
        // Implementation: write JSON line to stdin, read JSON line from stdout
        // Parse the response, match on id, return result or error
        todo!("Implement MCP JSON-RPC 2.0 wire protocol")
    }
}
```

**Step 3: Verify connection**

```bash
cd ~/Programming/zWork/sidecar-rust && cargo check
```

Expected: `mcp_client.rs` imports compile, `todo!()` macro doesn't block type checking.

---

### Task 2: Create cua-driver high-level API module

**Objective:** Wrap the MCP client with typed, ergonomic functions matching what the agent loop will call.

**Files:**
- Modify: `sidecar-rust/src/cua/mod.rs` (created in Task 1)
- Create: `sidecar-rust/src/cua/types.rs` — structs for AX elements, capture results

**Step 1: Define types in `sidecar-rust/src/cua/types.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIElement {
    pub index: u32,
    pub role: String,
    pub label: String,
    #[serde(default)]
    pub bounds: Option<[i32; 4]>,  // [x, y, w, h], may be [0,0,0,0] if TCC Screen Recording denied
    #[serde(default)]
    pub app: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureResult {
    pub mode: String,
    pub width: i32,
    pub height: i32,
    pub app: String,
    pub window_title: String,
    pub elements: Vec<UIElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub ok: bool,
    #[serde(default)]
    pub message: String,
    pub action: String,
}
```

**Step 2: Implement high-level functions in `sidecar-rust/src/cua/mod.rs`**

```rust
mod mcp_client;
pub mod types;

use mcp_client::McpClient;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::OnceCell;

static CUA: OnceCell<Arc<McpClient>> = OnceCell::const_new();

/// Get or initialize the persistent cua-driver connection.
pub async fn client() -> Result<Arc<McpClient>, String> {
    CUA.get_or_try_init(|| async {
        let client = McpClient::connect().await?;
        Ok(Arc::new(client))
    }).await.map(|c| c.clone())
}

pub async fn capture(app: Option<&str>) -> Result<types::CaptureResult, String> {
    let c = client().await?;
    let mut params = json!({"mode": "ax"});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("capture", params).await?;
    serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
}

pub async fn click(element: u32, app: Option<&str>) -> Result<types::ActionResult, String> {
    let c = client().await?;
    let mut params = json!({"element": element});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("click", params).await?;
    serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
}

pub async fn type_text(text: &str, app: Option<&str>) -> Result<types::ActionResult, String> {
    let c = client().await?;
    let mut params = json!({"text": text});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("type", params).await?;
    serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
}

pub async fn key(keys: &str, app: Option<&str>) -> Result<types::ActionResult, String> {
    let c = client().await?;
    let mut params = json!({"keys": keys});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("key", params).await?;
    serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
}

pub async fn focus_app(app: &str) -> Result<types::ActionResult, String> {
    let c = client().await?;
    let result = c.call("focus_app", json!({"app": app})).await?;
    serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
}

pub async fn scroll(direction: &str, amount: i32, app: Option<&str>) -> Result<types::ActionResult, String> {
    let c = client().await?;
    let mut params = json!({"direction": direction, "amount": amount});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("scroll", params).await?;
    serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
}

pub async fn list_apps() -> Result<Vec<Value>, String> {
    let c = client().await?;
    let result = c.call("list_apps", json!({})).await?;
    Ok(result["apps"].as_array().cloned().unwrap_or_default())
}

pub async fn wait(seconds: f64) -> Result<types::ActionResult, String> {
    let c = client().await?;
    let result = c.call("wait", json!({"seconds": seconds})).await?;
    serde_json::from_value(result).map_err(|e| format!("Parse error: {}", e))
}
```

**Step 3: Register the module**

Add `pub mod cua;` to `sidecar-rust/src/main.rs`.

**Step 4: Verify**

```bash
cd ~/Programming/zWork/sidecar-rust && cargo check
```

Expected: compiles with `todo!()` in mcp_client, or clean compile if MCP client is fully implemented.

---

### Task 3: Implement the MCP JSON-RPC wire protocol

**Objective:** Complete the `send_and_receive` method so the MCP client actually talks to cua-driver.

**Files:**
- Modify: `sidecar-rust/src/cua/mcp_client.rs`

**Step 1: Implement `send_and_receive`**

```rust
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, AsyncReadExt};

async fn send_and_receive(&self, request: &Value) -> Result<Value, String> {
    let mut stdin = self.stdin.lock().await;
    
    // Write JSON-RPC request as a single line (newline-delimited JSON)
    let req_str = serde_json::to_string(request)
        .map_err(|e| format!("Serialization error: {}", e))?;
    stdin.write_all(req_str.as_bytes()).await
        .map_err(|e| format!("Write error: {}", e))?;
    stdin.write_all(b"\n").await
        .map_err(|e| format!("Write error: {}", e))?;
    stdin.flush().await
        .map_err(|e| format!("Flush error: {}", e))?;
    
    // Read response — cua-driver returns newline-delimited JSON
    // We need to read stdout. Store a BufReader handle on self.
    // For v1: simple approach — read one line.
    todo!("Add stdout reader field to struct and read response line");
}
```

Note: This task requires adding a `stdout: Arc<Mutex<BufReader<ChildStdout>>>` field to `McpClient`. The constructor needs to wrap `child.stdout.take()`.

**Step 2: Full implementation details**

The struct becomes:
```rust
use tokio::process::{Child, ChildStdin, ChildStdout};

pub struct McpClient {
    stdin: Arc<Mutex<ChildStdin>>,
    stdout: Arc<Mutex<BufReader<ChildStdout>>>,
    next_id: Arc<Mutex<u64>>,
    child: Arc<Mutex<Child>>,
}
```

`send_and_receive` writes the JSON line to stdin, then reads one JSON line from stdout, parses it, and checks the `id` field matches. Returns the `result` field on success or the `error` field on failure.

**Step 3: Test with `cargo test` (integration test)**

Create `sidecar-rust/tests/cua_integration.rs`:
```rust
#[tokio::test]
async fn test_cua_list_apps() {
    let result = cua::list_apps().await;
    assert!(result.is_ok());
    let apps = result.unwrap();
    assert!(!apps.is_empty(), "Should return running apps");
}
```

Mark with `#[ignore]` — requires cua-driver on PATH, only runs manually.

**Step 4: Verify**

```bash
cd ~/Programming/zWork/sidecar-rust && cargo check
# Manual integration test (requires cua-driver):
cargo test test_cua_list_apps -- --ignored
```

Expected: compiles. `test_cua_list_apps` returns apps including "Finder", "Safari", "Hermes", etc.

---

### Task 4: Replace dctl tool schemas with structured cua-driver + zbctl schemas

**Objective:** Remove the generic `dctl`, `dctl_system`, `dctl_ui`, `dctl_browser`, `dctl_office` schemas. Replace with specific, self-documenting tools.

**Files:**
- Modify: `sidecar-rust/src/tools/mod.rs` — `get_tool_schemas()` function
- Modify: `sidecar-rust/src/tools/mod.rs` — `execute_tool()` dispatch
- Remove: `sidecar-rust/src/tools/dctl.rs` (no longer needed)

**Step 1: Define new tool schemas in `get_tool_schemas()`**

Replace the dctl_* entries (lines ~268-328 in mod.rs) with:

```rust
// ─── Desktop control (cua-driver) ───
json!({
    "name": "desktop_capture",
    "description": "Capture the accessibility tree of an app window. Returns numbered elements the agent can click/type into. MUST be called before desktop_click, desktop_type, or desktop_scroll. Use app=\"Safari\" or app=\"Chrome\" to scope to a single app, or omit for the frontmost app.",
    "parameters": {
        "type": "object",
        "properties": {
            "app": {"type": "string", "description": "App name to capture, e.g. \"Safari\", \"Chrome\", \"Finder\". Omit for frontmost app."}
        }
    }
}),
json!({
    "name": "desktop_click",
    "description": "Click an element by its index from the last desktop_capture result. Element indices come from the capture output.",
    "parameters": {
        "type": "object",
        "properties": {
            "element": {"type": "integer", "description": "Element index from capture output"},
            "app": {"type": "string", "description": "App to click in (optional, uses last capture target)"}
        },
        "required": ["element"]
    }
}),
json!({
    "name": "desktop_type",
    "description": "Type text into the currently focused field. Use desktop_click first to focus the right element.",
    "parameters": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "Text to type"},
            "app": {"type": "string", "description": "App to type in (optional)"}
        },
        "required": ["text"]
    }
}),
json!({
    "name": "desktop_scroll",
    "description": "Scroll in a direction. Use after desktop_capture to identify the scrollable area.",
    "parameters": {
        "type": "object",
        "properties": {
            "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
            "amount": {"type": "integer", "description": "Number of scroll ticks (default 3)"},
            "app": {"type": "string", "description": "App to scroll in (optional)"}
        },
        "required": ["direction"]
    }
}),
json!({
    "name": "desktop_key",
    "description": "Press a keyboard shortcut or key. Use for navigation (cmd+l, cmd+t, cmd+w, return, escape, tab).",
    "parameters": {
        "type": "object",
        "properties": {
            "keys": {"type": "string", "description": "Key combination, e.g. \"cmd+l\", \"cmd+t\", \"return\", \"escape\", \"tab\""},
            "app": {"type": "string", "description": "App to send keys to (optional)"}
        },
        "required": ["keys"]
    }
}),
json!({
    "name": "desktop_focus",
    "description": "Focus a running application without raising its window. Use before desktop_capture to target a specific app.",
    "parameters": {
        "type": "object",
        "properties": {
            "app": {"type": "string", "description": "App name, e.g. \"Safari\", \"Chrome\", \"Finder\", \"Gemini\""}
        },
        "required": ["app"]
    }
}),
json!({
    "name": "desktop_list_apps",
    "description": "List all running applications with their process IDs.",
    "parameters": {"type": "object", "properties": {}}
}),
// ─── Browser content (zbctl) ───
json!({
    "name": "browser_navigate",
    "description": "Open a URL in the user's Chrome browser (uses their active session/cookies).",
    "parameters": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Full URL to navigate to"}
        },
        "required": ["url"]
    }
}),
json!({
    "name": "browser_snapshot",
    "description": "Get a text snapshot of the current browser page. Returns interactive elements with IDs, visible text, and structure. Use this to read page content and find elements to interact with.",
    "parameters": {
        "type": "object",
        "properties": {
            "max_items": {"type": "integer", "description": "Max elements to return (default 80)"},
            "include_text": {"type": "boolean", "description": "Include visible text content (default true)"}
        }
    }
}),
json!({
    "name": "browser_click",
    "description": "Click an element on the current browser page by its ID from browser_snapshot.",
    "parameters": {
        "type": "object",
        "properties": {
            "element_id": {"type": "string", "description": "Element ID from browser_snapshot output"}
        },
        "required": ["element_id"]
    }
}),
json!({
    "name": "browser_type",
    "description": "Type text into a focused input field on the current browser page.",
    "parameters": {
        "type": "object",
        "properties": {
            "element_id": {"type": "string", "description": "Element ID of input from browser_snapshot"},
            "text": {"type": "string", "description": "Text to type"}
        },
        "required": ["element_id", "text"]
    }
}),
json!({
    "name": "browser_eval",
    "description": "Execute JavaScript in the current browser page and return the result. Use for reading DOM content that browser_snapshot doesn't capture.",
    "parameters": {
        "type": "object",
        "properties": {
            "expression": {"type": "string", "description": "JavaScript expression to evaluate. Example: \"document.body.innerText\""}
        },
        "required": ["expression"]
    }
}),
// ─── Office documents (kept from dctl via subprocess) ───
// Keep docx_read, docx_append, docx_replace, xlsx_read, xlsx_write schemas
// Simplified from dctl's CLI interface
```

**Step 2: Update `execute_tool()` dispatch**

Replace the dctl dispatch block (lines ~449-477) with:

```rust
"desktop_capture" => {
    let app = params.get("app").and_then(|v| v.as_str());
    match cua::capture(app).await {
        Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
        Err(e) => Err(e),
    }
}
"desktop_click" => {
    let element = params.get("element").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let app = params.get("app").and_then(|v| v.as_str());
    match cua::click(element, app).await {
        Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
        Err(e) => Err(e),
    }
}
"desktop_type" => {
    // ... similar
}
// ... etc for each tool
```

**Step 3: Remove `dctl.rs`**

Delete `sidecar-rust/src/tools/dctl.rs`. Remove `pub mod dctl;` from `mod.rs`.

**Step 4: Verify**

```bash
cd ~/Programming/zWork/sidecar-rust && cargo check
```

Expected: compiles. No references to dctl remain.

---

### Task 5: Update system prompt template

**Objective:** Replace any dctl-specific instruction blocks with concise desktop_capture → desktop_act and browser_snapshot → browser_act workflow instructions.

**Files:**
- Modify: `sidecar-rust/src/settings.rs` — `SYSTEM_PROMPT_TEMPLATE` constant

**Step 1: Locate the dctl instruction block in SYSTEM_PROMPT_TEMPLATE**

Search for "dctl" in the template. It likely contains paragraphs explaining dctl_system, dctl_ui, dctl_browser subcommands.

**Step 2: Replace with concise new block**

```
## Desktop control (macOS)

You can see and click anything on screen through the accessibility tree.

WORKFLOW: Capture first, then act by element index.

1. desktop_capture(app="Safari") → returns numbered elements
   - Each element has: index, role, label, app
   - Interactive roles: AXButton, AXLink, AXTextField, AXTextArea, AXComboBox
   - Content roles: AXHeading, AXStaticText, AXGroup
2. desktop_click(element=N) → click element N from the capture
3. desktop_type(text="...") → type into the focused field
4. desktop_scroll(direction="down") → scroll
5. desktop_key(keys="cmd+l") → keyboard shortcut

CRITICAL: desktop_capture before EVERY desktop_click. Indices come from the most recent capture. If the UI changes (new page, dialog), re-capture.

Note: desktop_capture exposes AX tree labels, not full DOM body text.
For reading web page content, use browser_snapshot or browser_eval(expression="document.body.innerText").

## Browser control (Chrome)

The agent connects to YOUR Chrome where you're signed in. No login walls.

WORKFLOW: Snapshot first, then act by element ID.

1. browser_navigate(url="...") → open a page
2. browser_snapshot() → returns page structure with element IDs and visible text
3. browser_click(element_id="e4") → click element by its ID
4. browser_type(element_id="e7", text="...") → type into input
5. browser_eval(expression="document.title") → run JavaScript

For reading article text: browser_eval(expression="document.body.innerText")

## Choosing desktop vs browser

- Use desktop_* tools to navigate between apps, open new tabs (desktop_key(keys="cmd+t")), and interact with non-browser apps
- Use browser_* tools to read web page content and interact with browser pages
- Common pattern: desktop_key(keys="cmd+l") → desktop_type(text="url") → desktop_key(keys="return") → browser_snapshot() to read what loaded
```

**Step 3: Verify**

```bash
cd ~/Programming/zWork/sidecar-rust && cargo check
```

Expected: compiles. Template string builds without syntax errors.

---

### Task 6: Integrate zbctl daemon lifecycle

**Objective:** zWork should start/stop the zbctl Python daemon alongside the Rust sidecar. The Rust sidecar connects to zbctl via WebSocket for browser commands.

**Files:**
- Create: `sidecar-rust/src/zbctl.rs` — WebSocket client for zbctl
- Modify: `sidecar-rust/src/main.rs` — start zbctl daemon on startup
- Modify: `sidecar-rust/src/tools/mod.rs` — browser_* tool dispatch

**Step 1: Create `sidecar-rust/src/zbctl.rs`**

```rust
use reqwest::Client;
use serde_json::Value;

const ZBCTL_URL: &str = "http://127.0.0.1:8788/api/command";

pub async fn send_command(command: &str, params: Value) -> Result<String, String> {
    let client = Client::new();
    let body = serde_json::json!({
        "command": command,
        "params": params
    });
    let resp = client.post(ZBCTL_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("zbctl request failed: {}", e))?;
    let text = resp.text().await
        .map_err(|e| format!("zbctl read failed: {}", e))?;
    Ok(text)
}

pub async fn navigate(url: &str) -> Result<String, String> {
    send_command("navigate", serde_json::json!({"url": url})).await
}

pub async fn snapshot(max_items: u32, include_text: bool) -> Result<String, String> {
    send_command("snapshot", serde_json::json!({
        "max_items": max_items,
        "include_text": include_text
    })).await
}

pub async fn click(element_id: &str) -> Result<String, String> {
    send_command("click", serde_json::json!({"element_id": element_id})).await
}

pub async fn type_text(element_id: &str, text: &str) -> Result<String, String> {
    send_command("type", serde_json::json!({"element_id": element_id, "text": text})).await
}

pub async fn eval(expression: &str) -> Result<String, String> {
    send_command("eval", serde_json::json!({"expression": expression})).await
}
```

**Step 2: Wire into tool dispatch in `mod.rs`**

```rust
"browser_navigate" => {
    let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
    zbctl::navigate(url).await
}
"browser_snapshot" => {
    let max_items = params.get("max_items").and_then(|v| v.as_u64()).unwrap_or(80) as u32;
    let include_text = params.get("include_text").and_then(|v| v.as_bool()).unwrap_or(true);
    zbctl::snapshot(max_items, include_text).await
}
// ... etc
```

**Step 3: Register module**

Add `pub mod zbctl;` to `main.rs`.

**Step 4: Verify**

```bash
cd ~/Programming/zWork/sidecar-rust && cargo check
```

Expected: compiles. zbctl integration is optional — browser_* tools fail gracefully if zbctl daemon isn't running.

---

### Task 7: Remove dctl dependency from zWork

**Objective:** Delete dctl-related code that's no longer needed. Keep only the office doc layer.

**Files:**
- Delete: `sidecar-rust/src/tools/dctl.rs`
- Modify: `sidecar-rust/src/tools/mod.rs` — remove `pub mod dctl;` and dctl dispatch
- Modify: `sidecar-rust/src/tools/mod.rs` — keep docx/xlsx tools, route through Python subprocess

**Step 1: Clean up tool module**

In `mod.rs`:
- Remove `pub mod dctl;` (line 13)
- Remove the `"dctl" | "dctl_system" | "dctl_ui" | "dctl_browser" | "dctl_office"` dispatch block (lines ~449-477)
- Keep the existing `extract_document` dispatch — it handles docx/xlsx/pptx internally

**Step 2: Remove from KNOWN_TOOLS**

In `agent/mod.rs`, remove `"dctl"`, `"dctl_system"`, `"dctl_ui"`, `"dctl_browser"`, `"dctl_office"` from `KNOWN_TOOLS` array (lines ~477-484).

**Step 3: Verify**

```bash
cd ~/Programming/zWork/sidecar-rust && cargo check
```

Expected: compiles cleanly, zero references to dctl.

---

### Task 8: Run full test suite

**Objective:** Verify nothing is broken by the changes.

**Step 1: Rust check**

```bash
cd ~/Programming/zWork/sidecar-rust && cargo check
```

Expected: compiles, zero errors, acceptable warnings.

**Step 2: Python tests**

```bash
cd ~/Programming/zWork && .venv/bin/python3 -m pytest tests/ -x -q
```

Expected: same result as before — 275 passed, 15 skipped (Python sidecar tests still pass, they don't depend on the Rust dctl code).

**Step 3: Manual smoke test (requires GUI)**

```bash
cd ~/Programming/zWork && ./run.sh
```

Open the zWork app, send a message like "list my running apps" — verify the agent can call `desktop_list_apps` and get results.

---

## System Prompt Impact

**Before (dctl-based):** The system prompt needed paragraphs explaining `dctl_system`, `dctl_ui`, `dctl_browser`, `dctl_office` — their subcommand syntax, how to pass args, which subcommands exist, how to parse output. Probably 500-800 tokens of dctl documentation.

**After (structured tools):** The system prompt has ~200 tokens:
> Capture first. Act by index. Re-capture after state changes. For page text that capture doesn't expose, use browser_snapshot or browser_eval.

The tool schemas carry the rest. Every parameter is typed and described. The model doesn't need CLI syntax knowledge.

## Risks & Tradeoffs

| Risk | Mitigation |
|------|-----------|
| cua-driver MCP session dies | MCP client reconnects on next call (lazy init in `OnceCell`) |
| zbctl daemon not running | Browser tools fail with clear error message; agent falls back to desktop_* tools |
| TCC Screen Recording denied → 0x0 bounds | Still works — AX labels are populated. Click by index works without bounds. Already proven. |
| Rust → Python subprocess for docx/xlsx | Acceptable latency (~100-300ms). Documents are rare operations compared to capture/click. |
| Dropping dctl office CLI parsing | We keep the Python modules (python-docx, openpyxl) directly; no CLI arg parsing needed |

## What Gets Deleted

- `sidecar-rust/src/tools/dctl.rs` — 73 lines
- dctl-related schema entries in `tools/mod.rs` — ~60 lines
- dctl-related dispatch in `tools/mod.rs` — ~30 lines
- dctl entries in `KNOWN_TOOLS` — 4 lines
- ~500-800 tokens of dctl documentation from system prompt

Total zWork Rust code deleted: ~170 lines. Replaced with ~400 lines of clean, typed tool code.

## What Survives from dctl

The Python modules in `/Programming/dctl/dctl/` that handle docx/xlsx/LibreOffice are still useful as a subprocess tool. The CLI wrapper code (`cli.py`, 933 lines) is not needed — zWork calls the modules directly or via a thin Python script.
