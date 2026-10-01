# zWork Telemetry Collector

An optional, self-hosted sink for the desktop app's anonymous usage events, plus
a script that summarizes them. Product analytics normally go to **PostHog**
(see [docs/TELEMETRY_SETUP.md](../docs/TELEMETRY_SETUP.md)); use this when you
want the raw events on your own box, or to read one install's local log.

## How events flow

```
app/src/lib/telemetry.ts ──► PostHog (posthog-js, when VITE_PUBLIC_POSTHOG_PROJECT_TOKEN is set at build)
          │
          └──► sidecar POST /api/telemetry/event
                  ├──► <data dir>/zWork/state/telemetry.jsonl   (always, while telemetry is on)
                  └──► $ZW_TELEMETRY_ENDPOINT                   (if set) ──► this collector
```

Nothing is sent when the user turns telemetry off in Settings: the client and
the sidecar both check the setting.

The sidecar forwards each event as:

```json
{ "event": "app_opened", "session_id": "uuid", "properties": { … }, "ts": 1759300000000 }
```

The collector adds `received_at` and `server_ts` and appends it to
`telemetry-data/YYYY-MM-DD.jsonl` (UTC). `session_id` is a fresh UUID per app
launch; there is **no install or user id**, so "sessions" is the closest thing
to a user count.

## Run it

```bash
cd telemetry-collector
pip install fastapi uvicorn
python server.py                     # http://localhost:8765
```

| Env | Default | |
|-----|---------|---|
| `PORT` | `8765` | listen port |
| `ZW_TELEMETRY_DIR` | `./telemetry-data` | where the JSONL files go |

Endpoints: `POST /ingest` (rejects non-JSON and bodies over 64 KB),
`GET /stats` (events and sessions, overall and per day), `GET /healthz`.
There is no auth on any of them, so put it behind a proxy, or keep `/stats`
off the public internet.

## Point the app at it

`ZW_TELEMETRY_ENDPOINT` is read by the sidecar **at runtime** from its
environment, which it inherits from the app. It is not a build setting, and
there is no `tauri.conf.json` key for it.

```bash
ZW_TELEMETRY_ENDPOINT=http://localhost:8765/ingest ./run.sh       # dev
```

To make shipped builds send to a collector, the endpoint has to be compiled
into the sidecar or set by the Tauri shell when it spawns it
(`app/src-tauri/src/main.rs`, next to the other `.env(...)` calls). Neither is
done today, so released builds only write the local log and PostHog.

## Analyze

```bash
python analyze.py                                    # ./telemetry-data
python analyze.py --days 30                          # active window
python analyze.py ~/Library/Application\ Support/zWork/state/telemetry.jsonl
```

It prints event counts, sessions, platforms and versions (from `app_opened`),
session length (from the latest heartbeat per session), screens, token use by
model, thumbs-down by model, error types and the update funnel. Your own
install's local log is a quick way to try it.

## Events

All come from `app/src/lib/telemetry.ts` and its callers.

| Event | Properties |
|-------|-----------|
| `app_opened` | app_version, os, screen, visible |
| `session_heartbeat` | reason, active_ms, active_total_ms, session_ms (every 60 s while visible, and on hide) |
| `app_closed` | reason, session_ms, active_ms (sent on unload; often lost) |
| `screen_view` | screen, has_chat |
| `onboarding_completed` | credential (the provider kind, e.g. `zwork_router`, never a key), model_id |
| `feedback_bad` | chat_id, message_id, model |
| `artifact_created` | kind, size_bytes |
| `error_encountered` | type (`api_error`, `chat_error`), message, component |
| `update_available` / `update_started` / `update_finished` | current_version, latest_version, source |
| `update_failed` | the above plus reason (`updater_error`, `exception`) |

`feature_used`, `onboarding_step`, `token_consumption` and `page_navigated`
have helpers in `telemetry.ts` but no callers yet.

## Privacy

- No names, emails, message text, file contents or API keys in the events.
- No persistent id: sessions can't be linked to each other or to a person.
- **One exception to watch:** `error_encountered.message` is the raw error
  string from the provider or the chat pipeline. It can contain anything the
  error does, such as a model name, a URL or a file path.
- PostHog is different: once a user signs in to zWork cloud, posthog-js
  identifies them by user id, email and name (`identifyPostHogUser`). That is
  separate from the anonymous events above.
