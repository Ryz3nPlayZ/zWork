#!/usr/bin/env python3
"""
Self-hosted sink for zWork telemetry.

The sidecar POSTs each event here when ZW_TELEMETRY_ENDPOINT is set in its
environment (sidecar-rust/src/server.rs, telemetry_event). The body is

    {"event": str, "session_id": str | null, "properties": {...} | null, "ts": ms}

This server appends it, plus received_at / server_ts, to a daily JSONL file in
ZW_TELEMETRY_DIR (default ./telemetry-data). The request is server-to-server
from the sidecar, so no CORS is needed.

    pip install fastapi uvicorn
    python server.py            # http://localhost:8765, PORT overrides
"""

import json
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="zWork Telemetry Collector")

TELEMETRY_DIR = Path(os.environ.get("ZW_TELEMETRY_DIR", "./telemetry-data"))
TELEMETRY_DIR.mkdir(parents=True, exist_ok=True)

# Events are small; anything bigger is a bug or abuse.
MAX_BODY_BYTES = 64 * 1024


@app.post("/ingest")
async def ingest_telemetry(request: Request):
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="event too large")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="body is not JSON")
    if not isinstance(payload, dict) or not isinstance(payload.get("event"), str):
        raise HTTPException(status_code=400, detail='expected an object with an "event" string')

    now = datetime.now(timezone.utc)
    payload["received_at"] = now.isoformat()
    payload["server_ts"] = int(now.timestamp() * 1000)

    log_file = TELEMETRY_DIR / f"{now:%Y-%m-%d}.jsonl"
    with log_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return {"ok": True}


@app.get("/stats")
async def get_stats():
    """Event and session counts, overall and per UTC day.

    There is no install id in the payload, so sessions (one per app launch)
    are the closest thing to a user count.
    """
    total = 0
    by_type: Counter[str] = Counter()
    sessions: set[str] = set()
    by_day: dict[str, dict] = {}

    for log_file in sorted(TELEMETRY_DIR.glob("*.jsonl")):
        day_events = 0
        day_sessions: set[str] = set()
        with log_file.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                total += 1
                day_events += 1
                by_type[event.get("event", "unknown")] += 1
                if sid := event.get("session_id"):
                    sessions.add(sid)
                    day_sessions.add(sid)
        by_day[log_file.stem] = {"events": day_events, "sessions": len(day_sessions)}

    return {
        "total_events": total,
        "sessions": len(sessions),
        "events_by_type": dict(by_type.most_common()),
        "by_day": by_day,
    }


@app.get("/healthz")
async def healthz():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8765))
    uvicorn.run(app, host="0.0.0.0", port=port)
