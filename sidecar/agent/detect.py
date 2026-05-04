"""Detect local AI CLI tool configurations that zWork can reuse.

Currently supported for credential reuse:
  - local credentials (`~/.claude/settings.json` env block)

Detected only (presence/status, no credential reuse yet):
  - OpenAI Codex CLI  (`~/.codex/`)
  - GitHub Copilot    (`~/.config/github-copilot/`)
  - MLX local runtime (`mlx_lm.server`, Apple Silicon only)
"""
from __future__ import annotations

import json
import os
import platform
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Integration:
    id: str
    name: str
    detected: bool
    can_reuse_credentials: bool
    detail: str = ""
    path: str = ""


def _claude_code() -> Integration:
    settings = Path("~/.claude/settings.json").expanduser()
    profile = Path("~/.claude.json").expanduser()
    present = settings.exists() or profile.exists()
    detail = ""
    reuse = False
    if settings.exists():
        try:
            data = json.loads(settings.read_text())
            env = data.get("env") or {}
            if env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY"):
                reuse = True
                base = env.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
                detail = f"Will use local credentials (base: {base})"
            else:
                detail = "Installed; no API token in env block"
        except Exception as e:  # pragma: no cover
            detail = f"Found settings.json but failed to parse: {e}"
    elif profile.exists():
        detail = "Installed (OAuth mode; token reuse not yet supported)"
    return Integration(
        id="claude_code",
        name="Local credentials",
        detected=present,
        can_reuse_credentials=reuse,
        detail=detail,
        path=str(settings if settings.exists() else profile),
    )


def _codex() -> Integration:
    d = Path("~/.codex").expanduser()
    present = d.exists() and d.is_dir()
    detail = "Installed (OAuth-based; credential reuse WIP)" if present else ""
    return Integration(
        id="codex",
        name="OpenAI Codex CLI",
        detected=present,
        can_reuse_credentials=False,
        detail=detail,
        path=str(d) if present else "",
    )


def _copilot() -> Integration:
    d = Path("~/.config/github-copilot").expanduser()
    present = d.exists() and d.is_dir()
    detail = "Installed (Copilot tokens are not reusable for chat API)" if present else ""
    return Integration(
        id="github_copilot",
        name="GitHub Copilot",
        detected=present,
        can_reuse_credentials=False,
        detail=detail,
        path=str(d) if present else "",
    )


def _mlx() -> Integration:
    """MLX is Apple's native ML runtime for Apple Silicon. `mlx_lm.server`
    exposes an OpenAI-compatible HTTP server, so once it's running the user
    can point a custom model at `http://localhost:8080/v1`. We don't auto-spawn
    the server here; we just surface presence so the UI can hint the user.
    """
    is_apple_silicon = platform.machine() == "arm64" and platform.system() == "Darwin"
    binary = shutil.which("mlx_lm.server")
    if not is_apple_silicon:
        return Integration(
            id="mlx",
            name="MLX (Apple Silicon)",
            detected=False,
            can_reuse_credentials=False,
            detail="Requires Apple Silicon (arm64 macOS)",
            path="",
        )
    if not binary:
        return Integration(
            id="mlx",
            name="MLX (Apple Silicon)",
            detected=False,
            can_reuse_credentials=False,
            detail="Install with: pip install mlx-lm",
            path="",
        )
    return Integration(
        id="mlx",
        name="MLX (Apple Silicon)",
        detected=True,
        can_reuse_credentials=False,
        detail="Run `mlx_lm.server --model <id>`, then add a model with base_url http://localhost:8080/v1",
        path=binary,
    )


def detect_all() -> list[Integration]:
    return [_claude_code(), _codex(), _copilot(), _mlx()]


def read_claude_code_env() -> dict[str, str]:
    """Return the env block from local credential settings, or {}."""
    settings = Path("~/.claude/settings.json").expanduser()
    if not settings.exists():
        return {}
    try:
        data = json.loads(settings.read_text())
        env = data.get("env") or {}
        return {k: str(v) for k, v in env.items() if isinstance(k, str)}
    except Exception:
        return {}


def read_claude_code_model() -> str | None:
    """Return the `model` field from local credential settings if any."""
    settings = Path("~/.claude/settings.json").expanduser()
    if not settings.exists():
        return None
    try:
        data = json.loads(settings.read_text())
        m = data.get("model")
        return str(m) if m else None
    except Exception:
        return None


def env_anthropic_credentials() -> tuple[str | None, str | None]:
    """Return (token, base_url) from current process env (already-exported vars)."""
    token = os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
    base = os.environ.get("ANTHROPIC_BASE_URL")
    return token, base
