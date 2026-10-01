//! Admin dashboard endpoints for money, growth and infrastructure:
//!
//! - `GET /api/admin/metrics/finance?days=N`: what upstream inference costs us,
//!   split by the requesting user's tier, against what those users pay.
//! - `GET /api/admin/metrics/downloads`: GitHub release downloads (installers,
//!   update bundles, update checks), daily deltas from our own snapshots, and
//!   the app versions / OSes seen by the gateway.
//! - `GET /api/admin/metrics/funnel?days=N`: signup → first request → paid,
//!   plus weekly retention cohorts.
//! - `GET /api/admin/metrics/status`: every public surface probed from the
//!   server, the database, and which integrations are configured.
//!
//! Costs are `gateway_requests.estimated_cost_usd`, filled by `estimate_cost`
//! at request time. A model missing from that price table stores NULL, so the
//! finance payload reports how much traffic is unpriced instead of hiding it.

use super::{compute_current_mrr, ensure_owner_or_service, tier_monthly_price, AdminDaysQuery, AppState};
use axum::{
    extract::{Json, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Process start, for the status page's uptime.
pub static STARTED_AT: OnceLock<DateTime<Utc>> = OnceLock::new();

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// A user pays when they hold a live Stripe subscription. Coupon/dev tiers
/// (tier set, no subscription) are paid-tier users who pay nothing.
const PAYING_SQL: &str =
    "(u.subscription_id IS NOT NULL AND u.subscription_status IN ('active', 'trialing', 'past_due'))";

// ── Finance ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct FinanceTierRow {
    tier: String,
    users: i64,
    paying_users: i64,
    active_users: i64,
    requests: i64,
    tokens: i64,
    cost_usd: f64,
    /// List-price revenue of this tier's paying users, prorated to the window.
    revenue_usd: f64,
    margin_usd: f64,
    cost_per_active_user: f64,
}

#[derive(Serialize)]
pub struct FinanceDay {
    date: String,
    free: f64,
    pro: f64,
    max: f64,
    total: f64,
}

#[derive(Serialize)]
pub struct FinanceModelRow {
    provider: String,
    model: String,
    requests: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    cost_usd: f64,
    unpriced_requests: i64,
}

#[derive(Serialize, Clone)]
pub struct FinanceSpender {
    user_id: String,
    email: String,
    name: String,
    tier: String,
    paying: bool,
    requests: i64,
    tokens: i64,
    cost_usd: f64,
    /// Window cost scaled to 30 days, comparable with `monthly_price_usd`.
    cost_30d_usd: f64,
    monthly_price_usd: f64,
    margin_30d_usd: f64,
}

#[derive(Serialize)]
pub struct FinanceOverview {
    window_days: i64,
    spend_usd: f64,
    prev_spend_usd: f64,
    /// Stripe MRR prorated to the window (discounts applied).
    revenue_usd: f64,
    margin_usd: f64,
    margin_pct: f64,
    mrr: f64,
    paid_users: i64,
    mtd_spend_usd: f64,
    projected_month_spend_usd: f64,
    last_month_spend_usd: f64,
    /// MRR minus the projected spend for this calendar month.
    projected_month_margin_usd: f64,
    free_spend_usd: f64,
    paid_spend_usd: f64,
    cost_per_request_usd: f64,
    cost_per_1k_tokens_usd: f64,
    requests: i64,
    unpriced_requests: i64,
    unpriced_tokens: i64,
    priced_coverage_pct: f64,
    unprofitable_users: i64,
    by_tier: Vec<FinanceTierRow>,
    daily: Vec<FinanceDay>,
    by_model: Vec<FinanceModelRow>,
    top_spenders: Vec<FinanceSpender>,
    unprofitable: Vec<FinanceSpender>,
}

async fn spend_between(state: &AppState, from_sql: &str, to_sql: &str) -> f64 {
    let sql = format!(
        "SELECT COALESCE(SUM(estimated_cost_usd), 0)::float8 FROM gateway_requests \
         WHERE created_at >= {from_sql} AND created_at < {to_sql}"
    );
    sqlx::query_scalar(&sql).fetch_one(&state.db).await.unwrap_or(0.0)
}

pub async fn admin_metrics_finance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AdminDaysQuery>,
) -> Result<Json<FinanceOverview>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;
    let days = q.days.clamp(1, 365);
    let db_err = |e: sqlx::Error| {
        tracing::warn!("finance query failed: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    };

    let (mrr, paid_users) = compute_current_mrr(&state).await;

    // Window totals, priced vs unpriced. Failed requests (no usage) aren't
    // "unpriced"; only rows that returned tokens but have no cost are.
    let totals = sqlx::query(
        r#"
        SELECT
          COUNT(*)::bigint AS requests,
          COALESCE(SUM(estimated_cost_usd), 0)::float8 AS cost,
          COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
          COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL AND COALESCE(total_tokens, 0) > 0)::bigint AS unpriced,
          COALESCE(SUM(total_tokens) FILTER (WHERE estimated_cost_usd IS NULL), 0)::bigint AS unpriced_tokens,
          COUNT(*) FILTER (WHERE COALESCE(total_tokens, 0) > 0)::bigint AS with_usage
        FROM gateway_requests
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
        "#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .map_err(db_err)?;
    let requests: i64 = totals.get("requests");
    let spend: f64 = totals.get("cost");
    let tokens: i64 = totals.get("tokens");
    let unpriced_requests: i64 = totals.get("unpriced");
    let unpriced_tokens: i64 = totals.get("unpriced_tokens");
    let with_usage: i64 = totals.get("with_usage");
    let priced_coverage_pct = if with_usage > 0 {
        (with_usage - unpriced_requests) as f64 / with_usage as f64 * 100.0
    } else {
        100.0
    };

    let prev_spend: f64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(estimated_cost_usd), 0)::float8 FROM gateway_requests
           WHERE created_at > NOW() - ($1 * 2 || ' days')::INTERVAL
             AND created_at <= NOW() - ($1 || ' days')::INTERVAL"#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0.0);

    // Calendar month: spent so far, a straight-line projection, last month.
    let mtd = spend_between(&state, "date_trunc('month', NOW())", "NOW()").await;
    let last_month = spend_between(
        &state,
        "date_trunc('month', NOW()) - INTERVAL '1 month'",
        "date_trunc('month', NOW())",
    )
    .await;
    let now = Utc::now();
    let days_in_month = {
        let (y, m) = (now.year(), now.month());
        let next = if m == 12 { NaiveDate::from_ymd_opt(y + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y, m + 1, 1) };
        let first = NaiveDate::from_ymd_opt(y, m, 1);
        match (first, next) {
            (Some(f), Some(n)) => (n - f).num_days() as f64,
            _ => 30.0,
        }
    };
    let elapsed_days = (now.day() as f64 - 1.0)
        + (now.timestamp() % 86_400) as f64 / 86_400.0;
    let projected = if elapsed_days > 0.25 { mtd / elapsed_days * days_in_month } else { mtd };

    // Per tier: users, payers, activity and cost in the window.
    let tier_rows = sqlx::query(&format!(
        r#"
        WITH usage AS (
          SELECT user_id,
                 COUNT(*)::bigint AS requests,
                 COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
                 COALESCE(SUM(estimated_cost_usd), 0)::float8 AS cost
          FROM gateway_requests
          WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
          GROUP BY user_id
        )
        SELECT u.tier,
               COUNT(*)::bigint AS users,
               COUNT(*) FILTER (WHERE {PAYING_SQL})::bigint AS paying,
               COUNT(usage.user_id)::bigint AS active,
               COALESCE(SUM(usage.requests), 0)::bigint AS requests,
               COALESCE(SUM(usage.tokens), 0)::bigint AS tokens,
               COALESCE(SUM(usage.cost), 0)::float8 AS cost,
               ARRAY_REMOVE(ARRAY_AGG(CASE WHEN {PAYING_SQL} THEN COALESCE(u.subscription_price_id, '') END), NULL) AS price_ids
        FROM app_users u
        LEFT JOIN usage ON usage.user_id = u.user_id
        GROUP BY u.tier
        "#
    ))
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;

    let mut by_tier: Vec<FinanceTierRow> = Vec::new();
    for row in tier_rows {
        let tier: String = row.get("tier");
        let price_ids: Vec<String> = row.get("price_ids");
        let monthly: f64 = price_ids.iter().map(|p| tier_monthly_price(&tier, p)).sum();
        let revenue = monthly * days as f64 / 30.0;
        let cost: f64 = row.get("cost");
        let active: i64 = row.get("active");
        by_tier.push(FinanceTierRow {
            users: row.get("users"),
            paying_users: row.get("paying"),
            active_users: active,
            requests: row.get("requests"),
            tokens: row.get("tokens"),
            cost_usd: round4(cost),
            revenue_usd: round2(revenue),
            margin_usd: round2(revenue - cost),
            cost_per_active_user: if active > 0 { round4(cost / active as f64) } else { 0.0 },
            tier,
        });
    }
    let order = |t: &str| match t { "free" => 0, "pro" => 1, "max" => 2, _ => 3 };
    by_tier.sort_by_key(|r| order(&r.tier));

    // Paid spend = cost of users holding a live subscription.
    let paid_spend: f64 = sqlx::query_scalar(&format!(
        r#"SELECT COALESCE(SUM(g.estimated_cost_usd), 0)::float8
           FROM gateway_requests g JOIN app_users u ON u.user_id = g.user_id
           WHERE g.created_at > NOW() - ($1 || ' days')::INTERVAL AND {PAYING_SQL}"#
    ))
    .bind(days)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0.0);

    // Daily spend stacked by the user's current tier.
    let daily_rows = sqlx::query(
        r#"
        WITH days AS (
          SELECT generate_series(DATE(NOW() - ($1 || ' days')::INTERVAL), DATE(NOW()), '1 day')::date AS d
        ),
        cost AS (
          SELECT DATE(g.created_at) AS d,
                 COALESCE(SUM(g.estimated_cost_usd) FILTER (WHERE COALESCE(u.tier, 'free') = 'free'), 0)::float8 AS free,
                 COALESCE(SUM(g.estimated_cost_usd) FILTER (WHERE u.tier = 'pro'), 0)::float8 AS pro,
                 COALESCE(SUM(g.estimated_cost_usd) FILTER (WHERE u.tier = 'max'), 0)::float8 AS max
          FROM gateway_requests g LEFT JOIN app_users u ON u.user_id = g.user_id
          WHERE g.created_at > NOW() - ($1 || ' days')::INTERVAL
          GROUP BY DATE(g.created_at)
        )
        SELECT days.d AS date, COALESCE(free, 0)::float8 AS free, COALESCE(pro, 0)::float8 AS pro, COALESCE(max, 0)::float8 AS max
        FROM days LEFT JOIN cost ON cost.d = days.d
        ORDER BY days.d
        "#,
    )
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;
    let daily = daily_rows
        .into_iter()
        .map(|row| {
            let date: NaiveDate = row.get("date");
            let (free, pro, max): (f64, f64, f64) = (row.get("free"), row.get("pro"), row.get("max"));
            FinanceDay {
                date: date.to_string(),
                free: round4(free),
                pro: round4(pro),
                max: round4(max),
                total: round4(free + pro + max),
            }
        })
        .collect();

    let model_rows = sqlx::query(
        r#"
        SELECT COALESCE(provider_name, 'unknown') AS provider,
               COALESCE(model_id, 'unknown') AS model,
               COUNT(*)::bigint AS requests,
               COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
               COALESCE(SUM(estimated_cost_usd), 0)::float8 AS cost,
               COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL AND COALESCE(total_tokens, 0) > 0)::bigint AS unpriced
        FROM gateway_requests
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
        GROUP BY 1, 2
        ORDER BY cost DESC, requests DESC
        LIMIT 40
        "#,
    )
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;
    let by_model = model_rows
        .into_iter()
        .map(|row| FinanceModelRow {
            provider: row.get("provider"),
            model: row.get("model"),
            requests: row.get("requests"),
            prompt_tokens: row.get("prompt_tokens"),
            completion_tokens: row.get("completion_tokens"),
            cost_usd: round4(row.get("cost")),
            unpriced_requests: row.get("unpriced"),
        })
        .collect();

    // Per-user cost vs price. Pull every user with spend (bounded by active
    // users, which is small), then rank in Rust so the unprofitable list and
    // the top list share one query.
    let user_rows = sqlx::query(&format!(
        r#"
        SELECT u.user_id, u.email, u.name, u.tier,
               {PAYING_SQL} AS paying,
               COALESCE(u.subscription_price_id, '') AS price_id,
               COUNT(*)::bigint AS requests,
               COALESCE(SUM(g.total_tokens), 0)::bigint AS tokens,
               COALESCE(SUM(g.estimated_cost_usd), 0)::float8 AS cost
        FROM gateway_requests g JOIN app_users u ON u.user_id = g.user_id
        WHERE g.created_at > NOW() - ($1 || ' days')::INTERVAL
        GROUP BY u.user_id, u.email, u.name, u.tier, u.subscription_id, u.subscription_status, u.subscription_price_id
        HAVING COALESCE(SUM(g.estimated_cost_usd), 0) > 0
        "#
    ))
    .bind(days)
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;
    let scale = 30.0 / days as f64;
    let mut spenders: Vec<FinanceSpender> = user_rows
        .into_iter()
        .map(|row| {
            let tier: String = row.get("tier");
            let paying: bool = row.get("paying");
            let price_id: String = row.get("price_id");
            let price = if paying { tier_monthly_price(&tier, &price_id) } else { 0.0 };
            let cost: f64 = row.get("cost");
            FinanceSpender {
                user_id: row.get("user_id"),
                email: row.get("email"),
                name: row.get("name"),
                paying,
                requests: row.get("requests"),
                tokens: row.get("tokens"),
                cost_usd: round4(cost),
                cost_30d_usd: round4(cost * scale),
                monthly_price_usd: price,
                margin_30d_usd: round2(price - cost * scale),
                tier,
            }
        })
        .collect();
    spenders.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));
    let mut unprofitable: Vec<FinanceSpender> = spenders
        .iter()
        .filter(|s| s.paying && s.margin_30d_usd < 0.0)
        .cloned()
        .collect();
    let unprofitable_users = unprofitable.len() as i64;
    unprofitable.truncate(25);
    let top_spenders: Vec<FinanceSpender> = spenders.into_iter().take(25).collect();

    let revenue = mrr * days as f64 / 30.0;
    let margin = revenue - spend;
    Ok(Json(FinanceOverview {
        window_days: days,
        spend_usd: round4(spend),
        prev_spend_usd: round4(prev_spend),
        revenue_usd: round2(revenue),
        margin_usd: round2(margin),
        margin_pct: if revenue > 0.0 { (margin / revenue * 100.0).max(-999.0) } else { 0.0 },
        mrr,
        paid_users,
        mtd_spend_usd: round4(mtd),
        projected_month_spend_usd: round2(projected),
        last_month_spend_usd: round4(last_month),
        projected_month_margin_usd: round2(mrr - projected),
        // "Free" is everything not covered by a live subscription, including
        // coupon/dev users on paid tiers.
        free_spend_usd: round4((spend - paid_spend).max(0.0)),
        paid_spend_usd: round4(paid_spend),
        cost_per_request_usd: if requests > 0 { spend / requests as f64 } else { 0.0 },
        cost_per_1k_tokens_usd: if tokens > 0 { spend / tokens as f64 * 1000.0 } else { 0.0 },
        requests,
        unpriced_requests,
        unpriced_tokens,
        priced_coverage_pct,
        unprofitable_users,
        by_tier,
        daily,
        by_model,
        top_spenders,
        unprofitable,
    }))
}

// ── Downloads (GitHub releases) ───────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct DownloadAsset {
    name: String,
    platform: String,
    /// `installer` (first install), `update` (updater bundle) or
    /// `update_check` (latest.json, fetched on every update check).
    kind: String,
    downloads: i64,
}

#[derive(Serialize, Clone)]
pub struct DownloadRelease {
    tag: String,
    name: String,
    published_at: String,
    prerelease: bool,
    installers: i64,
    updates: i64,
    update_checks: i64,
    assets: Vec<DownloadAsset>,
}

#[derive(Serialize, Clone)]
pub struct PlatformCount {
    platform: String,
    downloads: i64,
}

#[derive(Serialize)]
pub struct DownloadDay {
    date: String,
    installers: i64,
    updates: i64,
    update_checks: i64,
}

#[derive(Serialize)]
pub struct VersionRow {
    version: String,
    users: i64,
    requests: i64,
}

#[derive(Serialize)]
pub struct OsRow {
    os: String,
    users: i64,
}

#[derive(Serialize, Clone, Default)]
pub struct GithubSummary {
    repo: String,
    stars: i64,
    forks: i64,
    open_issues: i64,
    watchers: i64,
    total_installers: i64,
    total_updates: i64,
    total_update_checks: i64,
    by_platform: Vec<PlatformCount>,
    releases: Vec<DownloadRelease>,
}

#[derive(Serialize)]
pub struct DownloadsOverview {
    #[serde(flatten)]
    github: GithubSummary,
    fetched_at: Option<String>,
    source_error: Option<String>,
    daily: Vec<DownloadDay>,
    versions_in_use: Vec<VersionRow>,
    os_split: Vec<OsRow>,
}

const GITHUB_CACHE_TTL: Duration = Duration::from_secs(15 * 60);

fn github_cache() -> &'static Mutex<Option<(Instant, DateTime<Utc>, GithubSummary)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, DateTime<Utc>, GithubSummary)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn classify_asset(name: &str) -> Option<(&'static str, &'static str)> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".sig") {
        return None;
    }
    if n == "latest.json" {
        return Some(("any", "update_check"));
    }
    let platform = if n.ends_with(".dmg") || n.ends_with(".app.tar.gz") || n.contains("darwin") || n.contains("macos") || n.contains("apple") {
        "macOS"
    } else if n.ends_with(".exe") || n.ends_with(".msi") || n.ends_with(".nsis.zip") || n.contains("windows") {
        "Windows"
    } else if n.contains(".appimage") || n.ends_with(".deb") || n.ends_with(".rpm") || n.contains("linux") {
        "Linux"
    } else {
        "other"
    };
    let kind = if n.ends_with(".app.tar.gz") || n.ends_with(".nsis.zip") || n.ends_with(".appimage.tar.gz") {
        "update"
    } else if n.ends_with(".dmg") || n.ends_with(".exe") || n.ends_with(".msi") || n.ends_with(".appimage") || n.ends_with(".deb") || n.ends_with(".rpm") {
        "installer"
    } else {
        return None;
    };
    Some((platform, kind))
}

async fn fetch_github(state: &AppState) -> Result<GithubSummary, String> {
    let repo = std::env::var("GITHUB_REPO").unwrap_or_else(|_| "Ryz3nPlayZ/zWork".to_string());
    let token = std::env::var("GITHUB_TOKEN").unwrap_or_default();
    let get = |url: String| {
        let mut req = state
            .http_client
            .get(url)
            .header("User-Agent", "zwork-admin")
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(10));
        if !token.trim().is_empty() {
            req = req.bearer_auth(token.trim());
        }
        req
    };

    let repo_json: Value = get(format!("https://api.github.com/repos/{repo}"))
        .send()
        .await
        .map_err(|e| format!("GitHub repo request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub repo request: {e}"))?
        .json()
        .await
        .map_err(|e| format!("GitHub repo JSON: {e}"))?;

    let mut releases_json: Vec<Value> = Vec::new();
    for page in 1..=3 {
        let batch: Vec<Value> = get(format!("https://api.github.com/repos/{repo}/releases?per_page=100&page={page}"))
            .send()
            .await
            .map_err(|e| format!("GitHub releases request failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("GitHub releases request: {e}"))?
            .json()
            .await
            .map_err(|e| format!("GitHub releases JSON: {e}"))?;
        let n = batch.len();
        releases_json.extend(batch);
        if n < 100 {
            break;
        }
    }

    let mut summary = GithubSummary {
        repo: repo.clone(),
        stars: repo_json.get("stargazers_count").and_then(Value::as_i64).unwrap_or(0),
        forks: repo_json.get("forks_count").and_then(Value::as_i64).unwrap_or(0),
        // GitHub's open_issues_count includes open PRs.
        open_issues: repo_json.get("open_issues_count").and_then(Value::as_i64).unwrap_or(0),
        watchers: repo_json.get("subscribers_count").and_then(Value::as_i64).unwrap_or(0),
        ..Default::default()
    };
    let mut platforms: BTreeMap<String, i64> = BTreeMap::new();
    for rel in &releases_json {
        if rel.get("draft").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let mut out = DownloadRelease {
            tag: rel.get("tag_name").and_then(Value::as_str).unwrap_or("").to_string(),
            name: rel.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            published_at: rel.get("published_at").and_then(Value::as_str).unwrap_or("").to_string(),
            prerelease: rel.get("prerelease").and_then(Value::as_bool).unwrap_or(false),
            installers: 0,
            updates: 0,
            update_checks: 0,
            assets: Vec::new(),
        };
        for asset in rel.get("assets").and_then(Value::as_array).into_iter().flatten() {
            let name = asset.get("name").and_then(Value::as_str).unwrap_or("");
            let downloads = asset.get("download_count").and_then(Value::as_i64).unwrap_or(0);
            let Some((platform, kind)) = classify_asset(name) else { continue };
            match kind {
                "installer" => {
                    out.installers += downloads;
                    *platforms.entry(platform.to_string()).or_default() += downloads;
                }
                "update" => out.updates += downloads,
                _ => out.update_checks += downloads,
            }
            out.assets.push(DownloadAsset {
                name: name.to_string(),
                platform: platform.to_string(),
                kind: kind.to_string(),
                downloads,
            });
        }
        summary.total_installers += out.installers;
        summary.total_updates += out.updates;
        summary.total_update_checks += out.update_checks;
        summary.releases.push(out);
    }
    summary.releases.sort_by(|a, b| b.published_at.cmp(&a.published_at));
    summary.releases.truncate(20);
    summary.by_platform = platforms
        .into_iter()
        .map(|(platform, downloads)| PlatformCount { platform, downloads })
        .collect();
    summary.by_platform.sort_by(|a, b| b.downloads.cmp(&a.downloads));
    Ok(summary)
}

/// GitHub only reports lifetime counts, so record today's totals; the daily
/// series is the difference between consecutive snapshots.
async fn record_download_snapshot(state: &AppState, s: &GithubSummary) {
    let by_platform = serde_json::to_value(&s.by_platform).unwrap_or(Value::Null);
    let res = sqlx::query(
        r#"
        INSERT INTO release_download_snapshots (day, installers, updates, update_checks, by_platform, captured_at)
        VALUES (CURRENT_DATE, $1, $2, $3, $4, NOW())
        ON CONFLICT (day) DO UPDATE SET
          installers = EXCLUDED.installers,
          updates = EXCLUDED.updates,
          update_checks = EXCLUDED.update_checks,
          by_platform = EXCLUDED.by_platform,
          captured_at = NOW()
        "#,
    )
    .bind(s.total_installers)
    .bind(s.total_updates)
    .bind(s.total_update_checks)
    .bind(by_platform)
    .execute(&state.db)
    .await;
    if let Err(e) = res {
        tracing::warn!("download snapshot insert failed: {e}");
    }
}

/// Fetch (or reuse the cached) GitHub summary and snapshot it. Called by the
/// endpoint and by the background refresher in `main`.
pub async fn refresh_downloads(state: &AppState, force: bool) -> (Option<(DateTime<Utc>, GithubSummary)>, Option<String>) {
    if !force {
        if let Some((at, fetched, s)) = github_cache().lock().ok().and_then(|g| g.clone()) {
            if at.elapsed() < GITHUB_CACHE_TTL {
                return (Some((fetched, s)), None);
            }
        }
    }
    match fetch_github(state).await {
        Ok(s) => {
            record_download_snapshot(state, &s).await;
            let now = Utc::now();
            if let Ok(mut g) = github_cache().lock() {
                *g = Some((Instant::now(), now, s.clone()));
            }
            (Some((now, s)), None)
        }
        Err(e) => {
            tracing::warn!("{e}");
            // Serve stale data rather than nothing.
            let stale = github_cache().lock().ok().and_then(|g| g.clone()).map(|(_, at, s)| (at, s));
            (stale, Some(e))
        }
    }
}

pub async fn admin_metrics_downloads(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DownloadsOverview>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;
    let (cached, source_error) = refresh_downloads(&state, false).await;
    let (fetched_at, github) = match cached {
        Some((at, s)) => (Some(at.to_rfc3339()), s),
        None => (None, GithubSummary::default()),
    };

    let daily_rows = sqlx::query(
        r#"
        SELECT day,
               installers - LAG(installers) OVER (ORDER BY day) AS installers,
               updates - LAG(updates) OVER (ORDER BY day) AS updates,
               update_checks - LAG(update_checks) OVER (ORDER BY day) AS update_checks
        FROM release_download_snapshots
        WHERE day > CURRENT_DATE - 61
        ORDER BY day
        "#,
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let daily = daily_rows
        .into_iter()
        .filter_map(|row| {
            let day: NaiveDate = row.get("day");
            let installers: Option<i64> = row.get("installers");
            Some(DownloadDay {
                date: day.to_string(),
                installers: installers?.max(0),
                updates: row.get::<Option<i64>, _>("updates").unwrap_or(0).max(0),
                update_checks: row.get::<Option<i64>, _>("update_checks").unwrap_or(0).max(0),
            })
        })
        .collect();

    let versions_in_use = sqlx::query(
        r#"
        SELECT COALESCE(NULLIF(app_version, ''), 'unknown') AS version,
               COUNT(DISTINCT user_id)::bigint AS users,
               COUNT(*)::bigint AS requests
        FROM gateway_requests
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY 1
        ORDER BY users DESC, requests DESC
        LIMIT 15
        "#,
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|row| VersionRow { version: row.get("version"), users: row.get("users"), requests: row.get("requests") })
    .collect();

    let os_split = sqlx::query(
        r#"
        SELECT COALESCE(NULLIF(os, ''), 'unknown') AS os, COUNT(DISTINCT user_id)::bigint AS users
        FROM gateway_requests
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY 1
        ORDER BY users DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|row| OsRow { os: row.get("os"), users: row.get("users") })
    .collect();

    Ok(Json(DownloadsOverview { github, fetched_at, source_error, daily, versions_in_use, os_split }))
}

// ── Funnel + retention cohorts ────────────────────────────────────────────

#[derive(Serialize)]
pub struct FunnelStep {
    step: String,
    users: i64,
}

#[derive(Serialize)]
pub struct Cohort {
    week_start: String,
    users: i64,
    /// `retention[k]` = share of the cohort active in week k after signup
    /// (k = 0 is the signup week). Only weeks that have started are present.
    retention: Vec<f64>,
}

#[derive(Serialize)]
pub struct FunnelOverview {
    window_days: i64,
    steps: Vec<FunnelStep>,
    median_hours_to_first_request: Option<f64>,
    cohorts: Vec<Cohort>,
}

pub async fn admin_metrics_funnel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AdminDaysQuery>,
) -> Result<Json<FunnelOverview>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;
    let days = q.days.clamp(7, 365);

    let row = sqlx::query(
        r#"
        WITH signups AS (
          SELECT user_id, created_at, subscription_started_at
          FROM app_users WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
        ),
        act AS (
          SELECT g.user_id,
                 MIN(g.created_at) AS first_at,
                 COUNT(DISTINCT DATE(g.created_at)) AS active_days
          FROM gateway_requests g JOIN signups s ON s.user_id = g.user_id
          GROUP BY g.user_id
        )
        SELECT
          (SELECT COUNT(*) FROM signups)::bigint AS signups,
          (SELECT COUNT(*) FROM act)::bigint AS activated,
          (SELECT COUNT(*) FROM act WHERE active_days >= 3)::bigint AS engaged,
          (SELECT COUNT(*) FROM signups WHERE subscription_started_at IS NOT NULL)::bigint AS paid,
          (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM a.first_at - s.created_at) / 3600.0)
             FROM act a JOIN signups s ON s.user_id = a.user_id WHERE a.first_at >= s.created_at)::float8 AS median_hours
        "#,
    )
    .bind(days)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        tracing::warn!("funnel query failed: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let steps = vec![
        FunnelStep { step: "Signed up".into(), users: row.get("signups") },
        FunnelStep { step: "Sent a request".into(), users: row.get("activated") },
        FunnelStep { step: "Active on 3+ days".into(), users: row.get("engaged") },
        FunnelStep { step: "Subscribed".into(), users: row.get("paid") },
    ];
    let median_hours_to_first_request: Option<f64> = row.get("median_hours");

    // Weekly cohorts for the last 8 signup weeks.
    let sizes = sqlx::query(
        r#"
        SELECT date_trunc('week', created_at)::date AS wk, COUNT(*)::bigint AS n
        FROM app_users
        WHERE created_at >= date_trunc('week', NOW()) - INTERVAL '7 weeks'
        GROUP BY 1 ORDER BY 1
        "#,
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let active = sqlx::query(
        r#"
        WITH u AS (
          SELECT user_id, date_trunc('week', created_at) AS cohort
          FROM app_users
          WHERE created_at >= date_trunc('week', NOW()) - INTERVAL '7 weeks'
        )
        SELECT u.cohort::date AS wk,
               (EXTRACT(EPOCH FROM date_trunc('week', g.created_at) - u.cohort) / 604800)::int AS k,
               COUNT(DISTINCT g.user_id)::bigint AS n
        FROM u JOIN gateway_requests g ON g.user_id = u.user_id AND g.created_at >= u.cohort
        GROUP BY 1, 2
        "#,
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let mut active_map: BTreeMap<(NaiveDate, i32), i64> = BTreeMap::new();
    for r in active {
        active_map.insert((r.get("wk"), r.get("k")), r.get("n"));
    }
    let today = Utc::now().date_naive();
    let cohorts = sizes
        .into_iter()
        .map(|r| {
            let wk: NaiveDate = r.get("wk");
            let n: i64 = r.get("n");
            let weeks_elapsed = ((today - wk).num_days() / 7) as i32;
            let retention = (0..=weeks_elapsed.min(7))
                .map(|k| {
                    let a = active_map.get(&(wk, k)).copied().unwrap_or(0);
                    if n > 0 { (a as f64 / n as f64 * 1000.0).round() / 10.0 } else { 0.0 }
                })
                .collect();
            Cohort { week_start: wk.to_string(), users: n, retention }
        })
        .collect();

    Ok(Json(FunnelOverview { window_days: days, steps, median_hours_to_first_request, cohorts }))
}

// ── Status: surfaces, database, integrations ──────────────────────────────

#[derive(Serialize)]
pub struct SurfaceProbe {
    name: String,
    url: String,
    host: String,
    role: String,
    expect: String,
    status: Option<u16>,
    ok: bool,
    latency_ms: Option<i64>,
    detail: Option<String>,
}

#[derive(Serialize)]
pub struct TableSize {
    name: String,
    rows: i64,
    bytes: i64,
}

#[derive(Serialize)]
pub struct DbStatus {
    ok: bool,
    latency_ms: i64,
    size_bytes: i64,
    tables: Vec<TableSize>,
}

#[derive(Serialize)]
pub struct Integration {
    name: String,
    configured: bool,
    detail: String,
}

#[derive(Serialize)]
pub struct StatusOverview {
    api_version: String,
    started_at: Option<String>,
    uptime_secs: Option<i64>,
    surfaces: Vec<SurfaceProbe>,
    database: DbStatus,
    integrations: Vec<Integration>,
}

/// (name, url, host, role, expected status class). "2xx" accepts 200–299,
/// "3xx" a redirect, a number that exact status.
fn surface_list() -> Vec<(&'static str, String, &'static str, &'static str, &'static str)> {
    let api = std::env::var("PUBLIC_API_BASE").unwrap_or_else(|_| "https://api.tryzwork.app".into());
    vec![
        ("Landing", "https://tryzwork.app".into(), "Vercel", "Marketing site (landing/)", "2xx"),
        ("Web app", "https://app.tryzwork.app".into(), "Caddy", "Browser demo of the app", "2xx"),
        ("Admin", "https://admin.tryzwork.app".into(), "Caddy", "This dashboard (admin-web/)", "2xx"),
        ("API", format!("{}/api/health", api.trim_end_matches('/')), "Caddy → api", "Gateway, auth, billing, admin API", "2xx"),
        ("Analytics", "https://analytics.tryzwork.app".into(), "Caddy", "Redirect to PostHog", "3xx"),
        ("DB host", "https://db.tryzwork.app".into(), "Caddy", "Must stay blocked", "403"),
    ]
}

async fn probe(client: &reqwest::Client, name: &str, url: String, host: &str, role: &str, expect: &str) -> SurfaceProbe {
    let started = Instant::now();
    let res = client.get(&url).send().await;
    let latency_ms = Some(started.elapsed().as_millis() as i64);
    let (status, detail) = match res {
        Ok(r) => {
            let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).map(|s| format!("→ {s}"));
            (Some(r.status().as_u16()), loc)
        }
        Err(e) => (None, Some(if e.is_timeout() { "timed out".to_string() } else { e.to_string() })),
    };
    let ok = match (status, expect) {
        (Some(s), "2xx") => (200..300).contains(&s),
        (Some(s), "3xx") => (300..400).contains(&s),
        (Some(s), exact) => exact.parse::<u16>().map(|e| e == s).unwrap_or(false),
        (None, _) => false,
    };
    SurfaceProbe {
        name: name.to_string(),
        url,
        host: host.to_string(),
        role: role.to_string(),
        expect: expect.to_string(),
        status,
        ok,
        latency_ms,
        detail,
    }
}

fn env_set(key: &str) -> bool {
    std::env::var(key).map(|v| !v.trim().is_empty()).unwrap_or(false)
}

pub async fn admin_metrics_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StatusOverview>, StatusCode> {
    let _owner = ensure_owner_or_service(&state, &headers).await?;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(6))
        .user_agent("zwork-admin-status")
        .build()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let surfaces = futures::future::join_all(
        surface_list()
            .into_iter()
            .map(|(name, url, host, role, expect)| {
                let client = client.clone();
                async move { probe(&client, name, url, host, role, expect).await }
            }),
    )
    .await;

    let db_started = Instant::now();
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db).await.is_ok();
    let latency_ms = db_started.elapsed().as_millis() as i64;
    let size_bytes: i64 = sqlx::query_scalar("SELECT pg_database_size(current_database())::bigint")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    let tables = sqlx::query(
        r#"
        SELECT relname AS name, n_live_tup::bigint AS rows,
               pg_total_relation_size(relid)::bigint AS bytes
        FROM pg_stat_user_tables
        ORDER BY bytes DESC
        LIMIT 20
        "#,
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|r| TableSize { name: r.get("name"), rows: r.get("rows"), bytes: r.get("bytes") })
    .collect();

    let mut integrations = vec![
        Integration {
            name: "Stripe".into(),
            configured: !state.stripe_secret_key.trim().is_empty(),
            detail: if state.stripe_webhook_secret.trim().is_empty() { "webhook secret missing".into() } else { "billing + webhook".into() },
        },
        Integration {
            name: "PostHog".into(),
            configured: !state.posthog_key.trim().is_empty(),
            detail: state.posthog_host.clone(),
        },
        Integration {
            name: "Google sign-in".into(),
            configured: !state.google_client_id.trim().is_empty() && !state.google_client_secret.trim().is_empty(),
            detail: "desktop OAuth".into(),
        },
        Integration {
            name: "Composio".into(),
            configured: !state.composio_api_key.trim().is_empty(),
            detail: "connector proxy".into(),
        },
        Integration {
            name: "GitHub token".into(),
            configured: env_set("GITHUB_TOKEN"),
            detail: "optional; raises the releases API rate limit".into(),
        },
        Integration {
            name: "Web demo".into(),
            configured: state.demo.enabled,
            detail: format!("{} messages / IP / day", state.demo.daily_requests_per_ip),
        },
    ];
    for p in &state.gateway.providers {
        integrations.push(Integration {
            name: format!("Provider: {}", p.name),
            configured: !p.api_key.trim().is_empty(),
            detail: if p.fallback_model.is_empty() || p.fallback_model == p.primary_model {
                p.primary_model.clone()
            } else {
                format!("{} (fallback {})", p.primary_model, p.fallback_model)
            },
        });
    }

    let started = STARTED_AT.get().copied();
    Ok(Json(StatusOverview {
        api_version: env!("CARGO_PKG_VERSION").to_string(),
        started_at: started.map(|s| s.to_rfc3339()),
        uptime_secs: started.map(|s| (Utc::now() - s).num_seconds()),
        surfaces,
        database: DbStatus { ok: db_ok, latency_ms, size_bytes, tables },
        integrations,
    }))
}

#[cfg(test)]
mod tests {
    use super::classify_asset;

    #[test]
    fn classifies_release_assets() {
        assert_eq!(classify_asset("zWork_0.5.2_aarch64.dmg"), Some(("macOS", "installer")));
        assert_eq!(classify_asset("zWork_aarch64.app.tar.gz"), Some(("macOS", "update")));
        assert_eq!(classify_asset("zWork_aarch64.app.tar.gz.sig"), None);
        assert_eq!(classify_asset("zWork_0.5.2_x64-setup.exe"), Some(("Windows", "installer")));
        assert_eq!(classify_asset("zWork_0.5.2_x64-setup.nsis.zip"), Some(("Windows", "update")));
        assert_eq!(classify_asset("zWork_0.5.2_amd64.AppImage"), Some(("Linux", "installer")));
        assert_eq!(classify_asset("latest.json"), Some(("any", "update_check")));
    }
}
