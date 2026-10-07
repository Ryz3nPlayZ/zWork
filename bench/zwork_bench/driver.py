"""Per-(instance × harness) driver: container → install → run → patch → eval.

The fairness contract lives here: for every selected harness, the container
is the *same* official SWE-bench image, the patch is extracted the *same* way
(``git -C /testbed diff``), and grading uses the *same* official swebench
harness. The only thing that varies is the :class:`Harness` implementation
(its install + headless run). That's what makes the head-to-head apples-to-
apples: container, prompt, model, turn budget, and grader are identical.
"""

from __future__ import annotations

import logging
import socket
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import container, eval as eval_mod
from .config import RunConfig
from .harnesses import get_harness
from .harnesses.base import Harness, HarnessRun
from .prompts import build_task_prompt

log = logging.getLogger(__name__)


@dataclass
class InstanceResult:
    instance_id: str
    harness: str  # which harness produced this result
    resolved: bool
    patch: str
    finish_reason: str
    n_turns: int
    duration_s: float
    errors: list[str]
    eval_report: dict[str, Any] | None = None
    trajectory_path: str = ""


def run_one(
    instance: dict[str, Any],
    harness_name: str,
    cfg: RunConfig,
    run_dir: Path,
    worker_idx: int,
    api_key: str,
) -> InstanceResult:
    """Run one instance with one harness to completion."""
    instance_id = instance["instance_id"]
    harness = get_harness(harness_name)

    # Per-harness run dir: runs/<ts>/<harness>/<instance_id>/
    inst_dir = run_dir / harness.name / instance_id
    inst_dir.mkdir(parents=True, exist_ok=True)

    # zWork publishes a sidecar port on the host; pick a unique one per worker.
    # Only zWork uses it, but assigning it for all harnesses is harmless.
    if hasattr(harness, "host_port"):
        harness.host_port = _free_port(worker_idx, cfg.sidecar_port)  # type: ignore[attr-defined]

    port = getattr(harness, "host_port", cfg.sidecar_port)
    container_name = f"zwork-bench-{harness.name}-{instance_id}-{port}"
    log.info("[%s][%s] starting container on port %s", harness.name, instance_id, port)

    started = time.monotonic()
    container_id = _start_container(instance, cfg, container_name, port)
    try:
        harness.install(container_id, cfg, api_key)
        log.info("[%s][%s] installed; driving task", harness.name, instance_id)

        run = harness.run_task(
            container_id=container_id,
            task_prompt=build_task_prompt(instance),
            cfg=cfg,
            run_dir=str(inst_dir),
        )

        patch = container.extract_patch(container_id)
        (inst_dir / "model.patch").write_text(patch)

        resolved, report = eval_mod.grade(
            instance=instance,
            model_patch=patch,
            run_dir=inst_dir,
            container_image=instance.get("image", ""),
            keep_container=cfg.keep_containers,
        )

        result = InstanceResult(
            instance_id=instance_id,
            harness=harness.name,
            resolved=resolved,
            patch=patch,
            finish_reason=run.finish_reason,
            n_turns=run.n_turns,
            duration_s=time.monotonic() - started,
            errors=run.errors,
            eval_report=report,
            trajectory_path=run.raw_log_path,
        )
        (inst_dir / "result.json").write_text(_result_json(result, run))
        return result
    finally:
        if not cfg.keep_containers:
            container.stop(container_id)
        else:
            log.warning(
                "[%s][%s] keeping container %s (--keep-containers)",
                harness.name, instance_id, container_id,
            )


# --- container lifecycle (shared across all harnesses) ----------------------


def _start_container(
    instance: dict[str, Any],
    cfg: RunConfig,
    name: str,
    port: int,
) -> str:
    image = instance.get("image") or container.default_image_name(instance["instance_id"])
    # Standard SWE-bench env: cwd=/testbed, repo at base_commit, deps installed.
    # We publish the sidecar port for every harness even though only zWork
    # binds it — keeps the container-start path uniform.
    cmd = [
        "docker", "run", "-d", "--rm",
        "--name", name,
        "-p", f"{port}:{cfg.sidecar_port}",
        "-w", "/testbed",
        image,
        "sleep", "infinity",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(
            f"docker run failed for {instance['instance_id']} ({image}):\n{out.stderr}"
        )
    return out.stdout.strip()


def _free_port(worker_idx: int, base: int) -> int:
    """Pick a host port unlikely to collide with another worker."""
    port = base + 100 + worker_idx * 10
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        while s.connect_ex(("127.0.0.1", port)) == 0:
            port += 1
    return port


def _result_json(result: InstanceResult, run: HarnessRun) -> str:
    import json
    return json.dumps(
        {
            "instance_id": result.instance_id,
            "harness": result.harness,
            "resolved": result.resolved,
            "finish_reason": result.finish_reason,
            "n_turns": result.n_turns,
            "duration_s": round(result.duration_s, 1),
            "errors": result.errors[:5],
        },
        indent=2,
    )
