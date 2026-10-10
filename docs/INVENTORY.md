# Inventory

Everything zWork runs in public, where it lives, how it gets there, and what we
measure. Probed live on 2026-10-01. The admin dashboard's **Status** tab runs the
same probes from the API server on every load, so check there for current state.

## Public surfaces

| Host | Serves | Hosted on | Deployed by | Expect |
|------|--------|-----------|-------------|--------|
| `tryzwork.app` | Marketing site (`landing/`) | Vercel | Vercel git integration, root dir `landing` | 200 |
| `www.tryzwork.app` | Redirect to the apex | Vercel | Vercel domain settings | 307 |
| `app.tryzwork.app` | The real desktop app (`app/`) built for web: account required, Flash only, plain chat through `/api/v1/chat/completions` | Caddy on the VM, `/var/www/app.tryzwork.app` | `scripts/deploy-app-demo.sh` | 200 |
| `admin.tryzwork.app` | Admin dashboard (`admin-web/`), password gated | Caddy on the VM, `/var/www/admin.tryzwork.app` | `scripts/deploy-admin-web.sh` | 200 |
| `api.tryzwork.app` | Cloud API (`cloud-src/api`, axum) and Better Auth under `/api/auth/*` | Caddy on the VM → docker compose | `ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build axum_api'` | 200 on `/health`, `/api/health` |
| `analytics.tryzwork.app` | Redirect to the PostHog project | Caddy on the VM | `cloud-src/Caddyfile` | 302 |
| `db.tryzwork.app` | Nothing. Placeholder that answers `403 disabled` | Caddy on the VM | `cloud-src/Caddyfile` | 403 |

The VM is the host behind `api.tryzwork.app`; `ssh-connect.sh` at the repo root
opens a shell on it. Caddy config is `cloud-src/Caddyfile`; services are in
`cloud-src/docker-compose.yml`.

### Off-site pieces

| What | Where |
|------|-------|
| Releases, installers, auto-update manifest | GitHub Releases on `Ryz3nPlayZ/zWork`. The updater reads `releases/latest/download/latest.json` |
| Product analytics | PostHog US, project 397748 |
| Self-hosted telemetry sink (optional) | `telemetry-collector/`, not deployed anywhere by default |

## Findings

1. **Dangling wildcard DNS.** `docs.tryzwork.app`, `auth.tryzwork.app` and any
   other unknown subdomain resolve to Vercel and return `404
   DEPLOYMENT_NOT_FOUND`. Either delete the wildcard record or point the names we
   want at real projects. A dangling wildcard on Vercel can be claimed by another
   account that adds the domain, so delete it.
2. **`api.tryzwork.app/` returns 404.** The Caddyfile's `handle /` comment says
   the root shows health, but axum has no `/` route. `/health` and
   `/api/health` both return 200. Either add a `/` route or drop the Caddy block.
3. **Two scripts deployed to `app.tryzwork.app`.** `scripts/deploy-web-demo.sh`
   rsynced the gitignored `minimal-chat/` over the real demo. Deleted; the
   docs no longer list `minimal-chat/` as part of the repo.
4. **Demo origins included the apex.** `app/src/lib/preview.ts` treated
   `tryzwork.app` and `www.tryzwork.app` as demo origins, from before the landing
   took the apex. Fixed: only `app.tryzwork.app` is a demo origin now.
5. **Dev port drift.** `landing/README.md` said 5173; `vite.config.ts` pins 4312
   (matching `docs/DEVELOPER_GUIDE.md`). Fixed in the README.
6. **The landing has no deploy script in the repo.** It deploys through Vercel's
   git integration, so a push to `main` that touches `landing/` ships it.
7. **The live apex was an old page.** Until early October `tryzwork.app` served
   an earlier build ("AI that works on your machine") that claimed "no cloud, no
   telemetry". Resolved: as of 2026-10-09 the apex serves the redesigned
   `landing/` ("your weekly paperwork, done").
8. **`zwork.ai` is not ours.** It's a GoDaddy parked domain (registered behind
   Domains By Proxy, no MX record), so links to it and `hello@zwork.ai` went
   nowhere. Resolved 2026-10-09: every reference is gone. `landing-legacy/`
   now points at `tryzwork.app` and uses `privacy@tryzwork.app` /
   `legal@tryzwork.app`, the addresses `legal/` already publishes (tryzwork.app
   mail is on Zoho). Don't reintroduce the domain.
9. **Router calls weren't tagged.** From the pi port until 34798b5 the sidecar
   sent hosted-router calls without a run id, so every model call in a task
   counted as a new message against the quota, and app version and OS were
   blank. Fixed in the sidecar and the API (API deployed 2026-10-09); users only
   get the fix with the next desktop release, and the Jobs tab shows how much
   traffic still comes from untagged builds.

## What the dashboard measures

What a dev/ops team wants to know, and where each answer lives now.

| Question | Where | Status |
|----------|-------|--------|
| Is everything up? | Status → public surfaces, DB latency, API uptime, integrations | ✅ |
| What needs my attention today? | Overview → Needs attention | ✅ |
| How much of our money are users spending? | Finance → spend, projection, cost per request | ✅ |
| Free vs paying spend | Finance → free-tier spend, paying spend, spend by tier | ✅ |
| Are we profitable per tier? Who costs more than they pay? | Finance → tiers table, unprofitable payers | ✅ |
| Which models cost the most? Any unpriced? | Finance → spend by model, unpriced warning | ✅ |
| Revenue, MRR, churn | Revenue | ✅ |
| Downloads, platform split, releases | Growth → downloads | ✅ (daily series starts when the API is deployed; it snapshots GitHub hourly) |
| Who updated to the latest version? | Growth → versions in use | ✅ |
| Do signups activate? Do they come back? | Growth → activation funnel, weekly retention cohorts | ✅ |
| Users, signups, DAU/WAU/MAU | Users, Engagement | ✅ |
| Requests, tokens, errors, latency | Usage, Health | ✅ |
| What is happening right now? | Live | ✅ |
| Who did what in the admin? | Audit | ✅ |
| Do people schedule recurring work? How often, at what cost? | Jobs | ✅ (from the first build with run tagging) |
| What did one user run, on which build? | Users → click a row | ✅ |

### Not measured yet

- **Real provider invoices.** Spend is an estimate: tokens × our price table
  (`estimate_cost`). A model missing from the table counts as $0 and shows up as
  "unpriced". Reconcile against the provider bills monthly.
- **Landing traffic and download conversion.** The landing has no analytics, so
  visits → download clicks → installs → signups can't be joined. Add PostHog
  (cookieless) to `landing/` and tag the download button.
- **Crash reporting.** Desktop crashes only show up if the user reports them.
- **Demo usage.** `/api/demo/chat` calls aren't broken out from signed-in usage.
- **Uptime history.** The Status tab is a point-in-time probe; there's no
  history or paging. An external monitor (e.g. a free uptime checker) on the
  hosts above would cover it.
- **Support load.** Open GitHub issues are counted, but not their age or response time.
