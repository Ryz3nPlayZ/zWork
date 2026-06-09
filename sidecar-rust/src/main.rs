use axum::{
    routing::{get, post},
    response::sse::{Event, Sse},
    response::IntoResponse,
    Json, Router,
};
use futures_util::stream;
use std::{convert::Infallible, net::SocketAddr, time::Duration};
use tower_http::cors::CorsLayer;
use tracing::info;

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
        .route("/api/health", get(health))
        .route("/api/me", get(me))
        .route("/api/chats", get(chats))
        .route("/api/events", get(events))
        .layer(CorsLayer::permissive());

    let addr = format!("{}:{}", host, port);
    info!("rWork Rust Backend -> http://{} (pid={})", addr, std::process::id());
    
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> &'static str {
    "OK"
}

async fn me() -> impl IntoResponse {
    Json(serde_json::json!({
        "id": "rwork-user",
        "email": "local@rwork.dev",
        "name": "rWork User",
        "tier": "pro"
    }))
}

async fn chats() -> impl IntoResponse {
    Json(serde_json::json!([]))
}

async fn events() -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    // Yield a keep-alive comment stream to keep connection active
    let stream = stream::repeat_with(|| Ok(Event::default().comment("keep-alive")))
        .throttle(Duration::from_secs(15));
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}
