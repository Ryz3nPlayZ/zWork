mod mcp_client;
mod types;

pub use types::{ActionResult, CaptureResult};

use mcp_client::McpClient;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::OnceCell;

/// Global persistent cua-driver connection. Initialized on first use.
static CUA: OnceCell<Arc<McpClient>> = OnceCell::const_new();

/// Get or initialize the cua-driver MCP client.
pub async fn client() -> Result<Arc<McpClient>, String> {
    CUA.get_or_try_init(|| async {
        let c = McpClient::connect().await?;
        Ok(Arc::new(c))
    })
    .await
    .map(|c| c.clone())
}

/// Capture the accessibility tree of an app window.
/// Returns numbered elements the agent can reference for click/type/scroll.
pub async fn capture(app: Option<&str>) -> Result<CaptureResult, String> {
    let c = client().await?;
    let mut params = json!({"mode": "ax"});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("capture", params).await?;
    serde_json::from_value(result).map_err(|e| format!("capture parse error: {}", e))
}

/// Click an element by its index from the last capture.
pub async fn click(element: u32, app: Option<&str>) -> Result<ActionResult, String> {
    let c = client().await?;
    let mut params = json!({"element": element});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("click", params).await?;
    serde_json::from_value(result).map_err(|e| format!("click parse error: {}", e))
}

/// Type text into the currently focused field.
pub async fn type_text(text: &str, app: Option<&str>) -> Result<ActionResult, String> {
    let c = client().await?;
    let mut params = json!({"text": text});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("type", params).await?;
    serde_json::from_value(result).map_err(|e| format!("type parse error: {}", e))
}

/// Press a key or key combination.
pub async fn key(keys: &str, app: Option<&str>) -> Result<ActionResult, String> {
    let c = client().await?;
    let mut params = json!({"keys": keys});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("key", params).await?;
    serde_json::from_value(result).map_err(|e| format!("key parse error: {}", e))
}

/// Focus an app without raising its window.
pub async fn focus_app(app: &str) -> Result<ActionResult, String> {
    let c = client().await?;
    let result = c.call("focus_app", json!({"app": app})).await?;
    serde_json::from_value(result).map_err(|e| format!("focus_app parse error: {}", e))
}

/// Scroll in a direction.
pub async fn scroll(direction: &str, amount: i32, app: Option<&str>) -> Result<ActionResult, String> {
    let c = client().await?;
    let mut params = json!({"direction": direction, "amount": amount});
    if let Some(a) = app {
        params["app"] = json!(a);
    }
    let result = c.call("scroll", params).await?;
    serde_json::from_value(result).map_err(|e| format!("scroll parse error: {}", e))
}

/// List all running applications with PIDs.
pub async fn list_apps() -> Result<Vec<Value>, String> {
    let c = client().await?;
    let result = c.call("list_apps", json!({})).await?;
    Ok(result["apps"].as_array().cloned().unwrap_or_default())
}

/// Wait for a duration in seconds.
pub async fn wait(seconds: f64) -> Result<ActionResult, String> {
    let c = client().await?;
    let result = c.call("wait", json!({"seconds": seconds})).await?;
    serde_json::from_value(result).map_err(|e| format!("wait parse error: {}", e))
}
