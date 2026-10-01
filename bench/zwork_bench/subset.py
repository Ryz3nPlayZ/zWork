"""Subset selection for SWE-bench Verified.

Three named subsets:

- ``smoke``  — 3 fast, well-known instances for CI sanity checks.
- ``subset`` — 30 instances, deterministically spread across the full dataset
  (every ~16th instance sorted by ``instance_id``). NOT cherry-picked: a
  reproducible cross-section of repos / difficulties so the resolved-rate is a
  fair estimator of the full-500 number. Default.
- ``full``   — all 500 instances.

Comma-separated explicit ``instance_id`` lists are also accepted.
"""

from __future__ import annotations

from typing import Any

from .config import RunConfig

DATASET_ID = "princeton-nlp/SWE-bench_Verified"


def load_dataset_instances() -> list[dict[str, Any]]:
    """Load the full SWE-bench Verified split, sorted by instance_id (stable)."""
    from datasets import load_dataset

    ds = load_dataset(DATASET_ID, split="test")
    rows: list[dict[str, Any]] = [dict(r) for r in ds]
    rows.sort(key=lambda r: r["instance_id"])
    return rows


# Three instances known to be small, fast, and widely-used as harness smoke
# tests across published agent runs. They exercise the basic read→edit→test
# loop without needing an exotic environment.
SMOKE_IDS = (
    "astropy__astropy-12907",
    "django__django-11039",
    "matplotlib__matplotlib-23314",
)

SUBSET_SIZE = 30


def select(instances: list[dict[str, Any]], cfg: RunConfig) -> list[dict[str, Any]]:
    """Pick the subset named in ``cfg.subset`` (or interpret it as id list)."""
    by_id = {r["instance_id"]: r for r in instances}

    spec = cfg.subset.strip().lower()
    if spec == "full":
        selected = instances
    elif spec == "subset":
        # Deterministic strided sample across the sorted dataset. No model is
        # allowed to see this list during development, so it can't overfit.
        n = len(instances)
        if n <= SUBSET_SIZE:
            selected = list(instances)
        else:
            stride = n / SUBSET_SIZE
            idxs = [int(i * stride) for i in range(SUBSET_SIZE)]
            selected = [instances[i] for i in idxs]
    elif spec == "smoke":
        selected = [by_id[i] for i in SMOKE_IDS if i in by_id]
        missing = [i for i in SMOKE_IDS if i not in by_id]
        if missing:
            raise RuntimeError(
                f"smoke subset references unknown instance ids: {missing}"
            )
    elif "," in cfg.subset:
        wanted = [s.strip() for s in cfg.subset.split(",") if s.strip()]
        missing = [w for w in wanted if w not in by_id]
        if missing:
            raise RuntimeError(f"unknown instance ids in subset list: {missing}")
        selected = [by_id[w] for w in wanted]
    else:
        raise ValueError(
            f"Unknown subset {cfg.subset!r}. Use smoke|subset|full or a comma-separated id list."
        )

    if cfg.instance_filter:
        wanted = set(cfg.instance_filter)
        selected = [r for r in selected if r["instance_id"] in wanted]

    return selected
