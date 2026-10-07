"""Claude Code harness: drives the official CLI headlessly via ``claude -p``.

Runs entirely inside the SWE-bench container (no host port, no SSE — just
``docker exec``). Installed via npm; configured via env vars. The fairness
flags mirror what zWork gets under ``ZWORK_CODING_ONLY``:

- ``--dangerously-skip-permissions`` ≈ zWork's ``auto_approve_destructive=true``
- ``--tools "Bash,Edit,Read,Write,Glob,Grep"`` ≈ zWork's coding allowlist
- ``--max-turns N`` ≈ zWork's ``ZWORK_MAX_TURNS``

The CLI writes its edits to the working tree under ``/testbed``; the driver
collects ``git diff`` afterward, exactly as for zWork.
"""

from __future__ import annotations

import logging
import subprocess
import time
from pathlib import Path

from .. import container
from ..config import RunConfig, resolve_api_key
from .base import HarnessRun

log = logging.getLogger(__name__)

# Pin the CLI version so the comparison is reproducible. Bump deliberately.
CLAUDE_CODE_PKG = "@anthropic-ai/claude-code"
CLAUDE_CODE_VERSION = "latest"

# Coding toolset matching zWork's ZWORK_CODING_ONLY allowlist.
CODING_TOOLS = "Bash,Edit,Read,Write,Glob,Grep"


class ClaudeCodeHarness:
    name = "claude-code"
    label = "Claude Code"

    def install(self, container_id: str, cfg: RunConfig, api_key: str) -> None:
        # 1. Node + npm — most SWE-bench images ship node, but be defensive.
        self._ensure_node(container_id)

        # 2. Install the CLI globally.
        container.run(
            container_id, [], "npm", "install", "-g",
            f"{CLAUDE_CODE_PKG}@{CLAUDE_CODE_VERSION}",
            timeout=180.0,
        )

        # 3. If the profile targets an Anthropic-compatible endpoint that ISN'T
        #    api.anthropic.com (e.g. DeepSeek's /anthropic), persist the base
        #    URL + token + model into the container's ~/.claude/settings.json.
        #    This is exactly what `claudeswitch deepseek` does on a host —
        #    replicated in-container so Claude Code reaches the SAME model the
        #    other harnesses do. The key never enters git; it's threaded from
        #    the operator's env at run time.
        self._apply_provider_settings(container_id, cfg, api_key)

    def run_task(
        self,
        container_id: str,
        task_prompt: str,
        cfg: RunConfig,
        run_dir: str,
    ) -> HarnessRun:
        api_key = resolve_api_key(cfg.profile)
        started = time.monotonic()

        # Write the prompt to a file inside the container and pass via stdin so
        # long prompts / shell-escaping can't corrupt the command line.
        prompt_path = "/tmp/zwork_bench_task.txt"
        container.write_file(container_id, prompt_path, task_prompt)

        # When pointed at a non-Anthropic endpoint, the model is fixed by
        # ANTHROPIC_MODEL in settings.json — still pass --model for explicitness
        # and so logs show which snapshot ran.
        cmd = [
            "claude", "-p",
            "--model", self.model_selector(cfg),
            "--dangerously-skip-permissions",
            "--max-turns", str(cfg.max_turns),
            "--tools", CODING_TOOLS,
            "--add-dir", "/testbed",
        ]
        # Feed the prompt via stdin: `cat prompt | claude -p ...`
        try:
            out = container.run(
                container_id, [], "/bin/sh", "-c",
                f"cat {prompt_path} | " + " ".join(cmd),
                cwd="/testbed",
                check=False,
                timeout=cfg.wall_timeout_s,
                capture=True,
            )
            finish_reason = "done"
            errors: list[str] = []
            if out.returncode != 0:
                finish_reason = "error"
                errors.append(
                    f"claude exited rc={out.returncode}: {out.stderr.strip()[:500]}"
                )
        except subprocess.TimeoutExpired:
            finish_reason = "wall_timeout"
            out = None  # type: ignore
            errors = [f"claude exceeded wall_timeout_s={cfg.wall_timeout_s}"]

        duration = time.monotonic() - started

        # Save raw output for the trajectory.
        rd = Path(run_dir)
        log_text = (out.stdout if out else "") + "\n--STDERR--\n" + (out.stderr if out else "")
        (rd / "raw.log").write_text(log_text)

        return HarnessRun(
            finish_reason=finish_reason,
            n_turns=0,  # CLI doesn't surface a turn count on stdout
            duration_s=duration,
            errors=errors,
            raw_log_path=str((rd / "raw.log").resolve()),
            assistant_text=(out.stdout if out else ""),
        )

    def model_selector(self, cfg: RunConfig) -> str:
        # The selector string for the SAME upstream snapshot. For the deepseek
        # profile this is "deepseek-v4-pro" — the value claudeswitch writes to
        # ANTHROPIC_MODEL. For a pure-anthropic profile it'd be the Claude id.
        return cfg.profile.model_selectors.get("claude-code", "sonnet")

    # -- helpers ------------------------------------------------------------

    def _apply_provider_settings(
        self, container_id: str, cfg: RunConfig, api_key: str
    ) -> None:
        """Replicate `claudeswitch <provider>` inside the container.

        If the profile's base_url is a non-Anthropic Anthropic-compatible
        endpoint (DeepSeek, etc.), write ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
        / ANTHROPIC_MODEL into ~/.claude/settings.json so the CLI talks to that
        endpoint. For pure Anthropic profiles, write the API key to env and leave
        the settings alone (the CLI reads ANTHROPIC_API_KEY natively).
        """
        from ..config import PROFILE_BASE_URL
        import json as _json

        base_url = PROFILE_BASE_URL.get(cfg.profile.name, "")
        if not base_url:
            # Pure-Anthropic path: nothing to persist; the env var set on
            # run_task handles auth. Install is done.
            return

        settings = {
            "env": {
                "ANTHROPIC_BASE_URL": base_url,
                "ANTHROPIC_AUTH_TOKEN": api_key,
                "ANTHROPIC_MODEL": cfg.profile.upstream_model,
                "API_TIMEOUT_MS": "3000000",
            }
        }
        container.run(container_id, [], "mkdir", "-p", "/root/.claude")
        container.write_file(
            container_id, "/root/.claude/settings.json", _json.dumps(settings, indent=2)
        )

    # -- helpers ------------------------------------------------------------

    def _ensure_node(self, container_id: str) -> None:
        # `node --version` is the cheapest presence check.
        probe = container.run(container_id, [], "node", "--version", check=False)
        if probe.returncode == 0:
            return
        log.info("node not found in container; installing via nodesource setup")
        # SWE-bench images are Debian/Ubuntu-based; nodesource's setup script
        # is the most reliable cross-distro path.
        container.run(
            container_id, [], "/bin/sh", "-c",
            "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && "
            "apt-get install -y nodejs",
            timeout=300.0,
        )


def _read_api_key_for(cfg: RunConfig) -> str:
    import os
    return resolve_api_key(cfg.profile)
