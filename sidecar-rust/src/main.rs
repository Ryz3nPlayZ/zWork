use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post, patch, delete},
    Router,
};
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, AllowPrivateNetwork, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

/// Maximum accepted HTTP request body size.
///
/// Axum's `Json` extractor rejects bodies larger than 2 MB by default. Image
/// uploads are base64-encoded (≈33% overhead), so even a modest phone photo or
/// screenshot exceeds that and the upload endpoint returned HTTP 413 — which
/// surfaced to the user as "images can't be uploaded" (the attachment was
/// silently dropped before ever reaching the agent). 100 MB comfortably covers
/// large photos, screenshots, and PDFs while still bounding the server.
const MAX_BODY_BYTES: usize = 100 * 1024 * 1024;

/// Rejects any request without a matching `x-zwork-token` header.
///
/// The sidecar binds 127.0.0.1 but is reachable by any local process — and,
/// via browser requests to loopback, potentially by arbitrary websites. The
/// per-run token is minted by the Tauri host at launch, passed to this process
/// as `ZWORK_SIDECAR_TOKEN`, and only the desktop frontend can read it (via
/// the `get_sidecar_token` Tauri command). This blocks drive-by localhost RCE
/// against endpoints like /api/run-python.
///
/// `/ws` is exempt: the zbctl Chrome extension connects there
/// (browser_bridge.rs) and has no way to learn the per-run token. The
/// extension only receives browser_* commands over that socket — every other
/// endpoint still requires the token.
async fn require_sidecar_token(
    State(expected): State<Arc<String>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.uri().path() == "/ws" {
        return Ok(next.run(req).await);
    }
    let provided = req
        .headers()
        .get("x-zwork-token")
        .and_then(|v| v.to_str().ok());
    if provided == Some(expected.as_str()) {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn cors_layer() -> CorsLayer {
    // Only the Tauri webview and the zbctl Chrome extension may talk to this
    // loopback server from a browser context. `allow_private_network` lets
    // the extension (chrome-extension:// origin) reach us: modern Chrome
    // blocks cross-context requests to private/loopback addresses (Private
    // Network Access) unless the preflight echoes this header back.
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            let Ok(origin) = origin.to_str() else {
                return false;
            };
            matches!(
                origin,
                "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
            ) || origin.starts_with("chrome-extension://")
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("x-zwork-token"),
            HeaderName::from_static("x-zwork-app-version"),
            HeaderName::from_static("x-zwork-os"),
            HeaderName::from_static("x-zwork-run-id"),
            HeaderName::from_static("x-zwork-chat-id"),
            HeaderName::from_static("x-zwork-project-id"),
        ])
        .allow_private_network(AllowPrivateNetwork::yes())
}

mod paths;
mod sync_util;
mod crash;
mod secretstore;
mod settings;
mod chatstore;
mod skills;
mod academic;
mod watchdog;
mod tools;
mod agent;
mod taskstore;
mod schedulestore;
mod inboxstore;
mod scheduler;
mod server;
mod cua;
mod zbctl;
mod browser_bridge;
mod memory;
mod telegram;
mod composio;
mod deploy;
mod mcp;
mod office;

#[tokio::main]
async fn main() {
    // Install the crash-capturing panic hook BEFORE anything else so a panic
    // during setup is captured to ~/.zwork/logs/crashes.jsonl.
    crash::install();

    // Initialize logging
    tracing_subscriber::fmt::init();

    let host = std::env::var("ZWORK_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("ZWORK_PORT")
        .unwrap_or_else(|_| "8787".to_string())
        .parse::<u16>()
        .unwrap_or(8787);

    let sidecar_token = match std::env::var("ZWORK_SIDECAR_TOKEN") {
        Ok(token) if !token.trim().is_empty() => Arc::new(token),
        _ => {
            // Dev mode (running the binary directly, outside the Tauri host):
            // mint a throwaway token so the token middleware still runs.
            let generated = uuid::Uuid::new_v4().to_string();
            tracing::warn!(
                "ZWORK_SIDECAR_TOKEN not set; generated a per-run token (dev mode). \
                 Requests must send it as the x-zwork-token header."
            );
            Arc::new(generated)
        }
    };

    let app = Router::new()
        .route("/ws", get(browser_bridge::ws_handler))
        .route("/api/health", get(server::health))
        .route("/api/desktop/status", get(server::desktop_status))
        .route("/api/desktop/permissions/grant", post(server::desktop_grant))
        .route("/api/desktop/windows", get(server::list_windows))
        .route("/api/desktop/windows/:window_id/screenshot", post(server::capture_window))
        .route("/api/browser-bridge/status", get(server::browser_bridge_status))
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
        .route("/api/ollama/pull", post(server::ollama_pull))
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
        .route("/api/schedules", get(server::list_schedules).post(server::create_schedule))
        .route(
            "/api/schedules/:task_id",
            patch(server::update_schedule).delete(server::delete_schedule),
        )
        .route("/api/schedules/:task_id/run", post(server::run_schedule_now))
        .route("/api/inbox", get(server::list_inbox))
        .route("/api/inbox/all-read", post(server::mark_all_inbox_read))
        .route(
            "/api/inbox/:item_id",
            patch(server::mark_inbox_read).delete(server::delete_inbox_item),
        )
        .route("/api/uploads", get(server::list_uploads).post(server::upload_files))
        .route("/api/uploads/:filename", get(server::get_upload))
        .route("/api/screenshot", post(server::screenshot))
        .route("/api/run-python", post(server::run_python))
        .route("/api/telegram/send", post(server::telegram_send))
        .route("/api/refactor", post(server::refactor_code))
        .route("/api/scrape", post(server::scrape_url))
        .route("/api/export/docx", post(server::export_docx))
        .route("/api/export/pdf", post(server::export_pdf))
        // Token gate on every route (with the `/ws` exemption documented on
        // `require_sidecar_token`). Added before the CORS layer so CORS stays
        // outermost and preflight OPTIONS requests are answered without a token.
        .layer(middleware::from_fn_with_state(
            sidecar_token,
            require_sidecar_token,
        ))
        .layer(cors_layer());

    let app = app.layer(
        TraceLayer::new_for_http()
            .make_span_with(tower_http::trace::DefaultMakeSpan::new().level(tracing::Level::INFO))
            .on_response(tower_http::trace::DefaultOnResponse::new().level(tracing::Level::INFO)),
    );

    // Raise the default request body limit so image/PDF uploads (base64-encoded
    // in JSON) aren't rejected with HTTP 413. See `MAX_BODY_BYTES`.
    let app = app.layer(DefaultBodyLimit::max(MAX_BODY_BYTES));

    let addr = format!("{}:{}", host, port);
    info!("rWork Rust Backend -> http://{} (pid={})", addr, std::process::id());

    // Idle backstop for the cua-driver daemon. The primary lifecycle is the
    // agent calling desktop_start/end_session explicitly; this safety net tears
    // the daemon down only if a desktop session is left idle past
    // ZWORK_IDLE_TEARDOWN_SECS (default 1800s). See cua::idle_teardown_task.
    tokio::spawn(cua::idle_teardown_task());

    // Scheduled-task runner. Fires user-configured recurring tasks on their
    // schedules (every N min, or daily at HH:MM) and posts findings to the
    // inbox. See scheduler::scheduler_loop.
    tokio::spawn(scheduler::scheduler_loop());

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("failed to bind {addr}: {err}");
            std::process::exit(1);
        }
    };
    if let Err(err) = axum::serve(listener, app).await {
        tracing::error!("server exited with error: {err}");
        std::process::exit(1);
    }
}
