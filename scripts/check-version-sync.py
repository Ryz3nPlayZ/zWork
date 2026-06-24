#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    package_version = json.loads((ROOT / "app/package.json").read_text(encoding="utf-8"))["version"]
    tauri_version = json.loads((ROOT / "app/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"]
    cargo_version = tomllib.loads((ROOT / "app/src-tauri/Cargo.toml").read_text(encoding="utf-8"))["package"]["version"]

    versions = {
        "app/package.json": package_version,
        "app/src-tauri/tauri.conf.json": tauri_version,
        "app/src-tauri/Cargo.toml": cargo_version,
    }

    unique_versions = set(versions.values())
    if len(unique_versions) == 1:
        print(package_version)
        return 0

    print("release version mismatch detected:", file=sys.stderr)
    for path, version in versions.items():
        print(f"  {path}: {version}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
