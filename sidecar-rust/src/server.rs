use axum::{
    extract::{Path, State},
    response::sse::{Event, Sse},
    response::IntoResponse,
    Json,
};
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

fn display_name() -> String {
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
    
    "friend".to_string();
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
    let mut models = Vec::new();

    let cc = resolve("claude_code", &s, "");
    if cc.is_some() {
        let existing = s.custom_models.iter().any(|m| m.credential == "claude_code");
        if !existing {
            let cc_model = read_claude_code_model().unwrap_or_default();
            models.push(serde_json::json!({
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

    let default_model = if models.iter().any(|m| m.get("id").and_then(|v| v.as_str()) == Some(&s.default_model)) {
        s.default_model.clone()
    } else {
        models.first().and_then(|m| m.get("id").and_then(|v| v.as_str())).unwrap_or("").to_string()
    };

    Json(serde_json::json!({
        "credentials": credentials_status,
        "models": models,
        "default_model": default_model,
    }))
}

pub async fn get_settings() -> impl IntoResponse {
    let s = settings::load();
    Json(s)
}

pub async fn put_settings(Json(mut body): Json<settings::Settings>) -> impl IntoResponse {
    settings::save(&mut body);
    Json(body)
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
    Json(serde_json::json!({ "projects": [] }))
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

