# Lite bench: zWork vs OpenCode

Seventeen small, deterministic tasks that run in a few minutes with no
Docker: twelve on code and files, and five everyday office jobs (expenses,
invoices, form letters, payroll, a contract). Each run starts with a fresh git
workdir in `$TMPDIR`, kept outside this checkout so an agent can't reach the
hidden tests. The runner drives one harness headlessly on that workdir and
grades the result with a script. Both harnesses use the same model through
the same endpoint.

```bash
python3 bench/lite/run.py                                  # every task, both harnesses, 1 rep
python3 bench/lite/run.py --reps 2 --parallel 6
python3 bench/lite/run.py --harness zwork --tasks fix-pagination,csv-report
python3 bench/lite/run.py --provider ollama                 # local Ollama (gpt-oss:120b-cloud), no key
python3 bench/lite/run.py --provider zai                    # GLM 5.3 on the Z.ai coding plan
python3 bench/lite/run.py --report bench/lite/runs/<ts>     # re-render a report
```

Requirements:
- the zWork sidecar built with `cargo build --release` in `sidecar-rust`;
- `opencode` on PATH;
- `node` for `js-date-bug`;
- for `--provider deepseek` (the default), a DeepSeek key in `$DEEPSEEK_API_KEY` or as `env.ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`;
- for `--provider ollama`, a running Ollama daemon (`BENCH_OLLAMA_URL` overrides `http://127.0.0.1:11434/v1`, e.g. to route through a logging proxy);
- for `--provider zai`, a Z.ai coding-plan key. Each harness uses the key it
  already has: zWork's from its `secrets.json` (credential `zai-coding-plan`),
  opencode's from its `auth.json`. If only one exists, both use it, and
  `$ZHIPU_API_KEY` overrides both. Both talk to
  `https://api.z.ai/api/coding/paas/v4`; opencode through its built-in
  `zai-coding-plan` provider, zWork through a custom model on the same
  credential, set up the way the Settings page saves one.

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
| expense-report | Thirteen receipts → a month's expense report by policy: categories, a duplicate photo, a personal purchase, other months, euro conversion with and without a printed rate. |
| invoice-reconcile | Match a bank statement to invoices (references written different ways, a part payment, an unnumbered payment), list what's unpaid with days overdue, write reminders for the overdue ones. |
| client-letters | Mail merge from a template and a customer list: opt-outs in mixed case, a missing email, a duplicate, titles in the greeting, stray spaces. |
| weekly-payroll | Timesheets in three formats (start/end with breaks, h:mm, decimals, night shifts past midnight) → hours, overtime past 40 and pay. |
| contract-summary | Read a Word contract with an amendment that changes the fee and the late interest; fill in the key terms and write a short summary. |

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

## Results so far

### GLM 5.3 on the Z.ai coding plan

All 17 tasks, 2 reps each, product mode, zWork commit `bcad87c`
(run `20261116-001151`).

| harness | pass | median time | median tool calls | median in tok | median out tok |
|---|---|---|---|---|---|
| opencode | 32/34 | 41s | 8 | 79k | 2.0k |
| zWork | 30/34 | 49s | 6 | 80k | 2.0k |

Every other task passed 2/2 for both harnesses, including all five office
tasks for opencode and four of them for zWork.

- **rename-symbol** failed 0/2 for both, the same way: they renamed `calc`'s
  `disc` argument and left `Cart.total(disc=...)` alone. The prompt said "its
  keyword argument", so that was a fair reading. The prompt now names
  `Cart.total` too, and both went 2/2 (`20261116-003710`).
- **zWork's two other misses had the same cause: it didn't check its work.**
  On expense-report it typed the CSV by hand and dropped one row, while its
  summary totals were right. On sqlite-query its SQL subtracted refunds
  wrongly, and it reported a top customer at more than twice the runner-up
  without a second look. The product prompt now has a short "check before
  you say it's done" section: read back what you wrote, check that items
  and totals agree with the inputs, look into a result that stands out, and
  work things out with a script. Re-run on six tasks with 3 reps each
  (`20261116-003254`, zWork only), expense-report, sqlite-query,
  invoice-reconcile, weekly-payroll and csv-report all went 3/3.
- **client-letters**: in that re-run zWork twice saved `James_OBrien.md`
  without the apostrophe. The prompt doesn't say how to handle one, so the
  grader now accepts either spelling, as long as `sent.csv` names the same
  file. All three runs pass with that.

### gpt-oss on Ollama

All on `gpt-oss:120b-cloud` through Ollama, 2 reps per task, product mode.

| run | zWork commit | zWork pass | opencode pass | zWork median in tok | opencode median in tok |
|---|---|---|---|---|---|
| `20261003-233752` (baseline) | `2f98fd8` | 20/24 | 20/24 | 137k | 116k |
| `20261004-000305` | `ab8c1fb` | 20/24 | 19/24 | 126k | 97k |

What came out of it:

- **Ollama cloud stream failure.** On some contexts the stream dies with a
  bare `{"error":{"message":"Internal Server Error (ref: …)"}}` line, which
  has no `data:` prefix. Proxy traces show it happens while gpt-oss emits a
  tool call with a long multi-line argument, usually a bash heredoc of Python.
  Every byte-identical retry fails the same way, so the plain retry loop
  burned its attempts. zWork now reports the provider's message, and each
  retry ends the request with a short note that is never persisted. The note
  steers toward writing code to a file with `write` and running it with
  `bash`. With that note, csv-report went from 0/2 to 3/3 (focused run
  `20261004-001429`), and retries rescued 3 of the 4 turns that hit the
  failure. opencode hits the same failure: it went 0/2 on csv-report in
  `20261004-000305`.
- **Prompt overhead.** zWork sent about 54k characters of system prompt on
  every call; the skills listing alone was 15k. Clipping each skill
  description to 150 characters removes about 10k characters (about 2.6k
  tokens) per call. zWork still sends more input per call than opencode,
  mainly from the prose tool list and 50 tool schemas in product mode.
- **organize-files** is mostly lost to model mistakes in both harnesses:
  collision order, manifest sort order, and wrong `original` paths. The
  grader accepts either case-insensitive collision outcome.
