#!/usr/bin/env python3
"""Refresh the bundled Composio app catalogue the Connectors page falls back to.

The live catalogue comes from Composio's Toolkit Catalog API through zWork
Cloud (`GET /api/composio/catalog`). When that can't be reached (signed out,
offline, older cloud), the sidecar serves this snapshot instead so the
storefront still has every app to browse.

Sources, in order:
  --from FILE        a saved `/api/v3/toolkits` items array (the Composio CLI
                     keeps one at ~/.composio/toolkits.json)
  COMPOSIO_API_KEY   fetch the live catalogue from backend.composio.dev

Only apps a person can connect in one step are kept: ones with Composio
managed sign-in, plus the apps zWork Cloud has its own sign-in for.

Usage:
  python3 scripts/sync-composio-catalog.py --from ~/.composio/toolkits.json
  COMPOSIO_API_KEY=... python3 scripts/sync-composio-catalog.py
"""

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "sidecar-rust/src/connectors/composio_catalog.json"
API = "https://backend.composio.dev/api/v3/toolkits"

# Apps zWork Cloud has its own sign-in set up for, even where Composio has no
# managed one (Xero). Keep in step with composio_app_display_map in cloud-src.
ZWORK_AUTH = {
    "gmail", "googlecalendar", "slack", "notion", "googledrive", "github", "jira", "trello",
    "todoist", "linear", "asana", "hubspot", "outlook", "one_drive", "excel",
    "microsoft_teams", "quickbooks", "xero",
}


def fetch_live(key: str) -> list:
    items, cursor = [], None
    while True:
        url = f"{API}?limit=1000" + (f"&cursor={cursor}" if cursor else "")
        req = urllib.request.Request(url, headers={"x-api-key": key})
        with urllib.request.urlopen(req, timeout=60) as r:
            page = json.load(r)
        items += page.get("items", [])
        cursor = page.get("next_cursor")
        if not cursor:
            return items


def normalise(t: dict) -> dict | None:
    slug = t.get("slug", "").lower()
    managed = bool(t.get("composio_managed_auth_schemes"))
    if not slug or t.get("no_auth") or t.get("is_local_toolkit"):
        return None
    if not managed and slug not in ZWORK_AUTH:
        return None
    meta = t.get("meta") or {}
    return {
        "slug": slug,
        "name": t.get("name") or slug,
        "description": (meta.get("description") or "").strip(),
        "logo": meta.get("logo") or f"https://logos.composio.dev/api/{slug}",
        "categories": [c.get("name", "") for c in meta.get("categories", []) if c.get("name")],
        "auth": t.get("auth_schemes") or [],
        "tools": meta.get("tools_count") or 0,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src")
    args = ap.parse_args()
    if args.src:
        raw = json.loads(Path(args.src).expanduser().read_text())
        raw = raw.get("items", raw) if isinstance(raw, dict) else raw
    elif os.environ.get("COMPOSIO_API_KEY"):
        raw = fetch_live(os.environ["COMPOSIO_API_KEY"])
    else:
        sys.exit("Pass --from FILE or set COMPOSIO_API_KEY")
    apps = sorted(filter(None, map(normalise, raw)), key=lambda a: a["name"].lower())
    OUT.write_text(json.dumps({"toolkits": apps}, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"{len(apps)} apps -> {OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT}")


if __name__ == "__main__":
    main()
