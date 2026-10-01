#!/usr/bin/env python3
r"""
Summarize zWork telemetry JSONL.

Works on the collector's daily files and on one install's local log, which
holds the same event shape. The app keeps that log at
<data dir>/zWork/state/telemetry.jsonl (macOS: ~/Library/Application Support,
Linux: ~/.local/share, Windows: %LOCALAPPDATA%):

    python analyze.py                      # ./telemetry-data/*.jsonl
    python analyze.py path/to/dir          # every *.jsonl in a directory
    python analyze.py ~/Library/Application\ Support/zWork/state/telemetry.jsonl
    python analyze.py --days 30            # "active" window, default 7

There is no install id in the payload; sessions (one per app launch) stand in
for users.
"""

import argparse
import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path


def load_data(source: Path) -> list[dict]:
    files = sorted(source.glob("*.jsonl")) if source.is_dir() else [source]
    data = []
    for file in files:
        with file.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    data.append(event)
    return data


def props(e: dict) -> dict:
    return e.get("properties") or {}


def when(e: dict) -> datetime | None:
    ts = e.get("ts") or e.get("server_ts")
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc) if ts else None


def heading(title: str):
    print(f"\n--- {title} ---")


def print_counts(counter: Counter, limit: int | None = None, prefix: str = ""):
    if not counter:
        print("  (none)")
    for key, count in counter.most_common(limit):
        print(f"  {prefix}{key}: {count:,}")


def print_summary(data: list[dict]):
    sessions = {e["session_id"] for e in data if e.get("session_id")}
    print("=" * 50)
    print("zWORK TELEMETRY SUMMARY")
    print("=" * 50)
    print(f"\nTotal events: {len(data):,}")
    print(f"Sessions: {len(sessions):,}")

    times = [t for t in map(when, data) if t]
    if times:
        print(f"From {min(times):%Y-%m-%d %H:%M} to {max(times):%Y-%m-%d %H:%M} UTC")

    heading("Events by type")
    print_counts(Counter(e.get("event", "unknown") for e in data))

    # os and app_version ride on app_opened, once per session.
    opened = [e for e in data if e.get("event") == "app_opened"]
    heading("Platforms (by session)")
    print_counts(Counter(props(e).get("os", "unknown") for e in opened))
    heading("Versions (by session)")
    print_counts(Counter(props(e).get("app_version", "unknown") for e in opened), prefix="v")


def print_active(data: list[dict], days: int):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    active = {e["session_id"] for e in data if e.get("session_id") and (t := when(e)) and t >= cutoff}
    heading(f"Active in the last {days} days")
    print(f"  {len(active):,} sessions")


def print_engagement(data: list[dict]):
    # app_closed rarely arrives (the window is gone before its POST lands), so
    # take each session's running totals from its latest heartbeat or close.
    latest: dict[str, dict] = {}
    for e in data:
        sid = e.get("session_id")
        if sid and e.get("event") in ("session_heartbeat", "app_closed"):
            p = props(e)
            if p.get("session_ms", 0) >= latest.get(sid, {}).get("session_ms", 0):
                latest[sid] = p
    if latest:
        active = sorted(p.get("active_total_ms", p.get("active_ms", 0)) / 60000 for p in latest.values())
        heading("Session length")
        print(f"  median active time: {active[len(active) // 2]:.1f} min over {len(active):,} sessions")
        print(f"  total active time: {sum(active) / 60:.1f} h")
    heading("Screens (screen_view)")
    print_counts(Counter(props(e).get("screen", "?") for e in data if e.get("event") == "screen_view"), 10)


def print_models(data: list[dict]):
    heading("Models (token_consumption)")
    tokens = Counter()
    for e in data:
        if e.get("event") == "token_consumption":
            tokens[props(e).get("model", "unknown")] += props(e).get("total_tokens", 0)
    print_counts(tokens, 10)
    heading("Models with a thumbs-down (feedback_bad)")
    print_counts(Counter(props(e).get("model", "unknown") for e in data if e.get("event") == "feedback_bad"), 10)


def print_errors(data: list[dict]):
    heading("Errors (error_encountered, by type)")
    print_counts(Counter(props(e).get("type", "unknown") for e in data if e.get("event") == "error_encountered"))


def print_updates(data: list[dict]):
    by = Counter(e.get("event") for e in data)
    heading("Updates")
    for name in ("update_available", "update_started", "update_finished", "update_failed"):
        print(f"  {name}: {by.get(name, 0):,}")
    reasons = Counter(props(e).get("reason", "unknown") for e in data if e.get("event") == "update_failed")
    if reasons:
        print(f"  failure reasons: {dict(reasons)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("source", nargs="?", default="./telemetry-data", help="directory of *.jsonl, or one .jsonl file")
    parser.add_argument("--days", type=int, default=7, help="window for the active count")
    args = parser.parse_args()

    source = Path(args.source).expanduser()
    data = load_data(source) if source.exists() else []
    if not data:
        print(f"No telemetry data found in {source}")
        return

    print_summary(data)
    print_active(data, args.days)
    print_engagement(data)
    print_models(data)
    print_errors(data)
    print_updates(data)


if __name__ == "__main__":
    main()
