# Telemetry setup

How the desktop app's usage events reach PostHog, and the other places they
can go. For the event list and the self-hosted collector, see
[telemetry-collector/README.md](../telemetry-collector/README.md).

## Paths

| Path | Configured by | Status |
|------|---------------|--------|
| **posthog-js in the app** → PostHog | `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN` (and optional `VITE_PUBLIC_POSTHOG_HOST`) in `app/.env` **at build time** | The real one. No token at build, no PostHog. |
| Sidecar local log | always on while telemetry is enabled | `<data dir>/zWork/state/telemetry.jsonl` per install |
| Sidecar → `ZW_TELEMETRY_ENDPOINT` | env var in the sidecar's environment **at runtime** | Optional, for `telemetry-collector/`. Not set in shipped builds. |
| Cloud API `POST /api/telemetry/event` → PostHog | `POSTHOG_API_KEY` / `POSTHOG_HOST` in `cloud-src/.env` | Requires a gateway token, which the sidecar doesn't send, so nothing calls it today. |

The user's Settings toggle gates all of them: `telemetry.ts` drops events and
opts posthog-js out, and the sidecar checks the setting again before it writes
or forwards anything.

## Turning PostHog on for a build

1. Get the project token from PostHog (Project settings → Project API key).
2. Put it in `app/.env`, which is gitignored. `app/.env.example` has the shape:

   ```
   VITE_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_…
   VITE_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
   ```

3. Build as usual (`scripts/build-*-release.*`). Vite inlines the values, so
   they have to be present on the machine or CI runner that builds. Setting
   them on a user's machine later does nothing.

To check that a build has it: launch it with telemetry on, open devtools, and
look for requests to `*.posthog.com`.

## What PostHog sees

- Anonymous events from `telemetry.ts`, keyed by posthog-js's own anonymous
  id, with `app_version`, `os` and `current_screen` registered as super
  properties.
- After a user signs in to zWork cloud, `identifyPostHogUser` links that id
  to their cloud user id, email, name, tier and access code. This is the only
  personal data in the pipeline. Signing out calls `posthog.reset()`.
- `person_profiles: "identified_only"`, so anonymous users don't create
  person profiles.

## Local testing without PostHog

```bash
cd telemetry-collector && pip install fastapi uvicorn && python server.py
ZW_TELEMETRY_ENDPOINT=http://localhost:8765/ingest ./run.sh
python telemetry-collector/analyze.py telemetry-collector/telemetry-data
```

Or skip the server and read your own install's log:

```bash
python telemetry-collector/analyze.py ~/Library/Application\ Support/zWork/state/telemetry.jsonl
```
