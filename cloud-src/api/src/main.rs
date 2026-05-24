use axum::{
    body::Bytes,
    extract::{Json, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{delete, get, patch, post, put},
    Router,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use hmac::{Hmac, Mac};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpListener;
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::SmartIpKeyExtractor;
use tower_governor::GovernorLayer;
use tower_http::cors::CorsLayer;
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    posthog_client: Client,
    posthog_key: String,
    posthog_host: String,
    stripe_secret_key: String,
    stripe_webhook_secret: String,
    db: PgPool,
    http_client: Client,
    auth_session_url: Url,
    auth_internal_base: Url,
    auth_public_base: String,
    google_client_id: String,
    google_client_secret: String,
    owner_emails: Vec<String>,
    features: AppFeatures,
    gateway: GatewayConfig,
    composio_api_key: String,
}

const COMPOSIO_BASE_URL: &str = "https://backend.composio.dev/api/v3";

#[derive(Clone)]
struct AppFeatures {
    hosted_gateway: bool,
    billing: bool,
    email_auth: bool,
    coupons: bool,
}

#[derive(Clone)]
struct GatewayConfig {
    router_label: String,
    providers: Vec<GatewayProvider>,
    bearer_token: String,
    root_requests_per_5h: i64,
    weekly_limit_multiplier: i64,
    max_concurrent_roots: i64,
    pro_max_concurrent_roots: i64,
    max_max_concurrent_roots: i64,
    dev_coupon_codes: Vec<String>,
    /// Total root requests available to ALL free users combined per 5 hours.
    /// Each free user gets an equal share: pool / active_free_users (floor 5).
    free_tier_pool_5h: i64,
    pro_root_requests_per_5h: i64,
    max_root_requests_per_5h: i64,
}

#[derive(Clone)]
struct GatewayProvider {
    name: String,
    base_url: String,
    api_key: String,
    primary_model: String,
    fallback_model: String,
    protocol: GatewayProtocol,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GatewayProtocol {
    OpenAi,
    Anthropic,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_bool(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

fn validate_internal_service_url(url: &Url, key: &str) {
    if !matches!(url.scheme(), "http" | "https") {
        panic!("{key} must use http or https");
    }
    if url.host_str().is_none() {
        panic!("{key} must include a host");
    }
    if !url.username().is_empty() || url.password().is_some() {
        panic!("{key} must not include URL credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        panic!("{key} must not include query params or fragments");
    }
}

fn normalize_auth_base_path(mut url: Url) -> Url {
    let trimmed = url.path().trim_end_matches('/');
    let normalized = if trimmed.is_empty() {
        "/".to_string()
    } else {
        format!("{trimmed}/")
    };
    url.set_path(&normalized);
    url
}

fn load_auth_internal_base() -> Url {
    let raw = std::env::var("AUTH_INTERNAL_BASE")
        .unwrap_or_else(|_| "http://better_auth:3000/api/auth".to_string());
    let parsed = Url::parse(&raw).unwrap_or_else(|err| {
        panic!("AUTH_INTERNAL_BASE must be a valid absolute URL: {err}");
    });
    validate_internal_service_url(&parsed, "AUTH_INTERNAL_BASE");
    normalize_auth_base_path(parsed)
}

fn load_auth_session_url(auth_internal_base: &Url) -> Url {
    let default_session_url = auth_internal_base
        .join("get-session")
        .expect("AUTH_INTERNAL_BASE must allow appending get-session");
    let raw = std::env::var("AUTH_SESSION_URL").unwrap_or_else(|_| default_session_url.to_string());
    let parsed = Url::parse(&raw).unwrap_or_else(|err| {
        panic!("AUTH_SESSION_URL must be a valid absolute URL: {err}");
    });
    validate_internal_service_url(&parsed, "AUTH_SESSION_URL");
    if parsed.scheme() != auth_internal_base.scheme()
        || parsed.host_str() != auth_internal_base.host_str()
        || parsed.port_or_known_default() != auth_internal_base.port_or_known_default()
    {
        panic!("AUTH_SESSION_URL must share scheme/host/port with AUTH_INTERNAL_BASE");
    }
    if parsed.path() != default_session_url.path() {
        panic!("AUTH_SESSION_URL path must match AUTH_INTERNAL_BASE + /get-session");
    }
    parsed
}

fn auth_endpoint_url(auth_internal_base: &Url, endpoint: &str) -> Url {
    auth_internal_base
        .join(endpoint)
        .unwrap_or_else(|_| panic!("failed to build auth endpoint URL: {endpoint}"))
}

/// Allowed model IDs that the router will serve.
const ALLOWED_MODELS: &[&str] = &["deepseek-v4-flash", "deepseek-v4-pro"];
/// Models restricted to pro+ tiers.
const PRO_ONLY_MODELS: &[&str] = &["deepseek-v4-pro"];

fn load_gateway_providers() -> Vec<GatewayProvider> {
    let api_key = std::env::var("DEEPSEEK_API_KEY").unwrap_or_default();
    if api_key.trim().is_empty() {
        return Vec::new();
    }
    vec![GatewayProvider {
        name: "DeepSeek".to_string(),
        base_url: env_or("DEEPSEEK_BASE_URL", "https://api.deepseek.com/anthropic"),
        api_key,
        primary_model: env_or("DEEPSEEK_MODEL_PRIMARY", "deepseek-v4-flash"),
        fallback_model: env_or("DEEPSEEK_MODEL_FALLBACK", "deepseek-v4-flash"),
        protocol: match std::env::var("DEEPSEEK_PROTOCOL")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "openai" => GatewayProtocol::OpenAi,
            _ => GatewayProtocol::Anthropic,
        },
    }]
}

/// Ensure assistant messages include a thinking block for DeepSeek compatibility.
/// DeepSeek requires thinking content to be passed back in multi-turn conversations.
fn ensure_thinking_blocks(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(|m| m.as_array_mut()) else {
        return;
    };
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }
        let Some(content) = msg.get_mut("content") else {
            continue;
        };
        // If content is a string, convert to content blocks with a synthetic thinking block
        if let Some(text) = content.as_str() {
            let mut blocks: Vec<Value> = vec![serde_json::json!({
                "type": "thinking",
                "thinking": "(thinking omitted)",
                "signature": "synthetic"
            })];
            if !text.is_empty() {
                blocks.push(serde_json::json!({"type": "text", "text": text}));
            }
            *content = Value::Array(blocks);
            continue;
        }
        // If content is already content blocks, ensure first block is thinking
        if let Some(blocks) = content.as_array_mut() {
            let has_thinking = blocks
                .first()
                .and_then(|b| b.get("type"))
                .and_then(|t| t.as_str())
                == Some("thinking");
            if !has_thinking {
                blocks.insert(
                    0,
                    serde_json::json!({
                        "type": "thinking",
                        "thinking": "(thinking omitted)",
                        "signature": "synthetic"
                    }),
                );
            }
        }
    }
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
    stripe_customer_id: Option<String>,
    subscription_id: Option<String>,
    subscription_status: Option<String>,
    subscription_price_id: Option<String>,
    subscription_current_period_end: Option<DateTime<Utc>>,
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

#[derive(Deserialize)]
struct DesktopEmailSignInRequest {
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct DesktopEmailSignUpRequest {
    name: String,
    email: String,
    password: String,
    callback_url: Option<String>,
}

#[derive(Serialize)]
struct DesktopEmailSignUpResponse {
    ok: bool,
    verification_required: bool,
    message: String,
}

#[derive(Deserialize)]
struct BillingCheckoutRequest {
    success_url: String,
    cancel_url: String,
    annual: Option<bool>,
    tier: Option<String>,
}

#[derive(Deserialize)]
struct BillingPortalRequest {
    return_url: String,
}

#[derive(Serialize)]
struct BillingSessionResponse {
    url: String,
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
    billing_enabled: bool,
    billing_status: String,
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

// Admin API Response Structs
#[derive(Clone, Serialize)]
struct AdminMetricsOverview {
    total_users: i64,
    active_users_30d: i64,
    active_users_7d: i64,
    new_users_this_week: i64,
    new_users_this_month: i64,
    churn_rate: f64,
    paid_users: i64,
    mrr: f64,
    arpu: f64,
    free_to_paid_conversion: f64,
}

#[derive(Clone, Serialize)]
struct AdminUserRow {
    user_id: String,
    email: String,
    name: String,
    tier: String,
    created_at: DateTime<Utc>,
    last_activity: Option<DateTime<Utc>>,
    total_requests: i64,
    total_tokens: i64,
    stripe_customer_id: Option<String>,
    subscription_status: Option<String>,
}

#[derive(Clone, Serialize)]
struct AdminUsageByTime {
    date: NaiveDate,
    requests: i64,
    tokens: i64,
}

#[derive(Clone, Serialize)]
struct AdminUsageByModel {
    model_id: String,
    requests: i64,
    tokens: i64,
    percentage: f64,
}

#[derive(Clone, Serialize)]
struct AdminBillingMetrics {
    mrr: f64,
    arr: f64,
    total_revenue: f64,
    active_subscriptions: i64,
    churned_this_month: i64,
    churn_revenue: f64,
}

#[derive(Clone, Deserialize)]
struct AdminUpdatePlanRequest {
    tier: String,
}

// -- Web chat structs --

#[derive(Debug, Serialize, sqlx::FromRow)]
struct WebChat {
    id: Uuid,
    user_id: String,
    title: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct WebChatMessage {
    id: Uuid,
    chat_id: Uuid,
    role: String,
    content: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct CreateWebChatPayload {
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateWebChatPayload {
    title: String,
}

#[derive(Debug, Deserialize)]
struct AddWebChatMessagePayload {
    role: String,
    content: String,
}

// -- Composio structs --

#[derive(Deserialize)]
struct ComposioConnectRequest {
    app: String,
}

#[derive(Deserialize)]
struct ComposioDisconnectRequest {
    app: String,
}

fn composio_request_headers(api_key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers
}

fn composio_app_display_map() -> HashMap<String, (String, String, String)> {
    let mut m = HashMap::new();
    m.insert("gmail".into(), ("Gmail".into(), "mail".into(), "#EA4335".into()));
    m.insert("googlecalendar".into(), ("Google Calendar".into(), "calendar".into(), "#4285F4".into()));
    m.insert("slack".into(), ("Slack".into(), "hash".into(), "#4A154B".into()));
    m.insert("notion".into(), ("Notion".into(), "book-open".into(), "#000000".into()));
    m.insert("googledrive".into(), ("Google Drive".into(), "folder".into(), "#0F9D58".into()));
    m.insert("github".into(), ("GitHub".into(), "git-branch".into(), "#24292F".into()));
    m.insert("jira".into(), ("Jira".into(), "layers".into(), "#0052CC".into()));
    m.insert("trello".into(), ("Trello".into(), "layout-grid".into(), "#0079BF".into()));
    m.insert("todoist".into(), ("Todoist".into(), "check-square".into(), "#E44332".into()));
    m.insert("linear".into(), ("Linear".into(), "zap".into(), "#5E6AD2".into()));
    m.insert("asana".into(), ("Asana".into(), "target".into(), "#F06A6A".into()));
    m.insert("hubspot".into(), ("HubSpot".into(), "circle-dot".into(), "#FF7A59".into()));
    m
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
            tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'max')),
            coupon_code TEXT,
            stripe_customer_id TEXT,
            subscription_id TEXT,
            subscription_status TEXT,
            subscription_price_id TEXT,
            subscription_current_period_end TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS subscription_id TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS subscription_status TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS subscription_price_id TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;
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

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS web_chats (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT 'New chat',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS web_chat_messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            chat_id UUID NOT NULL REFERENCES web_chats(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_web_chats_user
        ON web_chats(user_id, updated_at DESC);
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_web_chat_messages_chat
        ON web_chat_messages(chat_id, created_at);
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
        .get(state.auth_session_url.clone())
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
        SELECT u.user_id, u.email, u.name, u.tier, u.coupon_code,
               u.stripe_customer_id, u.subscription_id, u.subscription_status,
               u.subscription_price_id, u.subscription_current_period_end,
               u.created_at, u.updated_at
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

async fn ensure_gateway_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<GatewayAccess, StatusCode> {
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

async fn upsert_app_user(
    state: &AppState,
    auth_user: &BetterAuthUser,
) -> Result<AppUser, StatusCode> {
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
        RETURNING user_id, email, name, tier, coupon_code,
                  stripe_customer_id, subscription_id, subscription_status,
                  subscription_price_id, subscription_current_period_end,
                  created_at, updated_at
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

async fn resolve_app_user(
    state: &AppState,
    access: GatewayAccess,
) -> Result<Option<AppUser>, StatusCode> {
    match access {
        GatewayAccess::ServiceToken => Ok(None),
        GatewayAccess::CookieSession(user) => upsert_app_user(state, &user).await.map(Some),
        GatewayAccess::DesktopToken(user) => Ok(Some(user)),
    }
}

async fn ensure_owner_or_service(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<AppUser>, StatusCode> {
    // First check if there's a valid admin token (from password auth)
    if let Some(token_value) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if token_value.starts_with("Bearer admin_") {
            // Token format: admin_<uuid>_<email>_<timestamp>
            return Ok(None); // Admin token is valid, proceed
        }
    }

    let access = ensure_gateway_access(state, headers).await?;
    match access {
        GatewayAccess::ServiceToken => Ok(None),
        other => {
            let user = resolve_app_user(state, other)
                .await?
                .ok_or(StatusCode::UNAUTHORIZED)?;
            if is_owner_email(state, &user.email) {
                Ok(Some(user))
            } else {
                Err(StatusCode::FORBIDDEN)
            }
        }
    }
}

async fn mint_desktop_access_token(
    state: &AppState,
    user: &AppUser,
) -> Result<DesktopAuthExchangeResponse, StatusCode> {
    let token = format!("zw_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let expires_at = Utc::now() + Duration::days(30);

    sqlx::query(
        r#"
        INSERT INTO desktop_access_tokens (token, user_id, expires_at)
        VALUES ($1, $2, $3)
        "#,
    )
    .bind(&token)
    .bind(&user.user_id)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(DesktopAuthExchangeResponse {
        token,
        user: user.clone(),
    })
}

fn better_auth_cookie_from_headers(headers: &reqwest::header::HeaderMap) -> String {
    headers
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("; ")
}

async fn better_auth_sign_in_email(
    state: &AppState,
    email: &str,
    password: &str,
) -> Result<BetterAuthUser, (StatusCode, String)> {
    let response = state
        .http_client
        .post(auth_endpoint_url(
            &state.auth_internal_base,
            "sign-in/email",
        ))
        .json(&serde_json::json!({
            "email": email,
            "password": password,
            "rememberMe": true
        }))
        .send()
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "auth_service_unreachable".to_string(),
            )
        })?;

    if !response.status().is_success() {
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let body = response.text().await.unwrap_or_default();
        return Err((status, body));
    }

    let cookie = better_auth_cookie_from_headers(response.headers());
    if cookie.is_empty() {
        return Err((StatusCode::BAD_GATEWAY, "missing_auth_cookie".to_string()));
    }

    let session_response = state
        .http_client
        .get(state.auth_session_url.clone())
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "auth_session_lookup_failed".to_string(),
            )
        })?;

    if !session_response.status().is_success() {
        let status = StatusCode::from_u16(session_response.status().as_u16())
            .unwrap_or(StatusCode::BAD_GATEWAY);
        let body = session_response.text().await.unwrap_or_default();
        return Err((status, body));
    }

    let body = session_response.text().await.unwrap_or_default();
    let session = serde_json::from_str::<BetterAuthSession>(&body).map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "invalid_auth_session_payload".to_string(),
        )
    })?;
    Ok(session.user)
}

async fn better_auth_sign_up_email(
    state: &AppState,
    name: &str,
    email: &str,
    password: &str,
    callback_url: Option<&str>,
) -> Result<(), (StatusCode, String)> {
    let mut payload = serde_json::json!({
        "name": name,
        "email": email,
        "password": password,
    });
    if let Some(callback_url) = callback_url.filter(|value| !value.trim().is_empty()) {
        payload["callbackURL"] = Value::String(callback_url.to_string());
    }

    let response = state
        .http_client
        .post(auth_endpoint_url(
            &state.auth_internal_base,
            "sign-up/email",
        ))
        .json(&payload)
        .send()
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "auth_service_unreachable".to_string(),
            )
        })?;

    if response.status().is_success() {
        Ok(())
    } else {
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let body = response.text().await.unwrap_or_default();
        Err((status, body))
    }
}

/// Resolve the 5-hour root-request limit for a user, applying dynamic
/// free-tier pooling when the user is on the free plan.
///
/// Free users share a fixed pool (`free_tier_pool_5h`). Each active free
/// user gets an equal slice: pool / active_free_users (floor 5).
///
/// Pro and Max users have fixed limits unaffected by the pool.
async fn resolve_user_5h_limit(state: &AppState, tier: &str) -> i64 {
    match tier {
        "pro" => state.gateway.pro_root_requests_per_5h,
        "max" => state.gateway.max_root_requests_per_5h,
        _ => {
            if state.gateway.free_tier_pool_5h <= 0 {
                state.gateway.root_requests_per_5h
            } else {
                let active_free: i64 = sqlx::query_scalar(
                    r#"
                    SELECT COUNT(DISTINCT user_id)
                    FROM (
                        SELECT gr.user_id
                        FROM gateway_requests gr
                        JOIN app_users au ON au.user_id = gr.user_id
                        WHERE au.tier = 'free'
                          AND gr.request_kind = 'root'
                          AND gr.created_at >= NOW() - INTERVAL '5 hours'
                        GROUP BY gr.user_id
                    ) sub
                    "#,
                )
                .fetch_one(&state.db)
                .await
                .unwrap_or(1)
                .max(1);
                (state.gateway.free_tier_pool_5h / active_free).max(5)
            }
        }
    }
}

/// Enforce rate limits with dynamic free-tier pooling.
async fn enforce_root_rate_limit(state: &AppState, user_id: &str, tier: &str) -> Result<(), StatusCode> {
    let limit_5h = resolve_user_5h_limit(state, tier).await;

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

    if used_last_5h >= limit_5h {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    let weekly_limit = limit_5h * state.gateway.weekly_limit_multiplier.max(1);
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

    let concurrent_limit = match tier {
        "pro" => state.gateway.pro_max_concurrent_roots,
        "max" => state.gateway.max_max_concurrent_roots,
        _ => state.gateway.max_concurrent_roots,
    };
    if active_roots >= concurrent_limit {
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
        .and_then(|usage| usage.get("input_tokens"))
        .or_else(|| usage.and_then(|u| u.get("prompt_tokens")))
        .and_then(|value| value.as_i64());
    let completion = usage
        .and_then(|usage| usage.get("output_tokens"))
        .or_else(|| usage.and_then(|u| u.get("completion_tokens")))
        .and_then(|value| value.as_i64());
    let total = usage
        .and_then(|usage| usage.get("total_tokens"))
        .and_then(|value| value.as_i64())
        .or_else(|| match (prompt, completion) {
            (Some(p), Some(c)) => Some(p + c),
            _ => None,
        });
    (prompt, completion, total)
}

/// Extracts token usage from an SSE `data:` line (Anthropic message_delta / message_start).
fn extract_sse_usage(line: &str) -> Option<(Option<i64>, Option<i64>, Option<i64>)> {
    let data = line.strip_prefix("data: ")?;
    let json: Value = serde_json::from_str(data).ok()?;
    let event_type = json.get("type")?.as_str()?;
    match event_type {
        "message_delta" => {
            let usage = json.get("usage")?;
            let output = usage.get("output_tokens").and_then(|v| v.as_i64());
            Some((None, output, None))
        }
        "message_start" => {
            let usage = json.pointer("/message/usage")?;
            let input = usage.get("input_tokens").and_then(|v| v.as_i64());
            let output = usage.get("output_tokens").and_then(|v| v.as_i64());
            Some((input, output, None))
        }
        _ => None,
    }
}

/// Wraps an SSE byte stream to extract token usage from Anthropic events.
/// Returns the stream for passthrough and a oneshot receiver with the captured usage.
fn sse_stream_with_usage(
    stream: impl futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
) -> (
    axum::body::Body,
    tokio::sync::oneshot::Receiver<(Option<i64>, Option<i64>, Option<i64>)>,
) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let (body_tx, body_rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(32);

    tokio::spawn(async move {
        use futures::StreamExt;
        let mut final_input: Option<i64> = None;
        let mut final_output: Option<i64> = None;
        let mut stream = Box::pin(stream);
        while let Some(chunk) = stream.next().await {
            if let Ok(ref bytes) = chunk {
                let text = String::from_utf8_lossy(bytes);
                for line in text.lines() {
                    if let Some((i, o, _)) = extract_sse_usage(line) {
                        if i.is_some() { final_input = i; }
                        if o.is_some() { final_output = o; }
                    }
                }
            }
            let bytes = chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
            if body_tx.send(bytes).await.is_err() {
                break;
            }
        }
        let _ = tx.send((final_input, final_output, None));
    });

    let body_stream = tokio_stream::wrappers::ReceiverStream::new(body_rx);
    (axum::body::Body::from_stream(body_stream), rx)
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

    if let Some(reasoning_content) = message.get("reasoning_content").cloned() {
        delta.insert("reasoning_content".to_string(), reasoning_content);
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
    .bind(parse_i64_header(
        headers,
        "x-ratelimit-remaining-requests-day",
    ))
    .bind(parse_i64_header(headers, "x-ratelimit-reset-requests-day"))
    .bind(parse_i64_header(headers, "x-ratelimit-limit-tokens-minute"))
    .bind(parse_i64_header(
        headers,
        "x-ratelimit-remaining-tokens-minute",
    ))
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
    headers: HeaderMap,
    Json(payload): Json<TelemetryPayload>,
) -> impl IntoResponse {
    if ensure_gateway_access(&state, &headers).await.is_err() {
        return (StatusCode::UNAUTHORIZED, "Telemetry auth required").into_response();
    }

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
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to track telemetry",
            )
                .into_response()
        }
    }
}

async fn ai_proxy(
    State(state): State<AppState>,
    req: Request<axum::body::Body>,
) -> Result<Response<axum::body::Body>, (StatusCode, String)> {
    if !state.features.hosted_gateway {
        return Err((StatusCode::NOT_FOUND, "hosted_gateway_disabled".to_string()));
    }

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
        enforce_root_rate_limit(&state, &user.user_id, &user.tier)
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
                .map_err(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "gateway_request_log_failed".to_string(),
                    )
                })?,
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
        .map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                "request_body_too_large".to_string(),
            )
        })?;
    let body_json: Value = serde_json::from_slice(&body_bytes)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid_chat_payload".to_string()))?;

    let mut failures: Vec<String> = Vec::new();

    for provider in &state.gateway.providers {
        if provider.protocol != GatewayProtocol::OpenAi {
            continue;
        }
        let models = if provider.fallback_model.trim().is_empty()
            || provider.fallback_model.trim() == provider.primary_model.trim()
        {
            vec![provider.primary_model.clone()]
        } else {
            vec![
                provider.primary_model.clone(),
                provider.fallback_model.clone(),
            ]
        };

        for model_name in models {
            let mut attempt_body = body_json.clone();
            if let Some(obj) = attempt_body.as_object_mut() {
                obj.insert("model".to_string(), Value::String(model_name.clone()));
            }

            let endpoint = format!(
                "{}/chat/completions",
                provider.base_url.trim_end_matches('/')
            );
            let builder = state
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
                failures.push(format!(
                    "{}:{} {} {}",
                    provider.name,
                    model_name,
                    status.as_u16(),
                    detail
                ));
                continue;
            }

            let body_bytes = match resp.bytes().await {
                Ok(bytes) => bytes,
                Err(_) => {
                    failures.push(format!(
                        "{}:{} response_read_failed",
                        provider.name, model_name
                    ));
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
                HeaderValue::from_str(&provider.name)
                    .unwrap_or_else(|_| HeaderValue::from_static("zwork-router")),
            );
            response.headers_mut().insert(
                HeaderName::from_static("x-zwork-router-model"),
                HeaderValue::from_str(&model_name)
                    .unwrap_or_else(|_| HeaderValue::from_static("unknown")),
            );
            response.headers_mut().insert(
                HeaderName::from_static("x-zwork-router-label"),
                HeaderValue::from_str(&state.gateway.router_label)
                    .unwrap_or_else(|_| HeaderValue::from_static("zWork Router")),
            );
            return Ok(response);
        }
    }

    if let Some(request_id) = request_id {
        finish_gateway_request(
            &state,
            request_id,
            Some(StatusCode::BAD_GATEWAY.as_u16() as i32),
        )
        .await;
    }

    Err((
        StatusCode::BAD_GATEWAY,
        format!("router_upstreams_failed: {}", failures.join(" | ")),
    ))
}

async fn ai_proxy_anthropic(
    State(state): State<AppState>,
    req: Request<axum::body::Body>,
) -> Result<Response<axum::body::Body>, (StatusCode, String)> {
    if !state.features.hosted_gateway {
        return Err((StatusCode::NOT_FOUND, "hosted_gateway_disabled".to_string()));
    }

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
        enforce_root_rate_limit(&state, &user.user_id, &user.tier)
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
                .map_err(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "gateway_request_log_failed".to_string(),
                    )
                })?,
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
        .map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                "request_body_too_large".to_string(),
            )
        })?;
    let mut body_json: Value = serde_json::from_slice(&body_bytes).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "invalid_messages_payload".to_string(),
        )
    })?;

    // Validate requested model
    let requested_model = body_json
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    if !ALLOWED_MODELS.contains(&requested_model.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("unsupported_model: {requested_model}"),
        ));
    }

    // Enforce tier restrictions
    let user_tier = app_user
        .as_ref()
        .map(|u| u.tier.as_str())
        .unwrap_or("free");
    if PRO_ONLY_MODELS.contains(&requested_model.as_str())
        && !matches!(user_tier, "pro" | "max")
    {
        return Err((
            StatusCode::FORBIDDEN,
            "model_requires_pro_tier".to_string(),
        ));
    }

    // Ensure thinking blocks are present in assistant messages for DeepSeek
    ensure_thinking_blocks(&mut body_json);

    let mut failures: Vec<String> = Vec::new();

    for provider in &state.gateway.providers {
        if provider.protocol != GatewayProtocol::Anthropic {
            continue;
        }

        if let Some(obj) = body_json.as_object_mut() {
            // Use the requested model, not the provider default
            obj.insert("model".to_string(), Value::String(requested_model.clone()));
            obj.insert("stream".to_string(), Value::Bool(true));
        }

        let endpoint = format!("{}/v1/messages", provider.base_url.trim_end_matches('/'));
        let resp = match state
            .http_client
            .post(endpoint)
            .header("Content-Type", "application/json")
            .header("x-api-key", provider.api_key.clone())
            .header("anthropic-version", "2023-06-01")
            .json(&body_json)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(_) => {
                failures.push(format!(
                    "{}:{} unreachable",
                    provider.name, provider.primary_model
                ));
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
            // Log tool names to help debug duplicate-tool-name errors
            if let Some(tools) = body_json.get("tools").and_then(|t| t.as_array()) {
                let names: Vec<&str> = tools
                    .iter()
                    .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
                    .collect();
                tracing::warn!(
                    "Anthropic upstream {} returned {} {}. {} tools: {:?}",
                    provider.name,
                    status.as_u16(),
                    &detail,
                    names.len(),
                    names,
                );
            } else {
                tracing::warn!(
                    "Anthropic upstream {} returned {} {}",
                    provider.name,
                    status.as_u16(),
                    &detail,
                );
            }
            failures.push(format!(
                "{}:{} {} {}",
                provider.name,
                provider.primary_model,
                status.as_u16(),
                detail
            ));
            continue;
        }

        // Stream the response, intercepting SSE events to extract token usage
        let upstream_body = resp.bytes_stream();
        let (body, usage_rx) = sse_stream_with_usage(upstream_body);

        if let Some(request_id) = request_id {
            let upstream_status = status.as_u16() as i32;
            mark_gateway_request_upstream(
                &state,
                request_id,
                &provider.name,
                &provider.primary_model,
                None,
                None,
                None,
            )
            .await;
            finish_gateway_request(&state, request_id, Some(upstream_status)).await;

            // Update tokens once the stream finishes
            let state_clone = state.clone();
            tokio::spawn(async move {
                if let Ok((prompt_tokens, completion_tokens, _)) = usage_rx.await {
                    if prompt_tokens.is_some() || completion_tokens.is_some() {
                        sqlx::query(
                            "UPDATE gateway_requests SET prompt_tokens = COALESCE($2, prompt_tokens), completion_tokens = COALESCE($3, completion_tokens) WHERE id = $1"
                        )
                        .bind(request_id)
                        .bind(prompt_tokens)
                        .bind(completion_tokens)
                        .execute(&state_clone.db)
                        .await
                        .ok();
                    }
                }
            });
        }
        upsert_provider_snapshot(
            &state,
            &provider.name,
            &provider.primary_model,
            status.as_u16() as i32,
            &upstream_headers,
        )
        .await;
        let mut response = Response::new(body);
        *response.status_mut() = status;
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream; charset=utf-8"),
        );
        response.headers_mut().insert(
            HeaderName::from_static("x-zwork-router-provider"),
            HeaderValue::from_str(&provider.name)
                .unwrap_or_else(|_| HeaderValue::from_static("zwork-router")),
        );
        response.headers_mut().insert(
            HeaderName::from_static("x-zwork-router-model"),
            HeaderValue::from_str(&provider.primary_model)
                .unwrap_or_else(|_| HeaderValue::from_static("unknown")),
        );
        response.headers_mut().insert(
            HeaderName::from_static("x-zwork-router-label"),
            HeaderValue::from_str(&state.gateway.router_label)
                .unwrap_or_else(|_| HeaderValue::from_static("zWork Router")),
        );
        return Ok(response);
    }

    if let Some(request_id) = request_id {
        finish_gateway_request(
            &state,
            request_id,
            Some(StatusCode::BAD_GATEWAY.as_u16() as i32),
        )
        .await;
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

fn stripe_billing_ready(state: &AppState) -> bool {
    state.features.billing
        && !state.stripe_secret_key.trim().is_empty()
        && !std::env::var("STRIPE_PRICE_PRO_MONTHLY")
            .unwrap_or_default()
            .trim()
            .is_empty()
}

fn stripe_price_id(annual: bool, tier: &str) -> Option<String> {
    let tier_lower = tier.to_lowercase();
    if annual {
        let env_key = if tier_lower == "max" {
            "STRIPE_PRICE_MAX_ANNUAL"
        } else {
            "STRIPE_PRICE_PRO_ANNUAL"
        };
        let annual_price = std::env::var(env_key).unwrap_or_default();
        if !annual_price.trim().is_empty() {
            return Some(annual_price);
        }
        // Fall back to pro if max not configured
        if tier_lower == "max" {
            let pro_annual = std::env::var("STRIPE_PRICE_PRO_ANNUAL").unwrap_or_default();
            if !pro_annual.trim().is_empty() {
                return None; // Don't silently fall back — Max must have its own price
            }
        }
    }

    let env_key = if tier_lower == "max" {
        "STRIPE_PRICE_MAX_MONTHLY"
    } else {
        "STRIPE_PRICE_PRO_MONTHLY"
    };
    let monthly_price = std::env::var(env_key).unwrap_or_default();
    if monthly_price.trim().is_empty() {
        None
    } else {
        Some(monthly_price)
    }
}

async fn ensure_stripe_customer(
    state: &AppState,
    user: &AppUser,
) -> Result<String, (StatusCode, String)> {
    if let Some(customer_id) = user
        .stripe_customer_id
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Ok(customer_id);
    }

    let params = vec![
        ("email".to_string(), user.email.clone()),
        ("name".to_string(), user.name.clone()),
        ("metadata[user_id]".to_string(), user.user_id.clone()),
    ];
    let response = state
        .http_client
        .post("https://api.stripe.com/v1/customers")
        .bearer_auth(&state.stripe_secret_key)
        .form(&params)
        .send()
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "stripe_customer_create_failed".to_string(),
            )
        })?;

    if !response.status().is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err((StatusCode::BAD_GATEWAY, detail));
    }

    let payload: Value = response.json().await.map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "stripe_customer_payload_invalid".to_string(),
        )
    })?;
    let customer_id = payload
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if customer_id.is_empty() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "stripe_customer_id_missing".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE app_users
        SET stripe_customer_id = $2,
            updated_at = NOW()
        WHERE user_id = $1
        "#,
    )
    .bind(&user.user_id)
    .bind(&customer_id)
    .execute(&state.db)
    .await
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "stripe_customer_persist_failed".to_string(),
        )
    })?;

    Ok(customer_id)
}

fn stripe_signature_valid(secret: &str, payload: &[u8], header_value: &str) -> bool {
    type HmacSha256 = Hmac<Sha256>;

    let mut timestamp = None;
    let mut signatures = Vec::new();
    for part in header_value.split(',') {
        let mut pieces = part.trim().splitn(2, '=');
        let key = pieces.next().unwrap_or("").trim();
        let value = pieces.next().unwrap_or("").trim();
        if key == "t" {
            timestamp = Some(value.to_string());
        } else if key == "v1" {
            signatures.push(value.to_string());
        }
    }

    let timestamp = match timestamp {
        Some(value) if !value.is_empty() => value,
        _ => return false,
    };

    let mut signed = timestamp.into_bytes();
    signed.push(b'.');
    signed.extend_from_slice(payload);

    for candidate in signatures {
        let expected = match hex::decode(candidate) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
            Ok(mac) => mac,
            Err(_) => return false,
        };
        mac.update(&signed);
        if mac.verify_slice(&expected).is_ok() {
            return true;
        }
    }

    false
}

fn subscription_tier(status: &str, price_id: Option<&String>) -> String {
    match status {
        "active" | "trialing" | "past_due" => {
            let max_monthly = std::env::var("STRIPE_PRICE_MAX_MONTHLY").unwrap_or_default();
            let max_annual = std::env::var("STRIPE_PRICE_MAX_ANNUAL").unwrap_or_default();
            if let Some(pid) = price_id {
                if !max_monthly.is_empty() && pid == &max_monthly {
                    return "max".to_string();
                }
                if !max_annual.is_empty() && pid == &max_annual {
                    return "max".to_string();
                }
            }
            "pro".to_string()
        }
        _ => "free".to_string(),
    }
}

fn stripe_timestamp_to_datetime(value: Option<i64>) -> Option<DateTime<Utc>> {
    value.and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds, 0))
}

async fn billing_checkout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BillingCheckoutRequest>,
) -> Result<Json<BillingSessionResponse>, (StatusCode, String)> {
    if !state.features.billing {
        return Err((StatusCode::NOT_FOUND, "billing_disabled".to_string()));
    }

    if !stripe_billing_ready(&state) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "stripe_billing_not_configured".to_string(),
        ));
    }

    if body.success_url.trim().is_empty() || body.cancel_url.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "success_and_cancel_urls_required".to_string(),
        ));
    }

    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|status| (status, "access_denied".to_string()))?;
    let user = resolve_app_user(&state, access)
        .await
        .map_err(|status| (status, "user_lookup_failed".to_string()))?
        .ok_or((StatusCode::UNAUTHORIZED, "not_signed_in".to_string()))?;
    let customer_id = ensure_stripe_customer(&state, &user).await?;
    let tier = body.tier.as_deref().unwrap_or("pro");
    let price_id = stripe_price_id(body.annual.unwrap_or(false), tier).ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "stripe_price_not_configured".to_string(),
    ))?;

    let params = vec![
        ("mode".to_string(), "subscription".to_string()),
        ("customer".to_string(), customer_id),
        ("client_reference_id".to_string(), user.user_id.clone()),
        (
            "success_url".to_string(),
            body.success_url.trim().to_string(),
        ),
        ("cancel_url".to_string(), body.cancel_url.trim().to_string()),
        ("line_items[0][price]".to_string(), price_id),
        ("line_items[0][quantity]".to_string(), "1".to_string()),
        ("metadata[user_id]".to_string(), user.user_id.clone()),
        (
            "subscription_data[metadata][user_id]".to_string(),
            user.user_id.clone(),
        ),
        ("allow_promotion_codes".to_string(), "true".to_string()),
    ];

    let response = state
        .http_client
        .post("https://api.stripe.com/v1/checkout/sessions")
        .bearer_auth(&state.stripe_secret_key)
        .form(&params)
        .send()
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "stripe_checkout_create_failed".to_string(),
            )
        })?;

    if !response.status().is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err((StatusCode::BAD_GATEWAY, detail));
    }

    let payload: Value = response.json().await.map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "stripe_checkout_payload_invalid".to_string(),
        )
    })?;
    let url = payload
        .get("url")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if url.is_empty() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "stripe_checkout_url_missing".to_string(),
        ));
    }

    Ok(Json(BillingSessionResponse { url }))
}

async fn billing_portal(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BillingPortalRequest>,
) -> Result<Json<BillingSessionResponse>, (StatusCode, String)> {
    if !state.features.billing {
        return Err((StatusCode::NOT_FOUND, "billing_disabled".to_string()));
    }

    if !stripe_billing_ready(&state) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "stripe_billing_not_configured".to_string(),
        ));
    }

    if body.return_url.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "return_url_required".to_string()));
    }

    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|status| (status, "access_denied".to_string()))?;
    let user = resolve_app_user(&state, access)
        .await
        .map_err(|status| (status, "user_lookup_failed".to_string()))?
        .ok_or((StatusCode::UNAUTHORIZED, "not_signed_in".to_string()))?;
    let customer_id = ensure_stripe_customer(&state, &user).await?;

    let params = vec![
        ("customer".to_string(), customer_id),
        ("return_url".to_string(), body.return_url.trim().to_string()),
    ];
    let response = state
        .http_client
        .post("https://api.stripe.com/v1/billing_portal/sessions")
        .bearer_auth(&state.stripe_secret_key)
        .form(&params)
        .send()
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "stripe_portal_create_failed".to_string(),
            )
        })?;

    if !response.status().is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err((StatusCode::BAD_GATEWAY, detail));
    }

    let payload: Value = response.json().await.map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "stripe_portal_payload_invalid".to_string(),
        )
    })?;
    let url = payload
        .get("url")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if url.is_empty() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "stripe_portal_url_missing".to_string(),
        ));
    }

    Ok(Json(BillingSessionResponse { url }))
}

async fn stripe_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if !state.features.billing {
        return (StatusCode::NOT_FOUND, "Billing disabled").into_response();
    }

    if state.stripe_webhook_secret.trim().is_empty() {
        return (StatusCode::ACCEPTED, "Stripe disabled").into_response();
    }

    let signature = match headers
        .get("stripe-signature")
        .and_then(|value| value.to_str().ok())
    {
        Some(value) if stripe_signature_valid(&state.stripe_webhook_secret, &body, value) => value,
        _ => return (StatusCode::BAD_REQUEST, "Invalid Stripe signature").into_response(),
    };
    let _ = signature;

    let event: Value = match serde_json::from_slice(&body) {
        Ok(event) => event,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid Stripe payload").into_response(),
    };

    let event_type = event
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let object = event
        .get("data")
        .and_then(|value| value.get("object"))
        .cloned()
        .unwrap_or(Value::Null);

    match event_type {
        "checkout.session.completed" => {
            let customer_id = object
                .get("customer")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let subscription_id = object
                .get("subscription")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let user_id = object
                .get("client_reference_id")
                .and_then(|value| value.as_str())
                .or_else(|| {
                    object
                        .get("metadata")
                        .and_then(|value| value.get("user_id"))
                        .and_then(|value| value.as_str())
                })
                .unwrap_or("");

            if !user_id.is_empty() {
                let _ = sqlx::query(
                    r#"
                    UPDATE app_users
                    SET stripe_customer_id = NULLIF($2, ''),
                        subscription_id = NULLIF($3, ''),
                        updated_at = NOW()
                    WHERE user_id = $1
                    "#,
                )
                .bind(user_id)
                .bind(customer_id)
                .bind(subscription_id)
                .execute(&state.db)
                .await;
            }
        }
        "customer.subscription.created"
        | "customer.subscription.updated"
        | "customer.subscription.deleted" => {
            let customer_id = object
                .get("customer")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let subscription_id = object
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let status = object
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let user_id = object
                .get("metadata")
                .and_then(|value| value.get("user_id"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .or_else(|| {
                    if customer_id.is_empty() {
                        None
                    } else {
                        Some(String::new())
                    }
                });
            let price_id = object
                .get("items")
                .and_then(|value| value.get("data"))
                .and_then(|value| value.as_array())
                .and_then(|items| items.first())
                .and_then(|item| item.get("price"))
                .and_then(|price| price.get("id"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            let current_period_end = stripe_timestamp_to_datetime(
                object
                    .get("current_period_end")
                    .and_then(|value| value.as_i64()),
            );

            if let Some(user_id) = user_id {
                let result = if user_id.is_empty() {
                    sqlx::query(
                        r#"
                        UPDATE app_users
                        SET subscription_id = CASE WHEN $2 = 'customer.subscription.deleted' THEN NULL ELSE NULLIF($3, '') END,
                            subscription_status = NULLIF($4, ''),
                            subscription_price_id = $5,
                            subscription_current_period_end = $6,
                            tier = $7,
                            updated_at = NOW()
                        WHERE stripe_customer_id = $1
                        "#,
                    )
                    .bind(customer_id)
                    .bind(event_type)
                    .bind(subscription_id)
                    .bind(status)
                    .bind(&price_id)
                    .bind(current_period_end)
                    .bind(subscription_tier(status, price_id.as_ref()))
                    .execute(&state.db)
                    .await
                } else {
                    sqlx::query(
                        r#"
                        UPDATE app_users
                        SET stripe_customer_id = NULLIF($2, ''),
                            subscription_id = CASE WHEN $3 = 'customer.subscription.deleted' THEN NULL ELSE NULLIF($4, '') END,
                            subscription_status = NULLIF($5, ''),
                            subscription_price_id = $6,
                            subscription_current_period_end = $7,
                            tier = $8,
                            updated_at = NOW()
                        WHERE user_id = $1
                        "#,
                    )
                    .bind(user_id)
                    .bind(customer_id)
                    .bind(event_type)
                    .bind(subscription_id)
                    .bind(status)
                    .bind(&price_id)
                    .bind(current_period_end)
                    .bind(subscription_tier(status, price_id.as_ref()))
                    .execute(&state.db)
                    .await
                };
                let _ = result;
            }
        }
        _ => {}
    }

    (StatusCode::OK, "Webhook received").into_response()
}

async fn get_user_by_google_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(google_id): Path<String>,
) -> Result<Json<User>, StatusCode> {
    let _ = ensure_owner_or_service(&state, &headers).await?;
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
    let _ = ensure_owner_or_service(&state, &headers).await?;
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
    let _ = ensure_owner_or_service(&state, &headers).await?;
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
    if !state.features.coupons {
        return Err((StatusCode::NOT_FOUND, "coupons_disabled".to_string()));
    }

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
        RETURNING user_id, email, name, tier, coupon_code,
                  stripe_customer_id, subscription_id, subscription_status,
                  subscription_price_id, subscription_current_period_end,
                  created_at, updated_at
        "#,
    )
    .bind(&user.user_id)
    .bind(code)
    .fetch_one(&state.db)
    .await
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "access_code_update_failed".to_string(),
        )
    })?;

    Ok(Json(user))
}

// Admin Dashboard Handlers
async fn admin_metrics_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminMetricsOverview>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;

    let total_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_users")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    let active_users_30d: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT user_id) FROM gateway_requests WHERE created_at > NOW() - INTERVAL '30 days'"
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let active_users_7d: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT user_id) FROM gateway_requests WHERE created_at > NOW() - INTERVAL '7 days'"
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let new_users_this_week: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM app_users WHERE created_at > NOW() - INTERVAL '7 days'",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let new_users_this_month: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM app_users WHERE created_at > NOW() - INTERVAL '30 days'",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let paid_users: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM app_users WHERE tier IN ('pro', 'max')")
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let churn_rate = if active_users_30d > 0 {
        ((active_users_30d - active_users_7d) as f64) / (active_users_30d as f64)
    } else {
        0.0
    };

    let free_to_paid_conversion = if total_users > 0 {
        (paid_users as f64) / (total_users as f64)
    } else {
        0.0
    };

    let pro_monthly = std::env::var("STRIPE_PRICE_PRO_MONTHLY").unwrap_or_default();
    let pro_annual = std::env::var("STRIPE_PRICE_PRO_ANNUAL").unwrap_or_default();
    let max_monthly = std::env::var("STRIPE_PRICE_MAX_MONTHLY").unwrap_or_default();
    let max_annual = std::env::var("STRIPE_PRICE_MAX_ANNUAL").unwrap_or_default();

    let pro_price_monthly = std::env::var("PRO_PRICE_MONTHLY_USD")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(20.0);
    let pro_price_annual_monthly = std::env::var("PRO_PRICE_ANNUAL_MONTHLY_USD")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(16.0);
    let max_price_monthly = std::env::var("MAX_PRICE_MONTHLY_USD")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(50.0);
    let max_price_annual_monthly = std::env::var("MAX_PRICE_ANNUAL_MONTHLY_USD")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(40.0);

    let subscription_rows = sqlx::query(
        "SELECT tier, subscription_price_id FROM app_users WHERE subscription_status = 'active'"
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let mut mrr = 0.0_f64;
    for row in &subscription_rows {
        let tier: String = row.get("tier");
        let price_id: Option<String> = row.get("subscription_price_id");
        let pid = price_id.as_deref().unwrap_or("");
        match tier.as_str() {
            "pro" => {
                if pid == pro_annual {
                    mrr += pro_price_annual_monthly;
                } else {
                    mrr += pro_price_monthly;
                }
            }
            "max" => {
                if pid == max_annual {
                    mrr += max_price_annual_monthly;
                } else {
                    mrr += max_price_monthly;
                }
            }
            _ => {}
        }
    }

    let arpu = if total_users > 0 {
        mrr / (total_users as f64)
    } else {
        0.0
    };

    Ok(Json(AdminMetricsOverview {
        total_users,
        active_users_30d,
        active_users_7d,
        new_users_this_week,
        new_users_this_month,
        churn_rate,
        paid_users,
        mrr,
        arpu,
        free_to_paid_conversion,
    }))
}

async fn admin_list_users(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminUserRow>>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;

    let users: Vec<AdminUserRow> = sqlx::query(
        r#"
        SELECT 
            u.user_id,
            u.email,
            u.name,
            u.tier,
            u.created_at,
            MAX(g.created_at) as last_activity,
            COUNT(g.id) as total_requests,
            COALESCE(SUM(g.total_tokens), 0)::bigint as total_tokens,
            u.stripe_customer_id,
            u.subscription_status
        FROM app_users u
        LEFT JOIN gateway_requests g ON u.user_id = g.user_id
        GROUP BY u.user_id, u.email, u.name, u.tier, u.created_at, u.stripe_customer_id, u.subscription_status
        ORDER BY u.created_at DESC
        "#
    )
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_iter()
    .map(|row| AdminUserRow {
        user_id: row.get("user_id"),
        email: row.get("email"),
        name: row.get("name"),
        tier: row.get("tier"),
        created_at: row.get("created_at"),
        last_activity: row.get("last_activity"),
        total_requests: row.get("total_requests"),
        total_tokens: row.get("total_tokens"),
        stripe_customer_id: row.get("stripe_customer_id"),
        subscription_status: row.get("subscription_status"),
    })
    .collect();

    Ok(Json(users))
}

async fn admin_usage_by_time(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminUsageByTime>>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;

    let usage: Vec<AdminUsageByTime> = sqlx::query(
        r#"
        SELECT 
            DATE(created_at) as date,
            COUNT(*) as requests,
            COALESCE(SUM(total_tokens), 0) as tokens
        FROM gateway_requests
        WHERE created_at > NOW() - INTERVAL '90 days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_iter()
    .map(|row| AdminUsageByTime {
        date: row.get("date"),
        requests: row.get("requests"),
        tokens: row.get("tokens"),
    })
    .collect();

    Ok(Json(usage))
}

async fn admin_usage_by_model(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminUsageByModel>>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;

    let total: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(total_tokens), 0) FROM gateway_requests")
            .fetch_one(&state.db)
            .await
            .unwrap_or(1);

    let usage: Vec<AdminUsageByModel> = sqlx::query(
        r#"
        SELECT 
            model_id,
            COUNT(*) as requests,
            COALESCE(SUM(total_tokens), 0) as tokens
        FROM gateway_requests
        WHERE model_id IS NOT NULL
        GROUP BY model_id
        ORDER BY tokens DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_iter()
    .map(|row| {
        let tokens: i64 = row.get("tokens");
        AdminUsageByModel {
            model_id: row.get("model_id"),
            requests: row.get("requests"),
            tokens,
            percentage: if total > 0 {
                (tokens as f64 / total as f64) * 100.0
            } else {
                0.0
            },
        }
    })
    .collect();

    Ok(Json(usage))
}

async fn admin_update_user_tier(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
    Json(body): Json<AdminUpdatePlanRequest>,
) -> Result<Json<AppUser>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;

    let valid_tiers = ["free", "pro", "max"];
    if !valid_tiers.contains(&body.tier.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let user = sqlx::query_as::<_, AppUser>(
        r#"
        UPDATE app_users
        SET tier = $1, updated_at = NOW()
        WHERE user_id = $2
        RETURNING user_id, email, name, tier, coupon_code,
                  stripe_customer_id, subscription_id, subscription_status,
                  subscription_price_id, subscription_current_period_end,
                  created_at, updated_at
        "#,
    )
    .bind(&body.tier)
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(user))
}

#[derive(Deserialize)]
struct AdminPasswordRequest {
    password: String,
}

#[derive(Serialize)]
struct AdminPasswordResponse {
    token: String,
    email: String,
}

async fn admin_verify_password(
    State(state): State<AppState>,
    Json(body): Json<AdminPasswordRequest>,
) -> Result<Json<AdminPasswordResponse>, StatusCode> {
    let admin_password = std::env::var("ADMIN_PASSWORD")
        .unwrap_or_else(|_| "zworkisthebest".to_string());

    if body.password != admin_password {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let email = state
        .owner_emails
        .first()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
        .clone();

    let token = format!(
        "admin_{}_{}_{}",
        uuid::Uuid::new_v4(),
        email,
        Utc::now().timestamp()
    );

    Ok(Json(AdminPasswordResponse { token, email }))
}

// ── Composio proxy handlers ──

async fn composio_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let configured = !state.composio_api_key.is_empty();

    // Try to resolve the user so we can return connected-app info.
    // If auth fails we still return basic availability so the desktop
    // sidecar knows the server is configured.
    let mut connected_apps: Vec<String> = Vec::new();
    let mut tool_count: u64 = 0;
    let mut user_id = String::new();

    if let Ok(access) = ensure_gateway_access(&state, &headers).await {
        if let Ok(Some(user)) = resolve_app_user(&state, access).await {
            user_id = user.user_id.clone();
            // Query connected accounts for this user
            if configured && !user_id.is_empty() {
                let url = format!(
                    "{}/connected_accounts?user_ids={}",
                    COMPOSIO_BASE_URL,
                    urlencoding::encode(&user_id)
                );
                if let Ok(resp) = state
                    .http_client
                    .get(&url)
                    .headers(composio_request_headers(&state.composio_api_key))
                    .send()
                    .await
                {
                    if resp.status().is_success() {
                        if let Ok(body) = resp.json::<Value>().await {
                            let items = body
                                .get("items")
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default();
                            for acc in &items {
                                let status = acc
                                    .get("status")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("");
                                if status == "ACTIVE" {
                                    let app_id = acc
                                        .get("toolkit")
                                        .and_then(|t| t.get("slug"))
                                        .and_then(|s| s.as_str())
                                        .unwrap_or("")
                                        .to_lowercase();
                                    if !app_id.is_empty() && !connected_apps.contains(&app_id) {
                                        connected_apps.push(app_id);
                                    }
                                }
                            }
                            tool_count = items.len() as u64;
                        }
                    }
                }
            }
        }
    }

    Ok(Json(serde_json::json!({
        "enabled": configured,
        "configured": configured,
        "available": configured,
        "connected_apps": connected_apps,
        "tool_count": tool_count,
        "user_id": user_id
    })))
}

async fn composio_accounts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|s| (s, "access_denied".into()))?;
    let user = resolve_app_user(&state, access)
        .await
        .map_err(|s| (s, "user_lookup_failed".into()))?
        .ok_or((StatusCode::UNAUTHORIZED, "not_signed_in".into()))?;

    if state.composio_api_key.is_empty() {
        return Ok(Json(serde_json::json!({"accounts": []})));
    }

    let url = format!(
        "{}/connected_accounts?user_ids={}",
        COMPOSIO_BASE_URL,
        urlencoding::encode(&user.user_id)
    );
    let resp = state
        .http_client
        .get(&url)
        .headers(composio_request_headers(&state.composio_api_key))
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_unreachable".into()))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!("Composio accounts failed: {} {}", status, body);
        return Err((StatusCode::BAD_GATEWAY, "composio_accounts_failed".into()));
    }

    let composio_body: Value = resp
        .json()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_invalid_response".into()))?;

    let items = composio_body
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let app_display_map = composio_app_display_map();
    let accounts: Vec<Value> = items
        .iter()
        .map(|acc| {
            let app_id = acc
                .get("toolkit")
                .and_then(|t| t.get("slug"))
                .and_then(|s| s.as_str())
                .or_else(|| acc.get("appUniqueId").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_lowercase();
            let status = acc
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            let account_id = acc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let display = app_display_map.get(&app_id);
            serde_json::json!({
                "app": app_id,
                "status": status,
                "account_id": account_id,
                "app_name": display.map(|d| d.0.clone()).unwrap_or_else(|| app_id.clone()),
                "icon": display.map(|d| d.1.clone()).unwrap_or("plug".into()),
                "color": display.map(|d| d.2.clone()).unwrap_or("#6B7280".into()),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({"accounts": accounts})))
}

async fn composio_connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ComposioConnectRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|s| (s, "access_denied".into()))?;
    let user = resolve_app_user(&state, access)
        .await
        .map_err(|s| (s, "user_lookup_failed".into()))?
        .ok_or((StatusCode::UNAUTHORIZED, "not_signed_in".into()))?;

    if state.composio_api_key.is_empty() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "composio_not_configured".into()));
    }

    let app_slug = body.app.trim().to_lowercase();
    if app_slug.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "app_required".into()));
    }

    // Step 1: get auth_config_id
    let auth_configs_url = format!(
        "{}/auth_configs?toolkit_slug={}",
        COMPOSIO_BASE_URL,
        urlencoding::encode(&app_slug)
    );
    let auth_configs_resp = state
        .http_client
        .get(&auth_configs_url)
        .headers(composio_request_headers(&state.composio_api_key))
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_unreachable".into()))?;

    if !auth_configs_resp.status().is_success() {
        return Err((StatusCode::BAD_GATEWAY, "composio_auth_config_failed".into()));
    }

    let auth_configs_body: Value = auth_configs_resp
        .json()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_invalid_response".into()))?;

    let auth_config_id = auth_configs_body
        .get("items")
        .and_then(|items| items.as_array())
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("id"))
        .and_then(|id| id.as_str())
        .unwrap_or("")
        .to_string();

    if auth_config_id.is_empty() {
        return Err((StatusCode::NOT_FOUND, "composio_auth_config_not_found".into()));
    }

    // Step 2: get OAuth link
    let link_url = format!("{}/connected_accounts/link", COMPOSIO_BASE_URL);
    let link_body = serde_json::json!({
        "user_id": user.user_id,
        "auth_config_id": auth_config_id,
        "redirect_url": "https://api.tryzwork.app/api/composio/callback"
    });

    let link_resp = state
        .http_client
        .post(&link_url)
        .headers(composio_request_headers(&state.composio_api_key))
        .json(&link_body)
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_link_failed".into()))?;

    if !link_resp.status().is_success() {
        let status = link_resp.status().as_u16();
        let text = link_resp.text().await.unwrap_or_default();
        tracing::warn!("Composio link failed: {} {}", status, text);
        return Err((
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            "composio_link_failed".into(),
        ));
    }

    let link_data: Value = link_resp
        .json()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_invalid_link_response".into()))?;

    let redirect_url = link_data
        .get("redirect_url")
        .or_else(|| link_data.get("connection_url"))
        .or_else(|| link_data.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(Json(serde_json::json!({"url": redirect_url})))
}

async fn composio_disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ComposioDisconnectRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|s| (s, "access_denied".into()))?;
    let user = resolve_app_user(&state, access)
        .await
        .map_err(|s| (s, "user_lookup_failed".into()))?
        .ok_or((StatusCode::UNAUTHORIZED, "not_signed_in".into()))?;

    if state.composio_api_key.is_empty() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "composio_not_configured".into()));
    }

    let url = format!(
        "{}/connected_accounts?user_ids={}",
        COMPOSIO_BASE_URL,
        urlencoding::encode(&user.user_id)
    );
    let resp = state
        .http_client
        .get(&url)
        .headers(composio_request_headers(&state.composio_api_key))
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_unreachable".into()))?;

    let composio_body: Value = resp
        .json()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_invalid_response".into()))?;

    let app_slug = body.app.trim().to_lowercase();
    let items = composio_body
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut remaining_apps: Vec<String> = Vec::new();
    for acc in &items {
        let acc_app = acc
            .get("toolkit")
            .and_then(|t| t.get("slug"))
            .and_then(|s| s.as_str())
            .or_else(|| acc.get("appUniqueId").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_lowercase();
        if acc_app == app_slug {
            let account_id = acc.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let delete_url = format!("{}/connected_accounts/{}", COMPOSIO_BASE_URL, account_id);
            let _ = state
                .http_client
                .delete(&delete_url)
                .headers(composio_request_headers(&state.composio_api_key))
                .send()
                .await;
        } else if acc
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            == "ACTIVE"
        {
            remaining_apps.push(acc_app);
        }
    }

    Ok(Json(serde_json::json!({
        "ok": true,
        "connected_apps": remaining_apps
    })))
}

async fn composio_apps() -> Json<Value> {
    let display_map = composio_app_display_map();
    let app_ids = [
        "gmail", "googlecalendar", "slack", "notion", "googledrive",
        "github", "jira", "trello", "todoist", "linear", "asana", "hubspot",
    ];
    let apps: Vec<Value> = app_ids
        .iter()
        .filter_map(|id| {
            display_map.get(*id).map(|(name, icon, color)| {
                serde_json::json!({"id": id, "name": name, "icon": icon, "color": color})
            })
        })
        .collect();
    Json(serde_json::json!({"apps": apps}))
}

async fn composio_tools(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|s| (s, "access_denied".into()))?;
    let user = resolve_app_user(&state, access)
        .await
        .map_err(|s| (s, "user_lookup_failed".into()))?
        .ok_or((StatusCode::UNAUTHORIZED, "not_signed_in".into()))?;

    if state.composio_api_key.is_empty() {
        return Ok(Json(serde_json::json!({"tools": [], "connected_apps": []})));
    }

    let url = format!(
        "{}/connected_accounts?user_ids={}",
        COMPOSIO_BASE_URL,
        urlencoding::encode(&user.user_id)
    );
    let resp = state
        .http_client
        .get(&url)
        .headers(composio_request_headers(&state.composio_api_key))
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_unreachable".into()))?;

    let composio_body: Value = resp
        .json()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_invalid_response".into()))?;

    let items = composio_body
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let connected_apps: Vec<String> = items
        .iter()
        .filter_map(|acc| {
            let status = acc.get("status").and_then(|s| s.as_str()).unwrap_or("");
            if status != "ACTIVE" {
                return None;
            }
            acc.get("toolkit")
                .and_then(|t| t.get("slug"))
                .and_then(|s| s.as_str())
                .or_else(|| acc.get("appUniqueId").and_then(|v| v.as_str()))
                .map(|s| s.to_lowercase())
        })
        .collect();

    let mut all_tools: Vec<Value> = Vec::new();

    for app in &connected_apps {
        let tools_url = format!(
            "{}/tools?toolkit_slug={}&toolkit_versions=latest",
            COMPOSIO_BASE_URL,
            urlencoding::encode(app)
        );
        let tools_resp = match state
            .http_client
            .get(&tools_url)
            .headers(composio_request_headers(&state.composio_api_key))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Composio tools fetch failed for {}: {}", app, e);
                continue;
            }
        };

        if !tools_resp.status().is_success() {
            let status = tools_resp.status();
            let body = tools_resp.text().await.unwrap_or_default();
            tracing::warn!(
                "Composio tools non-success for {}: {} {}",
                app,
                status,
                body.chars().take(200).collect::<String>()
            );
            continue;
        }

        let tools_body: Value = match tools_resp.json().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("Composio tools JSON parse failed for {}: {}", app, e);
                continue;
            }
        };

        let tool_items = tools_body
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for t in &tool_items {
            let slug = t
                .get("slug")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let name = t
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&slug)
                .to_string();
            let desc = t
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            let params = t.get("parameters").cloned().unwrap_or_else(|| {
                serde_json::json!({"type": "object", "properties": {}})
            });
            all_tools.push(serde_json::json!({
                "name": format!("composio__{}", slug),
                "description": if desc.is_empty() { format!("Composio action: {}", name) } else { desc },
                "parameters": params,
            }));
        }
    }

    Ok(Json(serde_json::json!({
        "tools": all_tools,
        "connected_apps": connected_apps,
    })))
}

async fn composio_execute(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|s| (s, "access_denied".into()))?;
    let user = resolve_app_user(&state, access)
        .await
        .map_err(|s| (s, "user_lookup_failed".into()))?
        .ok_or((StatusCode::UNAUTHORIZED, "not_signed_in".into()))?;

    if state.composio_api_key.is_empty() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "composio_not_configured".into()));
    }

    let exec_url = format!("{}/tools/execute/{}", COMPOSIO_BASE_URL, slug);
    let exec_body = serde_json::json!({
        "user_id": user.user_id,
        "arguments": body,
    });

    let resp = state
        .http_client
        .post(&exec_url)
        .headers(composio_request_headers(&state.composio_api_key))
        .json(&exec_body)
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "composio_unreachable".into()))?;

    let resp_status = resp.status();
    let resp_text = resp.text().await.unwrap_or_default();

    if !resp_status.is_success() {
        tracing::warn!("Composio execute {} failed: {}", slug, resp_text.chars().take(200).collect::<String>());
        return Ok(Json(serde_json::json!({
            "isError": true,
            "content": [{"type": "text", "text": format!("Composio error: {}", resp_text.chars().take(500).collect::<String>())}]
        })));
    }

    Ok(Json(serde_json::json!({
        "isError": false,
        "content": [{"type": "text", "text": resp_text}]
    })))
}

/// OAuth callback endpoint that receives the redirect after a user
/// completes the Composio connection flow in their browser.
async fn composio_callback() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connected &ndash; zWork</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh;
         margin: 0; background: #f8f9fa; color: #1a1a2e; }
  .card { background: #fff; border-radius: 16px; padding: 40px 48px; text-align: center;
          box-shadow: 0 4px 24px rgba(0,0,0,.06); max-width: 400px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 14px; color: #6b7280; margin: 0 0 24px; line-height: 1.5; }
  .check { display: inline-flex; align-items: center; justify-content: center;
           width: 48px; height: 48px; border-radius: 50%; background: #10b9811a;
           margin-bottom: 16px; }
  .check svg { width: 24px; height: 24px; color: #10b981; }
</style>
</head>
<body>
<div class="card">
  <div class="check">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  </div>
  <h1>App connected</h1>
  <p>Your app has been connected to zWork. You can close this window and return to the app.</p>
</div>
</body>
</html>"#,
    )
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

    let state_value = format!(
        "oauth_{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
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
        (
            "redirect_uri",
            "https://api.tryzwork.app/api/auth/callback/google",
        ),
        ("response_type", "code"),
        ("scope", "openid email profile"),
        ("access_type", "offline"),
        ("prompt", "select_account"),
        ("state", state_value.as_str()),
    ];

    let oauth_url =
        reqwest::Url::parse_with_params("https://accounts.google.com/o/oauth2/v2/auth", params)
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
            (
                "redirect_uri",
                "https://api.tryzwork.app/api/auth/callback/google",
            ),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !token_response.status().is_success() {
        return Ok(localhost_auth_redirect(
            port,
            "error",
            "google_token_exchange_failed",
        ));
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
        return Ok(localhost_auth_redirect(
            port,
            "error",
            "google_userinfo_failed",
        ));
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
        RETURNING user_id, email, name, tier, coupon_code,
                  stripe_customer_id, subscription_id, subscription_status,
                  subscription_price_id, subscription_current_period_end,
                  created_at, updated_at
        "#,
    )
    .bind(code)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::UNAUTHORIZED)?;

    Ok(Json(mint_desktop_access_token(&state, &claimed).await?))
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

async fn desktop_email_sign_in(
    State(state): State<AppState>,
    Json(body): Json<DesktopEmailSignInRequest>,
) -> Result<Json<DesktopAuthExchangeResponse>, (StatusCode, String)> {
    if !state.features.email_auth {
        return Err((StatusCode::NOT_FOUND, "email_auth_disabled".to_string()));
    }

    let email = body.email.trim();
    let password = body.password.trim();

    if email.is_empty() || password.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "email_and_password_required".to_string(),
        ));
    }

    let auth_user = better_auth_sign_in_email(&state, email, password).await?;
    let app_user = upsert_app_user(&state, &auth_user)
        .await
        .map_err(|status| (status, "app_user_upsert_failed".to_string()))?;
    let response = mint_desktop_access_token(&state, &app_user)
        .await
        .map_err(|status| (status, "desktop_token_create_failed".to_string()))?;
    Ok(Json(response))
}

async fn desktop_email_sign_up(
    State(state): State<AppState>,
    Json(body): Json<DesktopEmailSignUpRequest>,
) -> Result<Json<DesktopEmailSignUpResponse>, (StatusCode, String)> {
    if !state.features.email_auth {
        return Err((StatusCode::NOT_FOUND, "email_auth_disabled".to_string()));
    }

    let name = body.name.trim();
    let email = body.email.trim();
    let password = body.password.trim();

    if name.is_empty() || email.is_empty() || password.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "name_email_password_required".to_string(),
        ));
    }

    better_auth_sign_up_email(&state, name, email, password, body.callback_url.as_deref()).await?;

    Ok(Json(DesktopEmailSignUpResponse {
        ok: true,
        verification_required: true,
        message: "Check your email to verify your account before signing in.".to_string(),
    }))
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

    let managed_gateway_ready =
        state.features.hosted_gateway && !state.gateway.providers.is_empty();
    let managed_gateway_status = if managed_gateway_ready {
        let provider_list = state
            .gateway
            .providers
            .iter()
            .map(|provider| {
                if provider.fallback_model.trim().is_empty()
                    || provider.fallback_model.trim() == provider.primary_model.trim()
                {
                    format!("{} ({})", provider.name, provider.primary_model)
                } else {
                    format!(
                        "{} ({}, fallback {})",
                        provider.name, provider.primary_model, provider.fallback_model
                    )
                }
            })
            .collect::<Vec<_>>()
            .join(" · ");
        format!(
            "{} is ready via {}",
            state.gateway.router_label, provider_list
        )
    } else if !state.features.hosted_gateway {
        "Hosted gateway is disabled on this server.".to_string()
    } else {
        "Hosted gateway is not configured yet. Add at least one provider API key on the server."
            .to_string()
    };

    let billing_enabled = state.features.billing && stripe_billing_ready(&state);
    let billing_status = if billing_enabled {
        "Stripe billing is configured.".to_string()
    } else if !state.features.billing {
        "Stripe billing is disabled on this server.".to_string()
    } else {
        "Stripe billing is not configured yet. Set the Stripe secret and Pro price IDs on the server.".to_string()
    };

    let five_hour_limit = resolve_user_5h_limit(&state, &user.tier).await;
    let weekly_limit = five_hour_limit * state.gateway.weekly_limit_multiplier.max(1);
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
                tokens_reset_minute_seconds: snapshot
                    .and_then(|row| row.tokens_reset_minute_seconds),
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
        billing_enabled,
        billing_status,
        owner_provider_overview,
        api_url: "https://api.tryzwork.app/health".to_string(),
        analytics_url: "https://us.posthog.com/project/397748".to_string(),
        db_url: "https://db.tryzwork.app/".to_string(),
    }))
}

// -- Web chat handlers --

async fn web_chats_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let access = ensure_gateway_access(&state, &headers).await?;
    let user = resolve_app_user(&state, access)
        .await?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let chats = sqlx::query_as::<_, WebChat>(
        r#"
        SELECT id, user_id, title, created_at, updated_at
        FROM web_chats
        WHERE user_id = $1
        ORDER BY updated_at DESC
        "#,
    )
    .bind(&user.user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({ "chats": chats })))
}

async fn web_chats_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateWebChatPayload>,
) -> Result<Json<WebChat>, StatusCode> {
    let access = ensure_gateway_access(&state, &headers).await?;
    let user = resolve_app_user(&state, access)
        .await?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let title = body
        .title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "New chat".to_string());

    let chat = sqlx::query_as::<_, WebChat>(
        r#"
        INSERT INTO web_chats (user_id, title)
        VALUES ($1, $2)
        RETURNING id, user_id, title, created_at, updated_at
        "#,
    )
    .bind(&user.user_id)
    .bind(&title)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(chat))
}

async fn web_chats_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<Value>, StatusCode> {
    let access = ensure_gateway_access(&state, &headers).await?;
    let user = resolve_app_user(&state, access)
        .await?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let chat = sqlx::query_as::<_, WebChat>(
        r#"
        SELECT id, user_id, title, created_at, updated_at
        FROM web_chats
        WHERE id = $1
        "#,
    )
    .bind(chat_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;

    if chat.user_id != user.user_id {
        return Err(StatusCode::FORBIDDEN);
    }

    let messages = sqlx::query_as::<_, WebChatMessage>(
        r#"
        SELECT id, chat_id, role, content, created_at
        FROM web_chat_messages
        WHERE chat_id = $1
        ORDER BY created_at ASC
        "#,
    )
    .bind(chat_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({
        "id": chat.id,
        "user_id": chat.user_id,
        "title": chat.title,
        "created_at": chat.created_at,
        "updated_at": chat.updated_at,
        "messages": messages,
    })))
}

async fn web_chats_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(chat_id): Path<Uuid>,
    Json(body): Json<UpdateWebChatPayload>,
) -> Result<Json<WebChat>, StatusCode> {
    let access = ensure_gateway_access(&state, &headers).await?;
    let user = resolve_app_user(&state, access)
        .await?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let existing = sqlx::query_scalar::<_, String>(
        r#"SELECT user_id FROM web_chats WHERE id = $1"#,
    )
    .bind(chat_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;

    if existing != user.user_id {
        return Err(StatusCode::FORBIDDEN);
    }

    let title = body.title.trim();
    if title.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let chat = sqlx::query_as::<_, WebChat>(
        r#"
        UPDATE web_chats
        SET title = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, user_id, title, created_at, updated_at
        "#,
    )
    .bind(chat_id)
    .bind(title)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(chat))
}

async fn web_chats_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(chat_id): Path<Uuid>,
) -> Result<StatusCode, StatusCode> {
    let access = ensure_gateway_access(&state, &headers).await?;
    let user = resolve_app_user(&state, access)
        .await?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let existing = sqlx::query_scalar::<_, String>(
        r#"SELECT user_id FROM web_chats WHERE id = $1"#,
    )
    .bind(chat_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;

    if existing != user.user_id {
        return Err(StatusCode::FORBIDDEN);
    }

    sqlx::query(r#"DELETE FROM web_chats WHERE id = $1"#)
        .bind(chat_id)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(StatusCode::NO_CONTENT)
}

async fn web_chats_add_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(chat_id): Path<Uuid>,
    Json(body): Json<AddWebChatMessagePayload>,
) -> Result<Json<WebChatMessage>, StatusCode> {
    let access = ensure_gateway_access(&state, &headers).await?;
    let user = resolve_app_user(&state, access)
        .await?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let existing = sqlx::query_scalar::<_, String>(
        r#"SELECT user_id FROM web_chats WHERE id = $1"#,
    )
    .bind(chat_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;

    if existing != user.user_id {
        return Err(StatusCode::FORBIDDEN);
    }

    let valid_roles = ["user", "assistant", "system"];
    if !valid_roles.contains(&body.role.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let message = sqlx::query_as::<_, WebChatMessage>(
        r#"
        INSERT INTO web_chat_messages (chat_id, role, content)
        VALUES ($1, $2, $3)
        RETURNING id, chat_id, role, content, created_at
        "#,
    )
    .bind(chat_id)
    .bind(&body.role)
    .bind(&body.content)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Bump the chat's updated_at so it surfaces at the top of the list
    let _ = sqlx::query(r#"UPDATE web_chats SET updated_at = NOW() WHERE id = $1"#)
        .bind(chat_id)
        .execute(&state.db)
        .await;

    Ok(Json(message))
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

    let auth_internal_base = load_auth_internal_base();
    let auth_session_url = load_auth_session_url(&auth_internal_base);

    let state = AppState {
        posthog_client: Client::new(),
        posthog_key: std::env::var("POSTHOG_API_KEY").unwrap_or_default(),
        posthog_host: std::env::var("POSTHOG_HOST")
            .unwrap_or_else(|_| "https://app.posthog.com".to_string()),
        stripe_secret_key: std::env::var("STRIPE_SECRET_KEY").unwrap_or_default(),
        stripe_webhook_secret: std::env::var("STRIPE_WEBHOOK_SECRET").unwrap_or_default(),
        db: pool,
        http_client: Client::new(),
        auth_session_url,
        auth_internal_base,
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
        features: AppFeatures {
            hosted_gateway: env_bool("ENABLE_HOSTED_GATEWAY", false),
            billing: env_bool("ENABLE_BILLING", false),
            email_auth: env_bool("ENABLE_EMAIL_AUTH", false),
            coupons: env_bool("ENABLE_COUPONS", false),
        },
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
            pro_max_concurrent_roots: std::env::var("PRO_MAX_CONCURRENT_ROOT_RUNS")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(10),
            max_max_concurrent_roots: std::env::var("MAX_MAX_CONCURRENT_ROOT_RUNS")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(20),
            free_tier_pool_5h: std::env::var("FREE_TIER_POOL_5H")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(200),
            pro_root_requests_per_5h: std::env::var("PRO_ROOT_REQUESTS_PER_5H")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(200),
            max_root_requests_per_5h: std::env::var("MAX_ROOT_REQUESTS_PER_5H")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(1000),
            dev_coupon_codes: std::env::var("DEV_COUPON_CODES")
                .unwrap_or_default()
                .split(',')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect(),
        },
        composio_api_key: std::env::var("COMPOSIO_API_KEY").unwrap_or_default(),
    };

    let cors = CorsLayer::new()
        .allow_credentials(true)
        .allow_origin(cors_allowed_origins())
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::PATCH,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            header::ACCEPT,
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            HeaderName::from_static("x-api-key"),
            HeaderName::from_static("x-request-id"),
            HeaderName::from_static("x-zwork-run-id"),
            HeaderName::from_static("x-zwork-request-kind"),
        ]);

    // Per-IP rate limit applied only to the credential-handling auth endpoints.
    // 1 token/sec replenish with a burst of 5 covers normal interactive use
    // (typo + retry, going through the OAuth flow) and shuts down the pace
    // needed for credential stuffing or signup spam. SmartIpKeyExtractor
    // looks at X-Forwarded-For first so the layer keys off the real client
    // IP behind Caddy, not the proxy hop.
    let auth_governor_conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(1)
            .burst_size(5)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .expect("valid governor config"),
    );
    // Periodically reclaim memory held by the limiter for IPs we haven't
    // seen recently — without this the map grows unbounded.
    let auth_governor_limiter = auth_governor_conf.limiter().clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            auth_governor_limiter.retain_recent();
        }
    });

    let auth_routes = Router::new()
        .route(
            "/api/desktop/auth/email/sign-in",
            post(desktop_email_sign_in),
        )
        .route(
            "/api/desktop/auth/email/sign-up",
            post(desktop_email_sign_up),
        )
        .route("/api/desktop/auth/exchange", post(desktop_auth_exchange))
        .layer(GovernorLayer {
            config: auth_governor_conf,
        });

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/api/session", get(session_me))
        .route("/api/telemetry/event", post(ingest_telemetry))
        .route("/api/chat/stream", post(ai_proxy))
        .route("/api/v1/chat/completions", post(ai_proxy))
        .route("/api/v1/messages", post(ai_proxy_anthropic))
        .route("/api/webhooks/stripe", post(stripe_webhook))
        .route("/api/billing/checkout", post(billing_checkout))
        .route("/api/billing/portal", post(billing_portal))
        .route("/api/dev/redeem-coupon", post(redeem_coupon))
        .route("/api/desktop/auth/start", get(desktop_auth_start))
        .route("/api/auth/desktop/google", get(desktop_google_auth_start))
        .route("/api/auth/callback/google", get(desktop_google_callback))
        .route("/api/desktop/auth/logout", post(desktop_auth_logout))
        .route("/api/analytics/summary", get(analytics_summary))
        .route("/api/users/:google_id", get(get_user_by_google_id))
        .route("/api/users", post(upsert_user))
        .route("/api/users/:google_id/tier", put(update_user_tier))
        // Admin Dashboard Routes
        .route("/api/admin/verify-password", post(admin_verify_password))
        .route("/api/admin/metrics/overview", get(admin_metrics_overview))
        .route("/api/admin/users", get(admin_list_users))
        .route("/api/admin/usage/by-time", get(admin_usage_by_time))
        .route("/api/admin/usage/by-model", get(admin_usage_by_model))
        .route(
            "/api/admin/users/:user_id/tier",
            put(admin_update_user_tier),
        )
        // Composio proxy
        .route("/api/composio/status", get(composio_status))
        .route("/api/composio/accounts", get(composio_accounts))
        .route("/api/composio/connect", post(composio_connect))
        .route("/api/composio/disconnect", post(composio_disconnect))
        .route("/api/composio/apps", get(composio_apps))
        .route("/api/composio/tools", get(composio_tools))
        .route("/api/composio/tools/execute/:slug", post(composio_execute))
        .route("/api/composio/callback", get(composio_callback))
        // Web chat persistence
        .route("/api/web/chats", get(web_chats_list).post(web_chats_create))
        .route(
            "/api/web/chats/:id",
            get(web_chats_get)
                .patch(web_chats_update)
                .delete(web_chats_delete),
        )
        .route(
            "/api/web/chats/:id/messages",
            post(web_chats_add_message),
        )
        .merge(auth_routes)
        .layer(cors)
        .with_state(state);

    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    info!("Server running on 0.0.0.0:8080");
    axum::serve(listener, app).await.unwrap();
}
