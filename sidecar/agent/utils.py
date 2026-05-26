"""Shared utility functions for the sidecar agent."""

from __future__ import annotations

import secrets
import time
import uuid


def now_ms() -> int:
    """Return the current UTC time as a Unix timestamp in milliseconds."""
    return int(time.time() * 1000)


def uid() -> str:
    """Return a random 12-character hex string suitable for use as a short unique ID."""
    return uuid.uuid4().hex[:12]


def new_id(prefix: str) -> str:
    """Return a prefixed unique identifier in the format ``{prefix}_{16-hex-chars}``."""
    return f"{prefix}_{secrets.token_hex(8)}"
