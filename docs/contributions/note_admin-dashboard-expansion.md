# Admin dashboard expansion

## Context

zWork already shipped a minimal admin dashboard (`app/src/components/AdminPage.tsx`, four table-only tabs) backed by six `/api/admin/*` handlers in `cloud-src/api/src/main.rs`. The `gateway_requests` table already captured rich operational signal — latency, tokens, cost, upstream status, retries, routing decisions, failure history — plus `gateway_attempts` and `provider_snapshots` tables, but **none of that data was surfaced in any dashboard**. The expansion covers four goals at once: operational health, business/revenue, product/engagement, and real-time activity.

## What changed

### 1. Admin auth hardening (security-first)

The prior `ensure_owner_or_service` accepted any bearer starting with `Bearer admin_` — a critical hole because the admin token format was `admin_<uuid>_<email>_<ts>` with no signature and no validation beyond the prefix.

Replaced with:

- **HMAC-SHA256-signed stateless tokens** signed with `ADMIN_TOKEN_SECRET`. Token format: `admin_<base64url(json payload)>.<base64url(hmac sig)>` where payload = `{email, iat, exp, sid}`.
- **Session table** (`admin_sessions`) persists only the SHA-256 hash of each token, enabling per-session revocation and `last_used_at` tracking without storing raw bearers.
- **`ensure_owner_or_service` now verifies** the signature, checks `exp`, confirms the session exists and is non-revoked, and bumps `last_used_at` on success. Bad/expired/revoked tokens return `401`.
- **Constant-time password comparison** in `admin_verify_password`.
- **Logout endpoint** (`POST /api/admin/logout`) marks the session revoked.
- **Audit log** (`admin_audit_log` table + `audit_admin_action` helper) records logins, logouts, and tier changes. Surfaced via `GET /api/admin/audit?limit=200` and the new Audit tab.

`ADMIN_TOKEN_SECRET` is a new required env var for production (falls back to deriving from `ADMIN_PASSWORD` with a warning for dev).

### 2. Recharts + dashboard shell

Added `recharts` and built a shared chart library in `app/src/components/admin/shared.tsx` (`LineChartCard`, `AreaChartCard`, `BarChartCard`, `DonutCard`, `ChartCard`, CSV helpers) that uses the app's design-token CSS variables so charts adapt to light/dark themes automatically. `AdminPage.tsx` was rewritten to render nine tabs.

### 3. Operational / health

`GET /api/admin/metrics/health?days=N` computes (in SQL via `percentile_cont`): error rate, status-code buckets (2xx/3xx/4xx/5xx/unknown), latency p50/p95/p99, TTFT p50/p95, retried-request counts, top failing models, and per-day series for all of the above. `GET /api/admin/metrics/providers` joins `gateway_requests` aggregates with the latest `provider_snapshots` row per provider to show rate-limit saturation. The **Health** tab renders latency lines, TTFT area chart, status-code donut, error-rate line, failing-models bar, and per-provider cards with saturation gauges.

### 4. Business / revenue

Added `subscription_started_at` / `subscription_ended_at` columns to `app_users` (populated by the Stripe webhook) to track subscription lifecycle. `GET /api/admin/metrics/revenue?days=N` returns current MRR (recomputed from active subscriptions + price IDs), ARPU, paid users, new-subs/churn counts in the window, estimated provider cost (sum of `estimated_cost_usd`), gross margin %, daily series, and a tier split. The **Revenue** tab shows MRR/cost/margin area charts, net-subs stacked bar, and a tier-split donut.

### 5. Product / engagement

`GET /api/admin/metrics/engagement?days=N` returns DAU/WAU/MAU, stickiness % (DAU/MAU), new-vs-returning daily series, requests/tokens per day, and the top-10 most active users. The **Engagement** tab renders DAU area, new-vs-returning stacked bar, requests/tokens lines, and a top-users table.

### 6. Real-time activity

`GET /api/admin/metrics/live` returns active-users/requests/tokens in the last 5 minutes, a requests-per-min figure, and the 50 most recent `gateway_requests` rows (with user + provider + status + duration). The **Live** tab polls every 10s, pauses when the tab is hidden (`document.visibilitychange`), renders big stat cards with a live pulse, a requests/min sparkline, and a scrolling recent-activity feed. The Overview header also shows a compact "active · /min" badge polled every 30s.

### 7. Existing-tab polish + Audit tab

- **Users** now has a search box (name/email/tier).
- New **Audit** tab reads `/api/admin/audit?limit=200` and renders a time-ordered table with action badges.
- Overview gained a live-activity badge and a hint pointing to the deeper tabs.

## What was deliberately deferred

- **Per-provider cost backfill.** The cost estimates still use the legacy DeepSeek pricing heuristics in `admin_metrics_overview` and `admin_list_users`. The `tier_monthly_price` helper used by the revenue endpoint is the cleaner model; extending it to per-`(provider, model)` pricing and backfilling historical `estimated_cost_usd` rows is left as a follow-up so we don't rewrite historical cost data without explicit review.
- **Cohort retention heatmap.** The data is available; the engagement tab currently shows DAU/new-vs-returning rather than a full week-N cohort matrix.
- **Prometheus / OpenTelemetry / `/metrics`.** Out of scope; the Postgres-backed dashboard covers the same ground for now.
