# How opencode manages tools and context

Researched 2026-11-16 for comparison with zWork's `bench/lite` (GLM 5.3 via opencode's built-in `zai-coding-plan` provider; opencode 32/34, zWork 30/34).

**Source.** The canonical repo is `github.com/anomalyco/opencode`; `sst/opencode` redirects (301) there. The installed `opencode --version` is **2.0.26**, which matches tag `v2.0.26` (commit `9b4ec57`, 2026-10-08). Every reference below is to that tag.

**Paths.** Paths are relative to `packages/core/src`, except:
- `ai/…` means `packages/ai/src`.
- `cli/…` means `packages/cli/src`.

Line numbers are approximate to ±2.

**What v2 is.** v2 is a rewrite (Effect-TS services plus internal plugins). Several v1 behaviours people still describe online are **gone**:
- `todowrite`
- tool-output prune
- `doom_loop`
- read-before-edit timestamps
- LSP diagnostics after edits

Treat older blog posts and docs as v1.

**Inferred.** Anything marked *(inferred)* is my reading of behaviour, not something stated in the code.

---

## Key facts for the comparison

1. **GLM gets the short generic system prompt.** It is 15 lines, plus 3 tool-guidance sentences. It says nothing about verifying, testing, todo lists or thoroughness. Only gpt, claude, kimi, trinity and muse models get custom prompts (`plugin/optimize.ts`, `session/runner/prompt/system.txt`).

2. **The prompt steers the model away from the shell for file work.**
   - The prompt and the shell description both say "Prefer dedicated tools over shell commands".
   - They tell the model not to chain separators like `echo "===="`.
   - The prompt says "Prefer parallelizing independent tool calls".

   (`session/system-prompt.ts:11-26`, `system.txt:6`, `tool/plugin/shell.ts:35-45`)

3. **There is no `ls` tool. Listing a directory is a `read` call.** A file under 50 KB with no offset or limit comes back whole, with `N: ` line prefixes. Output is cut at 2,000 lines / 50 KiB, with a "continue with offset" marker (`tool/plugin/read.ts`, `tool/read-filesystem.ts:14-15,151`).

4. **The tool set GLM sees in the bench:** read, edit, write, shell, glob, grep, question, skill, subagent, webfetch, websearch, plus a Code Mode `execute` tool.
   - `patch` (apply_patch) is only for `gpt-` models.
   - `todowrite` no longer exists.

   (`tool/plugin/patch.ts:295-305`, `tool.ts:225-256`, `database/v1-migration.bun.ts:899-901`)

5. **Editing gives the model almost no feedback and enforces nothing.**
   - The model gets one line back: `Edited <file> (N replacements)`. The diff goes only to the UI.
   - Diagnostics are not run. LSP is a TODO.
   - The model is not required to read a file before editing it.

   Matching tries three passes: exact, then Unicode-normalized, then line-by-line with trailing whitespace trimmed (`tool/plugin/edit.ts:49-107,163-168,216`).

6. **Context is never trimmed during a bench run.**
   - v2 has no prune of old tool outputs.
   - Auto-compaction fires at `window − max(10% of window, 16k)`. For glm-5.3 (1M context) that is about 900k tokens, so it never fires on bench-sized tasks *(inferred from task sizes)*.
   - Every earlier file read, tool output and reasoning block is re-sent on every step.

   (`session/compaction.ts:94-101,905-912`, `config/normalize.ts:332-333`)

7. **Compaction, when it does happen**, produces:
   - a structured summary: Objective / Requirements / Decisions / Work State / Next Move / Relevant Files / Important Context;
   - plus the newest ~15k tokens kept as flattened text, with tool results cut to 1,250 characters.

   All of this is wrapped in a `<conversation-checkpoint>` user message (`session/compaction.ts:139-176,702-820`, `session/runner/to-llm-message.ts:306-325`).

8. **Loop control is minimal.**
   - There is no default step limit.
   - v2 has no doom-loop detection.
   - The run ends at the first step that makes no tool call.
   - Retries: 10, with exponential backoff capped at 10 s per gap.
   - No reminders are injected mid-run (no todo, verify or step-count nudges).

   (`session/runner/llm.ts:188-297`, `session/runner/step.ts:285-287`, `session/runner/retry.ts`)

9. **Bench mode (`run --standalone --auto`) auto-answers permission prompts.** The `question` tool is refused with feedback telling the model to make reasonable assumptions and state them (`cli/run/noninteractive.ts:70-71,158-197`).

10. **What the bench numbers actually show: the "re-reads twice as often" gap is more first reads, not re-reads.**

    | Measure | opencode | zWork | Ratio |
    |---|---|---|---|
    | `read` calls (per-task means summed over 17 tasks) | 71.8 | 38.0 | 1.9× |
    | Same-path re-reads (all runs) | 3 | 3 | equal |
    | All file and directory "looks" (read, ls, glob, find, plus shell cat/head/tail/sed/wc/ls/find) | 85.0 | 64.6 | 1.3× |

    The gap comes from four things:
    - directory listings counted as `read`;
    - one `read` per input file instead of `cat` in a shell;
    - many reads issued in parallel in one step;
    - somewhat broader exploration on the codebase tasks.

    The method is in §5.

---

## 1. System prompt and injected environment

### Prompt selection
- `plugin/optimize.ts` swaps the base prompt by model id:
  - `gpt` (L18, L37)
  - `claude` (L26, L45)
  - `kimi` (L51-52)
  - `trinity` (L55)
  - `muse` (L58)

  The plugin list is at L62.
- `glm` matches none of them, so it gets the default `session/runner/prompt/system.txt`.
- The GPT- and Anthropic-specific tool-removal plugins are disabled.
- `plugin/verbosity.ts` only affects GPT-5.x and gpt-6, so it does not apply to GLM.

### Default prompt (`session/runner/prompt/system.txt`, 15 lines), summarized
- **L1:** identity, "AI agent running in OpenCode, a coding agent harness".
- **L4:** format answers as GitHub-flavored Markdown.
- **L5:** `<system-reminder>` blocks come from the harness.
- **L6:** "Prefer parallelizing independent tool calls".
- **L7:** a slot for `${OPENCODE_TOOL_GUIDANCE}`.
- **L10-11:** use clear file paths; be "clear and concise".
- **L14-15:** stay consistent with the surrounding code; investigate before deleting or overwriting.

It has **no** instruction about verifying work, running tests, re-reading output, planning or todo lists.

### Tool guidance (`session/system-prompt.ts:11-26`)
The guidance is added only for tools that are present.
- **shell present:** "Prefer dedicated tools over shell commands" for reading, searching and editing, and do not chain commands with separators like `echo "===="`.
- **write present:** create or replace whole files, but prefer edit for existing files.
- **edit present:** `oldString` must be unique, or use `replaceAll`.

### Environment (`instructions/builtins.ts`)
- **L29-30:** "Today's date: …". When the date changes mid-session, an "is now:" message is sent.
- **L38-43:** an `<env>` block with:
  - working directory
  - workspace root
  - "Is directory a git repo"
  - platform
  - "Prefer <tmp> over /tmp"
- **L51:** "The environment you are running in is now:" when the environment changes.
- There is **no git status, no file tree and no directory listing** in the prompt. The model has to look for itself.

### Project instructions
- `config/plugin/instruction.ts` loads the global AGENTS.md, plus AGENTS.md files found walking up from the working directory. CLAUDE.md is **not** loaded as instructions.
- Skills are discovered from `.claude/skills` and `.agents/skills` (`config/plugin/compatibility.ts:40`).
- After a `read`, any nested AGENTS.md is added as a synthetic user message "Instructions from: <path>" (`tool/plugin/read.ts:82-107`, `session/instructions.ts:74-78`).

### Request assembly (`session/model-request.ts`)
- **System message (L100-120):** `[agent.system ?? SessionSystemPrompt.make(toolNames), initial instructions]`.
- **Instruction order is fixed** for cache-prefix stability (`session/context.ts:147-149`).
- **Output budget (L87-98):** the model's output limit, fitted to the room left in the window.
  - Fallback 32k
  - Max 256k
  - Min 1,024
  - Estimate error margin 15%
- **Images (L43-46):** a per-request image budget. Images beyond it are replaced by an IMAGE_REMOVED text.
- **Token estimate:** characters / 4 (`util/token.ts`).

### Code Mode catalog
When `execute` is enabled, a catalog of the code-mode tools is delivered through the instructions channel (`tool.ts:249-256`, `codemode/tool.ts:60-68`). That means the opencode namespace tools (session_rename, models, …) plus any MCP tools.

---

## 2. Tools

### Registration and gating
- **Order** (`plugin/internal.ts:213-247`): Patch, Edit, Glob, Grep, OpenCodeTools, McpResource, Question, Read, Shell, Skill, Subagent, WebFetch, WebSearch, Write.
- **Direct tools vs Code Mode** (`tool.ts:225-256`):
  - Tools marked `codemode: false` are sent as direct tool definitions: edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch, write, and patch.
  - All other tools (the opencode namespace and MCP tools) are reachable only through the `execute` tool, which runs JavaScript in a sandbox and calls `tools.<ns>[…]`.
- **Permissions:** a tool whose permission is wholly denied is dropped from the list (`tool.ts:225-233,292-295`). The bench config allows everything (`{"*": "allow"}`).
- **patch:** kept only if the model id contains `gpt-` and is not oss or gpt-4. Otherwise it is removed, so **GLM edits with edit + write** (`tool/plugin/patch.ts:295-305`).
- **Removed in v2:** `todowrite` and the other v1 tools (`database/v1-migration.bun.ts:899-901`).
- **Renamed in v2:** bash → `shell`, task → `subagent`, apply_patch → `patch`.

### Description sizes
Descriptions are short; ~tokens are estimated at characters / 4.

| Tool | Description |
|---|---|
| read | ~110 tokens (`read.ts:44`) |
| edit | ~120 (`edit.ts:125`) |
| shell | ~11 lines (`shell.ts:35-45`) |
| grep | ~50 |
| glob | 1 line |
| skill | ~40 |
| subagent | 6 lines |
| execute | 6 lines |

### read (`tool/plugin/read.ts`, `tool/read-filesystem.ts`)
- **What it handles:** a file or a directory. Lines are prefixed `N: `, with offset/limit paging.
- **Description advice:** "Prefer one larger read over many small slices", and use grep to locate text.
- **Limits:** 2,000 lines and 50 KiB (`read-filesystem.ts:14-15`).
  - A file of 50 KB or less with no offset or limit is returned whole (L151).
  - Lines longer than 2,000 characters are cut.
- **Paging marker:** `[Output truncated. Continue reading with offset: N]` (`read.ts:196,209`).
- **Missing file:** "Did you mean one of these?" with up to 3 suggestions (L169).

### edit (`tool/plugin/edit.ts`)
- **Matching passes** (L49-102, L163-168):
  1. exact match
  2. Unicode-normalized match
  3. line-by-line match with trailing whitespace trimmed

  Windows (CRLF) line endings are preserved.
- **Errors:**
  - not found
  - "Found N matches" (when not unique)
  - old and new strings identical
  - empty old string
- **Success:** only `Edited <file> (N replacement[s])` goes back to the model (L216). The diff is metadata for the UI.
- **Not yet built:** L105-107 list file-watcher notification, snapshots/undo, and "LSP notification and diagnostics" as TODOs. So no diagnostics come back after an edit.
- **No read-before-edit or file-timestamp check** exists anywhere in core (the v1 `FileTime` guard is gone).

### write (`tool/plugin/write.ts`)
- Returns "Wrote file successfully" or "Created file successfully" (L39).
- LSP is a TODO (L44).

### shell (`tool/plugin/shell.ts`)
- **Timeout:** 2 minutes by default.
- **Description:** "Prefer dedicated tools over shell commands" and "Rely on automatic truncation".
- **Background mode:** the model is told not to poll (L26).
- **Failure:** a non-zero exit appends "Exited with code N".
- **Output cap (L236-247):** keeps the **tail**, 2,000 lines / 50 KiB, configurable via `tool_output.max_lines` and `tool_output.max_bytes`. The marker says `[showing lines a-b of N; full output saved to …]`.

### Generic output cap (`tool-output.ts`, applied in `session/runner/step.ts:131`)
- 2,000 lines / 50 KiB, keeping the **head**.
- The full output is saved to a file and kept for 7 days (L13-15).
- The marker says `[showing lines 1-N of M; full output saved to <file>]` (L89-90).
- It is skipped if the tool already truncated its own output (L68).

### Other tools
- **glob:** has a default result limit. On truncation it says to "Consider using a more specific path or pattern".
- **grep:** uses ripgrep. Returns "Found N matches" with `Line N:` previews.
- **websearch:** tells the model the current year.
- **subagent:** runs in the foreground or background; it can continue an earlier subagent by `sessionID`.
- **question:** asks the user. In non-interactive runs it is cancelled with feedback (see §4).

### Agents
- **Default agent:** `build` (`agent.ts:13`, `plugin/agent.ts:80-85`). It has no `steps` limit.
- **Subagents:**
  - `general`
  - `explore`, which is read-only and has its own prompt
- **Hidden agents:** `compaction`, `title` and `summary`. The summary agent writes a PR-style session summary, not part of the main loop. Its prompt says not to mention running tests (`plugin/agent.ts:69`).

### Invalid tool calls
- **Repair before validation** (`plugin/tool-input-repair.ts`, 170 lines, L7-16). These repairs are schema-safe:
  - parse JSON that arrived as a string;
  - turn numeric and boolean strings into numbers and booleans;
  - drop unknown keys on closed objects;
  - drop `null` or `{}` placeholders on optional fields;
  - recurse into arrays, tuples, dictionaries and nested fields, to depth 6.

  `execute` is skipped.
- **Unknown tool:** `No tool named "X" is currently available. Please use a tool from the available tool list.` (`tool.ts:281-283`).
- **Tool not offered this request:** "Tool is not available for this request" (`tool.ts:275`).
- **Bad arguments:** `Invalid arguments for tool "X": <issues> Arguments provided: <json> Update the arguments and call the tool again.` (`tool/runtime.ts:98`).
- **Arguments cut off mid-stream:** "Tool call arguments were not completed… Re-issue the tool call" (`session/runner/step.ts:64-68`).

---

## 3. Context management

### Window, overflow and auto-compaction (`session/compaction.ts`, 963 lines)
- **Settings** (L42-48; config keys in `config/plugin/compaction.ts`):
  - `compaction.auto`
  - `compaction.buffer` (unset by default)
  - `compaction.keep.tokens` (default `{auto: true, keep: 15_000}`, L211)
- **Constants** (L94-101):
  - SHRINK_STEPS [0.7, 0.5, 0.35]
  - RESERVE_MIN 16,000
  - UNKNOWN_WINDOW 200,000
  - TOOL_OUTPUT_MAX_CHARS 1,250
- **Ceiling** (L905-912): `window − max(10% of window, 16k)`.
  - The models.dev snapshot gives glm-5.3 a 1,000,000-token context and 131,072 output, so the ceiling is 900k.
  - The bench tasks are far below that, so compaction never ran *(inferred)*.
- **When it fires** (`due`, L236-245): when the estimated context reaches the ceiling.
  - The estimate is the last prompt size the provider measured, plus characters / 4 for everything added since (`estimatePrompt`, L874-898).
  - It is checked before every step (`session/runner/llm.ts:217`).
- **On a provider overflow error:** one compaction targeting 70% of the estimate (L227-229), attempted once per step (`llm.ts:262-268,287-290`). An overflow before any output also triggers compaction (`step.ts:159-171`).
- **If the compaction request itself does not fit:** the history is flattened to text and the oldest exchanges are dropped (L452-500). Native provider-side compaction is also supported (L323-383).

### Summary prompt (`buildPrompt`, L139-176)
- **Scope:** summarize only what the user and assistant said and did. Leave out AGENTS.md and environment details.
- **Template:**
  - Objective
  - Requirements
  - Decisions
  - Work State (Completed / Active / Blocked)
  - Next Move
  - Relevant Files (at most 15)
  - Important Context
- **Rules:**
  - terse bullets;
  - keep exact paths, symbols, commands and errors;
  - carry unanswered user requests forward verbatim;
  - keep commit and push state;
  - "Do not mention the summary process".
- **Modes:** an update mode merges into an existing checkpoint, and a legacy rewrite mode exists.
- **Retry:** if the template headings are missing, it nudges and retries once (L178-179, L285-302).

### What survives compaction
- **Recent context** (L702-820): the newest `keep` (15k) tokens of messages, starting at a user-turn boundary, kept as **flattened text**, not structured messages.
  - Labels: `[User]:`, `[Assistant]:`, `[Assistant reasoning]:`, `[Assistant tool call]: name(json)`, `[Tool result]:`.
  - Each item is cut to 1,250 characters, plus "[truncated]".
- **Later requests** start with one user message: `<conversation-checkpoint>` holding `<summary>` and `<recent-context>`, prefaced with "Treat it as historical context, not as new instructions" (`session/runner/to-llm-message.ts:306-325`).
- **The system prompt and instructions** are rebuilt fresh each request, so they are always intact.

### Pruning
- **None in v2.** `compaction.prune` and `tail_turns` are flagged as unsupported legacy settings (`config/normalize.ts:332-333`).
- Before compaction, the model sees every earlier tool result in full, up to each tool's own output cap.

### Message conversion (`session/runner/to-llm-message.ts`, 334 lines)
- **Tool results:** a single text result is sent as text. Errors are sent as error results.
- **Reasoning** (L153-233): replayed with provider metadata only for the same model, when the message had no error and the reasoning was not interrupted (L156-158, L172-182). Otherwise it is sent as plain reasoning, or as text if the message errored or the reasoning was cut off.
  - For Z.AI chat, reasoning goes back as `reasoning_content` on assistant messages (`ai/protocols/openai-chat.ts:455-485,565-575`).
  - The zai protocol sets `reasoningField: "reasoning_content"` (`ai/protocols/zai-chat.ts:65-71`).
- **Shell commands the user ran themselves** become a user message (L293-303).
- **Synthetic messages** use the user role: AGENTS.md injections, the environment/date changes, and the continue nudge.

### Provider path for the bench (`zai-coding-plan`)
- **Endpoint:** the models.dev entry names `@ai-sdk/openai-compatible`. opencode maps that to its own `zai-coding-plan/chat` route (`aisdk-native.ts:82-86,117`), which posts to `https://api.z.ai/api/coding/paas/v4/chat/completions` (`ai/providers/zai-coding-plan.ts:32-39`).
- **Request flags:**
  - `tool_stream: true` for GLM 4.6 and later when tools are present (`ai/protocols/zai-chat.ts:44-58`);
  - `max_tokens`;
  - no strict schemas.
- **Thinking variants** (`variant.ts:270-292`): low, high and max. Choosing one sends `thinking: {type: enabled, clear_thinking: false}` plus `reasoningEffort`.
  - The bench passes no variant, so no `thinking` field is sent and Z.AI's default applies *(inferred)*.

### Prompt caching
- **Explicit cache breakpoints:** the auto policy (tools + system + tail, at most 4) applies only to routes in `RESPECTS_INLINE_HINTS` (`ai/cache-policy.ts:39-55`). That list includes `zai-coding-messages` but **not** `zai-coding-chat`, the route the bench uses.
- **`prompt_cache_key`:** sent only when the provider sets `supportsPromptCacheKey` (`ai/protocols/openai-chat.ts:792-799`). zai does not.
- **Result:** the bench relies on Z.AI's implicit prefix caching. The fixed instruction order keeps that prefix stable.

---

## 4. Loop control

### Main loop (`session/runner/llm.ts`, 375 lines)
- `drain` (L188-195) calls `runStep` repeatedly (L206-297).
- **Step limit (L223):** `stepLimitReached = agent.steps !== undefined && step >= steps`. The `build` agent sets no `steps`, so **there is no limit by default**.
- **At a configured limit** (L237-241, `runner/max-steps.ts`):
  - an assistant message "CRITICAL - MAXIMUM STEPS REACHED" is appended;
  - `toolChoice` is set to `none`;
  - the tool definitions are kept so the cache prefix still matches.

### Steps (`session/runner/step.ts`, 325 lines)
- **Tool execution (L126-138):** each tool starts **as soon as its call finishes streaming**, and calls in one step run concurrently.
- **Missing result:** "Provider did not return a tool result" (L63).
- **When the run ends (L285-287):** when `needsContinuation` is false. That is true only if the step called at least one tool that the provider did not run itself (`publish-llm-event.ts:619`). So **a reply with no tool call ends the run**. There is no completion check, verification pass or "are you done?" turn.

### Retries (`session/runner/retry.ts`)
- **Backoff (L42-56):** exponential from 2 s, capped at 10 s per gap, up to 10 retries, with jitter. That is about 84 s in total.
- **Retry-After:** the provider's value is honoured up to 15 minutes (L31-40).
- **Timeouts:** at most 3 retries (L58-62).
- **Cut-off stream:** after a retry, a synthetic message says "The previous response was interrupted. Continue from where you left off without repeating completed content." (`llm.ts:35-36,278-286`).

### Doom-loop detection
- **None in v2.** `doom_loop` exists only in the v1 permission config (`v1/config/permission.ts:31`).
- The only defence is prose in the trinity prompt (`trinity.txt:86`), which asks the model not to repeat the same tool call with the same parameters. GLM does not get that prompt.

### Mid-run reminders
This is the complete list:
- plan-mode enter/leave `<system-reminder>`, for the plan agent only (`plugin/plan.ts:14-25`);
- nested AGENTS.md injections after a read;
- date or environment change messages;
- the interrupted-stream continue message;
- a restart note after the process resumes (`session/execution/restart.ts`).

There are **no todo, verify, step-count or progress reminders**.

### Non-interactive run (bench)
The bench runs `opencode run --standalone --auto --format json -m zai-coding-plan/glm-5.3` (`bench/lite/run.py:301-339`).
- **Permissions:** auto-answered "once" (`cli/run/noninteractive.ts:158-183`).
- **`question`:** cancelled with feedback saying the run "cannot ask the user questions" and the model should make reasonable assumptions and state them (L70-71, L189-197).

---

## 5. What plausibly explains the extra reading and checking

### Method
- **Data:** every `events.jsonl` under `bench/lite/runs/*/{opencode,zwork}/*/*/`. That is 38 opencode runs and 56 zWork runs.
- **Counting:** tool calls were counted per run, averaged per task, then the 17 task means were summed. This stops tasks with more runs from dominating.
- **"Looks":** read, ls, glob and find calls, plus shell commands matching cat, head, tail, `sed -n`, wc, ls or find. This was matched by regex, so it is approximate.
- **Re-read:** the same path read again by `read` in the same run.

### Raw tool totals

| Harness | Calls |
|---|---|
| opencode | read 168, shell 89, edit 49, write 46, grep 8, glob 7, skill 1 |
| zWork | read 148, bash 131, write 55, edit 37, ls 29, grep 3, extract_document 2, read_skill 2, find 1 |

- opencode's 168 reads break down as 139 file reads, 26 directory listings and 3 failures. One failure was a GLM path typo, then retried.
- zWork made 47 bash calls that were cat, head, sed or tail.

### Findings
- **True re-reads are rare and equal: 3 vs 3.** The "twice as often" impression comes from `read` call counts (71.8 vs 38.0, 1.9×). Counting every kind of look, the gap shrinks to 85.0 vs 64.6 (1.3×).
- **Biggest per-task `read` gaps (opencode vs zWork means):**

  | Task | opencode | zWork |
  |---|---|---|
  | expense-report | 17 | 8.8 |
  | codebase-qa | 9.5 | 3.5 |
  | weekly-payroll | 7.25 | 4.0 |
  | config-migrate | 7 | 3 |
  | invoice-reconcile | 6 | 2.8 |

### Likely causes, strongest first
1. **Directory listings go through `read`.** opencode has no `ls` tool, so 26 of its 168 reads were listings. zWork's equivalent is 29 `ls` calls, which are not counted as reads.
2. **One `read` call per file instead of shell `cat`.**
   - The prompt and the shell description both say to prefer dedicated tools over shell, and ban separator-chained commands, which rules out the `for f in …; do echo ===; cat $f; done` pattern.
   - The prompt also says to parallelize independent calls.

   On expense-report, opencode read each receipt with its own `read` call, up to 13 tool calls in one step (runs typically take 3–9 steps). zWork more often used `cat`/`head` in bash. *(The causal link to the prompt wording is inferred; the call patterns are measured.)*
3. **Broader exploration on code tasks (codebase-qa, config-migrate).** Nothing in opencode's prompt asks for thoroughness, so this looks like GLM's own default behaviour under a short prompt *(inferred)*.
4. **Thin edit feedback did not cause re-reads.** opencode returns no diff or diagnostics after an edit and does not require a prior read, yet same-path re-reads stayed at 3. When it checked its work, it used the shell (for example, an `awk` sum of the expense totals after writing the report).

### Checking after writing
- **Measure:** any read, shell or grep after the last edit or write in a run.
- **Result:** opencode 26 of 34 runs (76%), zWork 32 of 46 (70%). The two are similar.
- **Cause:** opencode's prompt never asks for verification, so its checking is the model's own habit *(inferred)*.
- **Gap to zWork's prompt:** zWork's prompt now asks explicitly for read-back and total checks (commit `66636d9`). opencode's prompt has no counterpart to that.

### Context differences that may matter *(inferred)*
- **Full history:**
  - opencode keeps every earlier tool output in full for the whole run;
  - it never prunes;
  - compaction is effectively off at 1M tokens;
  - reasoning is replayed every turn.

  The model can therefore look back at earlier file contents rather than reading them again. That fits the low re-read count.
- **Possible correctness edge:** the full history plus whole-file reads (anything under 50 KB in one call, no slicing) may help explain opencode's small lead on the data-heavy office tasks.
- **Cost:** every step re-sends all of it. Only Z.AI's implicit prefix cache softens that, because the `zai-coding-chat` route sends no cache hints and no cache key.
