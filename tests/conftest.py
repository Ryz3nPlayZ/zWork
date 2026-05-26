"""Shared pytest fixtures for the zWork test suite."""

from __future__ import annotations

import os
import tempfile

import pytest


@pytest.fixture()
def zwork_home(tmp_path):
    """Provide a clean isolated ZWORK_HOME for each test."""
    old = os.environ.get("ZWORK_HOME")
    os.environ["ZWORK_HOME"] = str(tmp_path)
    yield tmp_path
    if old is None:
        os.environ.pop("ZWORK_HOME", None)
    else:
        os.environ["ZWORK_HOME"] = old


@pytest.fixture()
def clean_env(monkeypatch):
    """Strip sensitive environment variables for isolation."""
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    return monkeypatch
