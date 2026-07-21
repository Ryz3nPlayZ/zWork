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
use tower_http::trace::TraceLayer;
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
    admin_token_secret: String,
    admin_token_ttl_hours: i64,
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

/// Allowed model IDs that the router will serve (includes app aliases).
const ALLOWED_MODELS: &[&str] = &[
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "zwork-flash",
    "zwork-pro",
    "zwork-vision",
    "gemma4:31b",
    "llama-3.2-90b-vision",
    "meta-llama/llama-4-scout-17b-16e-instruct",
];
/// Models restricted to pro+ tiers.
const PRO_ONLY_MODELS: &[&str] = &[
    "deepseek-v4-pro",
    "zwork-pro",
    "zwork-vision",
    "gemma4:31b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
];

/// Resolve app-facing model aliases to the actual upstream model ID.
fn resolve_upstream_model(model: &str) -> &str {
    match model {
        "zwork-flash" => "deepseek-v4-flash",
        "zwork-pro" => "deepseek-v4-pro",
        "zwork-vision" => "gemma4:31b",
        other => other,
    }
}

fn load_gateway_providers() -> Vec<GatewayProvider> {
    let mut providers = Vec::new();

    let api_key = std::env::var("DEEPSEEK_API_KEY").unwrap_or_default();
    if !api_key.trim().is_empty() {
        // DeepSeek exposes TWO wire formats over the same API key:
        //   - https://api.deepseek.com/anthropic  → Anthropic Messages shape
        //   - https://api.deepseek.com             → OpenAI Chat Completions shape
        // The two gateway handlers (`ai_proxy_anthropic` for /api/v1/messages,
        // `ai_proxy` for /api/v1/chat/completions) each filter providers by
        // `protocol`, so a single provider entry can only serve one shape.
        // Registering DeepSeek under BOTH protocols lets the desktop sidecar
        // (Anthropic shape) and the web demo (OpenAI shape) share the same
        // upstream — without this, only one endpoint has a provider and the
        // other returns a bare 502 with an empty failure list.
        //
        // `DEEPSEEK_PROTOCOL` is preserved as a backward-compat hint but is no
        // longer exclusive: if it pins "anthropic" or "openai" explicitly, only
        // that variant registers; otherwise (unset / "both" / anything else)
        // both variants register.
        let primary = env_or("DEEPSEEK_MODEL_PRIMARY", "deepseek-v4-flash");
        let fallback = env_or("DEEPSEEK_MODEL_FALLBACK", "deepseek-v4-flash");
        let pin = std::env::var("DEEPSEEK_PROTOCOL")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let register_anthropic = pin.is_empty() || pin == "both" || pin == "anthropic";
        let register_openai = pin.is_empty() || pin == "both" || pin == "openai";

        if register_anthropic {
            providers.push(GatewayProvider {
                name: "DeepSeek".to_string(),
                base_url: env_or("DEEPSEEK_BASE_URL", "https://api.deepseek.com/anthropic"),
                api_key: api_key.clone(),
                primary_model: primary.clone(),
                fallback_model: fallback.clone(),
                protocol: GatewayProtocol::Anthropic,
            });
        }
        if register_openai {
            providers.push(GatewayProvider {
                name: "DeepSeek".to_string(),
                base_url: env_or("DEEPSEEK_OPENAI_BASE_URL", "https://api.deepseek.com"),
                api_key: api_key.clone(),
                primary_model: primary.clone(),
                fallback_model: fallback.clone(),
                protocol: GatewayProtocol::OpenAi,
            });
        }
    }

    // Load Groq provider
    let groq_key = std::env::var("GROQ_API_KEY").unwrap_or_default();
    if !groq_key.trim().is_empty() {
        providers.push(GatewayProvider {
            name: "Groq".to_string(),
            base_url: env_or("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
            api_key: groq_key,
            primary_model: env_or("GROQ_MODEL_PRIMARY", "meta-llama/llama-4-scout-17b-16e-instruct"),
            fallback_model: env_or("GROQ_MODEL_FALLBACK", "meta-llama/llama-4-scout-17b-16e-instruct"),
            protocol: GatewayProtocol::OpenAi,
        });
    }

    // Load up to 5 Ollama/Vision providers
    for i in 1..=5 {
        let key_env = format!("OLLAMA_API_KEY_{}", i);
        let base_env = format!("OLLAMA_BASE_URL_{}", i);
        let model_env = format!("OLLAMA_MODEL_{}", i);

        let key = std::env::var(&key_env).unwrap_or_default();
        let base_url = std::env::var(&base_env).unwrap_or_default();
        let model = std::env::var(&model_env).unwrap_or_else(|_| "gemma4:31b".to_string());

        if !base_url.trim().is_empty() {
            providers.push(GatewayProvider {
                name: format!("OllamaCloud_{}", i),
                base_url,
                api_key: key,
                primary_model: model.clone(),
                fallback_model: model,
                protocol: GatewayProtocol::OpenAi,
            });
        }
    }

    providers
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
    nonce: Option<String>,
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
    total_prompt_tokens: i64,
    total_completion_tokens: i64,
    estimated_cost_usd: f64,
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
    total_prompt_tokens: i64,
    total_completion_tokens: i64,
    estimated_cost_usd: f64,
    stripe_customer_id: Option<String>,
    subscription_status: Option<String>,
}

#[derive(Clone, Serialize)]
struct AdminUsageByTime {
    date: NaiveDate,
    requests: i64,
    roots: i64,
    continuations: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    tokens: i64,
}

#[derive(Clone, Serialize)]
struct AdminUsageByModel {
    provider_name: Option<String>,
    model_id: String,
    requests: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
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
        ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS subscription_ended_at TIMESTAMPTZ;
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
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS chat_id TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS project_id TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS app_version TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS os TEXT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS request_body_size_bytes BIGINT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS response_body_size_bytes BIGINT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS request_payload JSONB;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS response_payload JSONB;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS first_token_at TIMESTAMPTZ;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS upstream_duration_ms BIGINT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS total_duration_ms BIGINT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(12,6);
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS routing_decision JSONB;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS failure_history JSONB;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS stream BOOLEAN;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS max_tokens BIGINT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        ALTER TABLE gateway_requests
        ADD COLUMN IF NOT EXISTS tool_count INT;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_gateway_requests_chat_id ON gateway_requests(chat_id, created_at);
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_gateway_requests_provider_created ON gateway_requests(provider_name, created_at);
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_gateway_requests_finished_null ON gateway_requests(finished_at) WHERE finished_at IS NULL;
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS gateway_attempts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL REFERENCES gateway_requests(id) ON DELETE CASCADE,
            provider_name TEXT NOT NULL,
            model_id TEXT NOT NULL,
            attempt_number INT NOT NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ,
            upstream_status INT,
            error_message TEXT,
            error_detail TEXT,
            prompt_tokens BIGINT,
            completion_tokens BIGINT,
            total_tokens BIGINT,
            duration_ms BIGINT
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_gateway_attempts_request ON gateway_attempts(request_id, attempt_number);
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

    // ── Admin dashboard: sessions + audit log ──
    // The admin dashboard issues stateless HMAC-signed tokens after password
    // verification. We persist only the SHA-256 hash of each token so that we
    // can revoke individual sessions and stamp last_used_at without ever
    // storing the raw bearer.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS admin_sessions (
            token_hash TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_email_issued
        ON admin_sessions(email, issued_at DESC);
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS admin_audit_log (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            actor_email TEXT,
            action TEXT NOT NULL,
            target_user_id TEXT,
            metadata JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
        ON admin_audit_log(created_at DESC);
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
    let (_actor_email, user) = ensure_owner_or_service_with_actor(state, headers).await?;
    Ok(user)
}

/// Like `ensure_owner_or_service` but also returns the actor email (from the
/// admin token if present, otherwise the owner user's email) so handlers can
/// write accurate audit-log entries.
async fn ensure_owner_or_service_with_actor(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(Option<String>, Option<AppUser>), StatusCode> {
    // First check for an HMAC-signed admin token (from password auth).
    // verify_admin_token returns Ok(None) for non-admin-shaped tokens so we
    // fall through to gateway/owner auth; Ok(Some(email)) means a valid admin
    // session; Err means admin-shaped but invalid (bad sig / expired / revoked).
    if let Some(raw) = read_bearer_token(headers) {
        if raw.starts_with(ADMIN_TOKEN_PREFIX) {
            match verify_admin_token(state, &raw).await? {
                Some(email) => return Ok((Some(email), None)),
                None => {}
            }
        }
    }

    let access = ensure_gateway_access(state, headers).await?;
    match access {
        GatewayAccess::ServiceToken => Ok((None, None)),
        other => {
            let user = resolve_app_user(state, other)
                .await?
                .ok_or(StatusCode::UNAUTHORIZED)?;
            if is_owner_email(state, &user.email) {
                Ok((Some(user.email.clone()), Some(user)))
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
/// Pro model requests (deepseek-v4-pro / zwork-pro) count as 3x usage.
async fn enforce_root_rate_limit(state: &AppState, user_id: &str, tier: &str, requested_model: &str) -> Result<(), StatusCode> {
    let limit_5h = resolve_user_5h_limit(state, tier).await;

    // Weight pro model requests as 3x in the usage count
    let pro_models = ["deepseek-v4-pro", "zwork-pro"];
    let request_weight: i64 = if pro_models.contains(&requested_model) { 3 } else { 1 };

    // Count historical usage with pro-model weighting
    let used_last_5h: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(
            CASE WHEN model_id IN ('deepseek-v4-pro', 'zwork-pro') THEN 3 ELSE 1 END
        ), 0)
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

    if used_last_5h + request_weight > limit_5h {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    let weekly_limit = limit_5h * state.gateway.weekly_limit_multiplier.max(1);
    let used_last_7d: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(
            CASE WHEN model_id IN ('deepseek-v4-pro', 'zwork-pro') THEN 3 ELSE 1 END
        ), 0)
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

    if used_last_7d + request_weight > weekly_limit {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    let active_roots: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(DISTINCT run_id)
        FROM gateway_requests
        WHERE user_id = $1
          AND request_kind = 'root'
          AND finished_at IS NULL
          AND created_at >= NOW() - INTERVAL '30 minutes'
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
    first_token_at: Option<chrono::DateTime<chrono::Utc>>,
    upstream_duration_ms: Option<i64>,
    estimated_cost_usd: Option<f64>,
    routing_decision: Option<Value>,
    failure_history: Option<Value>,
) {
    let _ = sqlx::query(
        r#"
        UPDATE gateway_requests
        SET provider_name = $2,
            model_id = $3,
            prompt_tokens = $4,
            completion_tokens = $5,
            total_tokens = $6,
            first_token_at = COALESCE($7, first_token_at),
            upstream_duration_ms = COALESCE($8, upstream_duration_ms),
            estimated_cost_usd = $9,
            routing_decision = $10,
            failure_history = $11
        WHERE id = $1
        "#,
    )
    .bind(request_id)
    .bind(provider_name)
    .bind(model_id)
    .bind(prompt_tokens)
    .bind(completion_tokens)
    .bind(total_tokens)
    .bind(first_token_at)
    .bind(upstream_duration_ms)
    .bind(estimated_cost_usd)
    .bind(routing_decision)
    .bind(failure_history)
    .execute(&state.db)
    .await;
}

fn parse_i64_header(headers: &HeaderMap, name: &str) -> Option<i64> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok())
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Replace base64 image data URLs with a placeholder so request/response payloads
/// can be stored without bloating the database.
fn redact_image_data(value: &Value) -> Value {
    match value {
        Value::String(s) => {
            if s.starts_with("data:image/") && s.contains(";base64,") {
                Value::String("[image data redacted]".to_string())
            } else {
                Value::String(s.clone())
            }
        }
        Value::Array(arr) => Value::Array(arr.iter().map(redact_image_data).collect()),
        Value::Object(obj) => Value::Object(
            obj.iter()
                .map(|(k, v)| (k.clone(), redact_image_data(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Very rough cost estimation from provider/model token counts. Returns None when
/// pricing is unknown. Prices are per 1M tokens (input / output).
fn estimate_cost(provider: &str, model: &str, input: Option<i64>, output: Option<i64>) -> Option<f64> {
    let (input_price_1m, output_price_1m): (f64, f64) = match (provider, model) {
        ("DeepSeek", "deepseek-v4-pro") => (1.74, 3.48),
        ("DeepSeek", "deepseek-v4-flash") => (0.14, 0.28),
        ("Groq", _) => (0.15, 0.30),
        ("OllamaCloud_1", _) => (0.0, 0.0),
        _ => return None,
    };
    match (input, output) {
        (Some(i), Some(o)) => Some((i as f64 * input_price_1m + o as f64 * output_price_1m) / 1_000_000.0),
        _ => None,
    }
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
/// Returns the stream for passthrough and a oneshot receiver with the captured
/// usage plus the timestamp of the first received chunk.
fn sse_stream_with_usage(
    stream: impl futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
) -> (
    axum::body::Body,
    tokio::sync::oneshot::Receiver<(Option<DateTime<Utc>>, Option<i64>, Option<i64>, Option<i64>)>,
) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let (body_tx, body_rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(32);

    tokio::spawn(async move {
        use futures::StreamExt;
        let mut first_byte_at: Option<DateTime<Utc>> = None;
        let mut final_input: Option<i64> = None;
        let mut final_output: Option<i64> = None;
        let mut stream = Box::pin(stream);
        while let Some(chunk) = stream.next().await {
            if let Ok(ref bytes) = chunk {
                if first_byte_at.is_none() {
                    first_byte_at = Some(Utc::now());
                }
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
        let total = match (final_input, final_output) {
            (Some(i), Some(o)) => Some(i + o),
            _ => None,
        };
        let _ = tx.send((first_byte_at, final_input, final_output, total));
    });

    let body_stream = tokio_stream::wrappers::ReceiverStream::new(body_rx);
    (axum::body::Body::from_stream(body_stream), rx)
}

/// Wraps an upstream byte stream to capture:
///   - the timestamp of the first received chunk (`first_byte_at`)
///   - the full accumulated response bytes
///   - usage extracted from OpenAI-format SSE chunks
/// Returns a oneshot receiver with (bytes, first_byte_at, prompt_tokens, completion_tokens, total_tokens).
fn capture_stream_metadata(
    stream: impl futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
) -> tokio::sync::oneshot::Receiver<(Vec<u8>, Option<DateTime<Utc>>, Option<i64>, Option<i64>, Option<i64>)>
{
    let (tx, rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        use futures::StreamExt;
        let mut buf = Vec::new();
        let mut first_byte_at: Option<DateTime<Utc>> = None;
        let mut final_input: Option<i64> = None;
        let mut final_output: Option<i64> = None;
        let mut stream = Box::pin(stream);
        while let Some(chunk) = stream.next().await {
            if let Ok(ref bytes) = chunk {
                if first_byte_at.is_none() {
                    first_byte_at = Some(Utc::now());
                }
                buf.extend_from_slice(bytes);
                // Extract usage from SSE chunks if present.
                let text = String::from_utf8_lossy(bytes);
                for line in text.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            continue;
                        }
                        if let Ok(json) = serde_json::from_str::<Value>(data) {
                            if let Some(usage) = json.get("usage").and_then(|u| u.as_object()) {
                                if let Some(v) = usage.get("prompt_tokens").and_then(|v| v.as_i64()) {
                                    final_input = Some(v);
                                }
                                if let Some(v) = usage.get("completion_tokens").and_then(|v| v.as_i64()) {
                                    final_output = Some(v);
                                }
                            }
                        }
                    }
                }
            }
        }
        let total = match (final_input, final_output) {
            (Some(i), Some(o)) => Some(i + o),
            _ => None,
        };
        let _ = tx.send((buf, first_byte_at, final_input, final_output, total));
    });

    rx
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

#[derive(Debug, Default)]
struct GatewayRequestMeta {
    chat_id: Option<String>,
    project_id: Option<String>,
    app_version: Option<String>,
    os: Option<String>,
    request_payload: Option<Value>,
    request_body_size_bytes: Option<i64>,
    stream: Option<bool>,
    max_tokens: Option<i64>,
    tool_count: Option<i32>,
}

async fn insert_gateway_request(
    state: &AppState,
    user_id: &str,
    run_id: &str,
    request_kind: RequestKind,
    meta: &GatewayRequestMeta,
) -> Result<Uuid, StatusCode> {
    let kind = match request_kind {
        RequestKind::Root => "root",
        RequestKind::Continuation => "continuation",
    };

    sqlx::query_scalar(
        r#"
        INSERT INTO gateway_requests (
            user_id, run_id, request_kind,
            chat_id, project_id, app_version, os,
            request_payload, request_body_size_bytes,
            stream, max_tokens, tool_count,
            started_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(run_id)
    .bind(kind)
    .bind(&meta.chat_id)
    .bind(&meta.project_id)
    .bind(&meta.app_version)
    .bind(&meta.os)
    .bind(&meta.request_payload)
    .bind(meta.request_body_size_bytes)
    .bind(meta.stream)
    .bind(meta.max_tokens)
    .bind(meta.tool_count)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn finish_gateway_request(
    state: &AppState,
    request_id: Uuid,
    status: Option<i32>,
    response_payload: Option<Value>,
    response_body_size_bytes: Option<i64>,
    total_duration_ms: Option<i64>,
) {
    let _ = sqlx::query(
        r#"
        UPDATE gateway_requests
        SET upstream_status = $2,
            finished_at = NOW(),
            response_payload = COALESCE($3, response_payload),
            response_body_size_bytes = COALESCE($4, response_body_size_bytes),
            total_duration_ms = COALESCE($5, total_duration_ms)
        WHERE id = $1
        "#,
    )
    .bind(request_id)
    .bind(status)
    .bind(response_payload)
    .bind(response_body_size_bytes)
    .bind(total_duration_ms)
    .execute(&state.db)
    .await;
}

async fn insert_gateway_attempt(
    state: &AppState,
    request_id: Uuid,
    attempt_number: i32,
    provider_name: &str,
    model_id: &str,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        INSERT INTO gateway_attempts (request_id, attempt_number, provider_name, model_id, started_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING id
        "#,
    )
    .bind(request_id)
    .bind(attempt_number)
    .bind(provider_name)
    .bind(model_id)
    .fetch_one(&state.db)
    .await
}

async fn finish_gateway_attempt(
    state: &AppState,
    attempt_id: Uuid,
    status: Option<i32>,
    error_message: Option<&str>,
    error_detail: Option<&str>,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    total_tokens: Option<i64>,
    duration_ms: Option<i64>,
) {
    let _ = sqlx::query(
        r#"
        UPDATE gateway_attempts
        SET finished_at = NOW(),
            upstream_status = $2,
            error_message = $3,
            error_detail = $4,
            prompt_tokens = $5,
            completion_tokens = $6,
            total_tokens = $7,
            duration_ms = $8
        WHERE id = $1
        "#,
    )
    .bind(attempt_id)
    .bind(status)
    .bind(error_message)
    .bind(error_detail)
    .bind(prompt_tokens)
    .bind(completion_tokens)
    .bind(total_tokens)
    .bind(duration_ms)
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

    let started_at = Utc::now();
    let headers = req.headers().clone();
    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|status| (status, "gateway_access_denied".to_string()))?;
    let run_id = run_id_from_headers(&headers);
    let request_kind = request_kind_from_headers(&headers);
    let app_user = resolve_app_user(&state, access)
        .await
        .map_err(|status| (status, "gateway_user_resolution_failed".to_string()))?;

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

    // Extract model for rate-limit weighting (pro models = 3x cost)
    let openai_model = body_json
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();

    if let (Some(user), RequestKind::Root) = (&app_user, request_kind) {
        enforce_root_rate_limit(&state, &user.user_id, &user.tier, &openai_model)
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

    // Build request metadata from client headers and payload.
    let request_payload = redact_image_data(&body_json);
    let meta = GatewayRequestMeta {
        chat_id: header_str(&headers, "x-zwork-chat-id"),
        project_id: header_str(&headers, "x-zwork-project-id"),
        app_version: header_str(&headers, "x-zwork-app-version"),
        os: header_str(&headers, "x-zwork-os"),
        request_payload: Some(request_payload),
        request_body_size_bytes: Some(body_bytes.len() as i64),
        stream: body_json.get("stream").and_then(|v| v.as_bool()),
        max_tokens: body_json.get("max_tokens").and_then(|v| v.as_i64()),
        tool_count: body_json
            .get("tools")
            .and_then(|v| v.as_array())
            .map(|a| a.len() as i32),
    };

    let request_id = if let Some(user) = &app_user {
        Some(
            insert_gateway_request(&state, &user.user_id, &run_id, request_kind, &meta)
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

    let mut failures: Vec<String> = Vec::new();
    let mut attempt_number: i32 = 0;

    let resolved_model = resolve_upstream_model(&openai_model);
    let mut providers_to_try: Vec<&GatewayProvider> = Vec::new();
    for p in &state.gateway.providers {
        if p.protocol == GatewayProtocol::OpenAi && (p.primary_model == resolved_model || p.fallback_model == resolved_model) {
            providers_to_try.push(p);
        }
    }
    for p in &state.gateway.providers {
        if p.protocol == GatewayProtocol::OpenAi && !(p.primary_model == resolved_model || p.fallback_model == resolved_model) {
            providers_to_try.push(p);
        }
    }

    // Build routing decision record.
    let routing_decision = serde_json::json!({
        "requested_model": openai_model,
        "resolved_model": resolved_model,
        "provider_order": providers_to_try.iter().map(|p| serde_json::json!({
            "name": p.name,
            "primary_model": p.primary_model,
            "fallback_model": p.fallback_model,
        })).collect::<Vec<_>>(),
    });

    for provider in providers_to_try {
        // Build the list of models to try for this provider. If the provider
        // claims to support the requested model (primary or fallback matches),
        // prefer the requested model so users actually get what they selected.
        // Otherwise fall back to the provider's configured models.
        let supports_requested = provider.primary_model == resolved_model
            || provider.fallback_model == resolved_model;

        let mut models: Vec<String> = Vec::new();
        if supports_requested {
            models.push(resolved_model.to_string());
        }
        if !supports_requested || provider.primary_model != resolved_model {
            models.push(provider.primary_model.clone());
        }
        if !provider.fallback_model.trim().is_empty()
            && provider.fallback_model != provider.primary_model
            && provider.fallback_model != resolved_model
        {
            models.push(provider.fallback_model.clone());
        }

        for model_name in models {
            attempt_number += 1;
            let attempt_started = Utc::now();
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
                Err(e) => {
                    let msg = format!("{}:{} unreachable: {}", provider.name, model_name, e);
                    failures.push(msg.clone());
                    if let Some(req_id) = request_id {
                        let attempt_id = insert_gateway_attempt(&state, req_id, attempt_number, &provider.name, &model_name).await.ok();
                        if let Some(aid) = attempt_id {
                            finish_gateway_attempt(
                                &state, aid, None, Some("unreachable"), Some(&msg),
                                None, None, None,
                                Some((Utc::now() - attempt_started).num_milliseconds()),
                            ).await;
                        }
                    }
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
                    .take(500)
                    .collect::<String>();
                let msg = format!(
                    "{}:{} {} {}",
                    provider.name,
                    model_name,
                    status.as_u16(),
                    detail
                );
                failures.push(msg.clone());
                if let Some(req_id) = request_id {
                    let attempt_id = insert_gateway_attempt(&state, req_id, attempt_number, &provider.name, &model_name).await.ok();
                    if let Some(aid) = attempt_id {
                        finish_gateway_attempt(
                            &state, aid, Some(status.as_u16() as i32), Some("upstream_error"), Some(&detail),
                            None, None, None,
                            Some((Utc::now() - attempt_started).num_milliseconds()),
                        ).await;
                    }
                }
                continue;
            }

            // Success path: capture the full response stream, timing, and usage.
            let attempt_id = if let Some(req_id) = request_id {
                insert_gateway_attempt(&state, req_id, attempt_number, &provider.name, &model_name).await.ok()
            } else {
                None
            };

            let stream = resp.bytes_stream();
            let rx = capture_stream_metadata(stream);
            let (response_bytes, first_byte_at, stream_input, stream_output, stream_total) = rx.await.unwrap_or_else(|_| (Vec::new(), None, None, None, None));
            let attempt_finished = Utc::now();
            let attempt_duration_ms = (attempt_finished - attempt_started).num_milliseconds();
            let upstream_duration_ms = first_byte_at.map(|ft| (attempt_finished - ft).num_milliseconds());

            let body_json: Option<Value> = serde_json::from_slice(&response_bytes).ok();
            let (mut prompt_tokens, mut completion_tokens, mut total_tokens) = (stream_input, stream_output, stream_total);
            if let Some(ref json) = body_json {
                if prompt_tokens.is_none() || completion_tokens.is_none() {
                    let (p, c, t) = parse_usage_counts(json);
                    prompt_tokens = prompt_tokens.or(p);
                    completion_tokens = completion_tokens.or(c);
                    total_tokens = total_tokens.or(t);
                }
            }

            let response_payload = body_json.as_ref().map(redact_image_data);
            let response_body_size_bytes = Some(response_bytes.len() as i64);
            let status_i32 = Some(status.as_u16() as i32);
            let cost = estimate_cost(&provider.name, &model_name, prompt_tokens, completion_tokens);

            if let Some(req_id) = request_id {
                mark_gateway_request_upstream(
                    &state,
                    req_id,
                    &provider.name,
                    &model_name,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    first_byte_at,
                    upstream_duration_ms,
                    cost,
                    Some(routing_decision.clone()),
                    Some(serde_json::Value::Array(failures.iter().map(|f| serde_json::Value::String(f.clone())).collect())),
                ).await;
                finish_gateway_request(
                    &state,
                    req_id,
                    status_i32,
                    response_payload,
                    response_body_size_bytes,
                    Some((Utc::now() - started_at).num_milliseconds()),
                ).await;
            }

            if let Some(aid) = attempt_id {
                finish_gateway_attempt(
                    &state, aid, status_i32, None, None,
                    prompt_tokens, completion_tokens, total_tokens,
                    Some(attempt_duration_ms),
                ).await;
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
                .unwrap_or_else(|| response_bytes);
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
            Some(serde_json::json!({ "failures": failures })),
            None,
            Some((Utc::now() - started_at).num_milliseconds()),
        )
        .await;
        mark_gateway_request_upstream(
            &state,
            request_id,
            "",
            "",
            None,
            None,
            None,
            None,
            None,
            None,
            Some(routing_decision),
            Some(serde_json::Value::Array(failures.iter().map(|f| serde_json::Value::String(f.clone())).collect())),
        ).await;
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

    let started_at = Utc::now();
    let headers = req.headers().clone();
    let access = ensure_gateway_access(&state, &headers)
        .await
        .map_err(|status| (status, "gateway_access_denied".to_string()))?;
    let run_id = run_id_from_headers(&headers);
    let request_kind = request_kind_from_headers(&headers);
    let app_user = resolve_app_user(&state, access)
        .await
        .map_err(|status| (status, "gateway_user_resolution_failed".to_string()))?;

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

    if let (Some(user), RequestKind::Root) = (&app_user, request_kind) {
        enforce_root_rate_limit(&state, &user.user_id, &user.tier, &requested_model)
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

    let request_payload = redact_image_data(&body_json);
    let meta = GatewayRequestMeta {
        chat_id: header_str(&headers, "x-zwork-chat-id"),
        project_id: header_str(&headers, "x-zwork-project-id"),
        app_version: header_str(&headers, "x-zwork-app-version"),
        os: header_str(&headers, "x-zwork-os"),
        request_payload: Some(request_payload),
        request_body_size_bytes: Some(body_bytes.len() as i64),
        stream: Some(true),
        max_tokens: body_json.get("max_tokens").and_then(|v| v.as_i64()),
        tool_count: body_json
            .get("tools")
            .and_then(|v| v.as_array())
            .map(|a| a.len() as i32),
    };

    let request_id = if let Some(user) = &app_user {
        Some(
            insert_gateway_request(&state, &user.user_id, &run_id, request_kind, &meta)
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

    // Ensure thinking blocks are present in assistant messages for DeepSeek
    ensure_thinking_blocks(&mut body_json);

    let mut failures: Vec<String> = Vec::new();
    let mut attempt_number: i32 = 0;
    let resolved_model = resolve_upstream_model(&requested_model);
    let routing_decision = serde_json::json!({
        "requested_model": requested_model,
        "resolved_model": resolved_model,
        "provider_order": state.gateway.providers.iter()
            .filter(|p| p.protocol == GatewayProtocol::Anthropic)
            .map(|p| serde_json::json!({
                "name": p.name,
                "primary_model": p.primary_model,
                "fallback_model": p.fallback_model,
            }))
            .collect::<Vec<_>>(),
    });

    for provider in &state.gateway.providers {
        if provider.protocol != GatewayProtocol::Anthropic {
            continue;
        }

        attempt_number += 1;
        let attempt_started = Utc::now();
        let upstream_model = resolved_model.to_string();

        if let Some(obj) = body_json.as_object_mut() {
            // Resolve app aliases (zwork-flash → deepseek-v4-flash) before sending upstream
            obj.insert(
                "model".to_string(),
                Value::String(upstream_model.clone()),
            );
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
            Err(e) => {
                let msg = format!("{}:{} unreachable: {}", provider.name, upstream_model, e);
                failures.push(msg.clone());
                if let Some(req_id) = request_id {
                    let attempt_id = insert_gateway_attempt(&state, req_id, attempt_number, &provider.name, &upstream_model).await.ok();
                    if let Some(aid) = attempt_id {
                        finish_gateway_attempt(
                            &state, aid, None, Some("unreachable"), Some(&msg),
                            None, None, None,
                            Some((Utc::now() - attempt_started).num_milliseconds()),
                        ).await;
                    }
                }
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
                .take(500)
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
            let msg = format!(
                "{}:{} {} {}",
                provider.name,
                upstream_model,
                status.as_u16(),
                detail
            );
            failures.push(msg.clone());
            if let Some(req_id) = request_id {
                let attempt_id = insert_gateway_attempt(&state, req_id, attempt_number, &provider.name, &upstream_model).await.ok();
                if let Some(aid) = attempt_id {
                    finish_gateway_attempt(
                        &state, aid, Some(status.as_u16() as i32), Some("upstream_error"), Some(&detail),
                        None, None, None,
                        Some((Utc::now() - attempt_started).num_milliseconds()),
                    ).await;
                }
            }
            continue;
        }

        // Stream the response, intercepting SSE events to extract token usage
        let attempt_id = if let Some(req_id) = request_id {
            insert_gateway_attempt(&state, req_id, attempt_number, &provider.name, &upstream_model).await.ok()
        } else {
            None
        };
        let upstream_body = resp.bytes_stream();
        let (body, usage_rx) = sse_stream_with_usage(upstream_body);

        if let Some(req_id) = request_id {
            let state_clone = state.clone();
            let provider_name = provider.name.clone();
            let upstream_model_clone = upstream_model.clone();
            let started = started_at;
            let routing = routing_decision.clone();
            let failure_json = serde_json::Value::Array(failures.iter().map(|f| serde_json::Value::String(f.clone())).collect());
            tokio::spawn(async move {
                let Ok((first_byte_at, prompt_tokens, completion_tokens, total_tokens)) = usage_rx.await else { return; };
                let finished_at = Utc::now();
                let upstream_duration_ms = first_byte_at.map(|ft| (finished_at - ft).num_milliseconds());
                let total_duration_ms = (finished_at - started).num_milliseconds();
                let cost = estimate_cost(&provider_name, &upstream_model_clone, prompt_tokens, completion_tokens);
                mark_gateway_request_upstream(
                    &state_clone,
                    req_id,
                    &provider_name,
                    &upstream_model_clone,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    first_byte_at,
                    upstream_duration_ms,
                    cost,
                    Some(routing),
                    Some(failure_json),
                ).await;
                finish_gateway_request(
                    &state_clone,
                    req_id,
                    Some(status.as_u16() as i32),
                    None,
                    None,
                    Some(total_duration_ms),
                ).await;
                if let Some(aid) = attempt_id {
                    finish_gateway_attempt(
                        &state_clone, aid, Some(status.as_u16() as i32), None, None,
                        prompt_tokens, completion_tokens, total_tokens,
                        Some((finished_at - attempt_started).num_milliseconds()),
                    ).await;
                }
            });
        }
        upsert_provider_snapshot(
            &state,
            &provider.name,
            &upstream_model,
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
            HeaderValue::from_str(&requested_model)
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
            Some(serde_json::json!({ "failures": failures })),
            None,
            Some((Utc::now() - started_at).num_milliseconds()),
        )
        .await;
        mark_gateway_request_upstream(
            &state,
            request_id,
            "",
            "",
            None,
            None,
            None,
            None,
            None,
            None,
            Some(routing_decision),
            Some(serde_json::Value::Array(failures.iter().map(|f| serde_json::Value::String(f.clone())).collect())),
        ).await;
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

    // Reject stale or future-dated timestamps to prevent webhook replay.
    // Stripe's recommended default tolerance is 5 minutes (300s).
    match timestamp.parse::<i64>() {
        Ok(ts) if (Utc::now().timestamp() - ts).abs() <= 300 => {}
        _ => return false,
    }

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
                // When the subscription becomes active for the first time,
                // stamp subscription_started_at. When it ends, stamp
                // subscription_ended_at so the revenue dashboard can compute churn.
                let is_active = status == "active" || status == "trialing";
                let is_terminated = event_type == "customer.subscription.deleted"
                    || status == "canceled";
                let result = if user_id.is_empty() {
                    sqlx::query(
                        r#"
                        UPDATE app_users
                        SET subscription_id = CASE WHEN $2 = 'customer.subscription.deleted' THEN NULL ELSE NULLIF($3, '') END,
                            subscription_status = NULLIF($4, ''),
                            subscription_price_id = $5,
                            subscription_current_period_end = $6,
                            tier = $7,
                            subscription_started_at = COALESCE(subscription_started_at, CASE WHEN $8 THEN NOW() ELSE NULL END),
                            subscription_ended_at = CASE WHEN $9 THEN NOW() ELSE subscription_ended_at END,
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
                    .bind(is_active)
                    .bind(is_terminated)
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
                            subscription_started_at = COALESCE(subscription_started_at, CASE WHEN $9 THEN NOW() ELSE NULL END),
                            subscription_ended_at = CASE WHEN $10 THEN NOW() ELSE subscription_ended_at END,
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
                    .bind(is_active)
                    .bind(is_terminated)
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

    // MRR + paid count come straight from Stripe so discounts (e.g. 100%-off
    // coupons) are accounted for. See compute_current_mrr for the rationale.
    let (mrr, paid_users) = compute_current_mrr(&state).await;

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


    let arpu = if total_users > 0 {
        mrr / (total_users as f64)
    } else {
        0.0
    };

    let (total_prompt, total_completion): (i64, i64) = sqlx::query_as(
        r#"SELECT COALESCE(SUM(prompt_tokens), 0)::bigint, COALESCE(SUM(completion_tokens), 0)::bigint FROM gateway_requests"#
    )
    .fetch_one(&state.db)
    .await
    .map(|(p, c): (i64, i64)| (p, c))
    .unwrap_or((0, 0));

    // DeepSeek v4-flash pricing (cache miss): /bin/bash.14/M input, /bin/bash.28/M output
    let estimated_cost = (total_prompt as f64 / 1_000_000.0) * 0.14 + (total_completion as f64 / 1_000_000.0) * 0.28;

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
        total_prompt_tokens: total_prompt,
        total_completion_tokens: total_completion,
        estimated_cost_usd: (estimated_cost * 100.0).round() / 100.0,
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
            COALESCE(SUM(g.prompt_tokens), 0)::bigint as total_prompt_tokens,
            COALESCE(SUM(g.completion_tokens), 0)::bigint as total_completion_tokens,
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
    .map(|row| {
        let prompt: i64 = row.get("total_prompt_tokens");
        let completion: i64 = row.get("total_completion_tokens");
        let model: String = row.get("tier");
        // DeepSeek pricing per 1M tokens (cache miss, conservative)
        let (input_rate, output_rate) = if model == "max" {
            (0.435, 0.87) // pro model rates for max users
        } else if model == "pro" {
            (0.435, 0.87) // deepseek-v4-pro rates
        } else {
            (0.14, 0.28) // deepseek-v4-flash rates
        };
        let cost = (prompt as f64 / 1_000_000.0) * input_rate + (completion as f64 / 1_000_000.0) * output_rate;
        AdminUserRow {
            user_id: row.get("user_id"),
            email: row.get("email"),
            name: row.get("name"),
            tier: row.get("tier"),
            created_at: row.get("created_at"),
            last_activity: row.get("last_activity"),
            total_requests: row.get("total_requests"),
            total_prompt_tokens: prompt,
            total_completion_tokens: completion,
            estimated_cost_usd: (cost * 100.0).round() / 100.0,
            stripe_customer_id: row.get("stripe_customer_id"),
            subscription_status: row.get("subscription_status"),
        }
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
            DATE(created_at)::date as date,
            COUNT(*)::bigint as requests,
            COUNT(*) FILTER (WHERE request_kind = 'root')::bigint as roots,
            COUNT(*) FILTER (WHERE request_kind = 'continuation')::bigint as continuations,
            COALESCE(SUM(prompt_tokens), 0)::bigint as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0)::bigint as completion_tokens,
            COALESCE(SUM(total_tokens), 0)::bigint as tokens
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
        roots: row.get("roots"),
        continuations: row.get("continuations"),
        prompt_tokens: row.get("prompt_tokens"),
        completion_tokens: row.get("completion_tokens"),
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
        sqlx::query_scalar("SELECT COALESCE(SUM(total_tokens), 0)::bigint FROM gateway_requests")
            .fetch_one(&state.db)
            .await
            .unwrap_or(1);

    let usage: Vec<AdminUsageByModel> = sqlx::query(
        r#"
        SELECT
            MAX(provider_name) as provider_name,
            model_id,
            COUNT(*)::bigint as requests,
            COALESCE(SUM(prompt_tokens), 0)::bigint as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0)::bigint as completion_tokens,
            COALESCE(SUM(total_tokens), 0)::bigint as tokens
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
            provider_name: row.get("provider_name"),
            model_id: row.get("model_id"),
            requests: row.get("requests"),
            prompt_tokens: row.get("prompt_tokens"),
            completion_tokens: row.get("completion_tokens"),
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
    let (actor_email, _owner) = ensure_owner_or_service_with_actor(&state, &headers).await?;

    let valid_tiers = ["free", "pro", "max"];
    if !valid_tiers.contains(&body.tier.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Capture the prior tier for the audit trail before mutating.
    let prior_tier: Option<String> = sqlx::query_scalar(
        r#"SELECT tier FROM app_users WHERE user_id = $1"#,
    )
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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

    audit_admin_action(
        &state,
        actor_email.as_deref(),
        "tier_change",
        Some(&user_id),
        Some(serde_json::json!({
            "from": prior_tier,
            "to": body.tier,
        })),
    )
    .await;

    Ok(Json(user))
}

// ── Admin: operational health metrics ─────────────────────────────────────

#[derive(Deserialize)]
struct AdminDaysQuery {
    #[serde(default = "default_health_days")]
    days: i64,
}

fn default_health_days() -> i64 {
    7
}

#[derive(Serialize)]
struct AdminHealthStatusSlice {
    bucket: String,
    count: i64,
}

#[derive(Serialize)]
struct AdminHealthDayPoint {
    date: String,
    requests: i64,
    errors: i64,
    error_rate: f64,
    p50_latency_ms: Option<f64>,
    p95_latency_ms: Option<f64>,
    p99_latency_ms: Option<f64>,
    p50_ttft_ms: Option<f64>,
    p95_ttft_ms: Option<f64>,
}

#[derive(Serialize)]
struct AdminFailingModel {
    model_id: String,
    provider_name: Option<String>,
    total_requests: i64,
    failed_requests: i64,
    failure_rate: f64,
}

#[derive(Serialize)]
struct AdminHealthOverview {
    window_days: i64,
    total_requests: i64,
    failed_requests: i64,
    error_rate: f64,
    retried_requests: i64,
    status_breakdown: Vec<AdminHealthStatusSlice>,
    latency_p50_ms: Option<f64>,
    latency_p95_ms: Option<f64>,
    latency_p99_ms: Option<f64>,
    ttft_p50_ms: Option<f64>,
    ttft_p95_ms: Option<f64>,
    daily: Vec<AdminHealthDayPoint>,
    top_failing_models: Vec<AdminFailingModel>,
}

async fn admin_metrics_health(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AdminDaysQuery>,
) -> Result<Json<AdminHealthOverview>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;
    let days = q.days.clamp(1, 90);

    // Totals + error counts in the window. A request counts as "failed" when
    // upstream_status is null (we never got a response) or >= 400.
    let totals = sqlx::query(
        r#"
        SELECT
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE upstream_status IS NULL OR upstream_status >= 400)::bigint AS failed
        FROM gateway_requests
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
        "#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let total_requests: i64 = totals.get("total");
    let failed_requests: i64 = totals.get("failed");
    let error_rate = if total_requests > 0 {
        failed_requests as f64 / total_requests as f64
    } else {
        0.0
    };

    // Retries: rows that have a non-null failure_history, OR that have more
    // than one gateway_attempt row.
    let retried_requests: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM gateway_requests g
        WHERE g.created_at > NOW() - ($1 || ' days')::INTERVAL
          AND (
            g.failure_history IS NOT NULL
            OR (SELECT COUNT(*) FROM gateway_attempts a WHERE a.request_id = g.id) > 1
          )
        "#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    // Status-code bucket breakdown (2xx / 3xx / 4xx / 5xx / unknown).
    let status_rows = sqlx::query(
        r#"
        SELECT
            CASE
              WHEN upstream_status IS NULL THEN 'unknown'
              WHEN upstream_status < 300 THEN '2xx'
              WHEN upstream_status < 400 THEN '3xx'
              WHEN upstream_status < 500 THEN '4xx'
              ELSE '5xx'
            END AS bucket,
            COUNT(*)::bigint AS count
        FROM gateway_requests
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
        GROUP BY bucket
        "#,
    )
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let status_breakdown: Vec<AdminHealthStatusSlice> = status_rows
        .into_iter()
        .map(|row| AdminHealthStatusSlice {
            bucket: row.get("bucket"),
            count: row.get("count"),
        })
        .collect();

    // Overall latency + TTFT percentiles (only over rows that finished).
    // percentile_cont returns NUMERIC, so cast to float8 for f64 decoding.
    let pct = sqlx::query(
        r#"
        SELECT
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY total_duration_ms)::float8 AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms)::float8 AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY total_duration_ms)::float8 AS p99
        FROM gateway_requests
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
          AND total_duration_ms IS NOT NULL
        "#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let opt_f64 = |row: &sqlx::postgres::PgRow, col: &str| -> Option<f64> {
        row.get::<Option<f64>, _>(col)
    };
    let latency_p50_ms = opt_f64(&pct, "p50");
    let latency_p95_ms = opt_f64(&pct, "p95");
    let latency_p99_ms = opt_f64(&pct, "p99");

    let ttft = sqlx::query(
        r#"
        SELECT
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_token_at - started_at)) * 1000)::float8 AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_token_at - started_at)) * 1000)::float8 AS p95
        FROM gateway_requests
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
          AND started_at IS NOT NULL AND first_token_at IS NOT NULL
        "#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let ttft_p50_ms = opt_f64(&ttft, "p50");
    let ttft_p95_ms = opt_f64(&ttft, "p95");

    // Daily series with per-day percentiles + error rate.
    let daily_rows = sqlx::query(
        r#"
        SELECT
            DATE(created_at)::date AS date,
            COUNT(*)::bigint AS requests,
            COUNT(*) FILTER (WHERE upstream_status IS NULL OR upstream_status >= 400)::bigint AS errors,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY total_duration_ms)::float8 AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms)::float8 AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY total_duration_ms)::float8 AS p99,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_token_at - started_at)) * 1000)::float8 AS t50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_token_at - started_at)) * 1000)::float8 AS t95
        FROM gateway_requests
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
        GROUP BY DATE(created_at)
        ORDER BY DATE(created_at)
        "#,
    )
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let daily: Vec<AdminHealthDayPoint> = daily_rows
        .into_iter()
        .map(|row| {
            let date: NaiveDate = row.get("date");
            let requests: i64 = row.get("requests");
            let errors: i64 = row.get("errors");
            AdminHealthDayPoint {
                date: date.to_string(),
                requests,
                errors,
                error_rate: if requests > 0 {
                    errors as f64 / requests as f64
                } else {
                    0.0
                },
                p50_latency_ms: row.get("p50"),
                p95_latency_ms: row.get("p95"),
                p99_latency_ms: row.get("p99"),
                p50_ttft_ms: row.get("t50"),
                p95_ttft_ms: row.get("t95"),
            }
        })
        .collect();

    // Top failing models.
    let failing_rows = sqlx::query(
        r#"
        SELECT
            COALESCE(model_id, '(unknown)') AS model_id,
            MAX(provider_name) AS provider_name,
            COUNT(*)::bigint AS total_requests,
            COUNT(*) FILTER (WHERE upstream_status IS NULL OR upstream_status >= 400)::bigint AS failed_requests
        FROM gateway_requests
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
          AND model_id IS NOT NULL
        GROUP BY model_id
        HAVING COUNT(*) FILTER (WHERE upstream_status IS NULL OR upstream_status >= 400) > 0
        ORDER BY failed_requests DESC
        LIMIT 10
        "#,
    )
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let top_failing_models: Vec<AdminFailingModel> = failing_rows
        .into_iter()
        .map(|row| {
            let total: i64 = row.get("total_requests");
            let failed: i64 = row.get("failed_requests");
            AdminFailingModel {
                model_id: row.get("model_id"),
                provider_name: row.get("provider_name"),
                total_requests: total,
                failed_requests: failed,
                failure_rate: if total > 0 {
                    failed as f64 / total as f64
                } else {
                    0.0
                },
            }
        })
        .collect();

    Ok(Json(AdminHealthOverview {
        window_days: days,
        total_requests,
        failed_requests,
        error_rate,
        retried_requests,
        status_breakdown,
        latency_p50_ms,
        latency_p95_ms,
        latency_p99_ms,
        ttft_p50_ms,
        ttft_p95_ms,
        daily,
        top_failing_models,
    }))
}

#[derive(Serialize)]
struct AdminProviderHealth {
    provider_name: String,
    total_requests: i64,
    failed_requests: i64,
    failure_rate: f64,
    avg_latency_ms: Option<f64>,
    p95_latency_ms: Option<f64>,
    requests_limit_day: Option<i64>,
    requests_remaining_day: Option<i64>,
    saturation_pct: Option<f64>,
    last_status: Option<i32>,
    last_model_id: Option<String>,
    observed_at: Option<DateTime<Utc>>,
}

async fn admin_metrics_providers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AdminDaysQuery>,
) -> Result<Json<Vec<AdminProviderHealth>>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;
    let days = q.days.clamp(1, 90);

    let agg_rows = sqlx::query(
        r#"
        SELECT
            provider_name,
            COUNT(*)::bigint AS total_requests,
            COUNT(*) FILTER (WHERE upstream_status IS NULL OR upstream_status >= 400)::bigint AS failed_requests,
            AVG(total_duration_ms)::float8 AS avg_latency_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms)::float8 AS p95_latency_ms
        FROM gateway_requests
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
          AND provider_name IS NOT NULL
        GROUP BY provider_name
        ORDER BY total_requests DESC
        "#,
    )
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Latest rate-limit snapshot per provider (single row each, so fetch all).
    let snap_rows = sqlx::query(
        r#"
        SELECT provider_name, last_model_id, last_status,
               requests_limit_day, requests_remaining_day, observed_at
        FROM provider_snapshots
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut snaps: HashMap<String, (Option<i32>, Option<String>, Option<i64>, Option<i64>, Option<DateTime<Utc>>)> =
        HashMap::new();
    for row in snap_rows {
        let name: String = row.get("provider_name");
        snaps.insert(
            name,
            (
                row.get("last_status"),
                row.get("last_model_id"),
                row.get("requests_limit_day"),
                row.get("requests_remaining_day"),
                row.get("observed_at"),
            ),
        );
    }

    let out: Vec<AdminProviderHealth> = agg_rows
        .into_iter()
        .map(|row| {
            let name: String = row.get("provider_name");
            let total: i64 = row.get("total_requests");
            let failed: i64 = row.get("failed_requests");
            let (last_status, last_model_id, limit_day, remaining_day, observed_at) =
                snaps.get(&name).cloned().unwrap_or((None, None, None, None, None));
            let saturation_pct = match (limit_day, remaining_day) {
                (Some(limit), Some(remaining)) if limit > 0 => {
                    Some(((limit - remaining) as f64 / limit as f64) * 100.0)
                }
                _ => None,
            };
            AdminProviderHealth {
                provider_name: name,
                total_requests: total,
                failed_requests: failed,
                failure_rate: if total > 0 {
                    failed as f64 / total as f64
                } else {
                    0.0
                },
                avg_latency_ms: row.get("avg_latency_ms"),
                p95_latency_ms: row.get("p95_latency_ms"),
                requests_limit_day: limit_day,
                requests_remaining_day: remaining_day,
                saturation_pct,
                last_status,
                last_model_id,
                observed_at,
            }
        })
        .collect();

    Ok(Json(out))
}

// ── Admin: business / revenue metrics ─────────────────────────────────────

#[derive(Serialize)]
struct AdminRevenueDayPoint {
    date: String,
    mrr: f64,
    new_subs: i64,
    cancellations: i64,
    est_cost_usd: f64,
    margin: f64,
}

#[derive(Serialize)]
struct AdminTierSplit {
    tier: String,
    users: i64,
    mrr: f64,
}

#[derive(Serialize)]
struct AdminRevenueOverview {
    window_days: i64,
    current_mrr: f64,
    arpu: f64,
    paid_users: i64,
    churned_in_window: i64,
    new_subs_in_window: i64,
    est_cost_usd: f64,
    gross_margin_pct: f64,
    daily: Vec<AdminRevenueDayPoint>,
    tier_split: Vec<AdminTierSplit>,
}

/// Resolve per-tier monthly price (same logic as admin_metrics_overview).
fn tier_monthly_price(tier: &str, price_id: &str) -> f64 {
    // The *monthly* Stripe price IDs aren't needed here — we default to the
    // monthly USD price unless the price_id matches the *annual* plan.
    // Defaults reflect the current zWork pricing ($12 pro, $50 max).
    let pro_annual = std::env::var("STRIPE_PRICE_PRO_ANNUAL").unwrap_or_default();
    let max_annual = std::env::var("STRIPE_PRICE_MAX_ANNUAL").unwrap_or_default();
    let pro_price_monthly = std::env::var("PRO_PRICE_MONTHLY_USD")
        .ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(12.0);
    let pro_price_annual_monthly = std::env::var("PRO_PRICE_ANNUAL_MONTHLY_USD")
        .ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(10.0);
    let max_price_monthly = std::env::var("MAX_PRICE_MONTHLY_USD")
        .ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(50.0);
    let max_price_annual_monthly = std::env::var("MAX_PRICE_ANNUAL_MONTHLY_USD")
        .ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(41.67);
    match tier {
        "pro" => if price_id == pro_annual { pro_price_annual_monthly } else { pro_price_monthly },
        "max" => if price_id == max_annual { max_price_annual_monthly } else { max_price_monthly },
        _ => 0.0,
    }
}

/// Compute current MRR directly from Stripe. This is the source of truth —
// it handles discounts (e.g. 100%-off coupons) and annual/monthly normalization
// correctly, which a DB-only computation can't because we don't persist the
// Stripe discount object. Admin dashboard calls are infrequent (a human
// looking at a page), so a Stripe API call per request is fine.
///
/// Returns (mrr_usd_per_month, paid_subscriber_count).
async fn compute_current_mrr(state: &AppState) -> (f64, i64) {
    if state.stripe_secret_key.trim().is_empty() {
        return (0.0, 0);
    }

    let mut mrr = 0.0_f64;
    let mut paid = 0_i64;
    let mut has_more = true;
    let mut starting_after: Option<String> = None;

    // Page through all active subscriptions. Expand discount + price so we can
    // compute the effective monthly amount per sub in one pass.
    while has_more {
        let mut url = format!(
            "https://api.stripe.com/v1/subscriptions?status=active&limit=100&expand[]={}",
            "data.discount.coupon,data.items.data.price"
        );
        if let Some(sa) = &starting_after {
            url.push_str(&format!("&starting_after={}", sa));
        }

        let resp = match state
            .http_client
            .get(&url)
            .bearer_auth(&state.stripe_secret_key)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!("Stripe MRR query failed: {e}");
                return (0.0, 0);
            }
        };
        if !resp.status().is_success() {
            warn!("Stripe MRR query non-2xx: {}", resp.status());
            return (0.0, 0);
        }
        let body: Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                warn!("Stripe MRR query json decode failed: {e}");
                return (0.0, 0);
            }
        };

        let subs = body.get("data").and_then(|v| v.as_array());
        if let Some(subs) = subs {
            for sub in subs {
                // Effective monthly amount = unit_amount (cents) / 100, normalized
                // to monthly by the recurring interval, then discounted.
                let item = sub
                    .get("items")
                    .and_then(|i| i.get("data"))
                    .and_then(|d| d.as_array())
                    .and_then(|d| d.first());
                let price = item.and_then(|i| i.get("price"));
                let unit_amount = price
                    .and_then(|p| p.get("unit_amount"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let interval = price
                    .and_then(|p| p.get("recurring"))
                    .and_then(|r| r.get("interval"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("month");
                let interval_count = price
                    .and_then(|p| p.get("recurring"))
                    .and_then(|r| r.get("interval_count"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(1)
                    .max(1) as f64;

                let monthly_gross = match interval {
                    "year" => (unit_amount as f64 / 100.0) / 12.0 * interval_count,
                    "week" => (unit_amount as f64 / 100.0) * (52.0 / 12.0) * interval_count,
                    "day" => (unit_amount as f64 / 100.0) * (365.0 / 12.0) * interval_count,
                    _ => (unit_amount as f64 / 100.0) * interval_count, // month + anything else
                };

                // Apply discount if present.
                let mut effective = monthly_gross;
                if let Some(coupon) = sub
                    .get("discount")
                    .and_then(|d| d.get("coupon"))
                {
                    if let Some(pct) = coupon.get("percent_off").and_then(|v| v.as_f64()) {
                        effective = effective * (1.0 - pct / 100.0);
                    } else if let Some(amt_off) = coupon
                        .get("amount_off")
                        .and_then(|v| v.as_i64())
                    {
                        // amount_off is a one-time discount in cents; for MRR
                        // we treat a `forever` duration as reducing every
                        // billing cycle, otherwise ignore (one-shot).
                        let duration = coupon
                            .get("duration")
                            .and_then(|v| v.as_str())
                            .unwrap_or("once");
                        if duration == "forever" {
                            effective = (effective - amt_off as f64 / 100.0).max(0.0);
                        }
                    }
                }

                mrr += effective;
                paid += 1;
            }
        }

        has_more = body.get("has_more").and_then(|v| v.as_bool()).unwrap_or(false);
        if has_more {
            // The last sub's id is the cursor for the next page.
            starting_after = body
                .get("data")
                .and_then(|d| d.as_array())
                .and_then(|a| a.last())
                .and_then(|s| s.get("id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if starting_after.is_none() {
                break;
            }
        }
    }

    ((mrr * 100.0).round() / 100.0, paid)
}

async fn admin_metrics_revenue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AdminDaysQuery>,
) -> Result<Json<AdminRevenueOverview>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;
    let days = q.days.clamp(1, 365);

    let total_users: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM app_users")
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);
    let (current_mrr, paid_users) = compute_current_mrr(&state).await;
    let arpu = if total_users > 0 { current_mrr / total_users as f64 } else { 0.0 };

    // New subs + cancellations within the window, from lifecycle columns.
    let new_subs_in_window: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)::bigint FROM app_users WHERE subscription_started_at IS NOT NULL AND subscription_started_at > NOW() - ($1 || ' days')::INTERVAL"#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let churned_in_window: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)::bigint FROM app_users WHERE subscription_ended_at IS NOT NULL AND subscription_ended_at > NOW() - ($1 || ' days')::INTERVAL"#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    // Estimated provider cost across the window.
    let est_cost_usd: f64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(estimated_cost_usd), 0)::float8 FROM gateway_requests WHERE created_at > NOW() - ($1 || ' days')::INTERVAL"#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0.0);
    let gross_margin_pct = if current_mrr > 0.0 {
        ((current_mrr - est_cost_usd) / current_mrr * 100.0).max(-100.0)
    } else {
        0.0
    };

    // Daily series: MRR estimate is point-in-time per day (approximation — we
    // don't have historical MRR snapshots, so we approximate MRR on day D as
    // sum of prices for users whose subscription_started_at <= D and (no
    // subscription_ended_at OR subscription_ended_at > D)). Cost + churn +
    // new-subs are exact daily counts.
    let daily_rows = sqlx::query(
        r#"
        WITH days AS (
          SELECT generate_series(
            DATE(NOW() - ($1 || ' days')::INTERVAL),
            DATE(NOW()),
            '1 day'
          ) AS d
        ),
        cost AS (
          SELECT DATE(created_at) AS d,
                 COALESCE(SUM(estimated_cost_usd), 0)::float8 AS cost
          FROM gateway_requests
          WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
          GROUP BY DATE(created_at)
        ),
        new_subs AS (
          SELECT DATE(subscription_started_at) AS d, COUNT(*)::bigint AS n
          FROM app_users
          WHERE subscription_started_at IS NOT NULL
            AND subscription_started_at > NOW() - ($1 || ' days')::INTERVAL
          GROUP BY DATE(subscription_started_at)
        ),
        cancels AS (
          SELECT DATE(subscription_ended_at) AS d, COUNT(*)::bigint AS n
          FROM app_users
          WHERE subscription_ended_at IS NOT NULL
            AND subscription_ended_at > NOW() - ($1 || ' days')::INTERVAL
          GROUP BY DATE(subscription_ended_at)
        )
        SELECT
          d.d::date AS date,
          COALESCE(cost.cost, 0)::float8 AS cost,
          COALESCE(new_subs.n, 0)::bigint AS new_subs,
          COALESCE(cancels.n, 0)::bigint AS cancels
        FROM days d
        LEFT JOIN cost ON cost.d = d.d
        LEFT JOIN new_subs ON new_subs.d = d.d
        LEFT JOIN cancels ON cancels.d = d.d
        ORDER BY d.d
        "#,
    )
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut daily: Vec<AdminRevenueDayPoint> = Vec::new();
    for row in daily_rows {
        let date: NaiveDate = row.get("date");
        let cost: f64 = row.get("cost");
        let new_subs: i64 = row.get("new_subs");
        let cancels: i64 = row.get("cancels");
        // Approximate day-D MRR using current MRR (best-effort since we lack
        // historical snapshots); the cost/margin trend is what's most useful.
        let margin = current_mrr - cost;
        daily.push(AdminRevenueDayPoint {
            date: date.to_string(),
            mrr: current_mrr,
            new_subs,
            cancellations: cancels,
            est_cost_usd: (cost * 100.0).round() / 100.0,
            margin: (margin * 100.0).round() / 100.0,
        });
    }

    // Tier split (current snapshot).
    let tier_rows = sqlx::query(
        r#"
        SELECT tier,
               COUNT(*)::bigint AS users,
               COUNT(*) FILTER (WHERE subscription_status = 'active' AND subscription_id IS NOT NULL) AS active
        FROM app_users
        GROUP BY tier
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let tier_split: Vec<AdminTierSplit> = tier_rows
        .into_iter()
        .map(|row| {
            let tier: String = row.get("tier");
            let users: i64 = row.get("users");
            let active: i64 = row.get("active");
            // approximate tier MRR contribution: active count * tier price
            let tier_mrr = match tier.as_str() {
                "pro" => active as f64 * tier_monthly_price("pro", ""),
                "max" => active as f64 * tier_monthly_price("max", ""),
                _ => 0.0,
            };
            AdminTierSplit { tier, users, mrr: tier_mrr }
        })
        .collect();

    Ok(Json(AdminRevenueOverview {
        window_days: days,
        current_mrr,
        arpu,
        paid_users,
        churned_in_window,
        new_subs_in_window,
        est_cost_usd: (est_cost_usd * 100.0).round() / 100.0,
        gross_margin_pct,
        daily,
        tier_split,
    }))
}

// ── Admin: engagement metrics ─────────────────────────────────────────────

#[derive(Serialize)]
struct AdminEngagementDayPoint {
    date: String,
    dau: i64,
    new_users: i64,
    returning: i64,
    requests: i64,
    tokens: i64,
}

#[derive(Serialize)]
struct AdminEngagementOverview {
    window_days: i64,
    dau_today: i64,
    wau: i64,
    mau: i64,
    stickiness_pct: f64,
    new_users_in_window: i64,
    daily: Vec<AdminEngagementDayPoint>,
    top_active_users: Vec<AdminUserRow>,
}

async fn admin_metrics_engagement(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AdminDaysQuery>,
) -> Result<Json<AdminEngagementOverview>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;
    let days = q.days.clamp(1, 90);

    let dau_today: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT user_id)::bigint FROM gateway_requests WHERE created_at > NOW() - INTERVAL '1 day'"#,
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let wau: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT user_id)::bigint FROM gateway_requests WHERE created_at > NOW() - INTERVAL '7 days'"#,
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let mau: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT user_id)::bigint FROM gateway_requests WHERE created_at > NOW() - INTERVAL '30 days'"#,
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let stickiness_pct = if mau > 0 { (dau_today as f64 / mau as f64) * 100.0 } else { 0.0 };
    let new_users_in_window: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)::bigint FROM app_users WHERE created_at > NOW() - ($1 || ' days')::INTERVAL"#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    // Daily DAU + new users (signed up that day) + returning = dau - new.
    let daily_rows = sqlx::query(
        r#"
        WITH dau AS (
          SELECT DATE(created_at) AS d,
                 COUNT(DISTINCT user_id)::bigint AS dau,
                 COUNT(*)::bigint AS requests,
                 COALESCE(SUM(total_tokens), 0)::bigint AS tokens
          FROM gateway_requests
          WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
          GROUP BY DATE(created_at)
        ),
        newu AS (
          SELECT DATE(created_at) AS d, COUNT(*)::bigint AS n
          FROM app_users
          WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
          GROUP BY DATE(created_at)
        )
        SELECT d.d::date AS date,
               COALESCE(dau.dau, 0)::bigint AS dau,
               COALESCE(dau.requests, 0)::bigint AS requests,
               COALESCE(dau.tokens, 0)::bigint AS tokens,
               COALESCE(newu.n, 0)::bigint AS new_users
        FROM generate_series(
          DATE(NOW() - ($1 || ' days')::INTERVAL),
          DATE(NOW()),
          '1 day'
        ) AS d(d)
        LEFT JOIN dau ON dau.d = d.d
        LEFT JOIN newu ON newu.d = d.d
        ORDER BY d.d
        "#,
    )
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let daily: Vec<AdminEngagementDayPoint> = daily_rows
        .into_iter()
        .map(|row| {
            let date: NaiveDate = row.get("date");
            let dau: i64 = row.get("dau");
            let new_users: i64 = row.get("new_users");
            AdminEngagementDayPoint {
                date: date.to_string(),
                dau,
                new_users,
                returning: (dau - new_users).max(0),
                requests: row.get("requests"),
                tokens: row.get("tokens"),
            }
        })
        .collect();

    // Top active users in window — reuse the same row shape as list_users.
    let top_rows = sqlx::query(
        r#"
        SELECT
            u.user_id, u.email, u.name, u.tier, u.created_at,
            MAX(g.created_at) AS last_activity,
            COUNT(g.id)::bigint AS total_requests,
            COALESCE(SUM(g.prompt_tokens), 0)::bigint AS total_prompt_tokens,
            COALESCE(SUM(g.completion_tokens), 0)::bigint AS total_completion_tokens,
            u.stripe_customer_id, u.subscription_status
        FROM app_users u
        JOIN gateway_requests g ON u.user_id = g.user_id
        WHERE g.created_at > NOW() - ($1 || ' days')::INTERVAL
        GROUP BY u.user_id, u.email, u.name, u.tier, u.created_at, u.stripe_customer_id, u.subscription_status
        ORDER BY total_requests DESC
        LIMIT 10
        "#,
    )
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let top_active_users: Vec<AdminUserRow> = top_rows
        .into_iter()
        .map(|row| {
            let prompt: i64 = row.get("total_prompt_tokens");
            let completion: i64 = row.get("total_completion_tokens");
            let tier: String = row.get("tier");
            let (input_rate, output_rate) = if tier == "max" || tier == "pro" {
                (0.435, 0.87)
            } else {
                (0.14, 0.28)
            };
            let cost = (prompt as f64 / 1_000_000.0) * input_rate
                + (completion as f64 / 1_000_000.0) * output_rate;
            AdminUserRow {
                user_id: row.get("user_id"),
                email: row.get("email"),
                name: row.get("name"),
                tier,
                created_at: row.get("created_at"),
                last_activity: row.get("last_activity"),
                total_requests: row.get("total_requests"),
                total_prompt_tokens: prompt,
                total_completion_tokens: completion,
                estimated_cost_usd: (cost * 100.0).round() / 100.0,
                stripe_customer_id: row.get("stripe_customer_id"),
                subscription_status: row.get("subscription_status"),
            }
        })
        .collect();

    Ok(Json(AdminEngagementOverview {
        window_days: days,
        dau_today,
        wau,
        mau,
        stickiness_pct,
        new_users_in_window,
        daily,
        top_active_users,
    }))
}

// ── Admin: live activity ──────────────────────────────────────────────────

#[derive(Serialize)]
struct AdminRecentRequest {
    id: String,
    user_email: Option<String>,
    user_name: Option<String>,
    provider_name: Option<String>,
    model_id: Option<String>,
    upstream_status: Option<i32>,
    total_duration_ms: Option<i64>,
    total_tokens: Option<i64>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct AdminLiveOverview {
    active_users_5m: i64,
    requests_5m: i64,
    tokens_5m: i64,
    requests_per_min: f64,
    recent: Vec<AdminRecentRequest>,
}

async fn admin_metrics_live(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminLiveOverview>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;

    let active_users_5m: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT user_id)::bigint FROM gateway_requests WHERE created_at > NOW() - INTERVAL '5 minutes'"#,
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let stats: (i64, i64) = sqlx::query_as(
        r#"SELECT COUNT(*)::bigint, COALESCE(SUM(total_tokens), 0)::bigint FROM gateway_requests WHERE created_at > NOW() - INTERVAL '5 minutes'"#,
    )
    .fetch_one(&state.db)
    .await
    .map(|(c, t): (i64, i64)| (c, t))
    .unwrap_or((0, 0));
    let requests_5m = stats.0;
    let tokens_5m = stats.1;
    let requests_per_min = requests_5m as f64 / 5.0;

    let recent_rows = sqlx::query(
        r#"
        SELECT g.id, u.email, u.name, g.provider_name, g.model_id,
               g.upstream_status, g.total_duration_ms, g.total_tokens, g.created_at
        FROM gateway_requests g
        LEFT JOIN app_users u ON u.user_id = g.user_id
        ORDER BY g.created_at DESC
        LIMIT 50
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let recent: Vec<AdminRecentRequest> = recent_rows
        .into_iter()
        .map(|row| AdminRecentRequest {
            id: row.get::<uuid::Uuid, _>("id").to_string(),
            user_email: row.get("email"),
            user_name: row.get("name"),
            provider_name: row.get("provider_name"),
            model_id: row.get("model_id"),
            upstream_status: row.get("upstream_status"),
            total_duration_ms: row.get("total_duration_ms"),
            total_tokens: row.get("total_tokens"),
            created_at: row.get("created_at"),
        })
        .collect();

    Ok(Json(AdminLiveOverview {
        active_users_5m,
        requests_5m,
        tokens_5m,
        requests_per_min,
        recent,
    }))
}

#[derive(Deserialize)]
struct AdminPasswordRequest {
    password: String,
}

#[derive(Serialize)]
struct AdminPasswordResponse {
    token: String,
    email: String,
    expires_at: DateTime<Utc>,
}

// ── Admin token helpers ───────────────────────────────────────────────────
//
// Tokens are HMAC-SHA256 signed and stateless on the read path, but we persist
// a SHA-256 hash of each issued token in `admin_sessions` so individual sessions
// can be revoked and we can track last_used_at. Token format:
//
//     admin_<base64url(payload_json)>.<base64url(hmac_sig)>
//
// payload = { "email": "...", "iat": <unix_secs>, "exp": <unix_secs>,
//             "sid": "<8-char session id>" }

const ADMIN_TOKEN_PREFIX: &str = "admin_";

/// Base64url encode without padding (URL-safe, no '=' chars).
fn b64url_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Base64url decode, tolerant of missing padding.
fn b64url_decode(input: &str) -> Result<Vec<u8>, StatusCode> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|_| StatusCode::UNAUTHORIZED)
}

/// Resolve the HMAC signing key. Falls back to deriving from ADMIN_PASSWORD if
// ADMIN_TOKEN_SECRET is unset so dev keeps working — logged as a warning.
fn admin_signing_key(state: &AppState) -> Vec<u8> {
    if !state.admin_token_secret.is_empty() {
        return state.admin_token_secret.as_bytes().to_vec();
    }
    warn!("ADMIN_TOKEN_SECRET is unset; deriving signing key from ADMIN_PASSWORD. Set ADMIN_TOKEN_SECRET in production.");
    let pw = std::env::var("ADMIN_PASSWORD").unwrap_or_default();
    let mut key = b"zwork-admin-fallback::".to_vec();
    key.extend_from_slice(pw.as_bytes());
    key
}

/// SHA-256 of a token, hex-encoded — what we persist as the session PK.
fn hash_token(token: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Mint a signed admin token for `email` and persist its hash. Returns the
/// raw token to hand back to the caller, plus the expiry.
async fn mint_admin_token(
    state: &AppState,
    email: &str,
) -> Result<(String, DateTime<Utc>), StatusCode> {
    let now = Utc::now();
    let expires_at = now + Duration::hours(state.admin_token_ttl_hours);
    let sid = Uuid::new_v4().simple().to_string();
    let sid: String = sid.chars().take(12).collect();

    let payload = serde_json::json!({
        "email": email,
        "iat": now.timestamp(),
        "exp": expires_at.timestamp(),
        "sid": sid,
    });
    let payload_bytes = serde_json::to_vec(&payload).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let payload_b64 = b64url_encode(&payload_bytes);

    let mut mac = Hmac::<Sha256>::new_from_slice(&admin_signing_key(state))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    mac.update(payload_b64.as_bytes());
    let sig = b64url_encode(&mac.finalize().into_bytes());

    let token = format!("{ADMIN_TOKEN_PREFIX}{payload_b64}.{sig}");

    // Persist the hash so we can revoke + track usage.
    let token_hash = hash_token(&token);
    sqlx::query(
        r#"
        INSERT INTO admin_sessions (token_hash, email, expires_at)
        VALUES ($1, $2, $3)
        "#,
    )
    .bind(&token_hash)
    .bind(email)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok((token, expires_at))
}

/// Verify a raw admin token: correct signature, not expired, and present +
/// non-revoked in `admin_sessions`. Returns the actor email. Bumps
/// last_used_at on success.
///
/// Returns `Ok(None)` if `raw` is not an admin-shaped token (caller should try
/// the next auth path) and `Err(UNAUTHORIZED)` if it is admin-shaped but bad.
async fn verify_admin_token(
    state: &AppState,
    raw: &str,
) -> Result<Option<String>, StatusCode> {
    let body = match raw.strip_prefix(ADMIN_TOKEN_PREFIX) {
        Some(rest) => rest,
        None => return Ok(None),
    };

    let (payload_b64, sig_b64) = match body.rsplit_once('.') {
        Some((p, s)) => (p, s),
        None => return Err(StatusCode::UNAUTHORIZED),
    };

    // Recompute + compare signature in constant time.
    let mut mac = Hmac::<Sha256>::new_from_slice(&admin_signing_key(state))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    mac.update(payload_b64.as_bytes());
    mac.verify_slice(&b64url_decode(sig_b64)?)
        .map_err(|_| StatusCode::UNAUTHORIZED)?;

    let payload_bytes = b64url_decode(payload_b64)?;
    let payload: serde_json::Value =
        serde_json::from_slice(&payload_bytes).map_err(|_| StatusCode::UNAUTHORIZED)?;

    let exp = payload
        .get("exp")
        .and_then(|v| v.as_i64())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if Utc::now().timestamp() >= exp {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let email = payload
        .get("email")
        .and_then(|v| v.as_str())
        .ok_or(StatusCode::UNAUTHORIZED)?
        .to_string();

    // Session must exist + not be revoked.
    let token_hash = hash_token(&format!("{ADMIN_TOKEN_PREFIX}{body}"));
    let row = sqlx::query(
        r#"SELECT revoked_at FROM admin_sessions WHERE token_hash = $1"#,
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    match row {
        Some(row) => {
            let revoked_at: Option<DateTime<Utc>> = row.get("revoked_at");
            if revoked_at.is_some() {
                return Err(StatusCode::UNAUTHORIZED);
            }
            let _ = sqlx::query(
                r#"UPDATE admin_sessions SET last_used_at = NOW() WHERE token_hash = $1"#,
            )
            .bind(&token_hash)
            .execute(&state.db)
            .await;
            Ok(Some(email))
        }
        None => Err(StatusCode::UNAUTHORIZED),
    }
}

/// Append a row to the admin audit log. Best-effort: never fails the caller.
async fn audit_admin_action(
    state: &AppState,
    actor_email: Option<&str>,
    action: &str,
    target_user_id: Option<&str>,
    metadata: Option<serde_json::Value>,
) {
    let _ = sqlx::query(
        r#"
        INSERT INTO admin_audit_log (actor_email, action, target_user_id, metadata)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(actor_email)
    .bind(action)
    .bind(target_user_id)
    .bind(metadata)
    .execute(&state.db)
    .await;
}

async fn admin_verify_password(
    State(state): State<AppState>,
    Json(body): Json<AdminPasswordRequest>,
) -> Result<Json<AdminPasswordResponse>, StatusCode> {
    // Fail closed: never fall back to a compiled-in default password. If the
    // operator hasn't configured a sufficiently strong ADMIN_PASSWORD, admin
    // login is disabled entirely rather than accepting a guessable default.
    let admin_password = match std::env::var("ADMIN_PASSWORD") {
        Ok(pw) if pw.len() >= 16 => pw,
        _ => {
            warn!("ADMIN_PASSWORD is unset or shorter than 16 chars; admin login is disabled.");
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
    };

    // Constant-time comparison: compare byte-by-byte without short-circuit.
    let submitted = body.password.as_bytes();
    let expected = admin_password.as_bytes();
    if submitted.len() != expected.len()
        || submitted
            .iter()
            .zip(expected.iter())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            != 0
    {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let email = state
        .owner_emails
        .first()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
        .clone();

    let (token, expires_at) = mint_admin_token(&state, &email).await?;
    audit_admin_action(
        &state,
        Some(&email),
        "admin_login",
        None,
        None,
    )
    .await;

    Ok(Json(AdminPasswordResponse {
        token,
        email,
        expires_at,
    }))
}

async fn admin_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    let raw = match read_bearer_token(&headers) {
        Some(t) => t,
        None => return Err(StatusCode::UNAUTHORIZED),
    };
    let email = verify_admin_token(&state, &raw)
        .await?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let token_hash = hash_token(&raw);
    let _ = sqlx::query(
        r#"UPDATE admin_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL"#,
    )
    .bind(&token_hash)
    .execute(&state.db)
    .await;
    audit_admin_action(&state, Some(&email), "admin_logout", None, None).await;
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
struct AdminAuditQuery {
    #[serde(default = "default_audit_limit")]
    limit: i64,
}

fn default_audit_limit() -> i64 {
    200
}

#[derive(Serialize)]
struct AdminAuditRow {
    id: Uuid,
    actor_email: Option<String>,
    action: String,
    target_user_id: Option<String>,
    metadata: Option<Value>,
    created_at: DateTime<Utc>,
}

async fn admin_audit_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AdminAuditQuery>,
) -> Result<Json<Vec<AdminAuditRow>>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;
    let limit = q.limit.clamp(1, 1000);

    let rows = sqlx::query(
        r#"
        SELECT id, actor_email, action, target_user_id, metadata, created_at
        FROM admin_audit_log
        ORDER BY created_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let out: Vec<AdminAuditRow> = rows
        .into_iter()
        .map(|row| AdminAuditRow {
            id: row.get("id"),
            actor_email: row.get("actor_email"),
            action: row.get("action"),
            target_user_id: row.get("target_user_id"),
            metadata: row.get("metadata"),
            created_at: row.get("created_at"),
        })
        .collect();

    Ok(Json(out))
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

    let mut sign_in_url = format!(
        "https://api.tryzwork.app/api/auth/desktop/google?port={}",
        query.port,
    );
    // Round-trip the client's nonce so the localhost callback can be bound to
    // this sign-in attempt (verified by the Tauri host).
    if let Some(nonce) = valid_desktop_nonce(query.nonce.as_deref()) {
        sign_in_url.push_str("&nonce=");
        sign_in_url.push_str(&urlencoding::encode(nonce));
    }

    Ok(Redirect::temporary(&sign_in_url))
}

/// A desktop-auth nonce is only safe to embed in redirect URLs (and inside
/// the OAuth state composite) if it stays alphanumeric/dash/underscore — the
/// Tauri host generates UUIDs.
fn valid_desktop_nonce(nonce: Option<&str>) -> Option<&str> {
    nonce.filter(|n| {
        !n.is_empty()
            && n.len() <= 128
            && n.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

fn localhost_auth_redirect(port: u16, key: &str, value: &str, nonce: Option<&str>) -> Redirect {
    let mut redirect = format!(
        "http://127.0.0.1:{}/callback?{}={}",
        port,
        key,
        urlencoding::encode(value)
    );
    if let Some(nonce) = nonce {
        redirect.push_str("&nonce=");
        redirect.push_str(&urlencoding::encode(nonce));
    }
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
    // Round-trip the desktop client's nonce inside the OAuth state so the
    // callback can hand it back to the localhost listener. The nonce contains
    // no dots (see valid_desktop_nonce), so the composite splits cleanly.
    let state_value = match valid_desktop_nonce(query.nonce.as_deref()) {
        Some(nonce) => format!("{state_value}.{nonce}"),
        None => state_value,
    };
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

/// Forward a Google OAuth callback to Better Auth for the web sign-in flow.
///
/// The Google OAuth app has a single redirect URI routed to Axum. When the
/// callback's `state` isn't one we issued for the desktop flow, it's a web
/// (Better Auth) flow — so we act as a dispatcher: replay the request to
/// `better_auth:3000/api/auth/callback/google`, forwarding the browser's Cookie
/// header (which carries Better Auth's PKCE state cookie), then relay Better
/// Auth's response verbatim (status, all headers incl. `Set-Cookie` + the 302
/// `Location`, and body) back to the browser.
async fn forward_callback_to_better_auth(
    state: &AppState,
    headers: &HeaderMap,
    query: &GoogleCallbackQuery,
) -> Result<Response, StatusCode> {
    let mut forward_url = state
        .auth_internal_base
        .join("callback/google")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    {
        let mut q = forward_url.query_pairs_mut();
        if let Some(code) = query.code.as_deref() {
            q.append_pair("code", code);
        }
        if let Some(state_value) = query.state.as_deref() {
            q.append_pair("state", state_value);
        }
        if let Some(error) = query.error.as_deref() {
            q.append_pair("error", error);
        }
        if let Some(error_description) = query.error_description.as_deref() {
            q.append_pair("error_description", error_description);
        }
    }

    let mut req = state.http_client.get(forward_url.as_str());
    // The state cookie is what lets Better Auth correlate this callback with
    // the sign-in request it minted — it MUST travel with the forward.
    let cookie_present = headers.get(header::COOKIE).is_some();
    let cookie_preview = headers
        .get(header::COOKIE)
        .and_then(|c| c.to_str().ok())
        .map(|s| {
            // Log only cookie names, not values (values may be sensitive).
            s.split(';')
                .filter_map(|kv| kv.trim().split('=').next())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    tracing::info!(
        "demo-auth-debug: callback forward state={} cookie_present={} cookie_names=[{}] all_headers=[{}]",
        query.state.as_deref().unwrap_or(""),
        cookie_present,
        cookie_preview,
        headers.keys().map(|k| k.as_str()).collect::<Vec<_>>().join(",")
    );
    if let Some(cookie) = headers.get(header::COOKIE) {
        req = req.header(header::COOKIE, cookie.clone());
    }
    if let Some(ua) = headers.get(header::USER_AGENT) {
        req = req.header(header::USER_AGENT, ua.clone());
    }

    let upstream = req
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("better_auth callback forward failed: {e}");
            StatusCode::BAD_GATEWAY
        })?;

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let body = axum::body::Body::from_stream(upstream.bytes_stream());
    let mut response = Response::new(body);
    *response.status_mut() = status;
    // Relay every hop-by-hop-safe header — critically Set-Cookie and Location.
    for (name, value) in upstream_headers.iter() {
        // Skip headers that the HTTP transport owns; copying them confuses clients.
        if matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "content-encoding"
        ) {
            continue;
        }
        response.headers_mut().append(name.clone(), value.clone());
    }
    Ok(response)
}

async fn desktop_google_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<GoogleCallbackQuery>,
) -> Result<Response, StatusCode> {
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
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Desktop flow: state matched a row we issued → run the desktop token
    // exchange + localhost:{port} redirect (unchanged path below).
    let Some(oauth_state) = oauth_state else {
        // Web flow: this state was minted by Better Auth, not us. Google Console
        // has a single redirect URI routed to Axum, so we act as a dispatcher —
        // forward the original request (query + Cookie header carrying Better
        // Auth's PKCE state cookie) to better_auth:3000 and relay its response
        // verbatim. Better Auth validates the state cookie, exchanges the code,
        // sets its session cookie, and 302s to the caller's callbackURL.
        return forward_callback_to_better_auth(&state, &headers, &query).await;
    };

    let port = u16::try_from(oauth_state.port).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // The client nonce rode inside the OAuth state (see
    // desktop_google_auth_start); echo it back on the localhost redirect so
    // the Tauri host can bind this callback to its sign-in attempt.
    let nonce = state_value.split_once('.').map(|(_, n)| n);

    if let Some(error) = query.error.as_deref() {
        let detail = query
            .error_description
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(error);
        return Ok(localhost_auth_redirect(port, "error", detail, nonce).into_response());
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
            nonce,
        )
        .into_response());
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
            nonce,
        )
        .into_response());
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

    Ok(localhost_auth_redirect(port, "code", &desktop_code, nonce).into_response())
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
          AND created_at >= NOW() - INTERVAL '30 minutes'
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
        SELECT COALESCE(SUM(
            CASE WHEN model_id IN ('deepseek-v4-pro', 'zwork-pro') THEN 3 ELSE 1 END
        ), 0)
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
        SELECT COALESCE(SUM(
            CASE WHEN model_id IN ('deepseek-v4-pro', 'zwork-pro') THEN 3 ELSE 1 END
        ), 0)
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
        admin_token_secret: std::env::var("ADMIN_TOKEN_SECRET").unwrap_or_default(),
        admin_token_ttl_hours: std::env::var("ADMIN_TOKEN_TTL_HOURS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(12),
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
            HeaderName::from_static("x-zwork-chat-id"),
            HeaderName::from_static("x-zwork-project-id"),
            HeaderName::from_static("x-zwork-app-version"),
            HeaderName::from_static("x-zwork-os"),
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
        // Admin password verification is credential-handling and must be
        // throttled to stop brute-force against ADMIN_PASSWORD.
        .route("/api/admin/verify-password", post(admin_verify_password))
        .layer(GovernorLayer {
            config: auth_governor_conf,
        });

    let app = Router::new()
        .route("/health", get(health_check))
        // The web app (app.tryzwork.app) polls /api/health for backend
        // readiness. Caddy routes /api/* here, so expose health at that path
        // too — otherwise the web client sees a 404 and logs noise.
        .route("/api/health", get(health_check))
        .route("/api/session", get(session_me))
        .route("/api/telemetry/event", post(ingest_telemetry))
        .route("/api/chat/stream", post(ai_proxy))
        .route("/api/chat/completions", post(ai_proxy))
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
        // (/api/admin/verify-password is defined in auth_routes so it is
        // covered by the per-IP rate limiter.)
        .route("/api/admin/logout", post(admin_logout))
        .route("/api/admin/metrics/overview", get(admin_metrics_overview))
        .route("/api/admin/metrics/health", get(admin_metrics_health))
        .route("/api/admin/metrics/providers", get(admin_metrics_providers))
        .route("/api/admin/metrics/revenue", get(admin_metrics_revenue))
        .route("/api/admin/metrics/engagement", get(admin_metrics_engagement))
        .route("/api/admin/metrics/live", get(admin_metrics_live))
        .route("/api/admin/users", get(admin_list_users))
        .route("/api/admin/usage/by-time", get(admin_usage_by_time))
        .route("/api/admin/usage/by-model", get(admin_usage_by_model))
        .route(
            "/api/admin/users/:user_id/tier",
            put(admin_update_user_tier),
        )
        .route("/api/admin/audit", get(admin_audit_list))
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
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(tower_http::trace::DefaultMakeSpan::new().level(tracing::Level::INFO))
                .on_response(tower_http::trace::DefaultOnResponse::new().level(tracing::Level::INFO)),
        )
        .with_state(state);

    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    info!("Server running on 0.0.0.0:8080");
    axum::serve(listener, app).await.unwrap();
}
