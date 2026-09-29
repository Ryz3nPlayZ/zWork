"""zWork harness: drives the Rust sidecar over HTTP/SSE inside the container.

This is the same code that used to live inline in ``driver.py`` in the first
phase — extracted behind the :class:`Harness` protocol so zWork is one of
several interchangeable competitors. The sidecar runs on a known host port
(published by the container) and is driven like the desktop frontend drives
it, minus rendering.
"""

from __future__ import annotations

import json
import logging
import socket
import subprocess
import time
from pathlib import Path

from .. import container, sidecar_client
from ..config import RunConfig
from .base import Harness, HarnessRun

log = logging.getLogger(__name__)

SIDECAR_PORT = 8787


class ZWorkHarness:
    """Drives ``rwork-backend`` via ``POST /api/chat/stream`` (SSE)."""

    name = "zwork"
    label = "zWork"

    def __init__(self, host_port: int = SIDECAR_PORT) -> None:
        # Host port the container publishes the sidecar on. The driver picks a
        # unique one per worker and passes it via this attribute.
        self.host_port = host_port

    # -- Harness protocol ---------------------------------------------------

    def install(self, container_id: str, cfg: RunConfig, api_key: str) -> None:
        binary = cfg.sidecar_binary
        if not binary or not Path(binary).exists():
            raise RuntimeError(
                f"zWork harness needs --sidecar-binary; not found at {binary!r}."
            )

        # 1. Binary in.
        subprocess.run(
            ["docker", "cp", binary, f"{container_id}:/usr/local/bin/rwork-backend"],
            check=True, capture_output=True,
        )
        container.run(container_id, [], "chmod", "+x", "/usr/local/bin/rwork-backend")

        # 2. ~/.zwork/settings.json + secrets.json — register the pinned model.
        settings = {
            "default_model": cfg.profile.model_id,
            "custom_models": [cfg.profile.settings_entry()],
            "use_claude_code_config": False,
            "telemetry_enabled": False,
            "account_tier": "max",
            "api_keys": {},
            "provider_config": {},
            "telegram_chat_id": "",
            "telemetry_install_id": "",
        }
        secrets = {"api_keys": {cfg.profile.credential: api_key}}

        container.run(container_id, [], "mkdir", "-p", "/root/.zwork")
        container.write_file(container_id, "/root/.zwork/settings.json", json.dumps(settings))
        container.write_file(container_id, "/root/.zwork/secrets.json", json.dumps(secrets))
        container.run(container_id, [], "chmod", "600", "/root/.zwork/secrets.json")

        # 3. Launch sidecar backgrounded with the fairness flags.
        env = cfg.sidecar_env(api_key)
        env["ZWORK_HOST"] = "0.0.0.0"
        env["ZWORK_PORT"] = str(SIDECAR_PORT)
        container.exec_detached(container_id, ["/usr/local/bin/rwork-backend"], env=env)

        # 4. Wait for readiness.
        base_url = f"http://127.0.0.1:{self.host_port}"
        token = env["ZWORK_SIDECAR_TOKEN"]
        if not sidecar_client.wait_until_ready(base_url, token, timeout_s=60.0):
            raise RuntimeError(
                f"zWork sidecar failed to become ready on host port {self.host_port}"
            )

    def run_task(
        self,
        container_id: str,
        task_prompt: str,
        cfg: RunConfig,
        run_dir: str,
    ) -> HarnessRun:
        base_url = f"http://127.0.0.1:{self.host_port}"
        token = cfg.sidecar_env("")["ZWORK_SIDECAR_TOKEN"]
        started = time.monotonic()
        traj = sidecar_client.run_agent_turn(
            base_url=base_url,
            token=token,
            message=task_prompt,
            model_id=self.model_selector(cfg),
            timeout_s=cfg.wall_timeout_s,
        )
        run = HarnessRun(
            finish_reason=traj.finish_reason,
            n_turns=traj.n_turns,
            duration_s=time.monotonic() - started,
            errors=traj.errors,
            events=traj.events,
            assistant_text=traj.assistant_text,
        )
        # Persist the rich trajectory + event log.
        rd = Path(run_dir)
        (rd / "trajectory.json").write_text(json.dumps(traj.to_dict(), indent=2))
        (rd / "events.jsonl").write_text("\n".join(json.dumps(e) for e in traj.events))
        run.raw_log_path = str((rd / "events.jsonl").resolve())
        return run

    def model_selector(self, cfg: RunConfig) -> str:
        return cfg.profile.model_selectors.get("zwork", cfg.profile.model_id)
