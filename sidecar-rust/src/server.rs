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
    Json(json!({
        "id": "rwork-user",
        "email": "local@rwork.dev",
        "name": "rWork User",
        "tier": "pro"
    }))
}

pub async fn get_providers() -> impl IntoResponse {
    // Return standard providers matching what the UI expects
    Json(json!({
        "providers": [
            {
                "id": "zwork_router",
                "name": "zWork Cloud Router (Default)",
                "models": [
                    { "id": "deepseek-v4-flash", "name": "DeepSeek v4 Flash (Vision)" },
                    { "id": "groq-llama-3-3", "name": "Llama 3.3 70B (Fast)" }
                ]
            },
            {
                "id": "anthropic",
                "name": "Anthropic Claude BYOK",
                "models": [
                    { "id": "claude-3-5-sonnet", "name": "Claude 3.5 Sonnet" }
                ]
            }
        ]
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
    Json(list)
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
