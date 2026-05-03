#!/usr/bin/env python3
"""
Simple telemetry collector for zWork.
Stores events in a JSONL file for analysis.
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="zWork Telemetry Collector")

# Enable CORS for Tauri app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["tauri://*", "http://localhost:*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)

# Store telemetry data
TELEMETRY_DIR = Path(os.environ.get("ZW_TELEMETRY_DIR", "./telemetry-data"))
TELEMETRY_DIR.mkdir(parents=True, exist_ok=True)


@app.post("/ingest")
async def ingest_telemetry(request: Request):
    try:
        payload = await request.json()
        payload["received_at"] = datetime.utcnow().isoformat()
        payload["server_ts"] = int(datetime.utcnow().timestamp() * 1000)

        # Append to daily log file
        today = datetime.utcnow().strftime("%Y-%m-%d")
        log_file = TELEMETRY_DIR / f"{today}.jsonl"

        with log_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

        return {"ok": True}
    except Exception as e:
        print(f"Error ingesting telemetry: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stats")
async def get_stats():
    """Get basic stats from collected telemetry."""
    stats = {
        "total_events": 0,
        "unique_installs": set(),
        "events_by_type": {},
        "recent_hours": [],
    }

    for log_file in sorted(TELEMETRY_DIR.glob("*.jsonl")):
        with log_file.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    event = json.loads(line.strip())
                    stats["total_events"] += 1

                    if "install_id" in event and event["install_id"]:
                        stats["unique_installs"].add(event["install_id"])

                    event_type = event.get("event", "unknown")
                    stats["events_by_type"][event_type] = stats["events_by_type"].get(event_type, 0) + 1

                except json.JSONDecodeError:
                    continue

    stats["unique_installs"] = len(stats["unique_installs"])
    return stats


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8765))
    uvicorn.run(app, host="0.0.0.0", port=8765)
