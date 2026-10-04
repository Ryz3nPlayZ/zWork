#!/usr/bin/env python3
"""zWork vs OpenCode — lightweight local head-to-head (no Docker, stdlib only).

Each task in tasks/<id>/ is a seed repo + a prompt + a hidden grader. For every
(harness x task x rep) we copy the seed into a fresh git workdir, let the agent
work in it headlessly, then run the grader against a snapshot of the result.
Both harnesses hit the SAME upstream model (DeepSeek, OpenAI-compatible API)
with the same key, the same prompt and the same wall-clock budget.

    python3 bench/lite/run.py                      # all tasks, both harnesses, 1 rep
    python3 bench/lite/run.py --reps 3 --parallel 6
    python3 bench/lite/run.py --harness zwork --tasks fix-pagination,csv-report
    python3 bench/lite/run.py --report bench/lite/runs/<ts>   # re-render a report

The DeepSeek key comes from $DEEPSEEK_API_KEY, else from ~/.claude/settings.json
(env.ANTHROPIC_AUTH_TOKEN when ANTHROPIC_BASE_URL points at DeepSeek).
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
TASKS = HERE / "tasks"
REPO = HERE.parent.parent
DEFAULT_ZWORK_BIN = REPO / "sidecar-rust/target/release/rwork-backend"
DEEPSEEK_OPENAI_URL = "https://api.deepseek.com/v1"


# ---------------------------------------------------------------- setup ----


def deepseek_key() -> str:
    if os.environ.get("DEEPSEEK_API_KEY"):
        return os.environ["DEEPSEEK_API_KEY"]
    try:
        env = json.loads((Path.home() / ".claude/settings.json").read_text()).get("env", {})
        if "deepseek" in env.get("ANTHROPIC_BASE_URL", ""):
            return env["ANTHROPIC_AUTH_TOKEN"]
    except (OSError, ValueError, KeyError):
        pass
    sys.exit("No DeepSeek key: set DEEPSEEK_API_KEY")


def list_tasks(sel: str) -> list[str]:
    all_ids = sorted(p.name for p in TASKS.iterdir() if (p / "prompt.md").exists())
    if sel in ("", "all"):
        return all_ids
    ids = [t.strip() for t in sel.split(",") if t.strip()]
    bad = [t for t in ids if t not in all_ids]
    if bad:
        sys.exit(f"unknown tasks {bad}; known: {all_ids}")
    return ids


def prepare_workdir(task: str, work: Path) -> str:
    """Fresh copy of the seed repo, task setup, and an initial git commit."""
    tdir = TASKS / task
    shutil.copytree(tdir / "repo", work) if (tdir / "repo").exists() else work.mkdir(parents=True)
    if (tdir / "setup.py").exists():
        subprocess.run([sys.executable, str(tdir / "setup.py")], cwd=work, check=True)
    git = ["git", "-c", "user.name=bench", "-c", "user.email=bench@localhost"]
    subprocess.run([*git, "init", "-q"], cwd=work, check=True)
    subprocess.run([*git, "add", "-A"], cwd=work, check=True)
    subprocess.run([*git, "commit", "-qm", "seed"], cwd=work, check=True)
    return (tdir / "prompt.md").read_text().strip()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def kill_tree(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def empty_result() -> dict:
    return {"finish": "", "tool_calls": 0, "steps": 0, "input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": 0, "errors": [], "final_text": ""}


# --------------------------------------------------------------- zWork ----


def run_zwork(prompt: str, work: Path, run_dir: Path, args) -> dict:
    home = run_dir / "zhome"
    home.mkdir(parents=True, exist_ok=True)
    (home / "settings.json").write_text(json.dumps({
        "default_model": "bench-ds",
        "custom_models": [{
            "id": "bench-ds", "name": f"DeepSeek {args.model}", "shape": "openai",
            "credential": "deepseek", "model_id": args.model, "base_url_override": "",
        }],
        "use_claude_code_config": False,
        "telemetry_enabled": False,
    }))
    port, token = free_port(), "bench-token"
    env = {**os.environ, "PWD": str(work), "ZWORK_HOME": str(home), "ZWORK_PORT": str(port), "ZWORK_HOST": "127.0.0.1",
           "ZWORK_SIDECAR_TOKEN": token, "DEEPSEEK_API_KEY": args.key, "RUST_LOG": "warn"}
    if args.zwork_coding_only:
        env["ZWORK_CODING_ONLY"] = "1"
    log = open(run_dir / "zwork-sidecar.log", "w")
    proc = subprocess.Popen([str(args.zwork_bin)], cwd=work, env=env, stdout=log, stderr=log,
                            start_new_session=True)
    res = empty_result()
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                req = urllib.request.Request(f"{base}/api/health", headers={"x-zwork-token": token})
                if urllib.request.urlopen(req, timeout=2).status == 200:
                    break
            except OSError:
                pass
            if time.monotonic() > deadline or proc.poll() is not None:
                res["finish"] = "sidecar_failed"
                return res
            time.sleep(0.2)

        body = json.dumps({
            "run_id": f"bench-{run_dir.name}", "message": prompt, "model": "bench-ds",
            "new_chat_title": "bench", "plan_mode": False, "auto_approve_destructive": True,
            "artifact_mode": False, "web_search_enabled": False, "attachments": [],
        }).encode()
        req = urllib.request.Request(f"{base}/api/chat/stream", data=body, method="POST",
                                     headers={"x-zwork-token": token, "Content-Type": "application/json"})
        events = open(run_dir / "events.jsonl", "w")
        started = time.monotonic()
        text = ""
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[5:].strip())
                except ValueError:
                    continue
                events.write(json.dumps(ev) + "\n")
                t = ev.get("type")
                if t == "delta":
                    text += ev.get("text", "")
                elif t == "tool_use":
                    res["tool_calls"] += 1
                elif t == "usage":
                    res["input_tokens"] = ev.get("prompt_tokens", 0)
                    res["output_tokens"] = ev.get("completion_tokens", 0)
                    res["cache_read_tokens"] = ev.get("cache_read_tokens", 0)
                    res["steps"] += 1
                elif t == "error":
                    res["errors"].append(str(ev.get("text") or ev.get("message") or ev)[:300])
                elif t == "done":
                    res["finish"] = ev.get("reason", "done")
                elif t == "end":
                    res["finish"] = res["finish"] or "end"
                    break
                if time.monotonic() - started > args.timeout:
                    res["finish"] = "timeout"
                    break
        res["final_text"] = text[-2000:]
        res["finish"] = res["finish"] or "stream_closed"
    except TimeoutError:
        res["finish"] = "timeout"
    except OSError as e:
        res["finish"] = "error"
        res["errors"].append(f"{type(e).__name__}: {e}")
    finally:
        kill_tree(proc)
        log.close()
    return res


# ------------------------------------------------------------ OpenCode ----


def opencode_config_dir(model: str) -> Path:
    # Persistent (not per-run): opencode's first start against a fresh config
    # dir can stall for minutes, which would land in the first job's timing.
    cfg = Path(tempfile.gettempdir()).resolve() / "zwork-lite-bench" / "opencode-config"
    (cfg / "opencode").mkdir(parents=True, exist_ok=True)
    (cfg / "opencode" / "opencode.json").write_text(json.dumps({
        "$schema": "https://opencode.ai/config.json",
        "permission": {"*": "allow"},
        "autoupdate": False,
        "share": "disabled",
        "provider": {"deepseek": {
            "npm": "@ai-sdk/openai-compatible", "name": "DeepSeek",
            "options": {"baseURL": DEEPSEEK_OPENAI_URL, "apiKey": "{env:DEEPSEEK_API_KEY}"},
            "models": {model: {"name": model, "tool_call": True,
                               "limit": {"context": 128000, "output": 32768}}},
        }},
    }, indent=2))
    return cfg


def warm_opencode(args) -> None:
    """One throwaway prompt so provider/model-catalog setup isn't billed to a task."""
    work = args.work_root / "_warmup"
    work.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PWD": str(work), "XDG_CONFIG_HOME": str(args.oc_config), "DEEPSEEK_API_KEY": args.key,
           "OPENCODE_DISABLE_AUTOUPDATE": "1"}
    t0 = time.time()
    proc = subprocess.Popen(["opencode", "run", "--standalone", "--format", "json",
                             "-m", f"deepseek/{args.model}", "Reply with the word ok."],
                            cwd=work, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True)
    try:
        proc.wait(timeout=600)
    except subprocess.TimeoutExpired:
        print("opencode warm-up timed out", flush=True)
    finally:
        kill_tree(proc)
    print(f"opencode warm-up {time.time() - t0:.1f}s", flush=True)


def run_opencode(prompt: str, work: Path, run_dir: Path, args) -> dict:
    env = {**os.environ, "PWD": str(work), "XDG_CONFIG_HOME": str(args.oc_config), "DEEPSEEK_API_KEY": args.key,
           "OPENCODE_DISABLE_AUTOUPDATE": "1"}
    cmd = ["opencode", "run", "--standalone", "--auto", "--format", "json",
           "-m", f"deepseek/{args.model}", "--title", f"bench {run_dir.name}", prompt]
    res = empty_result()
    out = open(run_dir / "events.jsonl", "w")
    err = open(run_dir / "opencode-stderr.log", "w")
    proc = subprocess.Popen(cmd, cwd=work, env=env, stdout=out, stderr=err, start_new_session=True)
    try:
        proc.wait(timeout=args.timeout)
        res["finish"] = "done" if proc.returncode == 0 else f"exit_{proc.returncode}"
    except subprocess.TimeoutExpired:
        res["finish"] = "timeout"
    finally:
        kill_tree(proc)
        out.close()
        err.close()
    text = ""
    for line in (run_dir / "events.jsonl").read_text().splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        t, part = ev.get("type"), ev.get("part") or {}
        if t == "tool_use":
            res["tool_calls"] += 1
        elif t == "text":
            text += part.get("text", "") + "\n"
        elif t == "step_finish":
            tok = part.get("tokens") or {}
            cache = tok.get("cache") or {}
            res["steps"] += 1
            res["input_tokens"] += tok.get("input", 0) + cache.get("read", 0) + cache.get("write", 0)
            res["output_tokens"] += tok.get("output", 0) + tok.get("reasoning", 0)
            res["cache_read_tokens"] += cache.get("read", 0)
        elif t == "error":
            res["errors"].append(json.dumps(ev.get("error"))[:300])
    res["final_text"] = text[-2000:]
    return res


HARNESSES = {"zwork": run_zwork, "opencode": run_opencode}


# ---------------------------------------------------------------- jobs ----


def grade(task: str, work: Path) -> dict:
    r = subprocess.run([sys.executable, str(TASKS / task / "grade.py"), str(work)],
                       capture_output=True, text=True, timeout=300)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"pass": False, "detail": f"grader crashed: {r.stderr[-800:]}"}


def run_job(harness: str, task: str, rep: int, root: Path, args) -> dict:
    run_dir = root / harness / task / f"r{rep}"
    run_dir.mkdir(parents=True, exist_ok=True)
    # Workdirs live OUTSIDE the zWork checkout: an agent exploring upward from
    # a nested dir would otherwise find tasks/<id>/hidden/ (the grader's tests).
    work = args.work_root / harness / task / f"r{rep}"
    (run_dir / "workdir.txt").write_text(str(work))
    prompt = prepare_workdir(task, work)
    t0 = time.monotonic()
    try:
        res = HARNESSES[harness](prompt, work, run_dir, args)
    except Exception as e:  # a harness crash is a failed run, not a crashed benchmark
        res = empty_result()
        res.update(finish="crash", errors=[f"{type(e).__name__}: {e}"])
    res["duration_s"] = round(time.monotonic() - t0, 1)
    res.update(grade(task, work))
    diff = subprocess.run(["git", "diff", "--stat", "HEAD"], cwd=work, capture_output=True, text=True)
    res["diffstat"] = diff.stdout.strip().splitlines()[-1:] or [""]
    res.update(harness=harness, task=task, rep=rep)
    # Contamination tripwire: the agent touched the benchmark checkout (where
    # the hidden tests live). Such a run is reported but not counted as a pass.
    events = run_dir / "events.jsonl"
    res["escaped"] = events.exists() and str(HERE) in events.read_text(errors="replace")
    if res["escaped"]:
        res["pass"] = False
        res["detail"] = "ESCAPED workdir into the benchmark checkout; " + res["detail"]
    (run_dir / "result.json").write_text(json.dumps(res, indent=2))
    mark = "PASS" if res["pass"] else "FAIL"
    print(f"[{mark}] {harness:9s} {task:16s} r{rep}  {res['duration_s']:6.1f}s  "
          f"tools={res['tool_calls']:3d}  in={res['input_tokens']:>7d} out={res['output_tokens']:>6d}  "
          f"{res['finish']}  {'' if res['pass'] else res['detail'][:120]!r}", flush=True)
    return res


# -------------------------------------------------------------- report ----


def render_report(root: Path) -> str:
    results = [json.loads(p.read_text()) for p in sorted(root.glob("*/*/r*/result.json"))]
    meta = json.loads((root / "meta.json").read_text()) if (root / "meta.json").exists() else {}
    harnesses = sorted({r["harness"] for r in results})
    tasks = sorted({r["task"] for r in results})
    by = {(h, t): [r for r in results if r["harness"] == h and r["task"] == t] for h in harnesses for t in tasks}

    def med(xs):
        return statistics.median(xs) if xs else 0

    lines = [f"# zWork vs OpenCode — lite bench `{root.name}`", ""]
    if meta:
        lines += [f"Model: `{meta.get('model')}` · reps: {meta.get('reps')} · timeout: {meta.get('timeout')}s · "
                  f"zWork mode: {'coding-only' if meta.get('zwork_coding_only') else 'product'} · "
                  f"zWork commit: `{meta.get('commit')}` · opencode {meta.get('opencode_version')}", ""]
    lines += ["## Summary", "", "| harness | pass | pass rate | median time | median tool calls | median in tok | median out tok |",
              "|---|---|---|---|---|---|---|"]
    for h in harnesses:
        rs = [r for r in results if r["harness"] == h]
        p = sum(r["pass"] for r in rs)
        lines.append(f"| {h} | {p}/{len(rs)} | {100 * p / max(len(rs), 1):.0f}% | {med([r['duration_s'] for r in rs]):.0f}s | "
                     f"{med([r['tool_calls'] for r in rs]):.0f} | {med([r['input_tokens'] for r in rs]):,.0f} | "
                     f"{med([r['output_tokens'] for r in rs]):,.0f} |")
    lines += ["", "## Per task", "", "| task | " + " | ".join(f"{h} pass | {h} time | {h} tools" for h in harnesses) + " |",
              "|---|" + "---|---|---|" * len(harnesses)]
    for t in tasks:
        cells = []
        for h in harnesses:
            rs = by[(h, t)]
            cells += [f"{sum(r['pass'] for r in rs)}/{len(rs)}", f"{med([r['duration_s'] for r in rs]):.0f}s",
                      f"{med([r['tool_calls'] for r in rs]):.0f}"]
        lines.append(f"| {t} | " + " | ".join(cells) + " |")
    fails = [r for r in results if not r["pass"]]
    if fails:
        lines += ["", "## Failures", ""]
        for r in fails:
            lines.append(f"- **{r['harness']} / {r['task']} r{r['rep']}** ({r['finish']}): {r['detail'][:300]}")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--harness", default="zwork,opencode")
    ap.add_argument("--tasks", default="all")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument("--timeout", type=int, default=600, help="wall-clock seconds per run")
    ap.add_argument("--zwork-bin", type=Path, default=DEFAULT_ZWORK_BIN)
    ap.add_argument("--zwork-coding-only", action="store_true",
                    help="run zWork with ZWORK_CODING_ONLY=1 (coding prompt + toolset) instead of the product config")
    ap.add_argument("--out", type=Path, default=HERE / "runs")
    ap.add_argument("--report", type=Path, help="only re-render the report for an existing run dir")
    args = ap.parse_args()

    if args.report:
        text = render_report(args.report)
        (args.report / "report.md").write_text(text)
        print(text)
        return

    harnesses = [h.strip() for h in args.harness.split(",") if h.strip()]
    for h in harnesses:
        if h not in HARNESSES:
            sys.exit(f"unknown harness {h}")
    if "zwork" in harnesses and not args.zwork_bin.exists():
        sys.exit(f"zWork binary not found: {args.zwork_bin} (cargo build --release in sidecar-rust)")
    tasks = list_tasks(args.tasks)
    args.key = deepseek_key()
    root = args.out / dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    root.mkdir(parents=True)
    args.oc_config = opencode_config_dir(args.model)
    args.work_root = Path(tempfile.gettempdir()).resolve() / "zwork-lite-bench" / root.name
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()
    ocv = subprocess.run(["opencode", "--version"], capture_output=True, text=True).stdout.strip() if "opencode" in harnesses else ""
    (root / "meta.json").write_text(json.dumps({
        "model": args.model, "reps": args.reps, "timeout": args.timeout, "harnesses": harnesses, "tasks": tasks,
        "zwork_coding_only": args.zwork_coding_only, "commit": commit, "opencode_version": ocv,
        "zwork_bin": str(args.zwork_bin),
    }, indent=2))

    jobs = [(h, t, r) for r in range(args.reps) for t in tasks for h in harnesses]
    print(f"{len(jobs)} runs -> {root}", flush=True)
    if "opencode" in harnesses:
        warm_opencode(args)
    with cf.ThreadPoolExecutor(args.parallel) as pool:
        list(pool.map(lambda j: run_job(*j, root, args), jobs))
    text = render_report(root)
    (root / "report.md").write_text(text)
    print("\n" + text)


if __name__ == "__main__":
    main()
