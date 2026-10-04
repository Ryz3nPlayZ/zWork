# Lite bench: zWork vs OpenCode

Twelve small, deterministic tasks that run in a few minutes with no Docker.
Each run starts with a fresh git workdir in `$TMPDIR`, kept outside this
checkout so an agent can't reach the hidden tests. The runner drives one
harness headlessly on that workdir and grades the result with a script.
Both harnesses use the same model through the same DeepSeek
OpenAI-compatible endpoint.

```bash
python3 bench/lite/run.py                                  # every task, both harnesses, 1 rep
python3 bench/lite/run.py --reps 2 --parallel 6
python3 bench/lite/run.py --harness zwork --tasks fix-pagination,csv-report
python3 bench/lite/run.py --provider ollama                 # local Ollama (gpt-oss:120b-cloud), no key
python3 bench/lite/run.py --report bench/lite/runs/<ts>     # re-render a report
```

Requirements:
- the zWork sidecar built with `cargo build --release` in `sidecar-rust`;
- `opencode` on PATH;
- `node` for `js-date-bug`;
- for `--provider deepseek` (the default), a DeepSeek key in `$DEEPSEEK_API_KEY` or as `env.ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`;
- for `--provider ollama`, a running Ollama daemon.

## Tasks

Each `tasks/<id>/` contains:

| File | Role |
|---|---|
| `prompt.md` | The user message. |
| `repo/` | The seed. |
| `setup.py` | Optional. Runs in the workdir before the agent starts. |
| `hidden/` | Tests the agent never sees. |
| `grade.py WORKDIR` | Prints `{"pass": bool, "detail": str}`. |

The graders copy the workdir before they run, so grading never changes what
the agent left behind.

| Task | What it checks |
|---|---|
| fix-pagination | Two off-by-one bugs; hidden edge-case tests. |
| implement-roman | Implement from a spec, including validation errors. |
| csv-report | Messy CSV → JSON aggregates (trim, title-case, exclude refunds). |
| rename-symbol | Rename across a package without touching look-alike identifiers. |
| perf-dedupe | O(n²) → O(n) with identical semantics; 200k-record time limit. |
| js-date-bug | Make a lenient duration parser strict (Node). |
| cli-wordfreq | Write an argparse CLI to spec; exit codes and tie ordering. |
| codebase-qa | Answer questions by reading code, with a stale comment and a misleading name as traps. |
| organize-files | Sort, dedupe and flatten files, then write a manifest. |
| multi-bug | Three bugs, plus tests the agent must add. |
| sqlite-query | SQL over a generated DB with refund and status traps. |
| config-migrate | v1 → v2 JSON config migration with normalisation rules. |

## Harnesses

- **zwork** runs a private sidecar (`ZWORK_HOME` in the run dir, cwd set to
  the workdir) and POSTs one message to `/api/chat/stream`. Pass
  `--zwork-coding-only` to use the coding prompt and the restricted tool set.
- **opencode** runs `opencode run --standalone --auto --format json` with an
  isolated `XDG_CONFIG_HOME`, so no user MCP servers or plugins load, and all
  permissions allowed. A warm-up prompt runs first so provider setup isn't
  counted against the first task.

`PWD` is set explicitly because opencode resolves its project directory from
`$PWD`, not the process cwd. A run whose events mention this checkout's path
is marked `escaped` and counted as a fail.

## Output

Everything goes in `runs/<timestamp>/`, which git ignores:

- `meta.json`: model, commit and versions.
- `report.md`: pass rates plus median time, tool calls and tokens.
- `<harness>/<task>/r<n>/`: `result.json` and `events.jsonl` (the raw event
  stream), plus the sidecar or opencode logs.
