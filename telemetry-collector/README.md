# zWork Telemetry Collector

Simple server to collect and analyze zWork telemetry data.

## Setup

1. **Deploy the collector** (choose one):

   **Option A - Railway/Render/Fly.io:**
   ```bash
   # Deploy to Railway (free tier works)
   railway login
   railway init
   railway up
   # Get the URL from railway domain
   ```

   **Option B - Run locally (for testing):**
   ```bash
   cd telemetry-collector
   pip install fastapi uvicorn
   python server.py
   # Runs on http://localhost:8765
   ```

2. **Configure your zWork builds** to send telemetry:

   In `app/src-tauri/tauri.conf.json` or via environment:
   ```json
   {
     "tauri": {
       "bundle": {
         "environment": {
           "ZW_TELEMETRY_ENDPOINT": "https://your-collector-url.com/ingest"
         }
       }
     }
   }
   ```

3. **View your data**:

   ```bash
   # Basic stats
   curl https://your-collector-url.com/stats

   # Download raw data
   curl https://your-collector-url.com/telemetry-data/2024-04-25.jsonl

   # Analyze locally
   cat telemetry-data/*.jsonl | jq '.event' | sort | uniq -c
   ```

## What gets tracked

| Event | Properties |
|-------|-----------|
| `app_opened` | app_version, os, screen |
| `session_heartbeat` | active_ms, active_total_ms, session_ms |
| `chat_turn_started` | chat_id, resolved_model, artifact_mode, attachment_count |
| `chat_turn_finished` | chat_id, status, duration_ms |
| `update_available` | current_version, latest_version, source |
| `update_finished` | mode (auto/release_page) |
| `onboarding_completed` | telemetry_enabled, credential shape |

## Privacy

- No PII is collected (names, messages, API keys)
- Each install has a random `install_id` for counting unique users
- All data is anonymous and aggregated
