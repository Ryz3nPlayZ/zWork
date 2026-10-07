"""Shared grader helpers. Each task's grade.py is run as `python3 grade.py WORKDIR`
and must print one JSON line {"pass": bool, "detail": str} (via `finish`)."""

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile


def finish(ok, detail=""):
    print(json.dumps({"pass": bool(ok), "detail": str(detail)[-1500:]}))
    sys.exit(0)


def snapshot(workdir):
    """Copy the agent's workdir so grading never mutates (or is fooled by) it."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="bench-grade-"))
    dst = tmp / "w"
    shutil.copytree(workdir, dst, ignore=shutil.ignore_patterns(".git", "__pycache__", "node_modules"))
    return dst


def run(cmd, cwd, timeout=120, **kw):
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, **kw)
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(cmd, 124, e.stdout or "", f"TIMEOUT after {timeout}s")


def run_unittests(workdir, hidden_dir, files, timeout=120):
    """Drop the hidden test files into a copy of the workdir and run them."""
    w = snapshot(workdir)
    for f in files:
        shutil.copy(pathlib.Path(hidden_dir) / f, w / f)
    mods = [f[:-3] for f in files]
    r = run([sys.executable, "-m", "unittest", *mods], cwd=w, timeout=timeout)
    finish(r.returncode == 0, (r.stdout + r.stderr).strip())
