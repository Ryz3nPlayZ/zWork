use axum::{
    extract::{Json, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post, put},
    Router,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{postgres::PgPoolOptions, PgPool};
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    posthog_client: Client,
    posthog_key: String,
    posthog_host: String,
    stripe_webhook_secret: String,
    db: PgPool,
    http_client: Client,
    auth_session_url: String,
    auth_public_base: String,
    google_client_id: String,
    google_client_secret: String,
    owner_emails: Vec<String>,
    gateway: GatewayConfig,
}

#[derive(Clone)]
struct GatewayConfig {
    router_label: String,
    providers: Vec<GatewayProvider>,
    bearer_token: String,
    root_requests_per_5h: i64,
    weekly_limit_multiplier: i64,
    max_concurrent_roots: i64,
    dev_coupon_codes: Vec<String>,
}

#[derive(Clone)]
struct GatewayProvider {
    name: String,
    base_url: String,
    api_key: String,
    primary_model: String,
    fallback_model: String,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn load_gateway_providers() -> Vec<GatewayProvider> {
    let order = std::env::var("ROUTER_PROVIDER_ORDER")
        .unwrap_or_else(|_| "groq,cerebras,mistral".to_string());
    let mut providers = Vec::new();

    for name in order.split(',').map(|item| item.trim().to_ascii_lowercase()) {
        let provider = match name.as_str() {
            "groq" => GatewayProvider {
                name: "Groq".to_string(),
                base_url: env_or("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
                api_key: std::env::var("GROQ_API_KEY").unwrap_or_default(),
                primary_model: env_or("GROQ_MODEL_PRIMARY", "openai/gpt-oss-120b"),
                fallback_model: env_or("GROQ_MODEL_FALLBACK", "openai/gpt-oss-20b"),
            },
            "cerebras" => GatewayProvider {
                name: "Cerebras".to_string(),
                base_url: env_or("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1"),
                api_key: std::env::var("CEREBRAS_API_KEY").unwrap_or_default(),
                primary_model: env_or("CEREBRAS_MODEL_PRIMARY", "qwen-3-235b-a22b-instruct-2507"),
                fallback_model: env_or("CEREBRAS_MODEL_FALLBACK", "llama-4-scout-17b-16e-instruct"),
            },
            "mistral" => GatewayProvider {
                name: "Mistral".to_string(),
                base_url: env_or("MISTRAL_BASE_URL", "https://api.mistral.ai/v1"),
                api_key: std::env::var("MISTRAL_API_KEY").unwrap_or_default(),
                primary_model: env_or("MISTRAL_MODEL_PRIMARY", "mistral-medium-3.5"),
                fallback_model: env_or("MISTRAL_MODEL_FALLBACK", "devstral-2512"),
            },
            _ => continue,
        };

        if !provider.api_key.trim().is_empty() {
            providers.push(provider);
        }
    }

    providers
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
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    tier: String,
    #[serde(rename = "subscription_id")]
    #[sqlx(rename = "subscription_id")]
    subscription_id: Option<String>,
    #[serde(rename = "subscription_status")]
    #[sqlx(rename = "subscription_status")]
    subscription_status: Option<String>,
    #[serde(rename = "subscription_end_date")]
    #[sqlx(rename = "subscription_end_date")]
    subscription_end_date: Option<DateTime<Utc>>,
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

#[derive(Clone, Deserialize)]
struct BetterAuthUser {
    id: String,
    email: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct BetterAuthSession {
    user: BetterAuthUser,
}

#[derive(Clone, Serialize, Deserialize, sqlx::FromRow)]
struct AppUser {
    user_id: String,
    email: String,
    name: String,
    tier: String,
    coupon_code: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct CouponRedeemRequest {
    code: String,
}

#[derive(Deserialize)]
struct DesktopAuthStartQuery {
    port: u16,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize, sqlx::FromRow)]
struct DesktopOauthState {
    state: String,
    port: i32,
    expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct GoogleCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct GoogleUserInfo {
    sub: String,
    email: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct DesktopAuthExchangeRequest {
    code: String,
}

#[derive(Serialize)]
struct DesktopAuthExchangeResponse {
    token: String,
    user: AppUser,
}

#[derive(Deserialize, sqlx::FromRow)]
struct AnalyticsDayRow {
    day: NaiveDate,
    roots: i64,
    continuations: i64,
}

#[derive(sqlx::FromRow)]
struct ProviderAggregateRow {
    provider_name: String,
    requests_7d: i64,
    roots_7d: i64,
    continuations_7d: i64,
    total_tokens_7d: i64,
    prompt_tokens_7d: i64,
    completion_tokens_7d: i64,
}

#[derive(sqlx::FromRow)]
struct ProviderSnapshotRow {
    provider_name: String,
    last_model_id: Option<String>,
    last_status: Option<i32>,
    requests_limit_day: Option<i64>,
    requests_remaining_day: Option<i64>,
    requests_reset_day_seconds: Option<i64>,
    tokens_limit_minute: Option<i64>,
    tokens_remaining_minute: Option<i64>,
    tokens_reset_minute_seconds: Option<i64>,
    observed_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct AnalyticsDay {
    day: String,
    roots: i64,
    continuations: i64,
}

#[derive(Serialize)]
struct AnalyticsSummary {
    user: AppUser,
    router_label: String,
    root_requests_today: i64,
    continuation_requests_today: i64,
    active_runs: i64,
    root_requests_total: i64,
    continuation_requests_total: i64,
    five_hour_limit: i64,
    five_hour_used: i64,
    weekly_limit: i64,
    weekly_used: i64,
    past_week: Vec<AnalyticsDay>,
    past_month: Vec<AnalyticsDay>,
    managed_gateway_ready: bool,
    managed_gateway_status: String,
    owner_provider_overview: Vec<ProviderOverview>,
    api_url: String,
    analytics_url: String,
    db_url: String,
}

#[derive(Serialize)]
struct ProviderOverview {
    provider_name: String,
    requests_7d: i64,
    roots_7d: i64,
    continuations_7d: i64,
    total_tokens_7d: i64,
    prompt_tokens_7d: i64,
    completion_tokens_7d: i64,
    last_model_id: Option<String>,
    last_status: Option<i32>,
    last_observed_at: Option<String>,
    requests_limit_day: Option<i64>,
    requests_remaining_day: Option<i64>,
    requests_reset_day_seconds: Option<i64>,
    tokens_limit_minute: Option<i64>,
    tokens_remaining_minute: Option<i64>,
    tokens_reset_minute_seconds: Option<i64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RequestKind {
    Root,
    Continuation,
}

enum GatewayAccess {
    ServiceToken,
    CookieSession(BetterAuthUser),
    DesktopToken(AppUser),
}

async fn health_check() -> &'static str {
    "OK"
}

async fn bootstrap_schema(db: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS app_users (
            user_id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT NOT NULL,
            tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
            coupon_code TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS gateway_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            request_kind TEXT NOT NULL CHECK (request_kind IN ('root', 'continuation')),
            provider_name TEXT,
            model_id TEXT,
            prompt_tokens BIGINT,
            completion_tokens BIGINT,
            total_tokens BIGINT,
            upstream_status INT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS provider_name TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS model_id TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS prompt_tokens BIGINT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS completion_tokens BIGINT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS total_tokens BIGINT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS provider_snapshots (
            provider_name TEXT PRIMARY KEY,
            last_model_id TEXT,
            last_status INT,
            requests_limit_day BIGINT,
            requests_remaining_day BIGINT,
            requests_reset_day_seconds BIGINT,
            tokens_limit_minute BIGINT,
            tokens_remaining_minute BIGINT,
            tokens_reset_minute_seconds BIGINT,
            observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS desktop_auth_codes (
            code TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            email TEXT NOT NULL,
            name TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS desktop_access_tokens (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS desktop_oauth_states (
            state TEXT PRIMARY KEY,
            port INT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_gateway_requests_user_created_at
        ON gateway_requests (user_id, created_at);
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_gateway_requests_user_run_id
        ON gateway_requests (user_id, run_id);
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_desktop_auth_codes_user_id
        ON desktop_auth_codes (user_id, created_at DESC);
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_desktop_access_tokens_user_id
        ON desktop_access_tokens (user_id, created_at DESC);
        "#,
    )
    .execute(db)
    .await?;

    Ok(())
}

fn read_bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?;
    let trimmed = token.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn session_user_from_cookie(state: &AppState, headers: &HeaderMap) -> Option<BetterAuthUser> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?.to_string();
    if cookie.trim().is_empty() {
        return None;
    }

    let response = state
        .http_client
        .get(&state.auth_session_url)
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body = response.text().await.ok()?;
    let trimmed = body.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return None;
    }

    serde_json::from_str::<BetterAuthSession>(trimmed)
        .ok()
        .map(|session| session.user)
}

async fn app_user_from_desktop_token(state: &AppState, token: &str) -> Option<AppUser> {
    let user = sqlx::query_as::<_, AppUser>(
        r#"
        SELECT u.user_id, u.email, u.name, u.tier, u.coupon_code, u.created_at, u.updated_at
        FROM desktop_access_tokens t
        JOIN app_users u ON u.user_id = t.user_id
        WHERE t.token = $1
          AND t.expires_at > NOW()
        "#,
    )
    .bind(token)
    .fetch_optional(&state.db)
    .await
    .ok()??;

    let _ = sqlx::query(
        r#"
        UPDATE desktop_access_tokens
        SET last_used_at = NOW()
        WHERE token = $1
        "#,
    )
    .bind(token)
    .execute(&state.db)
    .await;

    Some(user)
}

async fn ensure_gateway_access(state: &AppState, headers: &HeaderMap) -> Result<GatewayAccess, StatusCode> {
    if let Some(token) = read_bearer_token(headers) {
        if !state.gateway.bearer_token.is_empty() && token == state.gateway.bearer_token {
            return Ok(GatewayAccess::ServiceToken);
        }
        if let Some(user) = app_user_from_desktop_token(state, &token).await {
            return Ok(GatewayAccess::DesktopToken(user));
        }
    }

    if let Some(user) = session_user_from_cookie(state, headers).await {
        return Ok(GatewayAccess::CookieSession(user));
    }

    Err(StatusCode::UNAUTHORIZED)
}

fn request_kind_from_headers(headers: &HeaderMap) -> RequestKind {
    match headers
        .get("x-zwork-request-kind")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("root")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "continuation" => RequestKind::Continuation,
        _ => RequestKind::Root,
    }
}

fn run_id_from_headers(headers: &HeaderMap) -> String {
    headers
        .get("x-zwork-run-id")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

async fn upsert_app_user(state: &AppState, auth_user: &BetterAuthUser) -> Result<AppUser, StatusCode> {
    let email = auth_user.email.clone().unwrap_or_default();
    let name = auth_user
        .name
        .clone()
        .unwrap_or_else(|| "zWork user".to_string());

    sqlx::query_as::<_, AppUser>(
        r#"
        INSERT INTO app_users (user_id, email, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id)
        DO UPDATE SET
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            updated_at = NOW()
        RETURNING user_id, email, name, tier, coupon_code, created_at, updated_at
        "#,
    )
    .bind(&auth_user.id)
    .bind(&email)
    .bind(&name)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn is_owner_email(state: &AppState, email: &str) -> bool {
    let email = email.trim().to_ascii_lowercase();
    !email.is_empty() && state.owner_emails.iter().any(|item| item == &email)
}

async fn resolve_app_user(state: &AppState, access: GatewayAccess) -> Result<Option<AppUser>, StatusCode> {
    match access {
        GatewayAccess::ServiceToken => Ok(None),
        GatewayAccess::CookieSession(user) => upsert_app_user(state, &user).await.map(Some),
        GatewayAccess::DesktopToken(user) => Ok(Some(user)),
    }
}

async fn enforce_root_rate_limit(state: &AppState, user_id: &str) -> Result<(), StatusCode> {
    let used_last_5h: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'root'
          AND created_at >= NOW() - INTERVAL '5 hours'
        "#,
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if used_last_5h >= state.gateway.root_requests_per_5h {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    let weekly_limit = state.gateway.root_requests_per_5h * state.gateway.weekly_limit_multiplier.max(1);
    let used_last_7d: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'root'
          AND created_at >= NOW() - INTERVAL '7 days'
        "#,
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if used_last_7d >= weekly_limit {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    let active_roots: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(DISTINCT run_id)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'root'
          AND finished_at IS NULL
        "#,
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if active_roots >= state.gateway.max_concurrent_roots {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    Ok(())
}

async fn mark_gateway_request_upstream(
    state: &AppState,
    request_id: Uuid,
    provider_name: &str,
    model_id: &str,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    total_tokens: Option<i64>,
) {
    let _ = sqlx::query(
        r#"
        UPDATE gateway_requests
        SET provider_name = $2,
            model_id = $3,
            prompt_tokens = $4,
            completion_tokens = $5,
            total_tokens = $6
        WHERE id = $1
        "#,
    )
    .bind(request_id)
    .bind(provider_name)
    .bind(model_id)
    .bind(prompt_tokens)
    .bind(completion_tokens)
    .bind(total_tokens)
    .execute(&state.db)
    .await;
}

fn parse_i64_header(headers: &HeaderMap, name: &str) -> Option<i64> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok())
}

fn parse_usage_counts(body_json: &Value) -> (Option<i64>, Option<i64>, Option<i64>) {
    let usage = body_json.get("usage").and_then(|value| value.as_object());
    let prompt = usage
        .and_then(|usage| usage.get("prompt_tokens"))
        .and_then(|value| value.as_i64());
    let completion = usage
        .and_then(|usage| usage.get("completion_tokens"))
        .and_then(|value| value.as_i64());
    let total = usage
        .and_then(|usage| usage.get("total_tokens"))
        .and_then(|value| value.as_i64());
    (prompt, completion, total)
}

fn wrap_json_completion_as_sse(body_json: &Value) -> Option<Vec<u8>> {
    let choices = body_json.get("choices")?.as_array()?;
    let first = choices.first()?;
    let finish_reason = first
        .get("finish_reason")
        .cloned()
        .unwrap_or(Value::String("stop".to_string()));
    let message = first.get("message")?.as_object()?;
    let mut delta = serde_json::Map::new();

    if let Some(content) = message.get("content").cloned() {
        delta.insert("content".to_string(), content);
    }

    if let Some(tool_calls) = message.get("tool_calls").cloned() {
        delta.insert("tool_calls".to_string(), tool_calls);
    }

    let event = serde_json::json!({
        "id": body_json.get("id").cloned().unwrap_or(Value::Null),
        "object": "chat.completion.chunk",
        "created": body_json.get("created").cloned().unwrap_or(Value::Null),
        "model": body_json.get("model").cloned().unwrap_or(Value::Null),
        "choices": [{
            "index": 0,
            "delta": Value::Object(delta),
            "finish_reason": finish_reason,
        }]
    });

    let payload = format!("data: {}\n\ndata: [DONE]\n\n", event);
    Some(payload.into_bytes())
}

async fn upsert_provider_snapshot(
    state: &AppState,
    provider_name: &str,
    model_id: &str,
    status: i32,
    headers: &HeaderMap,
) {
    let _ = sqlx::query(
        r#"
        INSERT INTO provider_snapshots (
            provider_name,
            last_model_id,
            last_status,
            requests_limit_day,
            requests_remaining_day,
            requests_reset_day_seconds,
            tokens_limit_minute,
            tokens_remaining_minute,
            tokens_reset_minute_seconds,
            observed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (provider_name)
        DO UPDATE SET
            last_model_id = EXCLUDED.last_model_id,
            last_status = EXCLUDED.last_status,
            requests_limit_day = EXCLUDED.requests_limit_day,
            requests_remaining_day = EXCLUDED.requests_remaining_day,
            requests_reset_day_seconds = EXCLUDED.requests_reset_day_seconds,
            tokens_limit_minute = EXCLUDED.tokens_limit_minute,
            tokens_remaining_minute = EXCLUDED.tokens_remaining_minute,
            tokens_reset_minute_seconds = EXCLUDED.tokens_reset_minute_seconds,
            observed_at = NOW()
        "#,
    )
    .bind(provider_name)
    .bind(model_id)
    .bind(status)
    .bind(parse_i64_header(headers, "x-ratelimit-limit-requests-day"))
    .bind(parse_i64_header(headers, "x-ratelimit-remaining-requests-day"))
    .bind(parse_i64_header(headers, "x-ratelimit-reset-requests-day"))
    .bind(parse_i64_header(headers, "x-ratelimit-limit-tokens-minute"))
    .bind(parse_i64_header(headers, "x-ratelimit-remaining-tokens-minute"))
    .bind(parse_i64_header(headers, "x-ratelimit-reset-tokens-minute"))
    .execute(&state.db)
    .await;
}

async fn insert_gateway_request(
    state: &AppState,
    user_id: &str,
    run_id: &str,
    request_kind: RequestKind,
) -> Result<Uuid, StatusCode> {
    let kind = match request_kind {
        RequestKind::Root => "root",
        RequestKind::Continuation => "continuation",
    };

    sqlx::query_scalar(
        r#"
        INSERT INTO gateway_requests (user_id, run_id, request_kind)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(run_id)
    .bind(kind)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn finish_gateway_request(state: &AppState, request_id: Uuid, status: Option<i32>) {
    let _ = sqlx::query(
        r#"
        UPDATE gateway_requests
        SET upstream_status = $2,
            finished_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(request_id)
    .bind(status)
    .execute(&state.db)
    .await;
}

async fn ingest_telemetry(
    State(state): State<AppState>,
    Json(payload): Json<TelemetryPayload>,
) -> impl IntoResponse {
    if state.posthog_key.trim().is_empty() {
        return (StatusCode::ACCEPTED, "Telemetry disabled").into_response();
    }

    let posthog_url = format!("{}/capture/", state.posthog_host.trim_end_matches('/'));
    let posthog_payload = serde_json::json!({
        "api_key": state.posthog_key,
        "event": payload.event,
        "properties": payload.properties,
        "distinct_id": payload.session_id.unwrap_or_else(|| "anonymous".to_string()),
        "timestamp": payload.ts,
    });

    match state
        .posthog_client
        .post(posthog_url)
        .json(&posthog_payload)
        .send()
        .await
    {
        Ok(_) => (StatusCode::OK, "Telemetry tracked").into_response(),
        Err(e) => {
            error!("Failed to track telemetry: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to track telemetry").into_response()
        }
    }
}

async fn ai_proxy(
    State(state): State<AppState>,
    req: Request<axum::body::Body>,
) -> Result<Response<axum::body::Body>, (StatusCode, String)> {
    let headers = req.headers().clone();
    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|status| (status, "gateway_access_denied".to_string()))?;
    let run_id = run_id_from_headers(&headers);
    let request_kind = request_kind_from_headers(&headers);
    let app_user = resolve_app_user(&state, access)
        .await
        .map_err(|status| (status, "gateway_user_resolution_failed".to_string()))?;

    if let (Some(user), RequestKind::Root) = (&app_user, request_kind) {
        enforce_root_rate_limit(&state, &user.user_id)
            .await
            .map_err(|status| {
                let message = match status {
                    StatusCode::TOO_MANY_REQUESTS => "root_request_quota_exceeded".to_string(),
                    StatusCode::CONFLICT => "too_many_active_runs".to_string(),
                    _ => "gateway_rate_limit_failed".to_string(),
                };
                (status, message)
            })?;
    }

    let request_id = if let Some(user) = &app_user {
        Some(
            insert_gateway_request(&state, &user.user_id, &run_id, request_kind)
                .await
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "gateway_request_log_failed".to_string()))?,
        )
    } else {
        None
    };

    if state.gateway.providers.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "hosted_gateway_not_configured".to_string(),
        ));
    }
    let body_bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024 * 10)
        .await
        .map_err(|_| (StatusCode::BAD_REQUEST, "request_body_too_large".to_string()))?;
    let mut body_json: Value =
        serde_json::from_slice(&body_bytes).map_err(|_| (StatusCode::BAD_REQUEST, "invalid_chat_payload".to_string()))?;

    let mut failures: Vec<String> = Vec::new();

    for provider in &state.gateway.providers {
        let models = if provider.fallback_model.trim().is_empty()
            || provider.fallback_model.trim() == provider.primary_model.trim()
        {
            vec![provider.primary_model.clone()]
        } else {
            vec![provider.primary_model.clone(), provider.fallback_model.clone()]
        };

        for model_name in models {
            let mut attempt_body = body_json.clone();
            if let Some(obj) = attempt_body.as_object_mut() {
                obj.insert("model".to_string(), Value::String(model_name.clone()));
            }

            let endpoint = format!("{}/chat/completions", provider.base_url.trim_end_matches('/'));
            let mut builder = state
                .http_client
                .post(endpoint)
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", provider.api_key))
                .json(&attempt_body);

            let resp = match builder.send().await {
                Ok(resp) => resp,
                Err(_) => {
                    failures.push(format!("{}:{} unreachable", provider.name, model_name));
                    continue;
                }
            };

            let status = resp.status();
            let upstream_headers = resp.headers().clone();
            if !status.is_success() {
                let detail = resp
                    .text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(180)
                    .collect::<String>();
                failures.push(format!("{}:{} {} {}", provider.name, model_name, status.as_u16(), detail));
                continue;
            }

            let body_bytes = match resp.bytes().await {
                Ok(bytes) => bytes,
                Err(_) => {
                    failures.push(format!("{}:{} response_read_failed", provider.name, model_name));
                    continue;
                }
            };
            let body_json: Option<Value> = serde_json::from_slice(&body_bytes).ok();
            let (prompt_tokens, completion_tokens, total_tokens) = body_json
                .as_ref()
                .map(parse_usage_counts)
                .unwrap_or((None, None, None));
            if let Some(request_id) = request_id {
                mark_gateway_request_upstream(
                    &state,
                    request_id,
                    &provider.name,
                    &model_name,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                )
                .await;
                finish_gateway_request(&state, request_id, Some(status.as_u16() as i32)).await;
            }
            upsert_provider_snapshot(
                &state,
                &provider.name,
                &model_name,
                status.as_u16() as i32,
                &upstream_headers,
            )
            .await;

            let response_bytes = body_json
                .as_ref()
                .and_then(wrap_json_completion_as_sse)
                .unwrap_or_else(|| body_bytes.to_vec());
            let body = axum::body::Body::from(response_bytes);
            let mut response = Response::new(body);
            *response.status_mut() = status;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/event-stream; charset=utf-8"),
            );
            response.headers_mut().insert(
                HeaderName::from_static("x-zwork-router-provider"),
                HeaderValue::from_str(&provider.name).unwrap_or_else(|_| HeaderValue::from_static("zwork-router")),
            );
            response.headers_mut().insert(
                HeaderName::from_static("x-zwork-router-model"),
                HeaderValue::from_str(&model_name).unwrap_or_else(|_| HeaderValue::from_static("unknown")),
            );
            response.headers_mut().insert(
                HeaderName::from_static("x-zwork-router-label"),
                HeaderValue::from_str(&state.gateway.router_label).unwrap_or_else(|_| HeaderValue::from_static("zWork Router")),
            );
            return Ok(response);
        }
    }

    if let Some(request_id) = request_id {
        finish_gateway_request(&state, request_id, Some(StatusCode::BAD_GATEWAY.as_u16() as i32)).await;
    }

    Err((
        StatusCode::BAD_GATEWAY,
        format!("router_upstreams_failed: {}", failures.join(" | ")),
    ))
}

fn cors_allowed_origins() -> Vec<HeaderValue> {
    let raw = std::env::var("CORS_ALLOWED_ORIGINS").unwrap_or_else(|_| {
        [
            "tauri://localhost",
            "https://tauri.localhost",
            "http://tauri.localhost",
            "https://localhost:1420",
            "http://localhost:1420",
            "https://127.0.0.1:1420",
            "http://127.0.0.1:1420",
            "https://tryzwork.app",
            "https://www.tryzwork.app",
            "https://api.tryzwork.app",
        ]
        .join(",")
    });

    raw.split(',')
        .filter_map(|value| HeaderValue::from_str(value.trim()).ok())
        .collect()
}

async fn stripe_webhook(State(state): State<AppState>) -> impl IntoResponse {
    if state.stripe_webhook_secret.trim().is_empty() {
        return (StatusCode::ACCEPTED, "Stripe disabled").into_response();
    }
    (StatusCode::OK, "Webhook received").into_response()
}

async fn get_user_by_google_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(google_id): Path<String>,
) -> Result<Json<User>, StatusCode> {
    let _ = ensure_gateway_access(&state, &headers).await?;
    sqlx::query_as::<_, User>("SELECT * FROM users WHERE google_id = $1")
        .bind(&google_id)
        .fetch_optional(&state.db)
        .await
        .map(|user| user.map(Json).ok_or(StatusCode::NOT_FOUND))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn upsert_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateUserRequest>,
) -> Result<Json<User>, StatusCode> {
    let _ = ensure_gateway_access(&state, &headers).await?;
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
        "#,
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

async fn update_user_tier(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(google_id): Path<String>,
    Json(req): Json<UpdateTierRequest>,
) -> Result<Json<User>, StatusCode> {
    let _ = ensure_gateway_access(&state, &headers).await?;
    sqlx::query_as::<_, User>(
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
        "#,
    )
    .bind(&google_id)
    .bind(&req.tier)
    .bind(&req.subscription_id)
    .bind(&req.subscription_status)
    .bind(req.subscription_end_date.as_deref())
    .fetch_optional(&state.db)
    .await
    .map(|user| user.map(Json).ok_or(StatusCode::NOT_FOUND))
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn session_me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AppUser>, StatusCode> {
    let access = ensure_gateway_access(&state, &headers).await?;
    let user = resolve_app_user(&state, access)
        .await?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(user))
}

async fn redeem_coupon(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CouponRedeemRequest>,
) -> Result<Json<AppUser>, (StatusCode, String)> {
    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|status| (status, "access_denied".to_string()))?;
    let user = resolve_app_user(&state, access)
        .await
        .map_err(|status| (status, "user_lookup_failed".to_string()))?
        .ok_or((StatusCode::UNAUTHORIZED, "not_signed_in".to_string()))?;
    let code = body.code.trim();

    if code.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "missing_access_code".to_string()));
    }

    let allowed = state
        .gateway
        .dev_coupon_codes
        .iter()
        .any(|candidate| candidate == code);
    if !allowed {
        return Err((StatusCode::FORBIDDEN, "invalid_access_code".to_string()));
    }

    let user = sqlx::query_as::<_, AppUser>(
        r#"
        UPDATE app_users
        SET tier = 'pro',
            coupon_code = $2,
            updated_at = NOW()
        WHERE user_id = $1
        RETURNING user_id, email, name, tier, coupon_code, created_at, updated_at
        "#,
    )
    .bind(&user.user_id)
    .bind(code)
    .fetch_one(&state.db)
    .await
    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "access_code_update_failed".to_string()))?;

    Ok(Json(user))
}

async fn desktop_auth_start(
    Query(query): Query<DesktopAuthStartQuery>,
) -> Result<Redirect, StatusCode> {
    if query.port == 0 {
        return Err(StatusCode::BAD_REQUEST);
    }

    let sign_in_url = format!(
        "https://api.tryzwork.app/api/auth/desktop/google?port={}",
        query.port,
    );

    Ok(Redirect::temporary(&sign_in_url))
}

fn localhost_auth_redirect(port: u16, key: &str, value: &str) -> Redirect {
    let redirect = format!(
        "http://127.0.0.1:{}/callback?{}={}",
        port,
        key,
        urlencoding::encode(value)
    );
    Redirect::temporary(&redirect)
}

async fn desktop_google_auth_start(
    State(state): State<AppState>,
    Query(query): Query<DesktopAuthStartQuery>,
) -> Result<Redirect, StatusCode> {
    if query.port == 0 {
        return Err(StatusCode::BAD_REQUEST);
    }

    if state.google_client_id.trim().is_empty() || state.google_client_secret.trim().is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    let state_value = format!("oauth_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let expires_at = Utc::now() + Duration::minutes(10);

    sqlx::query(
        r#"
        INSERT INTO desktop_oauth_states (state, port, expires_at)
        VALUES ($1, $2, $3)
        "#,
    )
    .bind(&state_value)
    .bind(i32::from(query.port))
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let params = [
        ("client_id", state.google_client_id.as_str()),
        ("redirect_uri", "https://api.tryzwork.app/api/auth/callback/google"),
        ("response_type", "code"),
        ("scope", "openid email profile"),
        ("access_type", "offline"),
        ("prompt", "select_account"),
        ("state", state_value.as_str()),
    ];

    let oauth_url = reqwest::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        params,
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Redirect::temporary(oauth_url.as_ref()))
}

async fn desktop_google_callback(
    State(state): State<AppState>,
    Query(query): Query<GoogleCallbackQuery>,
) -> Result<Redirect, StatusCode> {
    let state_value = query.state.as_deref().ok_or(StatusCode::BAD_REQUEST)?;
    let oauth_state = sqlx::query_as::<_, DesktopOauthState>(
        r#"
        DELETE FROM desktop_oauth_states
        WHERE state = $1
          AND expires_at > NOW()
        RETURNING state, port, expires_at
        "#,
    )
    .bind(state_value)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::UNAUTHORIZED)?;

    let port = u16::try_from(oauth_state.port).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if let Some(error) = query.error.as_deref() {
        let detail = query
            .error_description
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(error);
        return Ok(localhost_auth_redirect(port, "error", detail));
    }

    let code = query.code.as_deref().ok_or(StatusCode::BAD_REQUEST)?;
    let token_response = state
        .http_client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", state.google_client_id.as_str()),
            ("client_secret", state.google_client_secret.as_str()),
            ("redirect_uri", "https://api.tryzwork.app/api/auth/callback/google"),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !token_response.status().is_success() {
        return Ok(localhost_auth_redirect(port, "error", "google_token_exchange_failed"));
    }

    let token_payload = token_response
        .json::<GoogleTokenResponse>()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    let userinfo_response = state
        .http_client
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&token_payload.access_token)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !userinfo_response.status().is_success() {
        return Ok(localhost_auth_redirect(port, "error", "google_userinfo_failed"));
    }

    let google_user = userinfo_response
        .json::<GoogleUserInfo>()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    let auth_user = BetterAuthUser {
        id: google_user.sub,
        email: Some(google_user.email),
        name: google_user.name,
    };
    let app_user = upsert_app_user(&state, &auth_user).await?;
    let desktop_code = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let expires_at = Utc::now() + Duration::minutes(5);

    sqlx::query(
        r#"
        INSERT INTO desktop_auth_codes (code, user_id, email, name, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(&desktop_code)
    .bind(&app_user.user_id)
    .bind(&app_user.email)
    .bind(&app_user.name)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(localhost_auth_redirect(port, "code", &desktop_code))
}

async fn desktop_auth_exchange(
    State(state): State<AppState>,
    Json(body): Json<DesktopAuthExchangeRequest>,
) -> Result<Json<DesktopAuthExchangeResponse>, StatusCode> {
    let code = body.code.trim();
    if code.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let claimed = sqlx::query_as::<_, AppUser>(
        r#"
        WITH claimed AS (
            UPDATE desktop_auth_codes
            SET used_at = NOW()
            WHERE code = $1
              AND used_at IS NULL
              AND expires_at > NOW()
            RETURNING user_id, email, name
        )
        INSERT INTO app_users (user_id, email, name)
        SELECT user_id, email, name FROM claimed
        ON CONFLICT (user_id)
        DO UPDATE SET
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            updated_at = NOW()
        RETURNING user_id, email, name, tier, coupon_code, created_at, updated_at
        "#,
    )
    .bind(code)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::UNAUTHORIZED)?;

    let token = format!("zw_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let expires_at = Utc::now() + Duration::days(30);

    sqlx::query(
        r#"
        INSERT INTO desktop_access_tokens (token, user_id, expires_at)
        VALUES ($1, $2, $3)
        "#,
    )
    .bind(&token)
    .bind(&claimed.user_id)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(DesktopAuthExchangeResponse { token, user: claimed }))
}

async fn desktop_auth_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    let token = read_bearer_token(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let result = sqlx::query("DELETE FROM desktop_access_tokens WHERE token = $1")
        .bind(token)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if result.rows_affected() == 0 {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn analytics_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AnalyticsSummary>, StatusCode> {
    let access = ensure_gateway_access(&state, &headers).await?;
    let user = resolve_app_user(&state, access)
        .await?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let root_requests_today: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'root'
          AND created_at >= date_trunc('day', NOW())
        "#,
    )
    .bind(&user.user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let continuation_requests_today: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'continuation'
          AND created_at >= date_trunc('day', NOW())
        "#,
    )
    .bind(&user.user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let active_runs: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(DISTINCT run_id)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'root'
          AND finished_at IS NULL
        "#,
    )
    .bind(&user.user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let root_requests_total: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'root'
        "#,
    )
    .bind(&user.user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let continuation_requests_total: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'continuation'
        "#,
    )
    .bind(&user.user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let five_hour_used: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'root'
          AND created_at >= NOW() - INTERVAL '5 hours'
        "#,
    )
    .bind(&user.user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let weekly_used: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'root'
          AND created_at >= NOW() - INTERVAL '7 days'
        "#,
    )
    .bind(&user.user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let rows = sqlx::query_as::<_, AnalyticsDayRow>(
        r#"
        SELECT
            DATE(created_at) AS day,
            COUNT(*) FILTER (WHERE request_kind = 'root')::BIGINT AS roots,
            COUNT(*) FILTER (WHERE request_kind = 'continuation')::BIGINT AS continuations
        FROM gateway_requests
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
        ORDER BY day ASC
        "#,
    )
    .bind(&user.user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let past_week = rows
        .into_iter()
        .map(|row| AnalyticsDay {
            day: row.day.to_string(),
            roots: row.roots,
            continuations: row.continuations,
        })
        .collect();

    let month_rows = sqlx::query_as::<_, AnalyticsDayRow>(
        r#"
        SELECT
            DATE(created_at) AS day,
            COUNT(*) FILTER (WHERE request_kind = 'root')::BIGINT AS roots,
            COUNT(*) FILTER (WHERE request_kind = 'continuation')::BIGINT AS continuations
        FROM gateway_requests
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY day ASC
        "#,
    )
    .bind(&user.user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let past_month = month_rows
        .into_iter()
        .map(|row| AnalyticsDay {
            day: row.day.to_string(),
            roots: row.roots,
            continuations: row.continuations,
        })
        .collect();

    let managed_gateway_ready = !state.gateway.providers.is_empty();
    let managed_gateway_status = if managed_gateway_ready {
        let provider_list = state
            .gateway
            .providers
            .iter()
            .map(|provider| format!("{} ({}, fallback {})", provider.name, provider.primary_model, provider.fallback_model))
            .collect::<Vec<_>>()
            .join(" · ");
        format!("{} is ready via {}", state.gateway.router_label, provider_list)
    } else {
        "Hosted gateway is not configured yet. Add at least one provider API key on the server.".to_string()
    };

    let five_hour_limit = state.gateway.root_requests_per_5h;
    let weekly_limit = state.gateway.root_requests_per_5h * state.gateway.weekly_limit_multiplier.max(1);
    let mut owner_provider_overview = Vec::new();

    if is_owner_email(&state, &user.email) {
        let aggregate_rows = sqlx::query_as::<_, ProviderAggregateRow>(
            r#"
            SELECT
                COALESCE(provider_name, 'Unknown') AS provider_name,
                COUNT(*)::BIGINT AS requests_7d,
                COUNT(*) FILTER (WHERE request_kind = 'root')::BIGINT AS roots_7d,
                COUNT(*) FILTER (WHERE request_kind = 'continuation')::BIGINT AS continuations_7d,
                COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens_7d,
                COALESCE(SUM(prompt_tokens), 0)::BIGINT AS prompt_tokens_7d,
                COALESCE(SUM(completion_tokens), 0)::BIGINT AS completion_tokens_7d
            FROM gateway_requests
            WHERE created_at >= NOW() - INTERVAL '7 days'
            GROUP BY COALESCE(provider_name, 'Unknown')
            ORDER BY requests_7d DESC, provider_name ASC
            "#,
        )
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        let snapshot_rows = sqlx::query_as::<_, ProviderSnapshotRow>(
            r#"
            SELECT
                provider_name,
                last_model_id,
                last_status,
                requests_limit_day,
                requests_remaining_day,
                requests_reset_day_seconds,
                tokens_limit_minute,
                tokens_remaining_minute,
                tokens_reset_minute_seconds,
                observed_at
            FROM provider_snapshots
            "#,
        )
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        for aggregate in aggregate_rows {
            if aggregate.provider_name == "Unknown" {
                continue;
            }
            let snapshot = snapshot_rows
                .iter()
                .find(|row| row.provider_name == aggregate.provider_name);
            owner_provider_overview.push(ProviderOverview {
                provider_name: aggregate.provider_name,
                requests_7d: aggregate.requests_7d,
                roots_7d: aggregate.roots_7d,
                continuations_7d: aggregate.continuations_7d,
                total_tokens_7d: aggregate.total_tokens_7d,
                prompt_tokens_7d: aggregate.prompt_tokens_7d,
                completion_tokens_7d: aggregate.completion_tokens_7d,
                last_model_id: snapshot.and_then(|row| row.last_model_id.clone()),
                last_status: snapshot.and_then(|row| row.last_status),
                last_observed_at: snapshot.map(|row| row.observed_at.to_rfc3339()),
                requests_limit_day: snapshot.and_then(|row| row.requests_limit_day),
                requests_remaining_day: snapshot.and_then(|row| row.requests_remaining_day),
                requests_reset_day_seconds: snapshot.and_then(|row| row.requests_reset_day_seconds),
                tokens_limit_minute: snapshot.and_then(|row| row.tokens_limit_minute),
                tokens_remaining_minute: snapshot.and_then(|row| row.tokens_remaining_minute),
                tokens_reset_minute_seconds: snapshot.and_then(|row| row.tokens_reset_minute_seconds),
            });
        }
    }

    Ok(Json(AnalyticsSummary {
        user,
        router_label: state.gateway.router_label.clone(),
        root_requests_today,
        continuation_requests_today,
        active_runs,
        root_requests_total,
        continuation_requests_total,
        five_hour_limit,
        five_hour_used,
        weekly_limit,
        weekly_used,
        past_week,
        past_month,
        managed_gateway_ready,
        managed_gateway_status,
        owner_provider_overview,
        api_url: "https://api.tryzwork.app/health".to_string(),
        analytics_url: "https://us.posthog.com/project/397748".to_string(),
        db_url: "https://db.tryzwork.app/".to_string(),
    }))
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

    bootstrap_schema(&pool)
        .await
        .expect("Failed to bootstrap Postgres schema");

    let state = AppState {
        posthog_client: Client::new(),
        posthog_key: std::env::var("POSTHOG_API_KEY").unwrap_or_default(),
        posthog_host: std::env::var("POSTHOG_HOST")
            .unwrap_or_else(|_| "https://app.posthog.com".to_string()),
        stripe_webhook_secret: std::env::var("STRIPE_WEBHOOK_SECRET").unwrap_or_default(),
        db: pool,
        http_client: Client::new(),
        auth_session_url: std::env::var("AUTH_SESSION_URL")
            .unwrap_or_else(|_| "http://better_auth:3000/api/auth/get-session".to_string()),
        auth_public_base: std::env::var("AUTH_PUBLIC_BASE")
            .unwrap_or_else(|_| "https://api.tryzwork.app/api/auth".to_string()),
        google_client_id: std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default(),
        google_client_secret: std::env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default(),
        owner_emails: std::env::var("OWNER_EMAILS")
            .unwrap_or_default()
            .split(',')
            .map(|item| item.trim().to_ascii_lowercase())
            .filter(|item| !item.is_empty())
            .collect(),
        gateway: GatewayConfig {
            router_label: env_or("ROUTER_LABEL", "zWork Router"),
            providers: load_gateway_providers(),
            bearer_token: std::env::var("ZWORK_GATEWAY_TOKEN").unwrap_or_default(),
            root_requests_per_5h: std::env::var("ROOT_REQUESTS_PER_5H")
                .or_else(|_| std::env::var("ROOT_REQUESTS_PER_DAY"))
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(20),
            weekly_limit_multiplier: std::env::var("WEEKLY_LIMIT_MULTIPLIER")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(5),
            max_concurrent_roots: std::env::var("MAX_CONCURRENT_ROOT_RUNS")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(3),
            dev_coupon_codes: std::env::var("DEV_COUPON_CODES")
                .unwrap_or_default()
                .split(',')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect(),
        },
    };

    let cors = CorsLayer::new()
        .allow_origin(cors_allowed_origins())
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/api/session", get(session_me))
        .route("/api/telemetry/event", post(ingest_telemetry))
        .route("/api/chat/stream", post(ai_proxy))
        .route("/api/v1/chat/completions", post(ai_proxy))
        .route("/api/webhooks/stripe", post(stripe_webhook))
        .route("/api/dev/redeem-coupon", post(redeem_coupon))
        .route("/api/desktop/auth/start", get(desktop_auth_start))
        .route("/api/auth/desktop/google", get(desktop_google_auth_start))
        .route("/api/auth/callback/google", get(desktop_google_callback))
        .route("/api/desktop/auth/exchange", post(desktop_auth_exchange))
        .route("/api/desktop/auth/logout", post(desktop_auth_logout))
        .route("/api/analytics/summary", get(analytics_summary))
        .route("/api/users/:google_id", get(get_user_by_google_id))
        .route("/api/users", post(upsert_user))
        .route("/api/users/:google_id/tier", put(update_user_tier))
        .layer(cors)
        .with_state(state);

    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    info!("Server running on 0.0.0.0:8080");
    axum::serve(listener, app).await.unwrap();
}
