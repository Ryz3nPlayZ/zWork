use axum::{
    extract::{State, Json, Request, Path},
    routing::{get, post, put},
    Router,
    response::{IntoResponse, Response},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpListener;
use tracing::{info, error};
use reqwest::Client;
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

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

#[derive(Serialize, Deserialize, sqlx::FromRow)]
struct User {
    id: Uuid,
    google_id: String,
    email: String,
    name: String,
    #[serde(rename = "picture_url")]
    #[sqlx(rename = "picture_url")]
    picture_url: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    tier: String,
    #[serde(rename = "subscription_id")]
    #[sqlx(rename = "subscription_id")]
    subscription_id: Option<String>,
    #[serde(rename = "subscription_status")]
    #[sqlx(rename = "subscription_status")]
    subscription_status: Option<String>,
    #[serde(rename = "subscription_end_date")]
    #[sqlx(rename = "subscription_end_date")]
    subscription_end_date: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Deserialize)]
struct CreateUserRequest {
    google_id: String,
    email: String,
    name: String,
    picture_url: Option<String>,
}

#[derive(Deserialize)]
struct UpdateTierRequest {
    tier: String,
    subscription_id: Option<String>,
    subscription_status: Option<String>,
    subscription_end_date: Option<String>,
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
    _state: State<AppState>,
    req: Request<axum::body::Body>,
) -> Result<Response<axum::body::Body>, StatusCode> {
    let ollama_api_key = std::env::var("OLLAMA_API_KEY")
        .or_else(|_| std::env::var("ZWORK_TEST_OLLAMA_API_KEY"))
        .unwrap_or_default();
    let ollama_endpoint = "https://api.ollama.com/v1/chat/completions";
    let allowed_model = "minimax-m2.7:cloud";

    if ollama_api_key.trim().is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

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
async fn stripe_webhook(_state: State<AppState>) -> impl IntoResponse {
    // In a real implementation, we would use the `stripe` crate to verify the webhook signature
    // and update the user's tier in the Postgres database.
    (StatusCode::OK, "Webhook received").into_response()
}

// User Endpoints

// Get user by Google ID
async fn get_user_by_google_id(
    State(state): State<AppState>,
    Path(google_id): Path<String>,
) -> Result<Json<User>, StatusCode> {
    sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE google_id = $1"
    )
    .bind(&google_id)
    .fetch_optional(&state.db)
    .await
    .map(|user| user.map(Json).ok_or(StatusCode::NOT_FOUND))
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

// Create or update user (upsert by Google ID)
async fn upsert_user(
    State(state): State<AppState>,
    Json(req): Json<CreateUserRequest>,
) -> Result<Json<User>, StatusCode> {
    let user = sqlx::query_as::<_, User>(
        r#"
        INSERT INTO users (google_id, email, name, picture_url)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (google_id) 
        DO UPDATE SET 
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            picture_url = EXCLUDED.picture_url,
            updated_at = NOW()
        RETURNING *
        "#
    )
    .bind(&req.google_id)
    .bind(&req.email)
    .bind(&req.name)
    .bind(&req.picture_url)
    .fetch_one(&state.db)
    .await
    .map(Json)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(user)
}

// Update user tier
async fn update_user_tier(
    State(state): State<AppState>,
    Path(google_id): Path<String>,
    Json(req): Json<UpdateTierRequest>,
) -> Result<Json<User>, StatusCode> {
    let user = sqlx::query_as::<_, User>(
        r#"
        UPDATE users 
        SET 
            tier = $2,
            subscription_id = $3,
            subscription_status = $4,
            subscription_end_date = $5,
            updated_at = NOW()
        WHERE google_id = $1
        RETURNING *
        "#
    )
    .bind(&google_id)
    .bind(&req.tier)
    .bind(&req.subscription_id)
    .bind(&req.subscription_status)
    .bind(req.subscription_end_date.as_deref())
    .fetch_optional(&state.db)
    .await
    .map(|user| user.map(Json).ok_or(StatusCode::NOT_FOUND))
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    user
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
        // User endpoints
        .route("/api/users/:google_id", get(get_user_by_google_id))
        .route("/api/users", post(upsert_user))
        .route("/api/users/:google_id/tier", put(update_user_tier))
        .with_state(state);

    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    info!("Server running on 0.0.0.0:8080");
    axum::serve(listener, app).await.unwrap();
}
