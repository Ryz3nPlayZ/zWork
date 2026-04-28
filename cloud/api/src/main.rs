use axum::{
    extract::{State, Json, Request},
    routing::{get, post, any},
    Router,
    response::{IntoResponse, Response},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing::{info, error};
use reqwest::Client;
use sqlx::{PgPool, postgres::PgPoolOptions};

#[derive(Clone)]
struct AppState {
    posthog_client: Client,
    posthog_key: String,
    stripe_webhook_secret: String,
    db: PgPool,
    http_client: Client,
}

#[derive(Deserialize)]
struct TelemetryPayload {
    event: String,
    session_id: Option<String>,
    properties: Value,
    ts: i64,
}

async fn health_check() -> &'static str {
    "OK"
}

// Telemetry Ingestion Endpoint
async fn ingest_telemetry(
    State(state): State<AppState>,
    Json(payload): Json<TelemetryPayload>,
) -> impl IntoResponse {
    let posthog_url = "https://app.posthog.com/capture/";
    
    let posthog_payload = serde_json::json!({
        "api_key": state.posthog_key,
        "event": payload.event,
        "properties": payload.properties,
        "distinct_id": payload.session_id.unwrap_or_else(|| "anonymous".to_string()),
        "timestamp": payload.ts,
    });

    match state.posthog_client.post(posthog_url).json(&posthog_payload).send().await {
        Ok(_) => (StatusCode::OK, "Telemetry tracked").into_response(),
        Err(e) => {
            error!("Failed to track telemetry: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to track telemetry").into_response()
        }
    }
}

// AI Proxy Layer (Ollama Cloud)
async fn ai_proxy(
    State(state): State<AppState>,
    req: Request<axum::body::Body>,
) -> Result<Response<axum::body::Body>, StatusCode> {
    // Ollama Cloud API Configuration
    let ollama_api_key = "48dc3d9713554e81b1ff43c39187f491.mGuuk200M2L6VRM05MVzdvEc";
    let ollama_endpoint = "https://api.ollama.com/v1/chat/completions";
    let allowed_model = "minimax-m2.7:cloud";

    let body_bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024 * 10).await.map_err(|_| StatusCode::BAD_REQUEST)?;
    
    // Parse body to enforce model constraint
    let mut body_json: Value = serde_json::from_slice(&body_bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
    
    // Always force the allowed model for this proxy
    if let Some(obj) = body_json.as_object_mut() {
        obj.insert("model".to_string(), serde_json::Value::String(allowed_model.to_string()));
    }

    let client = reqwest::Client::new();
    let resp = client.post(ollama_endpoint)
        .header("Authorization", format!("Bearer {}", ollama_api_key))
        .header("Content-Type", "application/json")
        .json(&body_json)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    
    let status = resp.status();
    let stream = resp.bytes_stream();
    let body = axum::body::Body::from_stream(stream);
    
    let mut response = Response::new(body);
    *response.status_mut() = status;
    
    Ok(response)
}

// Stripe Webhook Endpoint for Paid Plans
async fn stripe_webhook() -> impl IntoResponse {
    // In a real implementation, we would use the `stripe` crate to verify the webhook signature
    // and update the user's tier in the Postgres database.
    (StatusCode::OK, "Webhook received").into_response()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("Failed to connect to Postgres");

    let state = AppState {
        posthog_client: Client::new(),
        posthog_key: std::env::var("POSTHOG_API_KEY").unwrap_or_default(),
        stripe_webhook_secret: std::env::var("STRIPE_WEBHOOK_SECRET").unwrap_or_default(),
        db: pool,
        http_client: Client::new(),
    };

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/api/telemetry/event", post(ingest_telemetry))
        .route("/api/chat/stream", post(ai_proxy))
        .route("/api/v1/chat/completions", post(ai_proxy))
        .route("/api/webhooks/stripe", post(stripe_webhook))
        .with_state(state);

    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    info!("Server running on 0.0.0.0:8080");
    axum::serve(listener, app).await.unwrap();
}
