#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def normalize_tag(value: str) -> str:
    return value[1:] if value.startswith("v") else value


def changelog_section(changelog: Path, version: str) -> str:
    text = changelog.read_text(encoding="utf-8")
    pattern = rf"## v{re.escape(version)}\n(.*?)(?=\n## |\Z)"
    match = re.search(pattern, text, re.DOTALL)
    return match.group(1).strip() if match else "See CHANGELOG.md for details."


def platform_keys(asset_name: str) -> list[str]:
    if asset_name.endswith(".AppImage"):
        m = re.search(r"zWork-linux-([^.]+)\.AppImage$", asset_name)
        if m:
            return [f"linux-{m.group(1)}"]
    if asset_name.endswith(".app.tar.gz"):
        if asset_name == "zWork-macos-universal.app.tar.gz":
            return ["darwin-x86_64", "darwin-aarch64"]
        m = re.search(r"zWork-macos-([^.]+)\.app\.tar\.gz$", asset_name)
        if m:
            return [f"darwin-{m.group(1)}"]
    if asset_name.endswith("-setup.exe"):
        m = re.search(r"zWork-windows-([^-]+)-setup\.exe$", asset_name)
        if m:
            return [f"windows-{m.group(1)}"]
    return []


def paired_signature(path: Path) -> str:
    sig = path.with_name(path.name + ".sig")
    if not sig.exists():
        raise FileNotFoundError(f"missing signature for {path.name}")
    return sig.read_text(encoding="utf-8").strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate zWork updater manifest for GitHub Releases.")
    parser.add_argument("--dist", default="dist", help="Path to release artifact directory")
    parser.add_argument("--repo", default="Ryz3nPlayZ/zWork", help="GitHub repo in owner/name form")
    parser.add_argument("--tag", required=True, help="Release tag, e.g. v0.1.0")
    parser.add_argument("--out", default=None, help="Output file path (defaults to dist/latest.json)")
    parser.add_argument("--notes", default=None, help="Release notes text; defaults to CHANGELOG section")
    args = parser.parse_args()

    dist = Path(args.dist)
    if not dist.is_dir():
        raise SystemExit(f"dist directory not found: {dist}")

    version = normalize_tag(args.tag)
    notes = args.notes if args.notes is not None else changelog_section(Path("CHANGELOG.md"), version)
    pub_date = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    manifest: dict[str, object] = {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": {},
    }

    base_url = f"https://github.com/{args.repo}/releases/download/{args.tag}"
    for asset in sorted(dist.iterdir()):
        if not asset.is_file():
            continue
        if asset.name.endswith(".sig") or asset.name == "latest.json":
            continue
        keys = platform_keys(asset.name)
        if not keys:
            continue
        signature = paired_signature(asset)
        for key in keys:
            manifest["platforms"][key] = {
                "url": f"{base_url}/{asset.name}",
                "signature": signature,
            }

    if not manifest["platforms"]:
        raise SystemExit("no updater-capable assets found in dist/")

    out = Path(args.out) if args.out else dist / "latest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
