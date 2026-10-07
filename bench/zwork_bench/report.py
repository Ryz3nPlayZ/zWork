"""Aggregate results into a JSON + Markdown report, grouped by harness.

When multiple harnesses ran (head-to-head mode), the report centers on a
comparison table: resolved-rate per harness, mean turns, and the delta vs the
best. Single-harness runs degrade gracefully to the original per-instance
layout.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rich.console import Console

from .config import RunConfig
from .driver import InstanceResult


def build_and_write(
    results: list[InstanceResult],
    cfg: RunConfig,
    run_dir: Path,
    subset_size: int,
) -> Path:
    """Build the report, write it, return the path to report.json."""
    report = _build(results, cfg, subset_size)
    json_path = run_dir / "report.json"
    md_path = run_dir / "report.md"
    json_path.write_text(json.dumps(report, indent=2))
    md_path.write_text(_to_markdown(report))
    return json_path


def print_summary(results: list[InstanceResult], console: Console) -> None:
    """One-screen summary printed at the end of a run."""
    by_harness = _group_by_harness(results)
    if len(by_harness) == 1:
        (hname, items), = by_harness.items()
        resolved = sum(1 for r in items if r.resolved)
        console.print(
            f"resolved: [bold green]{resolved}/{len(items)}[/] "
            f"({resolved / max(len(items), 1) * 100:.1f}%)  [{hname}]"
        )
        return

    # Head-to-head: print the comparison table.
    best_rate = max(
        (sum(1 for r in items if r.resolved) / max(len(items), 1)
         for items in by_harness.values()),
        default=0.0,
    )
    console.print("[bold]head-to-head:[/]")
    for hname, items in by_harness.items():
        resolved = sum(1 for r in items if r.resolved)
        rate = resolved / max(len(items), 1)
        delta = rate - best_rate
        marker = "[green]best[/]" if abs(delta) < 1e-6 else f"{delta*100:+.1f}pp"
        console.print(
            f"  [{hname:<13}] {resolved}/{len(items)} "
            f"({rate*100:5.1f}%)  {marker}"
        )


# --- internals --------------------------------------------------------------


def _build(
    results: list[InstanceResult], cfg: RunConfig, subset_size: int
) -> dict[str, Any]:
    by_harness = _group_by_harness(results)
    harness_summaries: dict[str, dict[str, Any]] = {}
    for hname, items in by_harness.items():
        total = len(items)
        resolved_n = sum(1 for r in items if r.resolved)
        turns = [r.n_turns for r in items if r.n_turns]
        durations = [r.duration_s for r in items]
        per_repo = defaultdict(lambda: {"total": 0, "resolved": 0})
        for r in items:
            repo = _repo_of(r.instance_id)
            per_repo[repo]["total"] += 1
            if r.resolved:
                per_repo[repo]["resolved"] += 1
        harness_summaries[hname] = {
            "resolved_rate": resolved_n / total if total else 0.0,
            "resolved": resolved_n,
            "total": total,
            "mean_turns": (sum(turns) / len(turns)) if turns else 0.0,
            "mean_duration_s": (sum(durations) / total) if total else 0.0,
            "per_repo": dict(sorted(per_repo.items())),
            "finish_reasons": _count_finish_reasons(items),
        }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model_profile": cfg.profile.name,
        "model_label": cfg.profile.label,
        "upstream_model": cfg.profile.upstream_model,
        "harnesses_run": list(by_harness.keys()),
        "subset": cfg.subset,
        "subset_size": subset_size,
        "by_harness": harness_summaries,
        "instances": [_result_to_dict(r) for r in results],
    }


def _group_by_harness(
    results: list[InstanceResult],
) -> dict[str, list[InstanceResult]]:
    g: dict[str, list[InstanceResult]] = defaultdict(list)
    for r in results:
        g[r.harness].append(r)
    return dict(g)


def _result_to_dict(r: InstanceResult) -> dict[str, Any]:
    return {
        "instance_id": r.instance_id,
        "harness": r.harness,
        "resolved": r.resolved,
        "finish_reason": r.finish_reason,
        "n_turns": r.n_turns,
        "duration_s": round(r.duration_s, 1),
        "errors": r.errors[:5],
        "has_patch": bool(r.patch.strip()),
    }


def _count_finish_reasons(results: list[InstanceResult]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for r in results:
        counts[r.finish_reason or "unknown"] += 1
    return dict(counts)


def _repo_of(instance_id: str) -> str:
    head = instance_id.rsplit("-", 1)[0]
    if "__" in head:
        return head.split("__", 1)[1]
    return head


def _to_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# SWE-bench Verified · harness comparison",
        "",
        f"- **Model:** {report['model_label']} (`{report['upstream_model']}`)",
        f"- **Profile:** `{report['model_profile']}`",
        f"- **Subset:** {report['subset']} ({report['subset_size']} instances)",
        f"- **Harnesses:** {', '.join(report['harnesses_run'])}",
        "",
        "## Comparison",
        "",
        "| Harness | Resolved | Rate | Mean turns | Mean time (s) |",
        "|---------|---------:|-----:|-----------:|--------------:|",
    ]
    summaries = report["by_harness"]
    best_rate = max(
        (s["resolved_rate"] for s in summaries.values()), default=0.0
    )
    for hname, s in summaries.items():
        delta = s["resolved_rate"] - best_rate
        marker = " *(best)*" if abs(delta) < 1e-6 else ""
        lines.append(
            f"| **{hname}**{marker} | {s['resolved']}/{s['total']} | "
            f"{s['resolved_rate']*100:.1f}% | {s['mean_turns']:.1f} | "
            f"{s['mean_duration_s']:.0f} |"
        )

    # Per-harness per-instance detail.
    lines += ["", "## Per-harness detail", ""]
    for hname, s in summaries.items():
        lines += [
            f"### {hname}",
            "",
            f"- resolved: **{s['resolved']}/{s['total']}** ({s['resolved_rate']*100:.1f}%)",
            f"- mean turns: {s['mean_turns']:.1f}",
            f"- mean wall time: {s['mean_duration_s']:.0f}s",
            "",
            "#### Per-repo",
            "",
            "| Repo | Resolved | Total |",
            "|------|---------:|------:|",
        ]
        for repo, counts in s["per_repo"].items():
            lines.append(f"| {repo} | {counts['resolved']} | {counts['total']} |")
        lines += ["", "#### Finish reasons", ""]
        for reason, n in s["finish_reasons"].items():
            lines.append(f"- `{reason}`: {n}")
        lines.append("")

    # Instances table (grouped by instance across harnesses for easy diffing).
    lines += ["## Instances", ""]
    by_inst: dict[str, dict[str, Any]] = defaultdict(dict)
    for inst in report["instances"]:
        by_inst[inst["instance_id"]][inst["harness"]] = inst

    header = ["Instance"] + report["harnesses_run"]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] * len(header)) + "|")
    for iid, hs in sorted(by_inst.items()):
        row = [iid]
        for hname in report["harnesses_run"]:
            inst = hs.get(hname)
            row.append(
                f"{'✅' if inst and inst['resolved'] else '❌'} "
                f"({inst['n_turns']}t, {inst['duration_s']}s)"
                if inst
                else "—"
            )
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")
    return "\n".join(lines)
