#!/usr/bin/env python3
"""Refresh the embedded provider/model catalog from models.dev.

The sidecar ships this snapshot so the catalog works offline and on first
launch; at runtime it refreshes from models.dev every 24h (see
sidecar-rust/src/harness/providers/catalog.rs). Keeps only tool-capable,
non-deprecated models and the fields the catalog reads.

    python3 scripts/update-models-snapshot.py
"""
import json
import pathlib
import urllib.request

OUT = pathlib.Path(__file__).resolve().parent.parent / "sidecar-rust/src/harness/providers/data/models.json"


def trim(raw: dict) -> dict:
    out = {}
    for pid, p in raw.items():
        models = {}
        for mid, m in p.get("models", {}).items():
            if not m.get("tool_call") or m.get("status") == "deprecated":
                continue
            t = {"id": m.get("id", mid), "name": m.get("name", mid)}
            for k in ("reasoning", "attachment"):
                if m.get(k):
                    t[k] = True
            if "image" in m.get("modalities", {}).get("input", []):
                t["modalities"] = {"input": ["text", "image"]}
            if "limit" in m:
                t["limit"] = {k: v for k, v in m["limit"].items() if k in ("context", "output")}
            if "cost" in m:
                t["cost"] = {k: v for k, v in m["cost"].items() if k in ("input", "output", "cache_read", "cache_write")}
            if "provider" in m:
                t["provider"] = m["provider"]
            models[mid] = t
        if models:
            out[pid] = {k: p[k] for k in ("id", "name", "env", "npm", "api", "doc") if k in p}
            out[pid]["models"] = models
    return out


def main() -> None:
    req = urllib.request.Request("https://models.dev/api.json", headers={"User-Agent": "zwork-snapshot"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = json.load(r)
    data = trim(raw)
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    print(f"{len(data)} providers, {sum(len(p['models']) for p in data.values())} models -> {OUT}")


if __name__ == "__main__":
    main()
