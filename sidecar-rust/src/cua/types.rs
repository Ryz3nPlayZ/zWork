use serde::{Deserialize, Serialize};

/// Result of a desktop_capture call.
///
/// cua-driver's `get_window_state` returns a Markdown rendering of the app's
/// accessibility tree, tagging every actionable element with `[element_index N]`.
/// Those indices are what `desktop_click` / `desktop_type` / `desktop_set_value`
/// reference. In `ax` capture mode (the v1 default) no screenshot is captured,
/// so this needs only the Accessibility grant, not Screen Recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureResult {
    /// App name this capture targeted (resolved from the agent's `app` arg).
    pub app: String,
    /// Window title — the agent verifies this matches its intended target
    /// (the iron workflow's "verify the window title" rule).
    #[serde(default)]
    pub window_title: String,
    /// The AX tree as Markdown, with `[element_index N]` tags on actionable
    /// elements. This is the primary payload the agent reads.
    #[serde(default)]
    pub tree_markdown: String,
    /// True when the AX tree was truncated to keep the payload out of the
    /// agent's context window. The agent should narrow (scroll, switch app)
    /// or accept that indices beyond the truncation point are unavailable.
    #[serde(default)]
    pub truncated: bool,
    /// Approximate element count in the *full* tree before truncation, so the
    /// agent can judge how much it isn't seeing. 0 when not counted.
    #[serde(default)]
    pub element_count: u32,
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

/// TCC permission state reported by the driver's own identity
/// (`com.trycua.driver`), not zWork's. This is the source of truth for whether
/// desktop control will actually work.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionStatus {
    pub driver_ok: bool,
    #[serde(default)]
    pub accessibility: bool,
    #[serde(default)]
    pub screen_recording: bool,
    /// Which TCC identity the booleans reflect (driver vs launching process).
    #[serde(default)]
    pub source: String,
    /// Human-readable error if the driver couldn't be reached.
    #[serde(default)]
    pub error: String,

    /// Set when the booleans look like they were measured against the wrong
    /// TCC identity — e.g. the driver reports its grant is missing while zWork
    /// itself is trusted. This is the classic "user granted Accessibility to
    /// zWork, not to CuaDriver" trap. Holds a ready-to-render message the UI
    /// can show verbatim. Absent when the state is healthy or unambiguous.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrong_identity_hint: Option<String>,

    /// Whether zWork's *own* process holds the Accessibility grant (a separate
    /// TCC identity from the driver). Surfaced so the UI can phrase the
    /// wrong-identity hint precisely ("you granted to zWork, not CuaDriver").
    /// Absent if the frontend hasn't reported it via the `ax_self_trusted`
    /// Tauri command or the backend hasn't been asked to include it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zwork_self_trusted: Option<bool>,
}
