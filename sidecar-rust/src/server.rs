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
pub async fn health() -> &'static str {
    "OK"
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
