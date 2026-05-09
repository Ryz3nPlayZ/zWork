"""Secret storage for provider API keys.

Primary path:
  - OS keyring via the `keyring` package.

Fallback:
  - a local `secrets.json` file under `ZWORK_HOME` when no keyring backend is
    available or the platform is unsupported.

`settings.json` only keeps credential names as presence markers. The actual
secret values live in the store selected here.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping

from .home import zwork_home

SERVICE_NAME = "zwork"
SECRET_FILE_NAME = "secrets.json"
ENV_STORE_MODE = "ZWORK_SECRET_STORE"

_KEYRING_AVAILABLE: bool | None = None


def _mode() -> str:
    return (os.environ.get(ENV_STORE_MODE) or "auto").strip().lower()


def _secret_file() -> Path:
    return zwork_home() / SECRET_FILE_NAME


def _load_keyring():
    global _KEYRING_AVAILABLE
    if _KEYRING_AVAILABLE is False:
        return None
    try:
        import keyring  # type: ignore

        _KEYRING_AVAILABLE = True
        return keyring
    except Exception:
        _KEYRING_AVAILABLE = False
        return None


def _account(credential: str) -> str:
    return f"api-key:{credential}"


def _read_file_store() -> dict[str, str]:
    path = _secret_file()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    keys = data.get("api_keys") or {}
    if not isinstance(keys, dict):
        return {}
    out: dict[str, str] = {}
    for credential, value in keys.items():
        if isinstance(credential, str) and isinstance(value, str) and value:
            out[credential] = value
    return out


def _write_file_store(keys: Mapping[str, str]) -> None:
    path = _secret_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {"api_keys": {k: v for k, v in keys.items() if v}}
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _delete_from_file_store(credential: str) -> None:
    current = _read_file_store()
    if credential in current:
        current.pop(credential, None)
        if current:
            _write_file_store(current)
        else:
            path = _secret_file()
            if path.exists():
                path.unlink()


def get_api_key(credential: str) -> str:
    if not credential:
        return ""

    mode = _mode()
    if mode in ("auto", "keyring"):
        keyring = _load_keyring()
        if keyring is not None:
            try:
                value = keyring.get_password(SERVICE_NAME, _account(credential))
                if value:
                    return value
            except Exception:
                if mode == "keyring":
                    return ""

    if mode in ("auto", "file"):
        return _read_file_store().get(credential, "")

    return ""


def set_api_key(credential: str, value: str) -> None:
    if not credential:
        return

    value = value or ""
    mode = _mode()
    keyring = _load_keyring() if mode in ("auto", "keyring") else None

    if value:
        if keyring is not None:
            try:
                keyring.set_password(SERVICE_NAME, _account(credential), value)
                if mode == "auto":
                    _delete_from_file_store(credential)
                return
            except Exception:
                if mode == "keyring":
                    raise

        if mode in ("auto", "file"):
            current = _read_file_store()
            current[credential] = value
            _write_file_store(current)
        return

    if keyring is not None:
        try:
            keyring.delete_password(SERVICE_NAME, _account(credential))
        except Exception:
            if mode == "keyring":
                raise

    if mode in ("auto", "file"):
        _delete_from_file_store(credential)


def delete_api_key(credential: str) -> None:
    set_api_key(credential, "")


def load_api_keys(credentials: Mapping[str, str] | None = None) -> dict[str, str]:
    """Load API keys for the credential names present in `credentials`.

    Legacy plaintext values from `settings.json` are treated as migration
    sources: if a value exists in the file but not in the secret store, it is
    moved into the secret store and then returned.
    """
    names = list((credentials or {}).keys())
    out: dict[str, str] = {}
    for credential in names:
        value = get_api_key(credential)
        if value:
            out[credential] = value
            continue
        legacy = (credentials or {}).get(credential) or ""
        if legacy:
            out[credential] = legacy
            try:
                set_api_key(credential, legacy)
            except Exception:
                # If migration fails, keep the legacy value in memory so the app
                # still works for this session.
                pass
    return out


def persist_api_keys(keys: Mapping[str, str]) -> dict[str, str]:
    """Write keys to the configured secret store and return file placeholders."""
    placeholders: dict[str, str] = {}
    for credential, value in keys.items():
        if value:
            set_api_key(credential, value)
            placeholders[credential] = ""
        else:
            delete_api_key(credential)
    return placeholders
