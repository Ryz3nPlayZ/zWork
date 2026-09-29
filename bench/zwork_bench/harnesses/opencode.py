"""OpenCode harness: drives the OpenCode CLI headlessly via ``opencode run``.

Installed via the official curl installer; run via ``docker exec``. OpenCode
ships a coding-focused toolset by default (no desktop/browser tools), so no
tool restriction is needed for fairness — the asymmetry is documented in the
report. Has no native max-turns flag, so we bound only by wall-clock.

Fairness flags:
- ``--auto`` ≈ zWork's ``auto_approve_destructive=true``
- ``--model anthropic/<snapshot>`` resolves to the same upstream model as the
  other harnesses
- ``--dir /testbed`` sets the working directory
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


class OpenCodeHarness:
    name = "opencode"
    label = "OpenCode"

    def install(self, container_id: str, cfg: RunConfig, api_key: str) -> None:
        # The official installer drops the `opencode` binary on PATH. It needs
        # no API key — the key is threaded at run time via _env_for_profile.
        container.run(
            container_id, [], "/bin/sh", "-c",
            "curl -fsSL https://opencode.ai/install | bash",
            timeout=180.0,
        )
        # The installer typically adds to ~/.local/bin or /usr/local/bin; make
        # sure `opencode` resolves from a non-login shell.
        probe = container.run(container_id, [], "opencode", "--version", check=False)
        if probe.returncode != 0:
            # Common fallback locations.
            for cand in ("/root/.local/bin/opencode", "/usr/local/bin/opencode"):
                exists = container.run(
                    container_id, [], "test", "-x", cand, check=False
                )
                if exists.returncode == 0:
                    container.run(
                        container_id, [], "ln", "-sf", cand, "/usr/local/bin/opencode",
                        check=False,
                    )
                    break

    def run_task(
        self,
        container_id: str,
        task_prompt: str,
        cfg: RunConfig,
        run_dir: str,
    ) -> HarnessRun:
        api_key = resolve_api_key(cfg.profile)
        started = time.monotonic()

        # Write the prompt to a file and pass via the shell to dodge quoting.
        prompt_path = "/tmp/zwork_bench_task.txt"
        container.write_file(container_id, prompt_path, task_prompt)

        cmd = [
            "opencode", "run",
            "--model", self.model_selector(cfg),
            "--auto",
            "--dir", "/testbed",
        ]
        # OpenCode reads provider API keys from env: DEEPSEEK_API_KEY for the
        # deepseek provider, ANTHROPIC_API_KEY for anthropic, etc. Build the
        # env map from the profile's credential so all three harnesses share
        # the same key for the same model.
        env = self._env_for_profile(cfg, api_key)
        try:
            out = container.run(
                container_id, [], "/bin/sh", "-c",
                f"cat {prompt_path} | " + " ".join(cmd),
                env=env,
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
                    f"opencode exited rc={out.returncode}: {out.stderr.strip()[:500]}"
                )
        except subprocess.TimeoutExpired:
            finish_reason = "wall_timeout"
            out = None  # type: ignore
            errors = [f"opencode exceeded wall_timeout_s={cfg.wall_timeout_s}"]

        duration = time.monotonic() - started
        rd = Path(run_dir)
        log_text = (out.stdout if out else "") + "\n--STDERR--\n" + (out.stderr if out else "")
        (rd / "raw.log").write_text(log_text)

        return HarnessRun(
            finish_reason=finish_reason,
            n_turns=0,  # CLI doesn't surface a turn count
            duration_s=duration,
            errors=errors,
            raw_log_path=str((rd / "raw.log").resolve()),
            assistant_text=(out.stdout if out else ""),
        )

    def _env_for_profile(self, cfg: RunConfig, api_key: str) -> dict[str, str]:
        """Map the profile's credential to the env var OpenCode expects."""
        cred = cfg.profile.credential
        if cred == "deepseek":
            return {"DEEPSEEK_API_KEY": api_key}
        if cred == "anthropic":
            return {"ANTHROPIC_API_KEY": api_key}
        if cred == "zwork_router":
            return {"OPENAI_API_KEY": api_key}
        return {f"{cred.upper()}_API_KEY": api_key}

    def model_selector(self, cfg: RunConfig) -> str:
        return cfg.profile.model_selectors.get(
            "opencode", f"anthropic/{cfg.profile.upstream_model}"
        )
