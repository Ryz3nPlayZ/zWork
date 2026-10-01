# zWork · SWE-bench Verified harness

Runs the zWork coding agent on [SWE-bench Verified](https://www.swebench.com/)
and produces a **resolved-rate** directly comparable to numbers published by
Claude Code, OpenCode, Aider, SWE-agent, etc. In **head-to-head mode** it runs
zWork *and* the competitors in identical containers on the **same model**, so
the comparison measures harness quality — not model quality.

The agents run **inside** official SWE-bench Docker containers (repo at
`base_commit` at `/testbed`), driven headlessly. Grading uses the **official**
`swebench.harness` (FAIL_TO_PASS ∪ PASS_TO_PASS), so the resolved boolean is
the canonical, leaderboard-comparable number.

## Quick start

```bash
# 1. Build the Linux sidecar binary (once) — only needed when --harness includes zwork.
scripts/build-rust-backend.sh

# 2. Install the harness.
cd bench && pip install -e .

# 3. Expose the DeepSeek key (same token `claudeswitch deepseek` uses).
export DEEPSEEK_API_KEY=sk-…

# 4. Head-to-head smoke check (3 instances × 3 harnesses, ~15 min).
zwork-bench run \
  --harness zwork,claude-code,opencode \
  --subset smoke \
  --sidecar-binary ../sidecar-rust/target/release/rwork-backend

# 5. Default head-to-head: 30-instance subset, DeepSeek-V4 Pro on all three.
zwork-bench run \
  --harness zwork,claude-code,opencode \
  --sidecar-binary ../sidecar-rust/target/release/rwork-backend

# 6. zWork only (the original single-harness mode).
zwork-bench run \
  --sidecar-binary ../sidecar-rust/target/release/rwork-backend
```

Reports land under `bench/runs/<timestamp>/` (`report.json`, `report.md`, plus
a per-`harness`/per-instance `trajectory.json` / `model.patch`).

## What "same LLM" means here (the fairness contract)

A head-to-head is only meaningful if every variable except the harness is
identical. For each SWE-bench instance, every selected harness runs with:

- **Same container** — the official SWE-bench image for that instance.
- **Same model** — pinned via per-harness selectors, all resolving to the
  *same* upstream snapshot. The default `deepseek` profile runs
  **DeepSeek-V4 Pro** on every harness:
  - zWork → custom model `bench-deepseek-pro`, base_url override
    `https://api.deepseek.com/anthropic` (talks to DeepSeek directly, not
    through the zWork router — router latency/retry shouldn't be credited to
    zWork's harness quality).
  - Claude Code → `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` +
    `ANTHROPIC_MODEL=deepseek-v4-pro` (the same env vars `claudeswitch deepseek`
    writes, replicated in-container).
  - OpenCode → `--model deepseek/deepseek-v4-pro`, `DEEPSEEK_API_KEY` in env.
- **Same task prompt** — the standard SWE-bench wrapper (`prompts.py`),
  identical across harnesses.
- **Same turn budget** — 40 turns (Claude Code `--max-turns 40`; zWork
  `ZWORK_MAX_TURNS=40`; OpenCode bounded by wall-clock — see asymmetries).
- **Same autonomy** — permissions bypassed in every harness
  (`--dangerously-skip-permissions` / `--auto` / `auto_approve_destructive`).
- **Comparable coding toolsets** — see below.
- **Same grader** — the official `swebench.harness`. Unchanged.

If a profile lacks a model selector for a selected harness, the CLI refuses to
run rather than silently substituting a different model. That guard is what
enforces the same-LLM guarantee.

### API key / security

The DeepSeek API key is **never committed to git**. Set it in your
environment before running:

```bash
export DEEPSEEK_API_KEY=sk-…   # the same token `claudeswitch deepseek` uses
```

The harness reads it from the env and threads it into each container at run
time (zWork's `secrets.json`, Claude Code's `~/.claude/settings.json`,
OpenCode's env). The `claudeswitch` script on your host contains a working
token already; the harness just needs it exposed as `DEEPSEEK_API_KEY`.

## Fairness: zWork is constrained, competitors aren't

zWork's product toolset advertises desktop/browser tools and steers toward
desktop automation — fatal in a headless coding container *and* an unfair
advantage over Claude Code / OpenCode (which ship coding-focused defaults).
The driver launches the zWork sidecar with `ZWORK_CODING_ONLY=1`, which:

- restricts zWork's tools to `{read_file, list_dir, grep_search, write_file,
  replace_file_content, run_command, web_search, update_todos, save_memory}`
  (an allowlist), and
- swaps the general-purpose system prompt for a coding-focused one.

Both gates are **env-var-only** and **no-ops** in normal product use. Claude
Code is similarly constrained via `--tools "Bash,Edit,Read,Write,Glob,Grep"`;
OpenCode uses its default (already coding-focused). The result: all three
harnesses end up with near-identical coding toolsets.

## Known asymmetries (documented per-run in the report, not hidden)

- **Turn budget**: Claude Code has native `--max-turns`; zWork has
  `ZWORK_MAX_TURNS`; OpenCode has no native cap, so it's bounded by wall-clock
  only. We surface `finish_reason` for every run so this is visible.
- **Trajectory richness**: zWork emits structured SSE events (full
  `tool_use`/`tool_result` trace); Claude Code and OpenCode only expose
  stdout/stderr. All three save a raw log; zWork additionally saves
  `events.jsonl`.
- **Container install time**: npm (Claude Code) / curl (OpenCode) installs add
  ~30–60s per container.

## Adding a harness (Aider, SWE-agent, …)

1. Write `zwork_bench/harnesses/<name>.py` implementing `base.Harness`
   (`install` + `run_task` + `model_selector`).
2. Register it in `harnesses/__init__.py`.
3. Add a model-selector entry for it to each profile in `config.py`.

Nothing else changes — the driver, grader, and report are harness-agnostic.

## What the number means

`resolved: true` ⟺ applying the agent's `model.patch` to the repo at
`base_commit`, then the gold `test_patch`, makes every FAIL_TO_PASS test pass
*and* keeps every PASS_TO_PASS test passing. This is exactly the predicate the
public SWE-bench leaderboard uses. Nothing about it is zWork-specific.

## Model profiles

The harness is model-agnostic — adding a model is an entry in `config.py`.

| Profile | Model | Use |
|---------|-------|-----|
| `deepseek` (default) | DeepSeek-V4 Pro | **Head-to-head.** Same model every harness reaches through a credential the team has. zWork + Claude Code hit DeepSeek's Anthropic-compatible endpoint directly; OpenCode reaches it natively. |
| `product-pro` | zWork Pro (via router) | zWork end-to-end through its real product path. Not head-to-head (competitors would need the router credential). |
| `product-ultimate` | zWork Ultimate (GLM-5.2 via router) | Same as above, frontier tier. |

For the head-to-head, use `--profile deepseek` (the default) with
`DEEPSEEK_API_KEY` set.

## Subsets

| `--subset` | Size | Purpose |
|-----------|-----:|---------|
| `smoke` | 3 | CI sanity check; ~$1, ~5 min. |
| `subset` (default) | 30 | Reproducible cross-section of the full 500 (deterministic stride, not cherry-picked). ~$10–40, ~1–3 h. |
| `full` | 500 | The headline number. ~$150–600, ~15–40 h. |
| `id1,id2,…` | n | Run specific instances by id. |

The 30-instance default is a **deterministic strided sample** of the sorted
dataset — it's an unbiased estimator of the full-500 rate, not a curated list,
so no model can overfit to it.

## Cost & time

Ballpark for `--profile neutral` (Claude Sonnet 4):

| Subset | Wall time (`--parallel 4`) | API spend |
|--------|---------------------------|-----------|
| smoke  | ~5 min                    | ~$1       |
| subset | 1–3 h                     | $10–40    |
| full   | 15–40 h                   | $150–600  |

Tune `--parallel` to trade wall time for API rate-limit pressure. Per-instance
budgets: `--max-turns` (default 40, mirrors other harnesses; product cap is 80)
and a 20-min wall timeout.

## Architecture

```
zwork-bench CLI
  ├─ subset.select() ─ pick instances
  └─ for each (instance × harness) ── ProcessPoolExecutor
       └─ driver.run_one()
            ├─ docker run <swebench image>          # repo at base_commit @ /testbed
            ├─ Harness.install(container)           # zwork: sidecar; claude-code: npm; opencode: curl
            ├─ Harness.run_task(prompt, model)      # harness-specific headless drive
            ├─ git -C /testbed diff                 # → model.patch (shared)
            └─ eval.grade(model.patch)              # official swebench.harness → resolved (shared)
  └─ report.build_and_write() ─ comparison table + per-harness breakdown
```

The container, patch extraction, and grader are **shared** across every
harness — only `Harness.install` and `Harness.run_task` differ. That's what
makes the head-to-head fair.

## Out of scope / follow-ups

- **Terminal-Bench / LiveCodeBench** — the harness is dataset-pluggable (add a
  loader to `subset.py`); defer until SWE-bench is shipping numbers.
- **Leaderboard submission** — once we have a defensible `--subset full`
  number, submit to `swebench.com`.
- **Browser/desktop benchmarks** — zWork's differentiator, but there's no
  standard cross-harness benchmark for them yet.
