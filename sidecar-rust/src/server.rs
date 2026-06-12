use axum::{
    extract::{Path, State},
    response::sse::{Event, Sse},
    response::IntoResponse,
    Json,
};
use futures_util::stream::Stream;
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
}

#[derive(Deserialize, Debug)]
pub struct ChatStreamRequest {
    pub chat_id: Option<String>,
    pub message: String,
    pub model: Option<String>,
    pub project_id: Option<String>,
    #[serde(default)]
    pub plan_mode: bool,
    #[serde(default)]
    pub auto_approve_destructive: bool,
}

// REST Handlers
pub async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true }))
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
                .unwrap_or_default()
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
                std::env::var(format!("{}_BASE_URL", credential.to_uppercase())).unwrap_or_default()
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
            if m.model_id.to_lowercase().contains("pro") {
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
    let updated = chatstore::update_message(&chat_id, &message_id, req.content, None);
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
        let chat = chatstore::create("New chat", &req.model.clone().unwrap_or_default(), &req.project_id.clone().unwrap_or_default());
        chat.id
    });
    
    let model_id = req.model.unwrap_or_else(|| "deepseek-v4-flash".to_string());
    let project_id = req.project_id.unwrap_or_default();
    
    let stream = run_agent_turn(
        chat_id,
        model_id,
        req.message,
        project_id,
        req.plan_mode,
        req.auto_approve_destructive,
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

// ─── Composio stubs ──────────────────────────────────────────────────────────
// These endpoints keep the frontend Connectors page from rendering blank.
// Full Composio integration is not yet wired into the Rust backend; the
// status stub advertises "not configured" so the UI can show the grid and
// invite the user to set up an API key later.

pub async fn composio_status() -> impl IntoResponse {
    Json(json!({
        "configured": false,
        "enabled": false,
        "available": false,
        "api_key_set": false,
        "connected_apps": [],
        "tool_count": 0,
        "user_id": "",
    }))
}

pub async fn composio_set_config() -> impl IntoResponse {
    (axum::http::StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": "composio not yet supported in this build" })))
}

pub async fn composio_accounts() -> impl IntoResponse {
    Json(json!({ "accounts": [] }))
}

pub async fn composio_connect() -> impl IntoResponse {
    (axum::http::StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": "composio not yet supported in this build" })))
}

pub async fn composio_disconnect() -> impl IntoResponse {
    (axum::http::StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": "composio not yet supported in this build" })))
}

/// Returns a curated list of supported apps so the Connectors page grid renders.
pub async fn composio_apps() -> impl IntoResponse {
    let apps = vec![
        json!({ "id": "gmail",          "name": "Gmail",           "color": "#EA4335", "icon": null }),
        json!({ "id": "googlecalendar", "name": "Google Calendar", "color": "#4285F4", "icon": null }),
        json!({ "id": "notion",         "name": "Notion",          "color": "#000000", "icon": null }),
        json!({ "id": "googledrive",    "name": "Google Drive",    "color": "#34A853", "icon": null }),
        json!({ "id": "github",         "name": "GitHub",          "color": "#24292E", "icon": null }),
        json!({ "id": "linear",         "name": "Linear",          "color": "#5E6AD2", "icon": null }),
    ];
    Json(json!({ "apps": apps }))
}

// ---- Ollama ----

#[derive(serde::Deserialize)]
pub struct OllamaModelsRequest {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

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

pub async fn ollama_models(
    Json(req): Json<OllamaModelsRequest>,
) -> impl IntoResponse {
    if !is_safe_ollama_url(&req.base_url) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": "URL not allowed. Only localhost, private IPs, and ollama.com are permitted." })),
        ).into_response();
    }

    let base = req.base_url.trim().trim_end_matches('/');
    let models_url = format!("{}/v1/models", base);

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
                    if status.is_success() {
                        // Try to parse and return the models
                        if let Ok(val) = serde_json::from_str::<Value>(&body) {
                            return Json(val).into_response();
                        }
                        return Json(json!({ "raw": body })).into_response();
                    }
                    (status, Json(json!({ "error": body }))).into_response()
                }
                Err(e) => (
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": format!("Failed to read response: {e}") })),
                ).into_response(),
            }
        }
        Err(e) => (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("Failed to connect to Ollama: {e}. Is Ollama running at {}?", req.base_url) })),
        ).into_response(),
    }
}
