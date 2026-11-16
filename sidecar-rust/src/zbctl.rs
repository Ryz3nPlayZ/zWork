// Browser control via embedded WebSocket bridge to the Chrome extension.
// Uses browser_bridge.rs internally — no external Python daemon needed.
// The Chrome extension connects to ws://127.0.0.1:8787/ws directly.

use serde_json::json;

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
    page_changed_is_success(crate::browser_bridge::send_command("click", json!({"elementId": element_id})).await)
}

/// A click that opens another page unloads the content script before it can
/// reply, which surfaces as "message channel closed". The click happened, so
/// report it as done rather than as a failure the model would retry.
fn page_changed_is_success(result: Result<String, String>) -> Result<String, String> {
    match result {
        Err(e) if e.contains("message channel closed") || e.contains("Receiving end does not exist") => Ok(
            "Done. The page changed after this action (it probably opened a new page). Take a new snapshot before the next step."
                .to_string(),
        ),
        other => other,
    }
}

/// Plain guidance when a page's security policy refuses scripts.
fn explain_eval_error(e: String) -> String {
    if e.contains("unsafe-eval") || e.contains("Content Security Policy") {
        "This page doesn't allow running scripts. Read it with browser_snapshot (or browser_screenshot) and act on it with browser_click / browser_type instead of browser_eval.".to_string()
    } else {
        e
    }
}

/// Type text into an input field on the page.
pub async fn type_text(element_id: u32, text: &str) -> Result<String, String> {
    page_changed_is_success(crate::browser_bridge::send_command("type", json!({"elementId": element_id, "text": text})).await)
}

/// Execute JavaScript in the current page.
pub async fn eval(expression: &str) -> Result<String, String> {
    crate::browser_bridge::send_command("eval", json!({"expression": expression}))
        .await
        .map_err(explain_eval_error)
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

/// Take a screenshot of the current browser tab.
pub async fn screenshot() -> Result<String, String> {
    crate::browser_bridge::send_command("screenshot", json!({})).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_after_click_counts_as_done() {
        let r = page_changed_is_success(Err("A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received".into()));
        assert!(r.unwrap().starts_with("Done."));
        assert!(page_changed_is_success(Err("No active tab".into())).is_err());
    }

    #[test]
    fn script_blocked_pages_get_plain_guidance() {
        let e = explain_eval_error("Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source".into());
        assert!(e.contains("browser_snapshot"));
        assert_eq!(explain_eval_error("No active tab".into()), "No active tab");
    }
}
