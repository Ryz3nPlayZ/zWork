from __future__ import annotations

import os
import sys
from pathlib import Path


def zwork_home() -> Path:
    """Root directory for zWork's user data."""
    root = Path(os.environ.get("ZWORK_HOME", "~/.zwork")).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return root


def settings_path() -> Path:
    return zwork_home() / "settings.json"


def chats_dir() -> Path:
    d = zwork_home() / "chats"
    d.mkdir(parents=True, exist_ok=True)
    return d


def onboarding_path() -> Path:
    """File that marks whether onboarding has been completed."""
    return zwork_home() / "onboarding.json"


def repo_root() -> Path:
    """
    Best-effort repo root. The desktop app sets CWD to the repo before
    launching the server; in dev we run from the repo as well.
    `zwork.md` and `zWork-Skills/` both live here.

    Packaged PyInstaller builds can expose bundled data through ``_MEIPASS``;
    when present, treat that as the root that owns the shipped skills tree.
    """
    env = os.environ.get("ZWORK_ROOT")
    if env:
        p = Path(env).expanduser()
        if p.exists():
            return p

    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        p = Path(bundle_root)
        if (p / "zWork-Skills").exists():
            return p

    return Path.cwd()


def zwork_md_path() -> Path:
    """
    Resolve the user's zwork.md. Order:
      1. ZWORK_MD env override if set.
      2. repo_root()/zwork.md if it exists.
      3. ~/.zwork/zwork.md (stable home location; where we write by default
         so Settings editors can always find it regardless of CWD).
    """
    env = os.environ.get("ZWORK_MD")
    if env:
        return Path(env).expanduser()
    rr = repo_root() / "zwork.md"
    if rr.exists():
        return rr
    return zwork_home() / "zwork.md"


def memory_path() -> Path:
    return zwork_home() / "memory.md"


def workspace_root() -> Path:
    d = zwork_home() / "workspace"
    d.mkdir(parents=True, exist_ok=True)
    return d


def workspace_apps_dir() -> Path:
    d = workspace_root() / "apps"
    d.mkdir(parents=True, exist_ok=True)
    return d


def workspace_outputs_dir() -> Path:
    d = workspace_root() / "outputs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def workspace_uploads_dir() -> Path:
    d = workspace_root() / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def workspace_scratch_dir() -> Path:
    d = workspace_root() / "scratch"
    d.mkdir(parents=True, exist_ok=True)
    return d


def projects_dir() -> Path:
    d = zwork_home() / "projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_dir(project_id: str) -> Path:
    d = projects_dir() / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def skills_dir() -> Path:
    return repo_root() / "zWork-Skills"


def is_safe_id(id_str: str | None) -> bool:
    """
    Validate that an identifier (like project_id or chat_id) is safe.
    Only allows alphanumeric characters, underscores, and hyphens.
    Permits None but rejects empty strings.
    """
    if id_str is None:
        return True
    if not id_str:
        return False
    import re
    return bool(re.fullmatch(r"[a-zA-Z0-9_-]+", id_str))
