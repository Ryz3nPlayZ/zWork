use axum::{
    routing::{get, post, patch, delete},
    Router,
};
use tower_http::cors::{AllowPrivateNetwork, CorsLayer};
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
mod taskstore;
mod server;
mod cua;
mod zbctl;
mod browser_bridge;
mod memory;
mod telegram;

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
        .route("/ws", get(browser_bridge::ws_handler))
        .route("/api/health", get(server::health))
        .route("/api/desktop/status", get(server::desktop_status))
        .route("/api/desktop/permissions/grant", post(server::desktop_grant))
        .route("/api/browser-bridge/status", get(server::browser_bridge_status))
        .route("/api/browser/command", post(server::browser_command))
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
        .route("/api/chats/:chat_id/messages/:message_id/truncate", post(server::truncate_message))
        .route("/api/chats/:chat_id/stop", post(server::stop_chat))
        .route("/api/chats/:chat_id/answer-question", post(server::answer_question))
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
        .route("/api/projects/:project_id/memory", get(server::get_project_memory).put(server::put_project_memory))
        .route("/api/projects/:project_id/timeline", get(server::get_project_timeline))
        .route("/api/projects/:project_id/files", get(server::list_project_files).post(server::upload_project_files))
        .route("/api/projects/:project_id/files/:filename", delete(server::delete_project_file))
        .route("/api/integrations", get(server::list_integrations))
        .route("/api/composio/status", get(server::composio_status))
        .route("/api/composio/config", post(server::composio_set_config))
        .route("/api/composio/accounts", get(server::composio_accounts))
        .route("/api/composio/connect", post(server::composio_connect))
        .route("/api/composio/disconnect", post(server::composio_disconnect))
        .route("/api/composio/apps", get(server::composio_apps))
        .route("/api/ollama/models", post(server::ollama_models))
        .route("/api/memory", get(server::get_memory).put(server::put_memory))
        .route("/api/user-md", get(server::get_user_md).put(server::put_user_md))
        .route("/api/telemetry/event", post(server::telemetry_event))
        .route("/api/activity-logs", get(server::activity_logs))
        .route("/api/mcp/servers", get(server::mcp_servers))
        .route("/api/mcp/tools", get(server::mcp_tools))
        .route("/api/tasks", get(server::list_tasks).post(server::create_task_handler))
        .route("/api/tasks/:task_id", patch(server::update_task_handler).delete(server::delete_task_handler))
        .route("/api/tasks/:task_id/column", patch(server::update_task_column_handler))
        .route("/api/events", get(server::list_events).post(server::create_event_handler))
        .route("/api/events/:event_id", delete(server::delete_event_handler))
        .route("/api/uploads", get(server::list_uploads).post(server::upload_files))
        .route("/api/uploads/:filename", get(server::get_upload))
        .route("/api/screenshot", post(server::screenshot))
        .route("/api/run-python", post(server::run_python))
        .route("/api/telegram/send", post(server::telegram_send))
        .route("/api/refactor", post(server::refactor_code))
        .route("/api/scrape", post(server::scrape_url))
        .route("/api/export/docx", post(server::export_docx))
        .route("/api/export/pdf", post(server::export_pdf))
        // `allow_private_network` lets the zbctl Chrome extension
        // (chrome-extension:// origin) reach this loopback server. Modern
        // Chrome blocks cross-context requests to private/loopback addresses
        // (Private Network Access) unless the preflight echoes this header back.
        .layer(
            CorsLayer::permissive().allow_private_network(AllowPrivateNetwork::yes()),
        );

    let addr = format!("{}:{}", host, port);
    info!("rWork Rust Backend -> http://{} (pid={})", addr, std::process::id());

    // Idle backstop for the cua-driver daemon. The primary lifecycle is the
    // agent calling desktop_start/end_session explicitly; this safety net tears
    // the daemon down only if a desktop session is left idle past
    // ZWORK_IDLE_TEARDOWN_SECS (default 1800s). See cua::idle_teardown_task.
    tokio::spawn(cua::idle_teardown_task());

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
