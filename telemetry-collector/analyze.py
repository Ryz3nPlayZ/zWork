#!/usr/bin/env python3
"""
Analyze zWork telemetry data.
"""

import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path


def load_data(telemetry_dir: str = "./telemetry-data"):
    """Load all telemetry jsonl files."""
    data = []
    for file in Path(telemetry_dir).glob("*.jsonl"):
        with file.open("r") as f:
            for line in f:
                try:
                    data.append(json.loads(line.strip()))
                except json.JSONDecodeError:
                    continue
    return data


def print_summary(data: list):
    """Print basic summary statistics."""
    installs = set()
    events = Counter()
    os_counts = Counter()
    versions = Counter()

    for e in data:
        if e.get("install_id"):
            installs.add(e["install_id"])
        events[e.get("event", "unknown")] += 1
        if e.get("os"):
            os_counts[e["os"]] += 1
        if e.get("properties", {}).get("app_version"):
            versions[e["properties"]["app_version"]] += 1

    print("=" * 50)
    print("zWORK TELEMETRY SUMMARY")
    print("=" * 50)
    print(f"\nTotal events: {len(data):,}")
    print(f"Unique installs: {len(installs):,}")

    print("\n--- Events by Type ---")
    for event, count in events.most_common():
        print(f"  {event}: {count:,}")

    print("\n--- Platforms ---")
    for os_name, count in os_counts.most_common():
        print(f"  {os_name}: {count:,}")

    print("\n--- Versions ---")
    for version, count in versions.most_common():
        print(f"  v{version}: {count:,}")

    # Time range
    if data:
        timestamps = [e.get("ts", 0) for e in data if e.get("ts")]
        if timestamps:
            latest = datetime.fromtimestamp(max(timestamps) / 1000)
            earliest = datetime.fromtimestamp(min(timestamps) / 1000)
            print(f"\n--- Time Range ---")
            print(f"  From: {earliest.strftime('%Y-%m-%d %H:%M')}")
            print(f"  To: {latest.strftime('%Y-%m-%d %H:%M')}")


def print_active_users(data: list, days: int = 7):
    """Show active users in the last N days."""
    cutoff = datetime.now() - timedelta(days=days)
    active_installs = set()

    for e in data:
        ts = e.get("ts") or e.get("server_ts")
        if ts:
            when = datetime.fromtimestamp(ts / 1000)
            if when >= cutoff and e.get("install_id"):
                active_installs.add(e["install_id"])

    print(f"\n--- Active in last {days} days ---")
    print(f"  {len(active_installs):,} unique installs")


def print_model_usage(data: list):
    """Show which LLM models are being used."""
    models = Counter()

    for e in data:
        if e.get("event") == "chat_turn_started":
            model = e.get("properties", {}).get("resolved_model", "unknown")
            models[model] += 1

    print("\n--- Model Usage ---")
    for model, count in models.most_common(10):
        print(f"  {model}: {count:,}")


def print_update_stats(data: list):
    """Show update-related stats."""
    updates_available = 0
    updates_completed = 0
    updates_failed = 0
    update_sources = Counter()

    for e in data:
        if e.get("event") == "update_available":
            updates_available += 1
            source = e.get("properties", {}).get("source", "unknown")
            update_sources[source] += 1
        elif e.get("event") == "update_finished":
            updates_completed += 1
        elif e.get("event") == "update_failed":
            updates_failed += 1

    print("\n--- Update Stats ---")
    print(f"  Updates available: {updates_available:,}")
    print(f"  Updates completed: {updates_completed:,}")
    print(f"  Updates failed: {updates_failed:,}")
    print(f"  Sources: {dict(update_sources)}")


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "./telemetry-data"
    data = load_data(data_dir)

    if not data:
        print(f"No telemetry data found in {data_dir}")
        return

    print_summary(data)
    print_active_users(data)
    print_model_usage(data)
    print_update_stats(data)


if __name__ == "__main__":
    main()
