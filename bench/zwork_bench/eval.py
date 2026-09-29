"""Grading wrapper around the official swebench harness.

For each instance we collected a ``model.patch`` in :mod:`driver`. The
*prediction* the SWE-bench grader expects is a JSON object::

    {"instance_id": ..., "model_patch": ..., "model_name_or_path": ...}

We write a predictions file for the whole run, hand it to
``swebench.harness.run_evaluation.main`` (the same entrypoint the CLI uses),
and read back the per-instance ``report.json`` it produces. That ``resolved``
boolean is THE number that's comparable across harnesses — it means the gold
test_patch was applied, FAIL_TO_PASS tests now pass, and PASS_TO_PASS tests
still pass.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .subset import DATASET_ID

log = logging.getLogger(__name__)

MODEL_NAME = "zwork"


def grade(
    *,
    instance: dict[str, Any],
    model_patch: str,
    run_dir: Path,
    container_image: str = "",
    keep_container: bool = False,
) -> tuple[bool, dict[str, Any]]:
    """Grade one instance via the official SWE-bench harness.

    Returns ``(resolved, report)``. If the patch is empty, the instance is
    counted as unresolved without spending grader time.
    """
    instance_id = instance["instance_id"]

    if not model_patch.strip():
        log.info("[%s] empty model patch → unresolved", instance_id)
        return False, {"instance_id": instance_id, "resolved": False, "reason": "empty_patch"}

    # swebench.harness expects a predictions file (list of dicts). One entry.
    predictions = [
        {
            "instance_id": instance_id,
            "model_patch": model_patch,
            "model_name_or_path": MODEL_NAME,
        }
    ]
    pred_path = run_dir / "prediction.json"
    pred_path.write_text(json.dumps(predictions, indent=2))

    report_dir = run_dir / "eval"
    report_dir.mkdir(parents=True, exist_ok=True)

    # Defer the import so merely importing this module doesn't require swebench.
    from swebench.harness.run_evaluation import main as swebench_main

    try:
        swebench_main(
            dataset_name=DATASET_ID,
            split="test",
            instance_ids=[instance_id],
            predictions_path=str(pred_path),
            max_workers=1,
            force_rebuild=False,
            cache_level="none",
            clean=not keep_container,
            open_file_limit=4096,
            run_id=f"zwork-{instance_id}",
            timeout=900,
            namespace=None,
            rewrite_reports=True,
            modal=False,
            report_dir=str(report_dir),
        )
    except Exception as e:  # grading infra failure (not an unresolved task)
        log.exception("[%s] swebench grading failed: %s", instance_id, e)
        return False, {
            "instance_id": instance_id,
            "resolved": False,
            "error": str(e),
        }

    report = _read_resolved(report_dir, instance_id, run_id=f"zwork-{instance_id}")
    resolved = bool(report.get("resolved", False))
    log.info("[%s] resolved=%s", instance_id, resolved)
    return resolved, report


def _read_resolved(
    report_dir: Path, instance_id: str, *, run_id: str
) -> dict[str, Any]:
    """Locate and read the per-instance report.json the harness just wrote."""
    candidates = [
        report_dir / f"{run_id}" / f"{instance_id}.report.json",
        report_dir / f"{run_id}.report.json",
    ]
    # Also glob, since swebench's report layout has shifted across versions.
    candidates.extend(report_dir.rglob(f"{instance_id}.report.json"))
    candidates.extend(report_dir.rglob("*.report.json"))

    for c in candidates:
        try:
            data = json.loads(c.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        # Per-instance report: top-level key is the instance_id.
        if isinstance(data, dict) and instance_id in data:
            entry = data[instance_id]
            return {"instance_id": instance_id, **entry, "report_file": str(c)}
        # Aggregate report: instance_id is a key alongside a totals dict.
        if isinstance(data, dict) and isinstance(data.get(instance_id), dict):
            return {"instance_id": instance_id, **data[instance_id], "report_file": str(c)}
        # Some layouts store the single instance at top level.
        if isinstance(data, dict) and "resolved" in data:
            return {"instance_id": instance_id, **data, "report_file": str(c)}

    return {"instance_id": instance_id, "resolved": False, "reason": "report_not_found"}
