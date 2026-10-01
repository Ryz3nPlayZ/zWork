"""Configuration: model profiles, run budgets, paths.

A *ModelProfile* is the full description of how to register a model with the
zWork sidecar in-container. The harness is model-agnostic — adding a model is a
new entry in :data:`PROFILES`. Two built-in profiles:

- ``neutral`` (default) — a neutral shared model (Claude Sonnet 4) so the
  resolved-rate is apples-to-apples with other harnesses (which report numbers
  on the same model). This measures *harness* quality.
- ``product`` — zWork's own router model. An end-to-end product number; not
  comparable across harnesses since they run different models.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ModelProfile:
    """How to register one model with every harness.

    The ``model_selectors`` map is the same-LLM guarantee: each entry is the
    selector string a *different* harness needs to reach the *same* upstream
    snapshot. All three must resolve to identical model weights — that's what
    makes a head-to-head fair. The README documents the exact snapshot each
    selector points at so a reader can verify.
    """

    name: str
    # The `model` value the driver POSTs to /api/chat/stream. Must match the
    # CustomModel.id written into the in-container settings.json.
    model_id: str
    # Upstream model identifier the provider resolves this to.
    upstream_model: str
    # Provider shape: "anthropic" (Messages API) or "openai" (Chat Completions).
    shape: str
    # Credential name — matches a key in secrets.json `api_keys`.
    credential: str
    # Human label for reports.
    label: str
    # Per-harness selector strings for the SAME upstream snapshot. Keys are
    # harness names: "zwork", "claude-code", "opencode".
    model_selectors: dict[str, str] = field(default_factory=dict)

    def settings_entry(self) -> dict[str, Any]:
        """The single CustomModel entry to merge into in-container settings.json.

        zWork's sidecar reads ``base_url_override`` on a CustomModel and, when
        set, talks to that URL directly instead of the zWork Cloud Router. We
        use that to point zWork straight at the provider (e.g. DeepSeek's
        Anthropic-compatible endpoint) — same path the competitors take. The
        override is resolved from :data:`PROFILE_BASE_URL` by profile name.
        """
        return {
            "id": self.model_id,
            "name": self.label,
            "shape": self.shape,
            "credential": self.credential,
            "model_id": self.upstream_model,
            "base_url_override": PROFILE_BASE_URL.get(self.name, ""),
        }


# The shared snapshot for the headline head-to-head. All three harnesses reach
# the SAME model via the selectors below. DeepSeek-V4 Pro is the natural pick:
# it's zWork Pro's underlying model AND Claude Code reaches it via
# `claudeswitch deepseek` (Anthropic-compatible endpoint) AND OpenCode supports
# it natively. No Anthropic key required anywhere.
DEEPSEEK_SNAPSHOT = "deepseek-v4-pro"
DEEPSEEK_ANTHROPIC_URL = "https://api.deepseek.com/anthropic"
DEEPSEEK_OPENAI_URL = "https://api.deepseek.com"


def _deepseek_selectors(zwork_id: str) -> dict[str, str]:
    """DeepSeek-V4 Pro, three harness-specific selector strings."""
    return {
        "zwork": zwork_id,                  # CustomModel.id in settings.json
        "claude-code": DEEPSEEK_SNAPSHOT,   # ANTHROPIC_MODEL value (via claudeswitch)
        "opencode": f"deepseek/{DEEPSEEK_SNAPSHOT}",  # provider/model
    }


# --- Built-in profiles ------------------------------------------------------
#
# The ``deepseek`` profile is the headline head-to-head: same model every
# harness can reach through a credential the team already has. zWork and
# Claude Code both hit DeepSeek's Anthropic-compatible endpoint directly
# (zWork via base_url_override on a custom model; Claude Code via the same
# ANTHROPIC_BASE_URL/ANTHROPIC_MODEL env vars that `claudeswitch deepseek`
# writes). OpenCode reaches it natively. The zWork Cloud Router is bypassed
# on purpose — router latency/retry shouldn't be credited to zWork's harness
# quality or penalized against it.
PROFILES: dict[str, ModelProfile] = {
    "deepseek": ModelProfile(
        name="deepseek",
        model_id="bench-deepseek-pro",
        upstream_model=DEEPSEEK_SNAPSHOT,
        shape="anthropic",
        credential="deepseek",
        label="DeepSeek-V4 Pro (direct)",
        model_selectors=_deepseek_selectors("bench-deepseek-pro"),
        # type: ignore — base_url_override is a new field; see below.
    ),
    # zWork's own router models — runs zWork end-to-end through its real product
    # path. NOT comparable head-to-head (competitors would need the same router
    # credential to reach the same model). Useful for the internal product number.
    "product-pro": ModelProfile(
        name="product-pro",
        model_id="zwork-pro",
        upstream_model="zwork-pro",  # router-side alias → deepseek-v4-pro
        shape="anthropic",
        credential="zwork_router",
        label="zWork Pro (via router)",
        model_selectors={"zwork": "zwork-pro"},
    ),
    "product-ultimate": ModelProfile(
        name="product-ultimate",
        model_id="zwork-ultimate",
        upstream_model="zwork-ultimate",
        shape="openai",
        credential="zwork_router",
        label="zWork Ultimate (via router)",
        model_selectors={"zwork": "zwork-ultimate"},
    ),
}

DEFAULT_PROFILE = "deepseek"

# Per-profile base_url_override: when set, zWork's sidecar talks to this URL
# directly instead of the router. Only the deepseek profile uses this today.
# We attach it as a module-level map rather than a dataclass field to keep
# ModelProfile hashable/picklable for the process pool.
PROFILE_BASE_URL: dict[str, str] = {
    "deepseek": DEEPSEEK_ANTHROPIC_URL,
}


def get_profile(name: str) -> ModelProfile:
    if name not in PROFILES:
        raise ValueError(
            f"Unknown model profile {name!r}. Known: {sorted(PROFILES)}"
        )
    return PROFILES[name]


# --- Per-run configuration --------------------------------------------------


@dataclass
class RunConfig:
    """Everything that defines one benchmark run."""

    profile: ModelProfile
    subset: str = "subset"  # smoke | subset | full | comma-separated ids
    parallel: int = 4
    max_turns: int = 40
    wall_timeout_s: int = 1200  # 20 min per instance — SWE-bench-hard tasks can be long
    sidecar_port: int = 8787
    sidecar_binary: str = ""  # path to prebuilt rwork-backend; empty = build in CI
    runs_dir: Path = field(default_factory=lambda: Path("bench/runs"))
    instance_filter: tuple[str, ...] = ()  # if non-empty, restrict to these ids
    keep_containers: bool = False  # for debugging — don't rm containers on exit

    @property
    def run_timestamp_dir(self) -> Path:
        import datetime as _dt

        ts = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        return self.runs_dir / ts

    def sidecar_env(self, api_key: str) -> dict[str, str]:
        """Env vars to launch the sidecar with inside each SWE-bench container."""
        env: dict[str, str] = {
            "ZWORK_HOST": "0.0.0.0",
            "ZWORK_PORT": str(self.sidecar_port),
            "ZWORK_SIDECAR_TOKEN": os.environ.get(
                "ZWORK_SIDECAR_TOKEN", _ephemeral_token()
            ),
            # The two fairness flags — see sidecar settings.rs / tools/mod.rs.
            "ZWORK_CODING_ONLY": "1",
            "ZWORK_MAX_TURNS": str(self.max_turns),
            # Put zWork home inside the container's testbed workspace so it
            # doesn't collide with the repo under test at /testbed.
            "ZWORK_HOME": "/root/.zwork",
            "RUST_LOG": "warn",
        }
        # Hand the API key to the sidecar under the credential name the
        # profile expects. The driver also writes it into secrets.json, but
        # the env var is the belt-and-suspenders path.
        cred_env = _credential_env_name(self.profile.credential)
        if api_key:
            env[cred_env] = api_key
        return env


# --- helpers ----------------------------------------------------------------


def _ephemeral_token() -> str:
    import secrets as _s

    return _s.token_urlsafe(24)


def _credential_env_name(credential: str) -> str:
    """The env var the zWork secretstore conventionally reads for a credential.

    The sidecar reads keys from ~/.zwork/secrets.json (written by the driver),
    so this is only a fallback — but we set it so the sidecar works even before
    secrets.json is written.
    """
    return f"{credential.upper()}_API_KEY"


def resolve_api_key(profile: ModelProfile) -> str:
    """Pull the API key for a profile from the environment.

    Security: the key is NEVER read from the repo, only from the operator's
    environment. For DeepSeek this is the same token ``claudeswitch deepseek``
    writes into Claude Code's settings — set it as ``DEEPSEEK_API_KEY``.
    """
    if profile.credential == "deepseek":
        return os.environ.get("DEEPSEEK_API_KEY", "")
    if profile.credential == "zwork_router":
        return os.environ.get("ZWORK_ROUTER_TOKEN", "") or os.environ.get(
            "ZWORK_GATEWAY_TOKEN", ""
        )
    if profile.credential == "anthropic":
        return os.environ.get("ANTHROPIC_API_KEY", "")
    return os.environ.get(_credential_env_name(profile.credential), "")
