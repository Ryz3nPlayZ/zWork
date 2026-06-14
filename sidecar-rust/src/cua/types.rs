use serde::{Deserialize, Serialize};

/// Represents one element from the accessibility tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIElement {
    pub index: u32,
    pub role: String,
    #[serde(default)]
    pub label: String,
    /// [x, y, w, h] — may be all zeros if TCC Screen Recording is denied.
    /// AX labels are still populated.
    #[serde(default)]
    pub bounds: [i32; 4],
    #[serde(default)]
    pub app: String,
}

/// Result of a desktop_capture call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureResult {
    pub mode: String,
    #[serde(default)]
    pub width: i32,
    #[serde(default)]
    pub height: i32,
    pub app: String,
    #[serde(default)]
    pub window_title: String,
    #[serde(default)]
    pub elements: Vec<UIElement>,
}

/// Result of an action (click, type, key, scroll, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub message: String,
    pub action: String,
}
