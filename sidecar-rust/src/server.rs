use axum::{
    extract::{Path, Query},
    response::sse::{Event, Sse},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use tokio_stream::StreamExt;

use crate::chatstore;
use crate::settings;
use crate::agent::run_agent_turn;

// Request body schemas
#[derive(Deserialize)]
pub struct CreateChatRequest {
    pub title: Option<String>,
    pub model: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Deserialize)]
pub struct PatchChatRequest {
    pub title: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Deserialize)]
pub struct PatchMessageRequest {
    pub content: Option<Value>,
    #[serde(default)]
    pub activities: Option<Vec<Value>>,
}

#[derive(Deserialize, Debug)]
pub struct ChatStreamRequest {
    pub chat_id: Option<String>,
    #[serde(default)]
    pub run_id: String,
    pub message: String,
    pub model: Option<String>,
    pub project_id: Option<String>,
    /// Caller-provided title for a newly created chat.
    #[serde(default)]
    pub new_chat_title: Option<String>,
    #[serde(default)]
    pub plan_mode: bool,
    #[serde(default)]
    pub auto_approve_destructive: bool,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    /// Whether the assistant should render rich artifacts. Defaults to true
    /// (the Python backend's default) to preserve the artifact UX.
    #[serde(default = "default_true")]
    pub artifact_mode: bool,
    /// When true, the message is grounded with live web-search results.
    #[serde(default)]
    pub web_search_enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
pub struct Attachment {
    pub client_id: Option<String>,
    pub name: String,
    pub path: String,
    pub mime: String,
    pub kind: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub data_url: Option<String>,
}

impl Attachment {
    /// Best-effort locator for prompt framing: prefer the on-disk path, then
    /// any data URL, then the original (often relative) path string.
    pub fn path_or_url(&self) -> String {
        if !self.path.is_empty() {
            self.path.clone()
        } else if let Some(u) = &self.data_url {
            if u.len() > 60 {
                format!("{}…", &u[..60])
            } else {
                u.clone()
            }
        } else {
            "(no path)".to_string()
        }
    }
}

// REST Handlers
pub async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

/// Whether the zbctl Chrome extension WebSocket is currently connected. The
/// Settings UI polls this to show live browser-bridge connection state.
pub async fn browser_bridge_status() -> impl IntoResponse {
    Json(json!({ "connected": crate::browser_bridge::extension_connected().await }))
}

/// cua-driver TCC permission status (Accessibility + Screen Recording) as
/// reported by the driver's own identity (`com.trycua.driver`) — the source of
/// truth for whether desktop control will actually work. Read-only probe; also
/// doubles as a driver-health check (`driver_ok` is false if the driver can't
/// be reached). This is what the Settings permission rows should read.
pub async fn desktop_status() -> impl IntoResponse {
    // Desktop control is macOS-only (the CuaDriver accessibility daemon is a
    // notarized .app with no Windows/Linux build). On other platforms return
    // an honest status instead of trying to reach a driver that can't exist —
    // the Settings UI surfaces this `error` to the user.
    if !cfg!(target_os = "macos") {
        return Json(crate::cua::PermissionStatus {
            driver_ok: false,
            accessibility: false,
            screen_recording: false,
            source: String::new(),
            error: "Desktop control is only available on macOS (it requires the \
                    CuaDriver accessibility daemon). On this platform, use the \
                    browser_* tools or run_command instead."
                .to_string(),
            wrong_identity_hint: None,
            zwork_self_trusted: None,
        });
    }
    Json(crate::cua::check_permissions(false).await.unwrap_or_else(|e| {
        crate::cua::PermissionStatus {
            driver_ok: false,
            accessibility: false,
            screen_recording: false,
            source: String::new(),
            error: e,
            wrong_identity_hint: None,
            zwork_self_trusted: None,
        }
    }))
}

/// Raise the macOS permission prompts for any missing grants, attributed to
/// the driver identity (`com.trycua.driver`). Returns the live status after.
/// This is the correct grant path — prompting from zWork's own identity would
/// leave the driver (the process that actually does AX + CGEvents) blocked.
pub async fn desktop_grant() -> impl IntoResponse {
    // No driver to grant permissions for off macOS — see desktop_status.
    if !cfg!(target_os = "macos") {
        return Json(crate::cua::PermissionStatus {
            driver_ok: false,
            accessibility: false,
            screen_recording: false,
            source: String::new(),
            error: "Desktop control is only available on macOS.".to_string(),
            wrong_identity_hint: None,
            zwork_self_trusted: None,
        });
    }
    Json(crate::cua::check_permissions(true).await.unwrap_or_else(|e| {
        crate::cua::PermissionStatus {
            driver_ok: false,
            accessibility: false,
            screen_recording: false,
            source: String::new(),
            error: e,
            wrong_identity_hint: None,
            zwork_self_trusted: None,
        }
    }))
}

/// List on-screen windows for the "Share Window" picker. macOS-only.
pub async fn list_windows() -> impl IntoResponse {
    if !cfg!(target_os = "macos") {
        return Json(json!({ "windows": [] }));
    }
    match crate::cua::list_on_screen_windows().await {
        Ok(wins) => Json(json!({ "windows": wins })),
        Err(e) => {
            tracing::warn!("list_windows failed: {}", e);
            Json(json!({ "windows": [], "error": e }))
        }
    }
}

/// Capture a screenshot of a specific window for the "Share Window" feature.
/// Returns the PNG as base64 so the frontend can inject it as an image
/// attachment. macOS-only; requires Screen Recording permission.
pub async fn capture_window(
    axum::extract::Path(window_id): axum::extract::Path<i64>,
) -> impl IntoResponse {
    if !cfg!(target_os = "macos") {
        return Json(json!({ "error": "Desktop capture is only available on macOS." }));
    }
    match crate::cua::capture_window_screenshot(window_id).await {
        Ok(path) => {
            // Read the PNG and base64-encode it.
            match std::fs::read(&path) {
                Ok(bytes) => {
                    let b64 = BASE64.encode(&bytes);
                    // Clean up the temp file.
                    let _ = std::fs::remove_file(&path);
                    Json(json!({ "data_url": format!("data:image/png;base64,{}", b64), "mime": "image/png" }))
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&path);
                    Json(json!({ "error": format!("Failed to read screenshot: {}", e) }))
                }
            }
        }
        Err(e) => Json(json!({ "error": e })),
    }
}

pub async fn me() -> impl IntoResponse {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());
    let os_name = std::env::consts::OS;
    let name = display_name();
    
    Json(json!({
        "name": name,
        "os": os_name,
        "cwd": cwd,
    }))
}

pub fn display_name() -> String {
    let p = crate::paths::onboarding_path();
    if p.exists() {
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(name) = val.get("display_name").and_then(|v| v.as_str()) {
                    if !name.trim().is_empty() {
                        return name.to_string();
                    }
                }
            }
        }
    }
    
    if let Ok(user) = std::env::var("USER") {
        if !user.trim().is_empty() {
            return user.trim().to_string();
        }
    }
    
    "friend".to_string()
}

fn read_claude_code_env() -> std::collections::HashMap<String, String> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return std::collections::HashMap::new(),
    };
    let path = home.join(".claude").join("settings.json");
    if !path.exists() {
        return std::collections::HashMap::new();
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return std::collections::HashMap::new(),
    };
    let val: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return std::collections::HashMap::new(),
    };
    let mut out = std::collections::HashMap::new();
    if let Some(env) = val.get("env").and_then(|e| e.as_object()) {
        for (k, v) in env {
            let val_str = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                _ => continue,
            };
            out.insert(k.clone(), val_str);
        }
    }
    out
}

pub fn read_claude_code_model() -> Option<String> {
    let home = dirs::home_dir()?;
    let path = home.join(".claude").join("settings.json");
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&content).ok()?;
    val.get("model").and_then(|m| m.as_str()).map(|s| s.to_string())
}

pub fn resolve(credential: &str, settings: &settings::Settings, override_base_url: &str) -> Option<Credentials> {
    let shape = if credential == "anthropic" || credential == "claude_code" {
        "anthropic".to_string()
    } else {
        "openai".to_string()
    };

    if credential == "claude_code" {
        if !settings.use_claude_code_config {
            return None;
        }
        let env = read_claude_code_env();
        let tok = env.get("ANTHROPIC_AUTH_TOKEN")
            .or_else(|| env.get("ANTHROPIC_API_KEY"))
            .cloned();
        if let Some(tok_str) = tok {
            if !tok_str.trim().is_empty() {
                let base = if !override_base_url.is_empty() {
                    override_base_url.to_string()
                } else {
                    env.get("ANTHROPIC_BASE_URL")
                        .cloned()
                        .unwrap_or_else(|| "https://api.anthropic.com".to_string())
                };
                return Some(Credentials {
                    shape,
                    api_key: tok_str,
                    base_url: base.trim_end_matches('/').to_string(),
                    source: "claude_code".to_string(),
                });
            }
        }
        return None;
    }

    if credential == "anthropic" {
        let key = settings.api_keys.get("anthropic").cloned().unwrap_or_default();
        if !key.trim().is_empty() {
            let base = if !override_base_url.is_empty() {
                override_base_url.to_string()
            } else {
                settings.provider_config.get("anthropic")
                    .and_then(|m| m.get("base_url"))
                    .cloned()
                    .unwrap_or_else(|| "https://api.anthropic.com".to_string())
            };
            return Some(Credentials {
                shape,
                api_key: key,
                base_url: base,
                source: "byok".to_string(),
            });
        }
        if let Ok(tok) = std::env::var("ANTHROPIC_API_KEY").or_else(|_| std::env::var("ANTHROPIC_AUTH_TOKEN")) {
            if !tok.trim().is_empty() {
                let base = if !override_base_url.is_empty() {
                    override_base_url.to_string()
                } else {
                    std::env::var("ANTHROPIC_BASE_URL").unwrap_or_else(|_| "https://api.anthropic.com".to_string())
                };
                return Some(Credentials {
                    shape,
                    api_key: tok,
                    base_url: base,
                    source: "env".to_string(),
                });
            }
        }
        return None;
    }

    if credential == "openai" {
        let key = settings.api_keys.get("openai").cloned().unwrap_or_default();
        if !key.trim().is_empty() {
            let base = if !override_base_url.is_empty() {
                override_base_url.to_string()
            } else {
                settings.provider_config.get("openai")
                    .and_then(|m| m.get("base_url"))
                    .cloned()
                    .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
            };
            return Some(Credentials {
                shape,
                api_key: key,
                base_url: base,
                source: "byok".to_string(),
            });
        }
        if let Ok(tok) = std::env::var("OPENAI_API_KEY") {
            if !tok.trim().is_empty() {
                let base = if !override_base_url.is_empty() {
                    override_base_url.to_string()
                } else {
                    std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".to_string())
                };
                return Some(Credentials {
                    shape,
                    api_key: tok,
                    base_url: base,
                    source: "env".to_string(),
                });
            }
        }
        return None;
    }

    if credential == "zwork_router" {
        let key = settings.api_keys.get("zwork_router")
            .or_else(|| settings.api_keys.get("openai"))
            .cloned()
            .unwrap_or_default();
        if !key.trim().is_empty() {
            let base = if !override_base_url.is_empty() {
                override_base_url.to_string()
            } else {
                settings.provider_config.get("zwork_router")
                    .and_then(|m| m.get("base_url"))
                    .or_else(|| settings.provider_config.get("openai").and_then(|m| m.get("base_url")))
                    .cloned()
                    .unwrap_or_else(|| "https://api.tryzwork.app/api".to_string())
            };
            return Some(Credentials {
                shape,
                api_key: key,
                base_url: base,
                source: "byok".to_string(),
            });
        }
        if let Ok(tok) = std::env::var("ZWORK_GATEWAY_TOKEN") {
            if !tok.trim().is_empty() {
                let base = if !override_base_url.is_empty() {
                    override_base_url.to_string()
                } else {
                    "https://api.tryzwork.app/api".to_string()
                };
                return Some(Credentials {
                    shape,
                    api_key: tok,
                    base_url: base,
                    source: "env".to_string(),
                });
            }
        }
        return None;
    }

    if credential == "ollama" {
        let base = if !override_base_url.is_empty() {
            override_base_url.to_string()
        } else {
            settings.provider_config.get("ollama")
                .and_then(|m| m.get("base_url"))
                .cloned()
                .unwrap_or_else(|| "http://localhost:11434/v1".to_string())
        };
        // Local Ollama doesn't require an API key
        let key = settings.api_keys.get("ollama").cloned().unwrap_or_default();
        return Some(Credentials {
            shape: "openai".to_string(),
            api_key: key,
            base_url: base.trim_end_matches('/').to_string(),
            source: "ollama".to_string(),
        });
    }

    // Default for other compatibility providers
    let key = settings.api_keys.get(credential).cloned().unwrap_or_default();
    if !key.trim().is_empty() {
        let base = if !override_base_url.is_empty() {
            override_base_url.to_string()
        } else {
            settings.provider_config.get(credential)
                .and_then(|m| m.get("base_url"))
                .cloned()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| default_base_url(credential))
        };
        return Some(Credentials {
            shape,
            api_key: key,
            base_url: base,
            source: "byok".to_string(),
        });
    }

    // Check uppercase env var
    let env_var_name = format!("{}_API_KEY", credential.to_uppercase());
    if let Ok(tok) = std::env::var(&env_var_name) {
        if !tok.trim().is_empty() {
            let base = if !override_base_url.is_empty() {
                override_base_url.to_string()
            } else {
                std::env::var(format!("{}_BASE_URL", credential.to_uppercase()))
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| default_base_url(credential))
            };
            return Some(Credentials {
                shape,
                api_key: tok,
                base_url: base,
                source: "env".to_string(),
            });
        }
    }

    None
}

/// Hard-coded default base URLs for OpenAI-compatible providers that aren't
/// given a dedicated `resolve` branch. Without these, a user who enters only a
/// Groq/DeepSeek/etc. API key resolves to an empty base_url and every request
/// fails. Mirrors Python's `OPENAI_COMPAT_PROVIDERS` table.
fn default_base_url(credential: &str) -> String {
    match credential {
        "groq" => "https://api.groq.com/openai/v1".to_string(),
        "cerebras" => "https://api.cerebras.ai/v1".to_string(),
        "deepseek" => "https://api.deepseek.com/v1".to_string(),
        "zai" => "https://api.z.ai/api/paas/v4".to_string(),
        "together" => "https://api.together.xyz/v1".to_string(),
        "mistral" => "https://api.mistral.ai/v1".to_string(),
        "perplexity" => "https://api.perplexity.ai".to_string(),
        "fireworks" => "https://api.fireworks.ai/inference/v1".to_string(),
        "openrouter" => "https://openrouter.ai/api/v1".to_string(),
        _ => String::new(),
    }
}

#[derive(Debug, Clone)]
pub struct Credentials {
    pub shape: String,
    pub api_key: String,
    pub base_url: String,
    pub source: String,
}

pub async fn get_providers() -> impl IntoResponse {
    let s = settings::load();
    
    // 1. Build credentials status
    let mut credentials_status = serde_json::Map::new();
    let sources = vec![
        "anthropic",
        "openai",
        "claude_code",
        "zwork_router",
        "groq",
        "cerebras",
        "deepseek",
        "zai",
    ];
    for src in sources {
        let cred = resolve(src, &s, "");
        credentials_status.insert(
            src.to_string(),
            serde_json::json!({
                "configured": cred.is_some(),
                "source": cred.as_ref().map(|c| c.source.clone()),
                "base_url": cred.as_ref().map(|c| c.base_url.clone()),
                "shape": if src == "anthropic" || src == "claude_code" { "anthropic" } else { "openai" },
            }),
        );
    }

    // 2. Build available models list
    // Custom models go first; synthesized claude_code entry goes last so it doesn't
    // hijack the default when the user has real provider models configured.
    let mut models = Vec::new();
    let mut synthesized_cc: Option<serde_json::Value> = None;

    let cc = resolve("claude_code", &s, "");
    if cc.is_some() {
        let existing = s.custom_models.iter().any(|m| m.credential == "claude_code");
        if !existing {
            let cc_model = read_claude_code_model().unwrap_or_default();
            synthesized_cc = Some(serde_json::json!({
                "id": "__claude_code__",
                "name": "Local credentials",
                "subtitle": format!("via {}", cc.as_ref().unwrap().base_url),
                "shape": "anthropic",
                "credential": "claude_code",
                "model_id": if cc_model.is_empty() { "(default)".to_string() } else { cc_model },
                "configured": true,
                "synthesized": true,
            }));
        }
    }

    for m in &s.custom_models {
        let cred = resolve(&m.credential, &s, &m.base_url_override);
        
        let subtitle = if m.credential == "zwork_router" {
            if m.model_id.to_lowercase().contains("vision") {
                "Vision and images".to_string()
            } else if m.model_id.to_lowercase().contains("pro") {
                "Most capable model".to_string()
            } else {
                "Fast and efficient".to_string()
            }
        } else {
            let base = if !m.base_url_override.is_empty() {
                m.base_url_override.clone()
            } else {
                cred.as_ref().map(|c| c.base_url.clone()).unwrap_or_default()
            };
            
            let label = match m.credential.as_str() {
                "anthropic" => "Anthropic",
                "openai" => "OpenAI-compatible",
                "claude_code" => "Local credentials",
                "zwork_router" => "Managed",
                "ollama" => "Ollama",
                "groq" => "Groq",
                "cerebras" => "Cerebras",
                "deepseek" => "DeepSeek",
                "zai" => "z.ai",
                "together" => "Together AI",
                "mistral" => "Mistral",
                "perplexity" => "Perplexity",
                "fireworks" => "Fireworks AI",
                "openrouter" => "OpenRouter",
                other => other,
            };
            
            if !base.is_empty() {
                format!("{} · {}", label, base)
            } else {
                label.to_string()
            }
        };

        models.push(serde_json::json!({
            "id": m.id,
            "name": m.name,
            "subtitle": subtitle,
            "shape": m.shape,
            "credential": m.credential,
            "model_id": m.model_id,
            "base_url_override": m.base_url_override,
            "configured": cred.is_some(),
            "synthesized": false,
        }));
    }

    // Push synthesized claude_code entry last so it doesn't win the default slot
    if let Some(cc_entry) = synthesized_cc {
        models.push(cc_entry);
    }

    // Prefer: 1) saved default_model if valid, 2) first configured model, 3) first model overall
    let default_model = if !s.default_model.is_empty() && models.iter().any(|m| m.get("id").and_then(|v| v.as_str()) == Some(&s.default_model)) {
        s.default_model.clone()
    } else {
        // Pick the first *configured* non-synthesized model, else first overall
        models.iter()
            .find(|m| {
                m.get("configured").and_then(|v| v.as_bool()).unwrap_or(false)
                    && !m.get("synthesized").and_then(|v| v.as_bool()).unwrap_or(false)
            })
            .or_else(|| models.first())
            .and_then(|m| m.get("id").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string()
    };

    Json(serde_json::json!({
        "credentials": credentials_status,
        "models": models,
        "default_model": default_model,
    }))
}


pub async fn get_settings() -> impl IntoResponse {
    let s = settings::load();
    Json(settings::public_view(&s))
}

/// Accepts a **partial** settings patch and merges it into the existing persisted settings.
/// Sending only `{ "api_keys": { "zwork_router": "tok" } }` will NOT wipe other fields.
#[derive(serde::Deserialize, Default)]
pub struct SettingsPatch {
    pub api_keys: Option<std::collections::HashMap<String, String>>,
    pub provider_config: Option<std::collections::HashMap<String, std::collections::HashMap<String, String>>>,
    pub default_model: Option<String>,
    pub use_claude_code_config: Option<bool>,
    pub telemetry_enabled: Option<bool>,
    pub telegram_chat_id: Option<String>,
    /// Synced from the cloud session (`CloudUser.tier`) by the desktop app.
    /// The sidecar uses it to enforce the free-tier scheduled-task cap.
    pub account_tier: Option<String>,
}

pub async fn put_settings(Json(patch): Json<SettingsPatch>) -> impl IntoResponse {
    let mut s = settings::load();

    // Merge api_keys: only update keys that are explicitly provided
    if let Some(keys) = patch.api_keys {
        for (k, v) in keys {
            s.api_keys.insert(k, v);
        }
    }

    // Merge provider_config: deep merge — update only the sub-maps provided
    if let Some(pc) = patch.provider_config {
        for (provider, cfg) in pc {
            let entry = s.provider_config.entry(provider).or_default();
            for (k, v) in cfg {
                entry.insert(k, v);
            }
        }
    }

    if let Some(dm) = patch.default_model {
        s.default_model = dm;
    }
    if let Some(ucc) = patch.use_claude_code_config {
        s.use_claude_code_config = ucc;
    }
    if let Some(te) = patch.telemetry_enabled {
        s.telemetry_enabled = te;
    }
    if let Some(chat_id) = patch.telegram_chat_id {
        s.telegram_chat_id = chat_id;
    }
    if let Some(tier) = patch.account_tier {
        // Normalize: accept cloud-tier values, default anything odd to "free".
        let t = tier.to_ascii_lowercase();
        s.account_tier = match t.as_str() {
            "pro" | "max" => t,
            _ => "free".to_string(),
        };
    }

    settings::save(&mut s);
    Json(settings::public_view(&s))
}

// SettingsPublic mirrors the public view of settings (API keys masked)
#[derive(Serialize)]
pub struct SettingsPublic {
    pub default_model: String,
    pub use_claude_code_config: bool,
    pub telemetry_enabled: bool,
    pub api_keys: HashMap<String, String>,
    pub provider_config: HashMap<String, HashMap<String, String>>,
    pub custom_models: Vec<settings::CustomModel>,
    pub telegram_chat_id: String,
    pub account_tier: String,
}

pub async fn list_chats() -> impl IntoResponse {
    let list = chatstore::list_all();
    Json(serde_json::json!({ "chats": list }))
}

pub async fn create_chat(Json(req): Json<CreateChatRequest>) -> impl IntoResponse {
    let title = req.title.unwrap_or_else(|| "New chat".to_string());
    let model = req.model.unwrap_or_default();
    let project_id = req.project_id.unwrap_or_default();
    
    let chat = chatstore::create(&title, &model, &project_id);
    Json(chat)
}

pub async fn get_chat(Path(chat_id): Path<String>) -> impl IntoResponse {
    match chatstore::get(&chat_id) {
        Some(chat) => Json(json!(chat)),
        None => Json(json!({ "error": "Chat not found" })),
    }
}

pub async fn patch_chat(
    Path(chat_id): Path<String>,
    Json(req): Json<PatchChatRequest>,
) -> impl IntoResponse {
    let mut chat = match chatstore::get(&chat_id) {
        Some(c) => c,
        None => return Json(json!({ "error": "Chat not found" })),
    };
    
    if let Some(ref title) = req.title {
        chat.title = title.clone();
    }
    if let Some(ref proj) = req.project_id {
        chat.project_id = proj.clone();
    }
    
    chatstore::save(&chat);
    Json(json!(chat))
}

pub async fn delete_chat(Path(chat_id): Path<String>) -> impl IntoResponse {
    let ok = chatstore::delete(&chat_id);
    Json(json!({ "success": ok }))
}

pub async fn patch_message(
    Path((chat_id, message_id)): Path<(String, String)>,
    Json(req): Json<PatchMessageRequest>,
) -> impl IntoResponse {
    let updated = chatstore::update_message(&chat_id, &message_id, req.content, req.activities);
    Json(json!({ "success": updated.is_some(), "message": updated }))
}

pub async fn stop_chat(Path(chat_id): Path<String>) -> impl IntoResponse {
    let stopped = crate::watchdog::cancel_run(&chat_id);
    Json(json!({ "success": stopped }))
}

pub async fn approve_gate(Path((_chat_id, gate_id)): Path<(String, String)>) -> impl IntoResponse {
    let ok = crate::agent::approve_gate(&gate_id);
    Json(json!({ "success": ok }))
}

pub async fn reject_gate(Path((_chat_id, gate_id)): Path<(String, String)>) -> impl IntoResponse {
    let ok = crate::agent::reject_gate(&gate_id);
    Json(json!({ "success": ok }))
}

// SSE Chat Stream Endpoint
pub async fn chat_stream_route(
    Json(req): Json<ChatStreamRequest>,
) -> impl IntoResponse {
    let chat_id = req.chat_id.unwrap_or_else(|| {
        let title = req.new_chat_title.as_deref().unwrap_or("New chat");
        let chat = chatstore::create(
            title,
            &req.model.clone().unwrap_or_default(),
            &req.project_id.clone().unwrap_or_default(),
        );
        chat.id
    });

    let model_id = req.model.unwrap_or_else(|| "deepseek-v4-flash".to_string());
    let project_id = req.project_id.unwrap_or_default();

    // Plan mode can be toggled by the explicit flag OR by keywords in the
    // message ("plan a feature", "create a plan", …). Mirrors the Python
    // backend so the same phrasings auto-enter plan mode.
    let mut plan_mode = req.plan_mode;
    if !plan_mode {
        let msg_lower = req.message.to_lowercase();
        const PLAN_KEYWORDS: &[&str] = &[
            "plan a ", "plan an ", "plan feature", "create a plan",
            "make a plan", "plan mode", "planda", "planla",
        ];
        if PLAN_KEYWORDS.iter().any(|k| msg_lower.contains(k)) {
            plan_mode = true;
        }
    }

    let stream = run_agent_turn(
        chat_id,
        req.run_id,
        model_id,
        req.message,
        req.attachments,
        project_id,
        plan_mode,
        req.auto_approve_destructive,
        req.artifact_mode,
        req.web_search_enabled,
        None,
    );

    // Map Value to Event
    let mapped = stream.map(|res| {
        let val = res.unwrap_or_default();
        let s = serde_json::to_string(&val).unwrap_or_default();
        Ok::<Event, Infallible>(Event::default().data(s))
    });

    Sse::new(mapped).keep_alive(axum::response::sse::KeepAlive::default())
}

// Onboarding Structs and Handlers

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct OnboardAnswer {
    pub key: String,
    pub question: String,
    pub answer: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct CredentialPayload {
    pub shape: Option<String>,
    pub credential: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model_id: Option<String>,
    pub model_name: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct OnboardBody {
    pub answers: Vec<OnboardAnswer>,
    pub credential: Option<CredentialPayload>,
    pub telemetry_enabled: Option<bool>,
}

pub async fn onboard_status() -> impl IntoResponse {
    let p = crate::paths::onboarding_path();
    let mut val = if p.exists() {
        let content = std::fs::read_to_string(&p).unwrap_or_default();
        serde_json::from_str::<Value>(&content).unwrap_or(json!({ "completed": false }))
    } else {
        json!({ "completed": false })
    };
    
    if let Some(obj) = val.as_object_mut() {
        obj.insert("zwork_md_exists".to_string(), json!(crate::paths::zwork_md_path().exists()));
    }
    Json(val)
}

pub async fn onboard_skip() -> impl IntoResponse {
    let p = crate::paths::onboarding_path();
    let _ = std::fs::write(&p, json!({ "completed": true, "skipped": true }).to_string());
    Json(json!({ "ok": true }))
}

pub async fn onboard_complete(Json(body): Json<OnboardBody>) -> impl IntoResponse {
    // 1. Save provider credential if present
    if let Some(cred) = body.credential {
        let mut s = settings::load();
        let shape = cred.shape.unwrap_or_else(|| "openai".to_string());
        let credkey = cred.credential.unwrap_or_else(|| "openai".to_string());
        let api_key = cred.api_key.unwrap_or_default();
        let base_url = cred.base_url.unwrap_or_default();
        let model_id = cred.model_id.unwrap_or_default();
        let model_name = cred.model_name.unwrap_or_else(|| model_id.clone());

        if !api_key.is_empty() {
            s.api_keys.insert(credkey.clone(), api_key);
        }
        if !base_url.is_empty() {
            s.provider_config
                .entry(credkey.clone())
                .or_insert_with(std::collections::HashMap::new)
                .insert("base_url".to_string(), base_url.clone());
        }
        if !model_id.is_empty() {
            let custom_id = if credkey == "zwork_router"
                || model_id == "zwork-flash"
                || model_id == "zwork-pro"
            {
                Some(model_id.clone())
            } else {
                None
            };
            
            let is_safe = custom_id.as_ref().map(|id| crate::paths::is_safe_id(id)).unwrap_or(true);
            if is_safe {
                let m = settings::upsert_custom_model(
                    &mut s,
                    custom_id,
                    model_name,
                    shape,
                    credkey,
                    model_id,
                    base_url,
                );
                s.default_model = m.id;
            }
        }
        if let Some(tel) = body.telemetry_enabled {
            s.telemetry_enabled = tel;
        }
        settings::save(&mut s);
    }

    // 2. Build zwork.md personalization instructions
    let mut preferred_name = String::new();
    for ans in &body.answers {
        if ans.key == "name" || ans.key == "preferred_name" {
            preferred_name = ans.answer.trim().to_string();
            break;
        }
    }
    if preferred_name.is_empty() {
        preferred_name = "rWork User".to_string();
    }

    // Map answers by key
    let mut by_key = std::collections::HashMap::new();
    let mut qna_lines = Vec::new();
    for ans in &body.answers {
        if !ans.answer.trim().is_empty() {
            by_key.insert(ans.key.clone(), ans.answer.clone());
            qna_lines.push(format!("- {}\n  → {}", ans.question, ans.answer));
        }
    }

    let vibe = by_key.get("vibe").cloned().unwrap_or_else(|| "Balanced".to_string());
    let verbosity = by_key.get("verbosity").cloned().unwrap_or_else(|| "Balanced".to_string());
    let decisions = by_key.get("decisions").cloned().unwrap_or_else(|| "Balanced".to_string());
    let profession = by_key.get("profession").cloned().unwrap_or_else(|| "".to_string());
    let goal = by_key.get("goal").cloned().unwrap_or_else(|| "".to_string());

    let decisions_lower = decisions.to_lowercase();
    let decision_behavior = if decisions_lower.contains("walk") {
        "walk me through each decision briefly"
    } else {
        "just pick sensible defaults and act"
    };

    let md = format!(
        "# zWork personalization\n\n\
         ## About the user\n\n\
         - Name: {}\n\
         - Profession: {}\n\
         - Long-term goal: {}\n\n\
         ## Preferences\n\n\
         - Vibe: **{}**\n\
         - Verbosity: **{}**\n\
         - Decision style: **{}**\n\n\
         ## How to talk to me\n\n\
         - Match the **{}** tone — no filler, no over-explaining.\n\
         - Default reply length: **{}**.\n\
         - For multi-step work: {}.\n\
         - Address me by my first name occasionally, never overdone.\n\
         - Prioritize action and shipping over meta-discussion.\n\n\
         ---\n\n\
         ## Raw onboarding answers (for reference)\n\n\
         {}\n",
        preferred_name,
        if profession.is_empty() { "(not specified)" } else { &profession },
        if goal.is_empty() { "(not specified)" } else { &goal },
        vibe,
        verbosity,
        decisions,
        vibe,
        verbosity,
        decision_behavior,
        qna_lines.join("\n")
    );

    let zmd_path = crate::paths::zwork_md_path();
    if let Some(parent) = zmd_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&zmd_path, md);

    // 3. Write onboarding complete file
    let onboarding_json = json!({
        "completed": true,
        "skipped": false,
        "display_name": preferred_name,
        "answers": body.answers,
        "zwork_md_path": zmd_path.to_string_lossy().to_string()
    });

    let p = crate::paths::onboarding_path();
    let _ = std::fs::write(&p, onboarding_json.to_string());

    Json(json!({ "ok": true }))
}

pub async fn list_skills() -> impl IntoResponse {
    let list = crate::skills::list_skills();
    let serialized: Vec<serde_json::Value> = list.into_iter().map(|s| {
        serde_json::json!({
            "slug": s.slug,
            "name": s.name,
            "description": s.description,
            "path": s.path.to_string_lossy().to_string()
        })
    }).collect();
    Json(serde_json::json!({ "skills": serialized }))
}

pub async fn list_projects() -> impl IntoResponse {
    let projects_dir = crate::paths::projects_dir();
    let mut projects = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            let meta_path = entry.path().join("project.json");
            if let Ok(content) = std::fs::read_to_string(&meta_path) {
                if let Ok(proj) = serde_json::from_str::<serde_json::Value>(&content) {
                    projects.push(proj);
                }
            }
        }
    }

    // Sort by created_at descending
    projects.sort_by(|a, b| {
        let ta = a.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0);
        let tb = b.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0);
        tb.cmp(&ta)
    });

    Json(serde_json::json!({ "projects": projects }))
}

#[derive(Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
}

pub async fn create_project(Json(req): Json<CreateProjectRequest>) -> impl IntoResponse {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let now = chrono::Utc::now().timestamp_millis();

    let project = serde_json::json!({
        "id": id,
        "name": req.name,
        "description": req.description,
        "icon": req.icon,
        "created_at": now,
        "updated_at": now,
        "chat_ids": [],
    });

    let dir = crate::paths::project_dir(&id);
    let _ = std::fs::create_dir_all(&dir);
    let meta_path = dir.join("project.json");
    let _ = std::fs::write(&meta_path, serde_json::to_string_pretty(&project).unwrap_or_default());

    Json(serde_json::json!({ "project": project }))
}

#[derive(Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub starred: Option<bool>,
    pub icon: Option<String>,
}

pub async fn update_project(
    Path(project_id): Path<String>,
    Json(req): Json<UpdateProjectRequest>,
) -> impl IntoResponse {
    let dir = crate::paths::project_dir(&project_id);
    let meta_path = dir.join("project.json");

    let mut project = match std::fs::read_to_string(&meta_path) {
        Ok(content) => serde_json::from_str::<serde_json::Value>(&content).unwrap_or_default(),
        Err(_) => return Json(json!({ "error": "Project not found" })),
    };

    if let Some(name) = req.name {
        project["name"] = json!(name);
    }
    if let Some(desc) = req.description {
        project["description"] = json!(desc);
    }
    if let Some(starred) = req.starred {
        project["starred"] = json!(starred);
    }
    if let Some(icon) = req.icon {
        project["icon"] = json!(icon);
    }
    project["updated_at"] = json!(chrono::Utc::now().timestamp_millis());

    let _ = std::fs::write(&meta_path, serde_json::to_string_pretty(&project).unwrap_or_default());

    Json(json!({ "project": project }))
}

pub async fn delete_project(Path(project_id): Path<String>) -> impl IntoResponse {
    let dir = crate::paths::project_dir(&project_id);
    if !dir.exists() {
        return Json(json!({ "ok": false, "error": "Project not found" }));
    }
    match std::fs::remove_dir_all(&dir) {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

pub async fn get_project_context(Path(project_id): Path<String>) -> impl IntoResponse {
    let dir = crate::paths::project_dir(&project_id);
    let ctx_path = dir.join("context.md");
    let content = std::fs::read_to_string(&ctx_path).unwrap_or_default();
    Json(json!({ "content": content }))
}

pub async fn put_project_context(
    Path(project_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let dir = crate::paths::project_dir(&project_id);
    let _ = std::fs::create_dir_all(&dir);
    let ctx_path = dir.join("context.md");
    let content = body.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let _ = std::fs::write(&ctx_path, content);
    Json(json!({ "ok": true }))
}

pub async fn list_integrations() -> impl IntoResponse {
    let mut integrations: Vec<serde_json::Value> = Vec::new();

    // Detect Claude Code (claude CLI + ~/.claude/settings.json)
    let claude_path = which_tool("claude");
    let cc_settings = dirs::home_dir()
        .map(|h| h.join(".claude").join("settings.json"))
        .filter(|p| p.exists());
    let cc_detected = claude_path.is_some() || cc_settings.is_some();
    let cc_can_reuse = cc_settings.is_some();
    let cc_detail = if cc_can_reuse {
        format!(
            "claude CLI detected{}. Credentials available in ~/.claude/settings.json.",
            claude_path.as_deref().map(|p| format!(" at {p}")).unwrap_or_default()
        )
    } else if cc_detected {
        "claude CLI detected but no ~/.claude/settings.json found.".to_string()
    } else {
        "Claude Code is not installed on this machine.".to_string()
    };
    integrations.push(serde_json::json!({
        "id": "claude_code",
        "name": "Claude Code",
        "detected": cc_detected,
        "can_reuse_credentials": cc_can_reuse,
        "detail": cc_detail,
        "path": claude_path.unwrap_or_default(),
    }));

    // Detect Ollama
    let ollama_path = which_tool("ollama");
    let ollama_detected = ollama_path.is_some();
    integrations.push(serde_json::json!({
        "id": "ollama",
        "name": "Ollama",
        "detected": ollama_detected,
        "can_reuse_credentials": false,
        "detail": if ollama_detected {
            format!("Ollama detected{}. Add models via Settings → Models.", ollama_path.as_deref().map(|p| format!(" at {p}")).unwrap_or_default())
        } else {
            "Ollama is not installed on this machine.".to_string()
        },
        "path": ollama_path.unwrap_or_default(),
    }));

    // Detect OpenAI Codex CLI (~/.codex/)
    let codex_dir = dirs::home_dir().map(|h| h.join(".codex")).filter(|p| p.exists());
    integrations.push(serde_json::json!({
        "id": "codex",
        "name": "OpenAI Codex CLI",
        "detected": codex_dir.is_some(),
        "can_reuse_credentials": false,
        "detail": if codex_dir.is_some() {
            "Codex CLI config detected at ~/.codex/.".to_string()
        } else {
            "Codex CLI is not installed.".to_string()
        },
        "path": codex_dir.map(|p| p.display().to_string()).unwrap_or_default(),
    }));

    // Detect GitHub Copilot (~/.config/github-copilot/)
    let copilot_dir = dirs::home_dir()
        .map(|h| h.join(".config").join("github-copilot"))
        .filter(|p| p.exists());
    integrations.push(serde_json::json!({
        "id": "github_copilot",
        "name": "GitHub Copilot",
        "detected": copilot_dir.is_some(),
        "can_reuse_credentials": false,
        "detail": if copilot_dir.is_some() {
            "GitHub Copilot config detected at ~/.config/github-copilot/.".to_string()
        } else {
            "GitHub Copilot is not signed in on this machine.".to_string()
        },
        "path": copilot_dir.map(|p| p.display().to_string()).unwrap_or_default(),
    }));

    // Detect MLX (Apple Silicon local runtime). Only meaningful on arm64 macOS.
    if cfg!(target_arch = "aarch64") && cfg!(target_os = "macos") {
        let mlx_dir = dirs::home_dir().map(|h| h.join(".mlx")).filter(|p| p.exists());
        let mlx_detected = mlx_dir.is_some();
        integrations.push(serde_json::json!({
            "id": "mlx",
            "name": "MLX (Apple Silicon)",
            "detected": mlx_detected,
            "can_reuse_credentials": false,
            "detail": if mlx_detected {
                "MLX runtime detected. Local models are available on this Apple Silicon Mac.".to_string()
            } else {
                "MLX runtime not detected. Install mlx-lm to run local models.".to_string()
            },
            "path": mlx_dir.map(|p| p.display().to_string()).unwrap_or_default(),
        }));
    }

    Json(serde_json::json!({ "integrations": integrations }))
}

fn which_tool(name: &str) -> Option<String> {
    let output = std::process::Command::new("which")
        .arg(name)
        .output()
        .ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Some(path);
        }
    }
    None
}

#[derive(Deserialize)]
pub struct UpsertCustomModelRequest {
    pub id: Option<String>,
    pub name: String,
    pub shape: String,
    pub credential: String,
    pub model_id: String,
    #[serde(default)]
    pub base_url_override: String,
}

pub async fn list_custom_models() -> impl IntoResponse {
    let s = settings::load();
    Json(json!({ "custom_models": s.custom_models }))
}

pub async fn upsert_custom_model(
    Json(req): Json<UpsertCustomModelRequest>,
) -> impl IntoResponse {
    let id_opt = req.id.clone();
    if let Some(ref id) = id_opt {
        if !crate::paths::is_safe_id(id) {
            return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid model_id" }))).into_response();
        }
    }

    // Validate shape + credential so garbage values can't be persisted. The
    // Python backend rejected these with a 400; without this, a bad shape
    // silently produces malformed provider requests later.
    let valid_shapes = ["anthropic", "openai"];
    if !valid_shapes.contains(&req.shape.as_str()) {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({
            "error": format!("invalid shape '{}': must be one of {:?}", req.shape, valid_shapes)
        }))).into_response();
    }
    if !settings::KNOWN_CREDENTIALS.contains(&req.credential.as_str()) {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({
            "error": format!("invalid credential '{}': must be one of {:?}", req.credential, settings::KNOWN_CREDENTIALS)
        }))).into_response();
    }

    let mut s = settings::load();
    let m = settings::upsert_custom_model(
        &mut s,
        id_opt,
        req.name,
        req.shape,
        req.credential,
        req.model_id,
        req.base_url_override,
    );
    settings::save(&mut s);
    
    Json(json!({
        "custom_models": s.custom_models,
        "id": m.id,
    })).into_response()
}

pub async fn delete_custom_model(
    Path(model_id): Path<String>,
) -> impl IntoResponse {
    if !crate::paths::is_safe_id(&model_id) {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid model_id" }))).into_response();
    }
    
    let mut s = settings::load();
    let ok = settings::remove_custom_model(&mut s, &model_id);
    if !ok {
        return (axum::http::StatusCode::NOT_FOUND, Json(json!({ "error": "model not found" }))).into_response();
    }
    
    if s.default_model == model_id {
        s.default_model = String::new();
    }
    settings::save(&mut s);
    
    Json(json!({
        "custom_models": s.custom_models,
    })).into_response()
}

// ─── Memory / User MD ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ContentBody {
    pub content: String,
}

#[derive(Deserialize)]
pub struct TelegramSendBody {
    pub text: String,
}

pub async fn get_memory() -> impl IntoResponse {
    // The agent reads `memories/MEMORY.md`, so the UI must too — otherwise
    // edits land in a file the agent never consults. Fall back to the legacy
    // `memory.md` for users upgrading from the Python backend.
    let path = crate::paths::memory_md_path();
    let content = std::fs::read_to_string(&path)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| std::fs::read_to_string(crate::paths::memory_path()).unwrap_or_default());
    Json(json!({ "content": content }))
}

pub async fn put_memory(Json(body): Json<ContentBody>) -> impl IntoResponse {
    // Write to `memories/MEMORY.md` — the file the agent actually loads.
    let p = crate::paths::memory_md_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&p, &body.content);
    Json(json!({ "ok": true }))
}

pub async fn get_user_md() -> impl IntoResponse {
    let content = std::fs::read_to_string(crate::paths::zwork_md_path()).unwrap_or_default();
    Json(json!({ "content": content }))
}

pub async fn put_user_md(Json(body): Json<ContentBody>) -> impl IntoResponse {
    let p = crate::paths::zwork_md_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&p, &body.content);
    Json(json!({ "ok": true }))
}

pub async fn telegram_send(Json(body): Json<TelegramSendBody>) -> impl IntoResponse {
    match crate::telegram::send_message_from_settings(&body.text).await {
        Ok(msg) => Json(json!({ "ok": true, "message": msg })).into_response(),
        Err(e) => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e }))
        ).into_response(),
    }
}

// ─── Telemetry ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TelemetryEventBody {
    pub event: String,
    pub session_id: Option<String>,
    pub properties: Option<Value>,
    pub ts: Option<u64>,
}

pub async fn telemetry_event(Json(body): Json<TelemetryEventBody>) -> impl IntoResponse {
    let s = settings::load();
    if !s.telemetry_enabled {
        return Json(json!({ "ok": true }));
    }

    let entry = json!({
        "event": body.event,
        "session_id": body.session_id,
        "properties": body.properties,
        "ts": body.ts.unwrap_or_else(|| {
            chrono::Utc::now().timestamp_millis() as u64
        }),
    });

    // Append JSONL line
    let log_path = crate::paths::telemetry_log_path();
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "{}", entry)
        });

    // Fire-and-forget to external endpoint if configured
    if let Ok(endpoint) = std::env::var("ZW_TELEMETRY_ENDPOINT") {
        if !endpoint.is_empty() {
            let _ = tokio::spawn(async move {
                let _ = reqwest::Client::new()
                    .post(&endpoint)
                    .json(&entry)
                    .timeout(std::time::Duration::from_secs(5))
                    .send()
                    .await;
            });
        }
    }

    Json(json!({ "ok": true }))
}

// ─── Chat answer-question ────────────────────────────────────────────────────

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct AnswerQuestionBody {
    pub answer: String,
    /// Optional: the specific question id (from the ask_question SSE event).
    /// When omitted, resolves the chat's most-recently-registered question.
    pub question_id: Option<String>,
}

pub async fn answer_question(
    Path(chat_id): Path<String>,
    Json(body): Json<AnswerQuestionBody>,
) -> impl IntoResponse {
    let ok = crate::agent::answer_pending_question(&chat_id, &body.answer, body.question_id.as_deref());
    Json(json!({ "success": ok }))
}

// ─── Chat truncate ───────────────────────────────────────────────────────────

pub async fn truncate_message(
    Path((chat_id, message_id)): Path<(String, String)>,
    Json(body): Json<PatchMessageRequest>,
) -> impl IntoResponse {
    let result = chatstore::truncate_at_message(&chat_id, &message_id, body.content);
    Json(json!({ "success": result.is_some(), "chat": result }))
}

// ─── Activity logs ───────────────────────────────────────────────────────────

pub async fn activity_logs() -> impl IntoResponse {
    let p = crate::paths::activity_log_path();
    let logs: Vec<Value> = if p.exists() {
        std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };
    Json(json!({ "logs": logs }))
}

// ─── Project extras ───────────────────────────────────────────────────────────

pub async fn get_project_memory(Path(project_id): Path<String>) -> impl IntoResponse {
    let dir = crate::paths::project_dir(&project_id);
    let p = dir.join("project_memory.md");
    let content = std::fs::read_to_string(&p).unwrap_or_default();
    Json(json!({ "content": content }))
}

pub async fn put_project_memory(
    Path(project_id): Path<String>,
    Json(body): Json<ContentBody>,
) -> impl IntoResponse {
    let dir = crate::paths::project_dir(&project_id);
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("project_memory.md"), &body.content);
    Json(json!({ "ok": true }))
}

pub async fn get_project_timeline(Path(project_id): Path<String>) -> impl IntoResponse {
    let dir = crate::paths::project_dir(&project_id);
    let p = dir.join("timeline.md");
    let content = std::fs::read_to_string(&p).unwrap_or_default();
    Json(json!({ "content": content }))
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct UploadItem {
    pub client_id: Option<String>,
    pub name: String,
    #[serde(default = "default_octet_stream")]
    pub mime: String,
    #[serde(default = "default_file_kind")]
    pub kind: String,
    pub text_content: Option<String>,
    pub data_url: Option<String>,
}

fn default_octet_stream() -> String { "application/octet-stream".to_string() }
fn default_file_kind() -> String { "file".to_string() }

#[derive(Deserialize)]
pub struct UploadBody {
    pub files: Vec<UploadItem>,
}

pub async fn list_project_files(Path(project_id): Path<String>) -> impl IntoResponse {
    let dir = crate::paths::project_dir(&project_id).join("files");
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let size = path.metadata().map(|m| m.len()).unwrap_or(0);
            files.push(json!({ "name": name, "size": size }));
        }
    }
    Json(json!({ "files": files }))
}

pub async fn upload_project_files(
    Path(project_id): Path<String>,
    Json(body): Json<UploadBody>,
) -> impl IntoResponse {
    let dir = crate::paths::project_dir(&project_id).join("files");
    let _ = std::fs::create_dir_all(&dir);
    let mut created = Vec::new();
    for item in &body.files {
        let filename = format!("{}_{}", uuid::Uuid::new_v4().simple(), item.name);
        let path = dir.join(&filename);
        if let Some(ref text) = item.text_content {
            let _ = std::fs::write(&path, text);
        } else if let Some(ref data_url) = item.data_url {
            // Decode base64 data URL
            if let Some(b64) = data_url.split(',').nth(1) {
                match standard_b64_decode(b64) {
                    Ok(bytes) => { let _ = std::fs::write(&path, bytes); }
                    Err(_) => continue,
                }
            }
        }
        created.push(json!({ "name": filename, "original_name": item.name }));
    }
    Json(json!({ "files": created }))
}

pub async fn delete_project_file(
    Path((project_id, filename)): Path<(String, String)>,
) -> impl IntoResponse {
    // Prevent path traversal
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Json(json!({ "error": "Invalid filename" }));
    }
    let path = crate::paths::project_dir(&project_id).join("files").join(&filename);
    if path.exists() {
        let _ = std::fs::remove_file(&path);
        Json(json!({ "ok": true }))
    } else {
        Json(json!({ "error": "File not found" }))
    }
}

// ─── Uploads ──────────────────────────────────────────────────────────────────

pub async fn list_uploads() -> impl IntoResponse {
    let dir = crate::paths::workspace_uploads_dir();
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let size = path.metadata().map(|m| m.len()).unwrap_or(0);
            let mime = guess_mime(&name);
            let mut item = json!({ "name": name, "size": size, "mime": mime });
            // Include text preview for small text files
            if size < 100_000 && mime.starts_with("text/") || name.ends_with(".md") || name.ends_with(".json") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    item.as_object_mut().unwrap().insert("content".to_string(), json!(content));
                }
            }
            files.push(item);
        }
    }
    Json(json!({ "files": files }))
}

pub async fn upload_files(Json(body): Json<UploadBody>) -> impl IntoResponse {
    let dir = crate::paths::workspace_uploads_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": format!("Failed to create uploads directory: {}", e) }))).into_response();
    }
    let mut created = Vec::new();
    let mut errors = Vec::new();
    for item in &body.files {
        let id = uuid::Uuid::new_v4().simple();
        let filename = format!("{}_{}", id, sanitize_filename(&item.name));
        let path = dir.join(&filename);

        let write_result = if let Some(ref text) = item.text_content {
            std::fs::write(&path, text)
        } else if let Some(ref data_url) = item.data_url {
            let b64 = match data_url.split(',').nth(1) {
                Some(b) => b,
                None => {
                    errors.push(format!("{}: invalid data URL", item.name));
                    continue;
                }
            };
            match standard_b64_decode(b64) {
                Ok(bytes) => std::fs::write(&path, bytes),
                Err(e) => {
                    errors.push(format!("{}: base64 decode failed: {}", item.name, e));
                    continue;
                }
            }
        } else {
            errors.push(format!("{}: no content provided", item.name));
            continue;
        };

        if let Err(e) = write_result {
            errors.push(format!("{}: write failed: {}", item.name, e));
            continue;
        }

        created.push(json!({
            "id": id.to_string(),
            "client_id": item.client_id,
            "name": item.name,
            "filename": filename,
            "path": path.to_string_lossy(),
            "mime": item.mime,
            "size": path.metadata().map(|m| m.len()).unwrap_or(0),
        }));
    }

    if !errors.is_empty() && created.is_empty() {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": errors.join("; ") }))).into_response();
    }

    Json(json!({ "files": created, "errors": errors })).into_response()
}

pub async fn get_upload(Path(filename): Path<String>) -> impl IntoResponse {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid filename" }))).into_response();
    }
    let path = crate::paths::workspace_uploads_dir().join(&filename);
    if !path.exists() {
        return (axum::http::StatusCode::NOT_FOUND, Json(json!({ "error": "File not found" }))).into_response();
    }
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = guess_mime(&filename);
            (axum::http::StatusCode::OK, [(axum::http::header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

// ─── Utility endpoints ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PythonRunRequest {
    pub code: String,
}

pub async fn run_python(Json(body): Json<PythonRunRequest>) -> impl IntoResponse {
    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("zwork_run_{}.py", uuid::Uuid::new_v4().simple()));
    if let Err(e) = std::fs::write(&tmp_path, &body.code) {
        return Json(json!({ "stdout": "", "stderr": format!("Failed to write temp file: {}", e) }));
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new("python3")
            .arg(&tmp_path)
            .output(),
    ).await;

    let _ = std::fs::remove_file(&tmp_path);

    match result {
        Ok(Ok(output)) => Json(json!({
            "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
            "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        })),
        Ok(Err(e)) => Json(json!({ "stdout": "", "stderr": e.to_string() })),
        Err(_) => Json(json!({ "stdout": "", "stderr": "Execution timed out (10s limit)" })),
    }
}

#[derive(Deserialize)]
pub struct ScrapeRequest {
    pub url: String,
}

pub async fn scrape_url(Json(body): Json<ScrapeRequest>) -> impl IntoResponse {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) zWork/1.0")
        .build()
        .unwrap_or_default();

    match client.get(&body.url).send().await {
        Ok(resp) => {
            let html = resp.text().await.unwrap_or_default();
            let title = extract_html_title(&html);
            let markdown = html_to_markdown(&html);
            Json(json!({ "markdown": markdown, "title": title }))
        }
        Err(e) => Json(json!({ "error": format!("Failed to fetch: {}", e), "markdown": "", "title": "" })),
    }
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct RefactorRequest {
    pub code: String,
    pub instruction: String,
    #[serde(default = "default_clean")]
    pub mode: String,
}

fn default_clean() -> String { "clean".to_string() }

pub async fn refactor_code(Json(body): Json<RefactorRequest>) -> impl IntoResponse {
    // Simple refactor: use LLM with non-streaming call
    let s = settings::load();
    let model_id = if !s.default_model.is_empty() { &s.default_model } else { "deepseek-v4-flash" };

    let (api_key, base_url, shape, real_model) = if let Some(m) = s.custom_models.iter().find(|m| m.id == model_id) {
        let real = if m.model_id.is_empty() { "deepseek-v4-flash".to_string() } else { m.model_id.clone() };
        if let Some(cred) = resolve(&m.credential, &s, &m.base_url_override) {
            (cred.api_key, cred.base_url, m.shape.clone(), real)
        } else {
            return Json(json!({ "error": "No credentials configured for refactoring model" }));
        }
    } else {
        match resolve("zwork_router", &s, "") {
            Some(cred) => (cred.api_key, cred.base_url, "anthropic".to_string(), "deepseek-v4-flash".to_string()),
            None => return Json(json!({ "error": "No model credentials available" })),
        }
    };

    let endpoint = if shape == "anthropic" {
        format!("{}/v1/messages", base_url)
    } else {
        format!("{}/chat/completions", base_url)
    };

    let system = format!(
        "You are a code refactoring assistant. Given code and an instruction, return ONLY a JSON object with keys: refactored_code, explanation, steps (array of strings). No markdown fences.\n\nMODE: {}\nINSTRUCTION: {}",
        body.mode, body.instruction
    );

    let user_msg = format!("MODE: {}\nINSTRUCTION: {}\n\nCode:\n{}", body.mode, body.instruction, body.code);
    let convo = json!([
        {"role": "user", "content": user_msg}
    ]);

    let req_body = if shape == "anthropic" {
        json!({ "model": real_model, "system": system, "messages": convo, "max_tokens": 4096 })
    } else {
        let mut msgs = vec![json!({"role": "system", "content": system})];
        if let Some(arr) = convo.as_array() { msgs.extend(arr.clone()); }
        json!({ "model": real_model, "messages": msgs, "max_tokens": 4096 })
    };

    let client = reqwest::Client::new();
    let mut req = client.post(&endpoint).json(&req_body);
    if shape == "anthropic" {
        req = req.header("x-api-key", &api_key).header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("authorization", format!("Bearer {}", api_key));
    }

    match req.send().await {
        Ok(resp) => {
            let text = resp.text().await.unwrap_or_default();
            // Try to extract the content from the response
            if let Ok(val) = serde_json::from_str::<Value>(&text) {
                let content = if shape == "anthropic" {
                    val.get("content").and_then(|c| c.get(0)).and_then(|c| c.get("text")).and_then(|t| t.as_str()).unwrap_or(&text).to_string()
                } else {
                    val.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|t| t.as_str()).unwrap_or(&text).to_string()
                };
                // Try parsing as JSON, strip markdown fences if present
                let cleaned = content.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
                if let Ok(parsed) = serde_json::from_str::<Value>(cleaned) {
                    Json(parsed)
                } else {
                    Json(json!({ "refactored_code": content, "explanation": "", "steps": [] }))
                }
            } else {
                Json(json!({ "error": "Failed to parse LLM response", "raw": text }))
            }
        }
        Err(e) => Json(json!({ "error": format!("LLM request failed: {}", e) })),
    }
}

#[derive(Deserialize)]
pub struct ExportRequest {
    pub content: String,
    #[serde(default = "default_export_title")]
    pub title: String,
}

fn default_export_title() -> String { "Document".to_string() }

/// Render a Rust string as a Python single-quoted literal (escaping backslash
/// and quote) so it can be interpolated safely into an inline `python3 -c`
/// script — used by the export handlers to inject the document title.
fn python_str_lit(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{}'", escaped)
}

pub async fn export_docx(Json(body): Json<ExportRequest>) -> impl IntoResponse {
    // Use Python to convert markdown → docx via python-docx
    // Script and command block removed

    // Simpler approach: write to temp file, run python, read result
    let tmp_md = std::env::temp_dir().join(format!("zwork_export_{}.md", uuid::Uuid::new_v4().simple()));
    let tmp_docx = tmp_md.with_extension("docx");
    let _ = std::fs::write(&tmp_md, &body.content);

    let script = format!(r#"
from docx import Document
from docx.shared import Pt
import re
doc = Document()
doc.add_heading({}, level=0)
in_code = False
code_buf = []
with open('{}') as f:
    for line in f:
        line = line.rstrip('\n')
        stripped = line.strip()
        if stripped.startswith('```'):
            if in_code:
                p = doc.add_paragraph('\n'.join(code_buf))
                for run in p.runs:
                    run.font.name = 'Courier New'
                    run.font.size = Pt(9)
                code_buf = []
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_buf.append(line)
            continue
        if line.startswith('# '): doc.add_heading(line[2:], level=1)
        elif line.startswith('## '): doc.add_heading(line[3:], level=2)
        elif line.startswith('### '): doc.add_heading(line[4:], level=3)
        elif re.match(r'^[-*]\s+\[[ xX]\]\s', line):
            text = re.sub(r'^[-*]\s+\[[ xX]\]\s+', '', line)
            doc.add_paragraph(('☑ ' if line.lower().startswith(('- [x]', '* [x]')) else '☐ ') + text)
        elif line.startswith('- ') or line.startswith('* '): doc.add_paragraph(line[2:], style='List Bullet')
        elif re.match(r'^\d+\.\s', line): doc.add_paragraph(re.sub(r'^\d+\.\s', '', line), style='List Number')
        elif stripped == '': pass
        else: doc.add_paragraph(line)
if code_buf:
    p = doc.add_paragraph('\n'.join(code_buf))
    for run in p.runs:
        run.font.name = 'Courier New'
doc.save('{}')
"#, python_str_lit(&body.title), tmp_md.display(), tmp_docx.display());

    let result = tokio::process::Command::new("python3")
        .arg("-c")
        .arg(&script)
        .output()
        .await;

    let _ = std::fs::remove_file(&tmp_md);

    match result {
        Ok(output) if output.status.success() && tmp_docx.exists() => {
            match std::fs::read(&tmp_docx) {
                Ok(bytes) => {
                    let _ = std::fs::remove_file(&tmp_docx);
                    let b64 = standard_b64_encode(&bytes);
                    Json(json!({ "data": format!("data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,{}", b64), "filename": format!("{}.docx", body.title) }))
                }
                Err(e) => Json(json!({ "error": format!("Failed to read docx: {}", e) })),
            }
        }
        Ok(output) => {
            let _ = std::fs::remove_file(&tmp_docx);
            Json(json!({ "error": String::from_utf8_lossy(&output.stderr).to_string() }))
        }
        Err(e) => Json(json!({ "error": format!("Failed to run python: {}", e) })),
    }
}

pub async fn export_pdf(Json(body): Json<ExportRequest>) -> impl IntoResponse {
    let tmp_md = std::env::temp_dir().join(format!("zwork_export_{}.md", uuid::Uuid::new_v4().simple()));
    let tmp_pdf = tmp_md.with_extension("pdf");
    let _ = std::fs::write(&tmp_md, &body.content);

    let script = format!(r#"
from fpdf import FPDF
import re
pdf = FPDF()
pdf.add_page()
pdf.set_auto_page_break(auto=True, margin=15)
pdf.set_font('Helvetica', 'B', 18)
pdf.cell(0, 12, {}, ln=True)
pdf.ln(2)
in_code = False
code_buf = []
with open('{}') as f:
    for line in f:
        line = line.rstrip('\n')
        stripped = line.strip()
        if stripped.startswith('```'):
            if in_code:
                pdf.set_font('Courier', '', 9)
                pdf.multi_cell(0, 4, '\n'.join(code_buf))
                code_buf = []
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_buf.append(line)
            continue
        if line.startswith('# '): pdf.set_font('Helvetica', 'B', 16); pdf.cell(0, 10, line[2:], ln=True)
        elif line.startswith('## '): pdf.set_font('Helvetica', 'B', 14); pdf.cell(0, 8, line[3:], ln=True)
        elif line.startswith('### '): pdf.set_font('Helvetica', 'B', 12); pdf.cell(0, 7, line[4:], ln=True)
        elif re.match(r'^[-*]\s+\[[ xX]\]\s', line):
            mark = 'x' if line.lower().startswith(('- [x]', '* [x]')) else ' '
            text = re.sub(r'^[-*]\s+\[[ xX]\]\s+', '', line)
            pdf.set_font('Helvetica', '', 10); pdf.multi_cell(0, 5, '[' + mark + '] ' + text)
        elif line.startswith('- ') or line.startswith('* '):
            pdf.set_font('Helvetica', '', 10); pdf.multi_cell(0, 5, '\u2022 ' + line[2:])
        elif re.match(r'^\d+\.\s', line):
            pdf.set_font('Helvetica', '', 10); pdf.multi_cell(0, 5, re.sub(r'^(\d+\.)\s', r'\1 ', line))
        else: pdf.set_font('Helvetica', '', 10); pdf.multi_cell(0, 5, line)
if code_buf:
    pdf.set_font('Courier', '', 9)
    pdf.multi_cell(0, 4, '\n'.join(code_buf))
pdf.output('{}')
"#, python_str_lit(&body.title), tmp_md.display(), tmp_pdf.display());

    let result = tokio::process::Command::new("python3")
        .arg("-c")
        .arg(&script)
        .output()
        .await;

    let _ = std::fs::remove_file(&tmp_md);

    match result {
        Ok(output) if output.status.success() && tmp_pdf.exists() => {
            match std::fs::read(&tmp_pdf) {
                Ok(bytes) => {
                    let _ = std::fs::remove_file(&tmp_pdf);
                    let b64 = standard_b64_encode(&bytes);
                    Json(json!({ "data": format!("data:application/pdf;base64,{}", b64), "filename": format!("{}.pdf", body.title) }))
                }
                Err(e) => Json(json!({ "error": format!("Failed to read pdf: {}", e) })),
            }
        }
        Ok(output) => {
            let _ = std::fs::remove_file(&tmp_pdf);
            Json(json!({ "error": String::from_utf8_lossy(&output.stderr).to_string() }))
        }
        Err(e) => Json(json!({ "error": format!("Failed to run python: {}", e) })),
    }
}

pub async fn screenshot() -> impl IntoResponse {
    // Use zbctl to capture the browser screenshot
    match crate::zbctl::screenshot().await {
        Ok(result) => {
            // zbctl returns a JSON object with dataUrl field
            if let Ok(val) = serde_json::from_str::<Value>(&result) {
                let data_url = val.get("dataUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&result)
                    .to_string();
                let filename = format!("screenshot_{}.png", chrono::Utc::now().timestamp_millis());
                let upload_dir = crate::paths::workspace_uploads_dir();
                let _ = std::fs::create_dir_all(&upload_dir);

                // Extract the base64 payload from a data URL. Handles any media
                // type (data:image/png;base64, …, data:image/jpeg;base64, …) by
                // splitting on the ";base64," marker. Falls back to the raw
                // string if this isn't a data URL at all.
                let b64_data = match data_url.split_once(";base64,") {
                    Some((_, payload)) => payload,
                    None => &data_url,
                };
                
                match standard_b64_decode(b64_data) {
                    Ok(bytes) => {
                        let save_path = upload_dir.join(&filename);
                        let _ = std::fs::write(&save_path, &bytes);
                        Json(json!({
                            "screenshot": data_url,
                            "path": save_path.to_string_lossy(),
                            "filename": filename,
                        }))
                    }
                    Err(e) => Json(json!({ "error": format!("Failed to decode screenshot: {}", e) })),
                }
            } else {
                Json(json!({ "error": "Invalid screenshot response from zbctl" }))
            }
        }
        Err(e) => Json(json!({ "error": format!("Screenshot failed (is zbctl running with Chrome connected?): {}", e) })),
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn standard_b64_decode(input: &str) -> Result<Vec<u8>, String> {
    // Manual base64 decode without adding a dependency
    let trimmed = input.trim().replace('\n', "").replace('\r', "").replace(' ', "");
    let decoded = base64_decode_bytes(trimmed.as_bytes());
    decoded.ok_or_else(|| "Invalid base64".to_string())
}

fn standard_b64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    let chunks = input.chunks(3);
    for chunk in chunks {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 { result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char); } else { result.push('='); }
        if chunk.len() > 2 { result.push(CHARS[(triple & 0x3F) as usize] as char); } else { result.push('='); }
    }
    result
}

fn base64_decode_bytes(input: &[u8]) -> Option<Vec<u8>> {
    const TABLE: [i8; 256] = [
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
        52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
        -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
        15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
        -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
        41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    ];
    let mut result = Vec::new();
    let input: Vec<u8> = input.iter().filter(|&&b| b != b'=' && b != b'\n' && b != b'\r' && b != b' ').copied().collect();
    let chunks = input.chunks(4);
    for chunk in chunks {
        let mut acc: u32 = 0;
        let mut bits = 0;
        for &b in chunk {
            let v = TABLE[b as usize];
            if v < 0 { return None; }
            acc = (acc << 6) | (v as u32);
            bits += 6;
        }
        while bits >= 8 {
            bits -= 8;
            result.push((acc >> bits) as u8);
        }
    }
    Some(result)
}

fn guess_mime(filename: &str) -> String {
    let lower = filename.to_lowercase();
    if lower.ends_with(".png") { "image/png".to_string() }
    else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg".to_string() }
    else if lower.ends_with(".gif") { "image/gif".to_string() }
    else if lower.ends_with(".pdf") { "application/pdf".to_string() }
    else if lower.ends_with(".json") { "application/json".to_string() }
    else if lower.ends_with(".md") { "text/markdown".to_string() }
    else if lower.ends_with(".txt") { "text/plain".to_string() }
    else if lower.ends_with(".html") { "text/html".to_string() }
    else if lower.ends_with(".csv") { "text/csv".to_string() }
    else { "application/octet-stream".to_string() }
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn extract_html_title(html: &str) -> String {
    if let Some(start) = html.find("<title>") {
        if let Some(end) = html[start + 7..].find("</title>") {
            return html[start + 7..start + 7 + end].trim().to_string();
        }
    }
    String::new()
}

fn html_to_markdown(html: &str) -> String {
    let mut text = html.to_string();
    // Strip script and style blocks
    let re_script = regex::Regex::new(r"(?is)<script[^>]*>.*?</script>").ok();
    let re_style = regex::Regex::new(r"(?is)<style[^>]*>.*?</style>").ok();
    if let Some(re) = re_script { text = re.replace_all(&text, "").to_string(); }
    if let Some(re) = re_style { text = re.replace_all(&text, "").to_string(); }
    // Headers
    for level in 1..=6 {
        let tag = format!("h{}", level);
        let prefix = "#".repeat(level);
        let re_open = regex::Regex::new(&format!(r"(?i)<{}\s*[^>]*>", tag)).ok();
        let re_close = regex::Regex::new(&format!(r"(?i)</{}>", tag)).ok();
        if let Some(re) = re_open { text = re.replace_all(&text, &format!("\n{} ", prefix)).to_string(); }
        if let Some(re) = re_close { text = re.replace_all(&text, "\n").to_string(); }
    }
    // Paragraphs and line breaks
    let re_p = regex::Regex::new(r"(?i)<p\s*[^>]*>").ok();
    let re_p_close = regex::Regex::new(r"(?i)</p>").ok();
    let re_br = regex::Regex::new(r"(?i)<br\s*/?\s*>").ok();
    if let Some(re) = re_p { text = re.replace_all(&text, "\n").to_string(); }
    if let Some(re) = re_p_close { text = re.replace_all(&text, "\n").to_string(); }
    if let Some(re) = re_br { text = re.replace_all(&text, "\n").to_string(); }
    // Links
    let re_link = regex::Regex::new(r#"(?i)<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>"#).ok();
    if let Some(re) = re_link { text = re.replace_all(&text, "[$2]($1)").to_string(); }
    // Bold and italic
    let re_b = regex::Regex::new(r"(?i)</?(b|strong)>").ok();
    let re_i = regex::Regex::new(r"(?i)</?(i|em)>").ok();
    if let Some(re) = re_b { text = re.replace_all(&text, "**").to_string(); }
    if let Some(re) = re_i { text = re.replace_all(&text, "*").to_string(); }
    // List items
    let re_li = regex::Regex::new(r"(?i)<li[^>]*>").ok();
    if let Some(re) = re_li { text = re.replace_all(&text, "- ").to_string(); }
    // Strip remaining tags
    let re_tag = regex::Regex::new(r"<[^>]+>").ok();
    if let Some(re) = re_tag { text = re.replace_all(&text, "").to_string(); }
    // Decode HTML entities
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'");
    // Collapse whitespace
    let re_ws = regex::Regex::new(r"\n{3,}").ok();
    if let Some(re) = re_ws { text = re.replace_all(&text, "\n\n").to_string(); }
    text.trim().to_string()
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TaskCreateUpdate {
    pub title: Option<String>,
    #[serde(default)]
    pub column: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
}

#[derive(Deserialize)]
pub struct TaskColumnUpdate {
    pub column: String,
}

pub async fn list_tasks() -> impl IntoResponse {
    let tasks = crate::taskstore::get_tasks();
    Json(json!({ "tasks": tasks }))
}

pub async fn create_task_handler(Json(req): Json<TaskCreateUpdate>) -> impl IntoResponse {
    let task = crate::taskstore::create_task(
        req.title.unwrap_or_default(),
        req.column,
        req.description,
        req.priority,
        req.due_date,
        req.assignee,
    );
    Json(json!({ "task": task }))
}

pub async fn update_task_handler(
    Path(task_id): Path<String>,
    Json(req): Json<TaskCreateUpdate>,
) -> impl IntoResponse {
    match crate::taskstore::update_task(
        &task_id,
        req.title,
        req.column,
        req.description,
        req.priority,
        req.due_date,
        req.assignee,
    ) {
        Some(task) => Json(json!({ "task": task })),
        None => Json(json!({ "error": "Task not found" })),
    }
}

pub async fn update_task_column_handler(
    Path(task_id): Path<String>,
    Json(req): Json<TaskColumnUpdate>,
) -> impl IntoResponse {
    match crate::taskstore::update_task_column(&task_id, &req.column) {
        Some(task) => Json(json!({ "task": task })),
        None => Json(json!({ "error": "Task not found" })),
    }
}

pub async fn delete_task_handler(Path(task_id): Path<String>) -> impl IntoResponse {
    let ok = crate::taskstore::delete_task(&task_id);
    Json(json!({ "success": ok }))
}

// ─── Events ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct EventCreateUpdate {
    pub title: String,
    pub date: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
}

pub async fn list_events() -> impl IntoResponse {
    let events = crate::taskstore::get_events();
    Json(json!({ "events": events }))
}

pub async fn create_event_handler(Json(req): Json<EventCreateUpdate>) -> impl IntoResponse {
    let event = crate::taskstore::create_event(
        req.title,
        req.date,
        req.start_time,
        req.end_time,
    );
    Json(json!({ "event": event }))
}

pub async fn delete_event_handler(Path(event_id): Path<String>) -> impl IntoResponse {
    let ok = crate::taskstore::delete_event(&event_id);
    Json(json!({ "success": ok }))
}

// ─── Scheduled Tasks ──────────────────────────────────────────────────────────
//
// CRUD + manual "run now" for the scheduled-task dashboard. The agent itself
// creates tasks via the `manage_schedules` tool (conversational flow); these
// HTTP endpoints back the dashboard UI (list / edit / toggle / delete / run).

pub async fn list_schedules() -> impl IntoResponse {
    let tasks = crate::schedulestore::get_all();
    Json(json!({ "tasks": tasks }))
}

#[derive(Deserialize)]
pub struct ScheduleCreate {
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub daily_time: Option<String>,
    #[serde(default)]
    pub daily_weekdays: Option<Vec<u32>>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub model: Option<String>,
}

pub async fn create_schedule(Json(req): Json<ScheduleCreate>) -> impl IntoResponse {
    // Mirror the tool's validation so the manual form path is equally safe.
    match (req.interval_minutes, req.daily_time.as_ref()) {
        (Some(_), Some(_)) => {
            return Json(json!({ "error": "Specify either interval_minutes OR daily_time, not both" }))
        }
        (None, None) => {
            return Json(json!({ "error": "A schedule is required: set interval_minutes or daily_time" }))
        }
        _ => {}
    }
    if let Some(m) = req.interval_minutes {
        if m < 15 {
            return Json(json!({ "error": format!("Minimum interval is 15 minutes. Got {}.", m) }));
        }
    }
    if req.title.trim().is_empty() || req.prompt.trim().is_empty() {
        return Json(json!({ "error": "title and prompt are required" }));
    }
    let enabled = req.enabled.unwrap_or(true);
    if enabled
        && !crate::tools::tier_lifts_cap_pub()
        && crate::schedulestore::count_enabled() >= 3
    {
        return Json(json!({ "error": "Free tier is limited to 3 enabled scheduled tasks. Disable one or upgrade to Pro." }));
    }
    let task = crate::schedulestore::create(crate::schedulestore::CreateParams {
        title: req.title,
        prompt: req.prompt,
        trigger_type: Some("time".to_string()),
        interval_minutes: req.interval_minutes,
        daily_time: req.daily_time,
        daily_weekdays: req.daily_weekdays,
        enabled: Some(enabled),
        notify_channel: Some("inbox".to_string()),
        model: req.model,
    });
    Json(json!({ "task": task }))
}

#[derive(Deserialize)]
pub struct ScheduleUpdate {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub interval_minutes: Option<Option<u32>>,
    #[serde(default)]
    pub daily_time: Option<Option<String>>,
    #[serde(default)]
    pub daily_weekdays: Option<Option<Vec<u32>>>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub model: Option<Option<String>>,
}

pub async fn update_schedule(
    Path(task_id): Path<String>,
    Json(req): Json<ScheduleUpdate>,
) -> impl IntoResponse {
    // Enforce cap on enable (mirrors tool).
    if let Some(true) = req.enabled {
        let currently_enabled =
            crate::schedulestore::get(&task_id).map(|t| t.enabled).unwrap_or(false);
        if !currently_enabled
            && !crate::tools::tier_lifts_cap_pub()
            && crate::schedulestore::count_enabled() >= 3
        {
            return Json(json!({ "error": "Free tier is limited to 3 enabled scheduled tasks." }));
        }
    }
    if let Some(Some(m)) = req.interval_minutes {
        if m < 15 {
            return Json(json!({ "error": format!("Minimum interval is 15 minutes. Got {}.", m) }));
        }
    }
    let updated = crate::schedulestore::update(
        &task_id,
        crate::schedulestore::UpdateParams {
            title: req.title,
            prompt: req.prompt,
            trigger_type: None,
            interval_minutes: req.interval_minutes,
            daily_time: req.daily_time,
            daily_weekdays: req.daily_weekdays,
            enabled: req.enabled,
            notify_channel: None,
            model: req.model,
        },
    );
    match updated {
        Some(task) => Json(json!({ "task": task })),
        None => Json(json!({ "error": "Scheduled task not found" })),
    }
}

pub async fn delete_schedule(Path(task_id): Path<String>) -> impl IntoResponse {
    // Clean up the task's memory file too.
    let _ = std::fs::remove_file(crate::paths::task_memory_path(&task_id));
    let ok = crate::schedulestore::delete(&task_id);
    Json(json!({ "success": ok }))
}

/// Manually trigger a scheduled task out of band (the "Run now" button). Fires
/// the run asynchronously and returns immediately.
pub async fn run_schedule_now(Path(task_id): Path<String>) -> impl IntoResponse {
    match crate::schedulestore::get(&task_id) {
        Some(task) => {
            // Fire-and-forget on the tokio runtime. The scheduler's overlap
            // guard prevents a collision if the next scheduled tick is imminent.
            tokio::spawn(crate::scheduler::run_task_now(task));
            Json(json!({ "success": true, "message": "Task run started" }))
        }
        None => Json(json!({ "error": "Scheduled task not found" })),
    }
}

// ─── Inbox ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct InboxQuery {
    pub unread: Option<bool>,
}

pub async fn list_inbox(Query(q): Query<InboxQuery>) -> impl IntoResponse {
    let items = crate::inboxstore::get_all(q.unread.unwrap_or(false));
    Json(json!({ "items": items, "unread_count": crate::inboxstore::get_all(true).len() }))
}

pub async fn mark_inbox_read(Path(item_id): Path<String>) -> impl IntoResponse {
    let ok = crate::inboxstore::mark_read(&item_id);
    Json(json!({ "success": ok }))
}

pub async fn mark_all_inbox_read() -> impl IntoResponse {
    let changed = crate::inboxstore::mark_all_read();
    Json(json!({ "success": true, "marked_read": changed }))
}

pub async fn delete_inbox_item(Path(item_id): Path<String>) -> impl IntoResponse {
    let ok = crate::inboxstore::delete(&item_id);
    Json(json!({ "success": ok }))
}

// ─── MCP ─────────────────────────────────────────────────────────────────────
// Reads configured stdio servers from ~/.zwork/mcp.json, probes each for
// readiness + tool count, and lists their tools. See `mcp.rs`.

pub async fn mcp_servers() -> impl IntoResponse {
    let config_path = crate::paths::home_dir().join("mcp.json");
    let servers = crate::mcp::server_status();
    Json(json!({ "servers": servers, "config_path": config_path.to_string_lossy() }))
}

pub async fn mcp_tools() -> impl IntoResponse {
    let tools = crate::mcp::all_tool_schemas();
    Json(json!({ "tools": tools }))
}

// ─── Composio ────────────────────────────────────────────────────────────────
// These proxy through the zWork cloud server (api.tryzwork.app), which owns the
// real Composio SDK + platform API key. See `composio.rs` and
// `cloud-src/api/src/main.rs` (composio_* handlers).

pub async fn composio_status() -> impl IntoResponse {
    Json(crate::composio::status().await)
}

/// Composio is configured entirely server-side; there's no client API key to
/// set. We accept the POST for compatibility with the Python-era UI and report
/// where configuration actually happens.
pub async fn composio_set_config() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "configured": crate::composio::is_configured(),
        "note": "Composio is configured via the zWork Cloud account token (zwork_router).",
    }))
}

pub async fn composio_accounts() -> impl IntoResponse {
    Json(crate::composio::accounts().await)
}

#[derive(Deserialize)]
pub struct ComposioAppRequest {
    pub app: String,
}

pub async fn composio_connect(Json(body): Json<ComposioAppRequest>) -> impl IntoResponse {
    match crate::composio::connect(body.app.trim()).await {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": msg })),
        )
            .into_response(),
    }
}

pub async fn composio_disconnect(Json(body): Json<ComposioAppRequest>) -> impl IntoResponse {
    match crate::composio::disconnect(body.app.trim()).await {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": msg })),
        )
            .into_response(),
    }
}

/// Returns a curated list of supported apps so the Connectors page grid renders.
pub async fn composio_apps() -> impl IntoResponse {
    Json(crate::composio::apps())
}

// ---- Ollama ----

#[derive(serde::Deserialize)]
pub struct OllamaModelsRequest {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(serde::Deserialize)]
pub struct OllamaPullRequest {
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

/// Default Ollama daemon address. Both the model-list and pull paths fall back
/// to this when the user hasn't supplied an explicit base_url — so the common
/// case (Ollama running locally on its default port) works with zero config.
const OLLAMA_DEFAULT_BASE: &str = "http://localhost:11434";

/// Check if an Ollama URL is safe to proxy (SSRF protection).
fn is_safe_ollama_url(url: &str) -> bool {
    let url = url.trim().trim_end_matches('/');
    // Allow localhost variants
    if url.starts_with("http://localhost:") || url.starts_with("http://127.0.0.1:") {
        return true;
    }
    // Allow official Ollama cloud
    if url.contains("ollama.com") {
        return true;
    }
    // Allow private network ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    if url.starts_with("http://192.168.") || url.starts_with("http://10.") {
        return true;
    }
    if url.starts_with("http://172.") {
        if let Some(rest) = url.strip_prefix("http://172.") {
            if let Some(octet_str) = rest.split('.').next() {
                if let Ok(octet) = octet_str.parse::<u8>() {
                    if octet >= 16 && octet <= 31 {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Resolve the user-supplied base_url to a canonical Ollama API root (no
/// trailing slash, no `/v1` suffix). Empty input → default localhost. Any
/// `/v1` suffix is stripped because we use the *native* Ollama API
/// (`/api/tags`, `/api/pull`), not the OpenAI-compat layer — this avoids the
/// double-`/v1` trap where `{base}/v1` + `/v1/models` produced a 404.
fn ollama_api_base(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return OLLAMA_DEFAULT_BASE.to_string();
    }
    // Strip a trailing /v1 or /v1/ so callers can safely append /api/... below.
    trimmed
        .strip_suffix("/v1")
        .unwrap_or(trimmed)
        .to_string()
}

pub async fn ollama_models(
    Json(req): Json<OllamaModelsRequest>,
) -> impl IntoResponse {
    // Empty base_url is the common case — default it instead of rejecting.
    // The SSRF guard only runs on an explicitly-provided URL.
    let base = if req.base_url.trim().is_empty() {
        OLLAMA_DEFAULT_BASE.to_string()
    } else {
        if !is_safe_ollama_url(&req.base_url) {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "error": "URL not allowed. Only localhost, private IPs, and ollama.com are permitted." })),
            ).into_response();
        }
        ollama_api_base(&req.base_url)
    };

    // Use the NATIVE Ollama list endpoint (/api/tags). The previous code used
    // /v1/models, which (a) double-suffixed when the user typed the /v1
    // placeholder, and (b) returns {data:[...]} while the frontend expects
    // {models:[...]}. /api/tags returns {models:[{name, ...}]} directly.
    let models_url = format!("{base}/api/tags");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let mut request = client.get(&models_url);
    if !req.api_key.is_empty() {
        request = request.header("authorization", format!("Bearer {}", req.api_key));
    }

    match request.send().await {
        Ok(resp) => {
            let status = resp.status();
            match resp.text().await {
                Ok(body) => {
                    if !status.is_success() {
                        return (status, Json(json!({ "error": body }))).into_response();
                    }
                    // Map Ollama's {models:[{name,...}]} → {models:[{id,name}]}.
                    // `name` is the canonical tag (e.g. "llama3.2:latest"); copy
                    // it to `id` so the frontend's chip list keys on it. Drop
                    // embedding models (capability "embedding") since they
                    // can't drive a chat.
                    let mapped = serde_json::from_str::<Value>(&body)
                        .ok()
                        .and_then(|v| v.get("models").cloned())
                        .and_then(|models| models.as_array().cloned())
                        .map(|arr| {
                            let ids: Vec<Value> = arr
                                .iter()
                                .filter(|m| {
                                    // Skip embedding-only models — they can't chat.
                                    let caps = m
                                        .get("capabilities")
                                        .and_then(|c| c.as_array())
                                        .map(|a| {
                                            a.iter().any(|x| {
                                                x.as_str()
                                                    .map(|s| s == "completion" || s == "tools")
                                                    .unwrap_or(false)
                                            })
                                        })
                                        .unwrap_or(true); // keep if capabilities absent
                                    caps
                                })
                                .map(|m| {
                                    let name = m
                                        .get("name")
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    json!({ "id": name, "name": name })
                                })
                                .filter(|m| !m["id"].as_str().unwrap_or("").is_empty())
                                .collect();
                            json!({ "models": ids })
                        })
                        .unwrap_or_else(|| json!({ "models": [] }));
                    Json(mapped).into_response()
                }
                Err(e) => (
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": format!("Failed to read response: {e}") })),
                ).into_response(),
            }
        }
        Err(e) => (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("Failed to connect to Ollama: {e}. Is Ollama running at {base}?") })),
        ).into_response(),
    }
}

/// Pull an Ollama model. Streams NDJSON progress lines from Ollama's
/// `/api/pull` as Server-Sent-Events so the frontend can show live download
/// progress. This is the "auto-pull" capability — the user types a model name
/// (or it's triggered by a "model not found" detection) and the model is
/// fetched without leaving zWork.
pub async fn ollama_pull(
    Json(req): Json<OllamaPullRequest>,
) -> Response {
    let base = if req.base_url.trim().is_empty() {
        OLLAMA_DEFAULT_BASE.to_string()
    } else {
        if !is_safe_ollama_url(&req.base_url) {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "error": "URL not allowed. Only localhost, private IPs, and ollama.com are permitted." })),
            ).into_response();
        }
        ollama_api_base(&req.base_url)
    };

    let pull_url = format!("{base}/api/pull");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600)) // pulls can be long
        .build()
        .unwrap_or_default();

    let mut post = client
        .post(&pull_url)
        .json(&json!({ "name": req.model, "stream": true }));
    if !req.api_key.is_empty() {
        post = post.header("authorization", format!("Bearer {}", req.api_key));
    }

    let resp = match post.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Failed to connect to Ollama: {e}. Is Ollama running at {base}?") })),
            ).into_response();
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return (
            status,
            Json(json!({ "error": body.chars().take(400).collect::<String>() })),
        ).into_response();
    }

    // Ollama streams newline-delimited JSON: {"status":"pulling manifest"},
    // {"status":"downloading","digest":"...","total":N,"completed":M}, ...,
    // {"status":"success"}. Re-emit each parsed record as an axum SSE `Event`
    // so the frontend's fetch reader can parse progress incrementally.
    // reqwest's chunk boundaries don't align with newlines, so we buffer and
    // split on '\n'.
    let body_stream = resp.bytes_stream().map(|chunk| {
        let bytes = chunk.unwrap_or_default();
        Ok::<_, std::convert::Infallible>(String::from_utf8_lossy(&bytes).to_string())
    });

    let sse_stream = tokio_stream::wrappers::ReceiverStream::new({
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, std::convert::Infallible>>(32);
        tokio::spawn(async move {
            let mut buf = String::new();
            let mut s = Box::pin(body_stream);
            while let Some(chunk) = s.next().await {
                buf.push_str(&chunk.unwrap_or_default());
                while let Some(idx) = buf.find('\n') {
                    let line: String = buf.drain(..=idx).collect();
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let event = Event::default().data(trimmed);
                    if tx.send(Ok(event)).await.is_err() {
                        return; // client disconnected
                    }
                }
            }
            let trailing = buf.trim();
            if !trailing.is_empty() {
                let _ = tx.send(Ok(Event::default().data(trailing))).await;
            }
            let _ = tx.send(Ok(Event::default().data("[DONE]"))).await;
        });
        rx
    });

    Sse::new(sse_stream).into_response()
}
