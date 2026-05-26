"""zWork sidecar — local FastAPI backend for the zWork desktop agent."""

from __future__ import annotations

__all__ = ["__version__"]


def _read_version() -> str:
    """Read the package version from importlib.metadata or pyproject.toml."""
    try:
        from importlib.metadata import version

        return version("sidecar")
    except Exception:
        pass
    try:
        import tomllib
        from pathlib import Path

        pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
        if pyproject.exists():
            data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
            return data["project"]["version"]
    except Exception:
        pass
    return "0.0.0-unknown"


__version__ = _read_version()
