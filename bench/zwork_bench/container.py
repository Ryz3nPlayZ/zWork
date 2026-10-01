"""Shared low-level Docker helpers used by the driver and every harness.

Kept in its own module so harness implementations can copy files into a
container, run commands, and read output without depending on ``driver.py``
(which would create a circular import — the driver imports the harnesses).
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from typing import Sequence

log = logging.getLogger(__name__)


def write_file(container_id: str, path: str, content: str) -> None:
    """Write a string to a path inside the container (binary-safe via docker cp)."""
    fd, tmp = tempfile.mkstemp()
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        run(container_id, [], "docker", "cp", tmp, f"{container_id}:{path}", check=True)
    finally:
        os.unlink(tmp)


def run(
    container_id: str,
    pre_exec_args: Sequence[str],
    *cmd: str,
    check: bool = True,
    timeout: float | None = None,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    capture: bool = True,
    input_text: str | None = None,
) -> subprocess.CompletedProcess:
    """``docker exec`` with ergonomic defaults.

    ``pre_exec_args`` are flags like ``["-d"]`` or ``["-e", "K=V"]`` that come
    before the container id (use ``[]`` for a plain exec). Returns the
    completed process. ``cwd``/``env`` map to ``-w``/``-e`` for convenience.
    """
    full = ["docker", "exec"]
    if cwd:
        full += ["-w", cwd]
    if env:
        for k, v in env.items():
            full += ["-e", f"{k}={v}"]
    full += list(pre_exec_args)
    full += [container_id, *cmd]
    log.debug("docker exec: %s", " ".join(full))
    return subprocess.run(
        full,
        capture_output=capture,
        text=True,
        check=check,
        timeout=timeout,
        input=input_text,
    )


def exec_detached(
    container_id: str, cmd: Sequence[str], env: dict[str, str] | None = None
) -> None:
    """Start a long-running process inside the container, detached (``-d``)."""
    run(container_id, ["-d"], *cmd, env=env, check=True, capture=True)


def extract_patch(container_id: str) -> str:
    """``git -C /testbed diff`` — the model's uncommitted changes."""
    out = run(
        container_id, [], "git", "diff", cwd="/testbed", check=False, capture=True
    )
    if out.returncode != 0:
        log.warning("git diff rc=%d: %s", out.returncode, out.stderr.strip())
    return out.stdout


def stop(container_id: str) -> None:
    subprocess.run(["docker", "rm", "-f", container_id], capture_output=True)


def default_image_name(instance_id: str) -> str:
    """Convention used by swebench: sweb.eval.<repo>_<inst>:latest."""
    repo = instance_id.rsplit("-", 1)[0].replace("__", "_").lower()
    return f"sweb.eval.{repo}:latest"
