// Browser control via embedded WebSocket bridge to the Chrome extension.
// Uses browser_bridge.rs internally — no external Python daemon needed.
// The Chrome extension connects to ws://127.0.0.1:8787/ws directly.

use serde_json::{json, Value};

/// Check if the Chrome extension is connected.
pub async fn extension_connected() -> bool {
    crate::browser_bridge::extension_connected().await
}

/// Navigate the user's Chrome to a URL.
pub async fn navigate(url: &str, _tab_id: Option<u32>) -> Result<String, String> {
    let mut params = json!({"url": url});
    if let Some(tid) = _tab_id {
        params["tabId"] = json!(tid);
    }
    crate::browser_bridge::send_command("navigate", params).await
}

/// Get a structured snapshot of the current browser page.
pub async fn snapshot(max_items: u32, _include_text: bool) -> Result<String, String> {
    crate::browser_bridge::send_command("snapshot", json!({"max_items": max_items})).await
}

/// Click an element on the page by its element ID.
pub async fn click(element_id: u32) -> Result<String, String> {
    crate::browser_bridge::send_command("click", json!({"elementId": element_id})).await
}

/// Type text into an input field on the page.
pub async fn type_text(element_id: u32, text: &str) -> Result<String, String> {
    crate::browser_bridge::send_command("type", json!({"elementId": element_id, "text": text})).await
}

/// Execute JavaScript in the current page.
pub async fn eval(expression: &str) -> Result<String, String> {
    crate::browser_bridge::send_command("eval", json!({"expression": expression})).await
}

/// Scroll the current page.
pub async fn scroll(direction: &str, amount: Option<i32>) -> Result<String, String> {
    let mut params = json!({"direction": direction});
    if let Some(amt) = amount {
        params["amount"] = json!(amt);
    }
    crate::browser_bridge::send_command("scroll", params).await
}

/// List all browser tabs.
pub async fn tabs() -> Result<String, String> {
    crate::browser_bridge::send_command("tabs", json!({})).await
}

/// Get the active browser tab.
pub async fn active_tab() -> Result<String, String> {
    crate::browser_bridge::send_command("active-tab", json!({})).await
}

/// Take a screenshot of the current browser tab.
pub async fn screenshot() -> Result<String, String> {
    crate::browser_bridge::send_command("screenshot", json!({})).await
}
