use axum::{
    routing::{get, post, patch, put, delete},
    Router,
};
use tower_http::cors::CorsLayer;
use tracing::info;

mod paths;
mod secretstore;
mod settings;
mod chatstore;
mod skills;
mod academic;
mod watchdog;
mod tools;
mod agent;
mod server;

#[tokio::main]
async fn main() {
    // Initialize logging
    tracing_subscriber::fmt::init();

    let host = std::env::var("ZWORK_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("ZWORK_PORT")
        .unwrap_or_else(|_| "8787".to_string())
        .parse::<u16>()
        .unwrap_or(8787);

    let app = Router::new()
        .route("/api/health", get(server::health))
        .route("/api/me", get(server::me))
        .route("/api/providers", get(server::get_providers))
        .route("/api/settings", get(server::get_settings).put(server::put_settings))
        .route("/api/chats", get(server::list_chats).post(server::create_chat))
        .route(
            "/api/chats/:chat_id",
            get(server::get_chat)
                .patch(server::patch_chat)
                .delete(server::delete_chat),
        )
        .route("/api/chats/:chat_id/messages/:message_id", patch(server::patch_message))
        .route("/api/chats/:chat_id/stop", post(server::stop_chat))
        .route("/api/chat/stream", post(server::chat_stream_route))
        .route("/api/chats/:chat_id/gate/:gate_id/approve", post(server::approve_gate))
        .route("/api/chats/:chat_id/gate/:gate_id/reject", post(server::reject_gate))
        .route("/api/onboard/status", get(server::onboard_status))
        .route("/api/onboard/skip", post(server::onboard_skip))
        .route("/api/onboard/complete", post(server::onboard_complete))
        .route("/api/custom-models", get(server::list_custom_models).post(server::upsert_custom_model))
        .route("/api/custom-models/:model_id", delete(server::delete_custom_model))
        .route("/api/skills", get(server::list_skills))
        .route("/api/projects", get(server::list_projects).post(server::create_project))
        .route("/api/projects/:project_id", patch(server::update_project).delete(server::delete_project))
        .route("/api/projects/:project_id/context", get(server::get_project_context).put(server::put_project_context))
        .route("/api/integrations", get(server::list_integrations))
        .route("/api/composio/status", get(server::composio_status))
        .route("/api/composio/config", post(server::composio_set_config))
        .route("/api/composio/accounts", get(server::composio_accounts))
        .route("/api/composio/connect", post(server::composio_connect))
        .route("/api/composio/disconnect", post(server::composio_disconnect))
        .route("/api/composio/apps", get(server::composio_apps))
        .route("/api/ollama/models", post(server::ollama_models))
        .layer(CorsLayer::permissive());

    let addr = format!("{}:{}", host, port);
    info!("rWork Rust Backend -> http://{} (pid={})", addr, std::process::id());
    
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
