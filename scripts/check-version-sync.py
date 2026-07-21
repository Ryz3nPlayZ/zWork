#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_cargo_version(path: Path) -> str:
    """Extract [package].version from a Cargo.toml without a TOML dependency.

    tomllib is 3.11+ and tomli isn't installed on the default macOS python3
    (3.9), so parse the first `version = "..."` under [package] with a regex.
    """
    text = path.read_text(encoding="utf-8")
    # Slice off everything after [dependencies] so we don't grab a dep version.
    pkg = text.split("[dependencies]", 1)[0]
    m = re.search(r'^version\s*=\s*"([^"]+)"', pkg, re.MULTILINE)
    if not m:
        raise SystemExit(f"could not find [package].version in {path}")
    return m.group(1)


def read_cask_version(path: Path) -> str:
    """Extract version from Homebrew cask file."""
    text = path.read_text(encoding="utf-8")
    m = re.search(r'^\s*version\s*"([^"]+)"', text, re.MULTILINE)
    if not m:
        raise SystemExit(f"could not find version in {path}")
    return m.group(1)


def main() -> int:
    package_version = json.loads((ROOT / "app/package.json").read_text(encoding="utf-8"))["version"]
    tauri_version = json.loads((ROOT / "app/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"]
    cargo_version = read_cargo_version(ROOT / "app/src-tauri/Cargo.toml")
    cask_version = read_cask_version(ROOT / "Casks/zwork.rb")

    versions = {
        "app/package.json": package_version,
        "app/src-tauri/tauri.conf.json": tauri_version,
        "app/src-tauri/Cargo.toml": cargo_version,
        "Casks/zwork.rb": cask_version,
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
