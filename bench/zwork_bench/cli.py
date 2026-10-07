"""`zwork-bench` CLI entrypoint.

Examples
--------
    # Head-to-head: zWork vs Claude Code vs OpenCode, 30-instance subset, Sonnet 4.
    zwork-bench run \\
      --harness zwork,claude-code,opencode \\
      --sidecar-binary ./target/release/rwork-backend

    # Just zWork vs Claude Code, smoke set (cheapest head-to-head check).
    zwork-bench run --harness zwork,claude-code --subset smoke ...

    # zWork only (the original single-harness mode still works).
    zwork-bench run --sidecar-binary ./target/release/rwork-backend

    # Full 500, all three harnesses — expensive.
    zwork-bench run --harness zwork,claude-code,opencode --subset full --parallel 8
"""

from __future__ import annotations

import itertools
import logging
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import typer
from rich.console import Console
from rich.logging import RichHandler
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
)

from . import report as report_mod
from .config import DEFAULT_PROFILE, RunConfig, get_profile, resolve_api_key
from .driver import InstanceResult, run_one
from .harnesses import ALL
from .subset import load_dataset_instances, select

app = typer.Typer(
    name="zwork-bench",
    add_completion=False,
    no_args_is_help=True,
    help="Run zWork (and competitors) on SWE-bench Verified.",
)
console = Console()


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(message)s",
        datefmt="[%X]",
        handlers=[RichHandler(console=console, show_path=False, rich_tracebacks=True)],
    )


def _parse_harnesses(spec: str) -> list[str]:
    names = [s.strip() for s in spec.split(",") if s.strip()]
    for n in names:
        if n not in ALL:
            raise typer.BadParameter(
                f"Unknown harness {n!r}. Known: {list(ALL)}"
            )
    return names


@app.command()
def run(
    harness: str = typer.Option(
        "zwork", "--harness", "-H",
        help="Comma-separated harnesses: zwork,claude-code,opencode.",
    ),
    profile: str = typer.Option(
        DEFAULT_PROFILE, "--profile", "-p", help="Model profile (deepseek|product-pro|product-ultimate)."
    ),
    subset: str = typer.Option(
        "subset", "--subset", "-s", help="smoke | subset | full | comma-separated instance ids."
    ),
    parallel: int = typer.Option(4, "--parallel", "-n", min=1, max=16, help="Concurrent (instance×harness) jobs."),
    max_turns: int = typer.Option(40, "--max-turns", help="Per-instance turn budget."),
    sidecar_binary: str = typer.Option(
        "", "--sidecar-binary", help="Path to prebuilt rwork-backend (required when --harness includes zwork)."
    ),
    runs_dir: Path = typer.Option(Path("bench/runs"), "--runs-dir"),
    keep_containers: bool = typer.Option(False, "--keep-containers", help="Don't rm containers on exit (debug)."),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Run one or more harnesses on SWE-bench Verified."""
    _setup_logging(verbose)

    harnesses = _parse_harnesses(harness)
    prof = get_profile(profile)
    api_key = resolve_api_key(prof)
    if not api_key:
        env_hint = {
            "deepseek": "DEEPSEEK_API_KEY",
            "zwork_router": "ZWORK_ROUTER_TOKEN",
            "anthropic": "ANTHROPIC_API_KEY",
        }.get(prof.credential, f"{prof.credential.upper()}_API_KEY")
        console.print(
            f"[bold red]error:[/] no API key for profile {profile!r} "
            f"(credential {prof.credential!r}). Set {env_hint} in the environment.",
            style="red",
        )
        raise typer.Exit(code=2)

    if "zwork" in harnesses and not sidecar_binary:
        console.print(
            "[bold red]error:[/] --sidecar-binary is required when --harness includes zwork. "
            "Build it with `scripts/build-rust-backend.sh` first.",
            style="red",
        )
        raise typer.Exit(code=2)

    # Validate model selectors for every selected harness — a missing selector
    # means the profile can't represent this harness's model and the run would
    # silently fall back to a default, breaking the same-LLM guarantee.
    # zwork always has a fallback via model_id, so only check the competitors.
    missing = [h for h in harnesses if h != "zwork" and h not in prof.model_selectors]
    if missing:
        console.print(
            f"[bold red]error:[/] profile {profile!r} has no model selector for "
            f"harness(es) {missing}. The same-LLM guarantee requires an explicit "
            f"selector per harness. Pick a profile that pins a model for them "
            f"(e.g. `neutral`), or add selectors in config.py.",
            style="red",
        )
        raise typer.Exit(code=2)

    cfg = RunConfig(
        profile=prof,
        subset=subset,
        parallel=parallel,
        max_turns=max_turns,
        sidecar_binary=str(Path(sidecar_binary).resolve()) if sidecar_binary else "",
        runs_dir=runs_dir,
        keep_containers=keep_containers,
    )

    console.rule(f"[bold]SWE-bench Verified · {prof.label} · {', '.join(harnesses)}")
    console.print(
        f"harnesses: [cyan]{', '.join(harnesses)}[/]  "
        f"profile: [cyan]{profile}[/]  subset: [cyan]{subset}[/]  parallel: [cyan]{parallel}[/]"
    )

    console.print("[dim]loading dataset…[/]")
    all_instances = load_dataset_instances()
    selected = select(all_instances, cfg)
    console.print(f"[dim]{len(selected)} instances × {len(harnesses)} harness(es) "
                  f"= {len(selected) * len(harnesses)} runs[/]")

    run_dir = cfg.run_timestamp_dir
    run_dir.mkdir(parents=True, exist_ok=True)
    console.print(f"[dim]run dir: {run_dir}[/]")

    # The work unit is (instance, harness). Fan all of them out across the pool.
    jobs = list(itertools.product(selected, harnesses))
    results: list[InstanceResult] = []

    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("running", total=len(jobs))

        with ProcessPoolExecutor(max_workers=parallel) as ex:
            future_to_job = {
                ex.submit(
                    _run_one,
                    inst,
                    hname,
                    cfg,
                    run_dir,
                    worker_idx,
                    api_key,
                ): (inst, hname)
                for worker_idx, ((inst, hname)) in enumerate(jobs)
            }
            try:
                for fut in as_completed(future_to_job):
                    inst, hname = future_to_job[fut]
                    iid = inst["instance_id"]
                    try:
                        res = fut.result()
                        results.append(res)
                        mark = "[green]✓[/]" if res.resolved else "[red]✗[/]"
                        progress.console.print(
                            f"  {mark} [{hname}] {iid}  "
                            f"({res.n_turns}t, {res.duration_s:.0f}s, {res.finish_reason})"
                        )
                    except Exception as e:
                        logging.exception("[%s][%s] failed: %s", hname, iid, e)
                        progress.console.print(f"  [red]‼ [{hname}] {iid} crashed: {e}[/]")
                    progress.advance(task)
            except KeyboardInterrupt:
                console.print("[yellow]interrupted[/]")
                ex.shutdown(wait=False, cancel_futures=True)
                raise

    report_path = report_mod.build_and_write(results, cfg, run_dir, len(selected))
    console.rule("[bold]result")
    report_mod.print_summary(results, console)
    console.print(f"report:   {report_path}")
    console.print(f"markdown: {report_path.with_suffix('.md')}")


def _run_one(inst, harness_name, cfg, run_dir, worker_idx, api_key) -> InstanceResult:
    """Process-pool worker: each (instance × harness) is fully isolated."""
    return run_one(inst, harness_name, cfg, run_dir, worker_idx, api_key)


if __name__ == "__main__":
    app()
