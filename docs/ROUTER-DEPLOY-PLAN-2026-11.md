# Deploy plan: router cost changes and the pending API changes

Status: **waiting for approval. Nothing is deployed.**

This deploys the API (`axum_api`) on the prod VM from one commit of this branch
(`claude/zen-taussig-01eb25`, or `main` once merged). The web app, landing and
desktop app are not touched.

## What the live API lacks

Live is image `cloud-axum_api:latest` (22aa2107, built Nov 22). Its
`~/cloud/api/src/main.rs` is 23 hunks behind HEAD (read-only diff, Nov 25):

| Change | Already on `main` | Effect |
|---|---|---|
| Flash route: GLM 5.3 Flash → DeepSeek V4.1 Flash 1017 → DeepSeek Flash (live: DeepSeek Flash → Luna → GLM) | yes | Flash share costs about 1.3× (about +$0.12 a month at current traffic) |
| Sol id `openai/gpt-6.2-sol` (live: `gpt-6.1-sol`) and its price-table row | yes | Apex uses the current Sol |
| Sol reasoning fix: drop `reasoning: off` for Sol, which rejects it with a 400 | yes | titles and summaries on Apex stop failing |
| Haiku as a third A/B arm, DeepSeek 1017 price row | yes | none once A/B is 0 (below) |
| Classifier prompt line "Most requests are EASY…" | yes | fewer escalations |
| Outlook, OneDrive, Excel, Teams, QuickBooks, Xero connector tiles | yes | tiles show in the storefront |
| CORS exposes `x-zwork-router-provider` / `-model` to the web app | yes | web app can show the model |
| Classifier reads the user's words, hand-back after 6 MiMo calls, A/B off, long-run at 60, titles not counted as tasks | this branch | about 25–30% cheaper per task |
| Images stay on Flash (only new images count), `session_id` per run for provider stickiness, repeat check counts only calls in a row | this branch | vision share about $0.40 cheaper; fewer cache misses and false escalations |
| New limits: Pro $1.50/wk, Max $6/wk, 5-hour share 0.25, free $0.05–0.25/wk | this branch | 2–3.5× more work per week |

`Cargo.toml`, `Cargo.lock`, `Dockerfile` and `admin_insights.rs` on the VM
already match HEAD, so only `main.rs` changes.

**Choice for you:** keep the GLM-first Flash route (better completions in the
bench, +$0.12 a month now) or keep DeepSeek Flash first (cheapest). The plan
below assumes GLM first, as on `main`. DeepSeek first is a one-line change to
`Route::Flash` before building.

## Settings

The VM's `docker-compose.yml` passes none of the quota or router variables to
the container, so the defaults in `main.rs` apply and no env change is needed.
Don't copy the repo's compose file over the VM's (the VM's differs). To tune a
value later without rebuilding, add it to the VM compose `axum_api`
environment and to `~/cloud/.env`.

| Variable | New default |
|---|---|
| `PRO_WEEKLY_USD` | 1.50 |
| `MAX_WEEKLY_USD` | 6.00 |
| `FIVE_HOUR_SHARE` | 0.25 |
| `FREE_USER_WEEKLY_MIN_USD` / `MAX_USD` | 0.05 / 0.25 |
| `ROUTER_AB_PERCENT` | 0 |
| `ROUTER_ESCALATE_AFTER_CALLS` | 60 |
| `ROUTER_ESCALATED_HANDBACK_CALLS` | 6 |
| `ROUTER_VISION_FOR_IMAGES` | off |

## Steps (on approval)

`C` is the commit to deploy: the tip of `claude/zen-taussig-01eb25` (router changes on top of `main`), or its merge into `main`.

1. **Back up.** On the VM:
   `sudo docker tag cloud-axum_api:latest cloud-axum_api:rollback-20261125`
   and `cp ~/cloud/api/src/main.rs ~/cloud/api/src/main.rs.bak-20261125`.
2. **Upload committed content only** (other sessions leave edits in the
   working tree):
   `git show C:cloud-src/api/src/main.rs | ./ssh-connect.sh 'cat > ~/cloud/api/src/main.rs'`.
   Check the md5 on both sides.
3. **Build** in the background on the VM:
   `cd ~/cloud && nohup sudo docker compose build axum_api > /tmp/axum_build.log 2>&1 &`.
   Wait for `Built` in the log tail and a new image id.
4. **Smoke test** in a throwaway container with a random token and no real
   credentials:
   `docker compose run -d --rm --no-deps --name zwork_api_test -p 127.0.0.1:18080:8080 -e ZWORK_GATEWAY_TOKEN=$(openssl rand -hex 24) axum_api`.
   Check that `/health` is 200 and `/api/admin/metrics/jobs` answers with the
   bearer. Then `docker rm -f zwork_api_test`.
5. **Swap:** `sudo docker compose up -d --no-deps axum_api`.
6. **Probe:** `/health` is 200, `/api/admin/metrics/jobs` is 401 without
   auth, and the container log shows no startup errors.
7. **First real requests** (read-only SQL, an hour later): new rows have
   `route` set, `routing_decision.why.reason` values look right, and none
   have `ab_test`.

## Rollback

`sudo docker tag cloud-axum_api:rollback-20261125 cloud-axum_api:latest && cd ~/cloud && sudo docker compose up -d --no-deps axum_api`,
then restore `main.rs.bak-20261125`. Older tags: `rollback-20261121`,
`rollback-20261120`, `rollback-20261116`. No database migration is involved,
so rollback is just the image.

## After a week

Read-only, per day:

- the share of runs with `why.reason = 'classifier'`, against 26% before;
- `handback` runs: their call count and whether they end in an error;
- spend per agent run, against a median of $0.0024 on Flash and $0.039
  escalated;
- users at their 5-hour or weekly cap, against 4 of 7 before;
- cache reads on calls 2+ of Flash runs (`session_id` should remove most
  full misses);
- whether screenshot runs on Flash finish as often as they did on Gemini.

If screenshot runs finish worse on Flash, set `ROUTER_VISION_FOR_IMAGES=1`
the same way. If hand-back runs finish worse, set `ROUTER_ESCALATED_HANDBACK_CALLS=0` in the
VM compose environment and recreate the container. No rebuild needed.
