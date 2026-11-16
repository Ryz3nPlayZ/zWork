# Harness engineering: how leading agents manage tools and context

Researched 2026-11-16. This note compares how established agent harnesses handle five things: which tools they load, how they cap tool output, how they compact context, how they persist memory and sessions, and how they guard the loop and the prompt cache. The goal is to find what zWork should copy.

zWork's agent loop is a Rust port of pi-mono, so pi comes first. opencode is covered in [opencode-internals.md](opencode-internals.md). zWork's own behavior is covered in [zwork-context-audit.md](zwork-context-audit.md).

**Method.** For open-source harnesses I read the code itself, pinned to one commit (listed in [Sources](#sources)). For Claude Code, Manus and the Anthropic API there is no code to read, so I used the official docs and engineering posts. Anything I could not confirm in source or official docs is marked **(unverified)**. Quoted wording is limited to short phrases.

---

## At a glance

| Harness | Default tools | Tool loading | Output caps (default) | Compaction trigger | What survives compaction | Loop guards |
|---|---|---|---|---|---|---|
| **pi-mono** (coding-agent) | 4 (read, bash, edit, write). grep, find, ls available | All upfront. Optional `tool_search` extension (BM25, off by default) for deferred tools | 2000 lines / 50 KB. read keeps the head and gives an offset hint. bash keeps the tail and saves the full output to a temp file. grep lines capped at 500 chars | context > window − 16,384 reserve. Also runs on overflow (compact, then retry once) | Last ~20k tokens kept verbatim. Older history becomes a structured summary plus lists of files read and modified | None in the loop: no turn cap, no repetition detection. Unknown tool or bad arguments come back as error results. Retry 3× with backoff |
| **Claude Code** | About 45 built-ins (Bash, Read, Edit, Write, Agent, Skill, ToolSearch, Task*, Web*, …) | Built-ins upfront. MCP tools deferred through ToolSearch by default (`auto` mode switches at 10% of the window) | Bash: 30k chars inline, beyond that a file path plus a 2k-char preview. Read: 25k tokens per call and 2000 lines. MCP: 25k tokens, warning at 10k | At the model's limit, with some exceptions: 200K for some models, ~967K on 1M-window models. Adjustable through `/autocompact` and env vars | Summary, plus re-injected CLAUDE.md, auto memory, skills (5k each, 25k total) and plan, plus up to 5 recently modified files re-read (each under 5k tokens) | Auto-compact thrashing stop. `--max-turns` (off by default). API retries 10 |
| **Codex CLI** | About 6–10 core: exec_command/write_stdin or shell, apply_patch, update_plan, view_image, web_search, request_user_input. Others conditional | Exposure modes Direct / Deferred / CodeModeOnly / Hidden. `tool_search` over deferred MCP tools | Per-model truncation policy, typically 10k tokens. Middle truncation with a "…N tokens truncated…" marker and a header giving the original count | min(configured limit, 90% of window). Also runs on context-window-exceeded and on a model switch to a smaller window | Summary handed off as if from another model, plus recent user messages up to 20k tokens, plus initial context re-injected | Argument-parse and unsupported-call errors returned to the model. Stream retries 5, request retries 4. Missing outputs filled with "aborted" |
| **Cline** (SDK rewrite) | 9: read_files, search_codebase, run_commands, fetch_web_content, editor or apply_patch, skills, ask_question, submit_and_exit | All upfront. GPT models get apply_patch instead of editor | Command output 48k chars, middle truncation with a hint to refine the command. Reads 2000 lines, 2000 chars per line. Any tool result 8k chars | 0.9 × (0.9 × window), about 81%, compacting down to 70%. Default max input 128k | Recent 20k tokens. Summary (Goal / State / Highlights / Next / Files, at most about 800 words). Outdated file reads replaced by a short marker | Identical-call warning at 3 repeats, escalation at 5. Stops after 6 consecutive mistakes |
| **Roo Code** (inactive since 2026-05, unverified) | About 23, gated by mode | Per mode (Code / Architect / Ask / …) | Terminal preview 10 KB, rest paged with `read_command_output`. read_file 2000 lines | Percentage threshold (`autoCondenseContextPercent`), or window × 0.9 − reserved output | "Fresh start" summary in a user message, with an `<analysis>` scratchpad. If condensing fails, falls back to dropping 50% of history non-destructively | Mistake limit 3. `ToolRepetitionDetector` |
| **Goose** | Developer extension: shell, write, edit, tree, read_image, plus other extensions | The agent enables or disables extensions itself. Optional code-execution mode | Shell: 2000 lines / 50 KB, full output saved to a temp file. Any text result over 200k chars goes to a file | 80% of window, capped at 225k tokens | Everything summarized as JSON working notes. Latest user message re-appended verbatim. Old tool-call pairs summarized in the background | Max turns 1000, with a turn-budget hint after half are used. Empty response retried 3×. Repetition inspector off by default |
| **Manus** (published lessons) | Large tool set, not enumerated | Every tool always in context. Unavailable ones blocked by logit masking and prefilling | Restorable compression: drop the content, keep the URL or path | Not published | Files on disk act as memory. `todo.md` is rewritten each step to recite the plan | Errors kept in context. Controlled variation to avoid few-shot ruts |
| **Anthropic API** (platform features) | n/a | `defer_loading` plus a regex or BM25 tool search. Up to 10k deferred tools. Keep 3–5 hot tools loaded | n/a | Server compaction `compact_20260112`: default 150k, minimum 50k. Context editing `clear_tool_uses`: default 100k | Compaction: everything before the last compaction block is dropped. Clearing: keeps the last 3 tool uses by default, can exclude named tools | n/a |

---

## pi-mono coding agent

Source: [badlogic/pi-mono @ 742d49f](https://github.com/badlogic/pi-mono/tree/742d49fcd8c51c90bbef704dc0f1a1c326bef728). The project docs now point to `earendil-works/pi`. Paths below are under `packages/coding-agent/` unless stated.

**1. Tools and loading**
- The default coding set is four tools: `read`, `bash`, `edit` and `write` (`src/core/tools/index.ts`). `grep`, `find`, `ls` and `powershell` exist but are opt-in.
- All tools are sent upfront.
- The `tool_search` extension (`src/extensions/tool-search/`) ranks deferred tools with BM25. It registers with `defaultActive: false`, and tools opt in with `exposure: "deferred"`.
- A separate code-mode extension also exists.

**2. Output caps** (`src/core/tools/truncate.ts`)
- Limits are 2000 lines and 50 KB, whichever comes first. grep match lines are capped at 500 chars.
- `read` keeps the head and appends a notice telling the model which offset to read from next.
- `bash` keeps the tail. The full output goes to a temp file, and the notice gives that file's path.
- Images are resized to at most 2000×2000 and about 4.5 MB (`src/utils/image-resize-core.ts`).

**3. Context management** (`docs/compaction.md`, `src/core/compaction/compaction.ts`)
- Trigger: `contextTokens > contextWindow − reserveTokens`. Defaults are `reserveTokens` 16,384 and `keepRecentTokens` 20,000.
- The check runs after tool results and before a new prompt.
- If a request overflows or the model stops early for length, pi compacts once and retries. `/compact [instructions]` compacts manually.
- The cut point walks back from the end until about 20k tokens are kept, and never splits at a tool result.
- If the cut lands inside a turn, the turn's prefix gets its own summary (`TURN_PREFIX_SUMMARIZATION_PROMPT`).
- The summary prompt asks for a structured checkpoint with these sections: Goal; Constraints & Preferences; Progress (Done / In Progress / Blocked); Key Decisions; Next Steps; Critical Context.
- A later compaction updates the previous summary instead of starting fresh (`UPDATE_SUMMARIZATION_INSTRUCTIONS`).
- Tool results are cut to 2000 chars before they go to the summarizer (`TOOL_RESULT_MAX_CHARS`).
- A summary that stopped on length is rejected.
- The `CompactionEntry` records `firstKeptEntryId` and cumulative `readFiles` / `modifiedFiles`.
- Summarization requests turn off cache writes.

**4. Memory and persistence**
- Sessions are stored as a JSONL tree (`docs/session-format.md`).
- Compaction and `context_edit` entries are appended without destroying history, so the full transcript survives.
- Moving between branches with `/tree` produces branch summaries.
- Context files are `AGENTS.override.md`, `AGENTS.md` and `CLAUDE.md` (`src/core/resource-loader.ts`).
- There is no cross-session memory tool in core.

**5. Robustness** (`packages/agent/src/agent-loop.ts`)
- An unknown tool returns a "Tool X not found" error result.
- Arguments are schema-checked (`validateToolArguments`).
- A message truncated mid-tool-call has its calls failed (`failToolCallsFromTruncatedMessage`).
- Streaming JSON is parsed with the `partial-json` library (`packages/ai/src/utils/json-parse.ts`).
- Retry settings: `maxRetries` 3, base delay 2 s, maximum 60 s (`docs/settings.md`).
- **There is no max-turn cap and no doom-loop detection.** zWork added both.

**6. Cache design**
- The system prompt is split into XML-tagged sections and carries no date (`src/core/system-prompt.ts`).
- Section changes are diffed into a patch message (`diffSystemPromptSections`) instead of rewriting the prompt.
- `src/core/cache-warmer.ts` pre-warms the cache.

## Claude Code

Claude Code is closed source. Every fact below comes from the official docs at code.claude.com/docs (pages: how-claude-code-works, context-window, prompt-caching, tools-reference, mcp, memory, model-config, env-vars, troubleshooting), read 2026-11-16.

**1. Tools and loading**
- tools-reference lists about 45 built-ins. The core ones are Bash, Read, Edit, Write, Agent, Skill, WebFetch, WebSearch and AskUserQuestion. Task* tools are the default on the models the docs list; TodoWrite is off unless re-enabled.
- Glob and Grep are not present by default on macOS, Linux and WSL; the shell is used for searching instead.
- MCP tools are deferred by default and loaded through `ToolSearch`.
- `ENABLE_TOOL_SEARCH=auto` loads MCP tools upfront until their definitions reach 10% of the window, and defers them after that.
- A server can opt out with `alwaysLoad`.
- Skills load on demand, and subagents run in their own context window.

**2. Output caps**
- Bash returns up to 30,000 chars inline (`BASH_MAX_OUTPUT_LENGTH`, ceiling 150,000). Longer output is saved to the session directory, and Claude gets the path plus a preview of the first 2,000 chars.
- Read returns at most 25,000 tokens per call. A whole file over that limit returns the first page with a "PARTIAL view" notice. A file over 256 KB gets an error that points to offset/limit or Grep.
- Glob returns at most 100 results, with a truncation flag.
- MCP output is capped at 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`), with a warning at 10,000. Text over 50,000 chars is saved to a file.
- Images are resized to fit model limits. PDFs over 10 pages are read in ranges of up to 20 pages.

**3. Context management**
- Without a configured window, compaction runs at the model's context limit, with these exceptions:
  - Some models compact at 200K.
  - Native 1M-window models compact at about 967K.
  - The auto-compact window can be set with `/autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
- The summary keeps requests and key code snippets, and can be steered with Compact Instructions in CLAUDE.md or `/compact focus`.
- After compaction, Claude Code re-injects:
  - CLAUDE.md and auto memory, from disk
  - skill descriptions, plus invoked skill bodies (5k tokens each, 25k total, oldest dropped first)
  - the plan-mode plan and a fresh git status
  - up to 5 recently modified files it had read or edited (files over 5k tokens come back as a path only)
  - a reminder of background tasks that are still running
- Claude Code also clears old tool results from context. The costs page mentions this, but the parameters are **(unverified)**.
- If context refills to the limit right after compacting several times in a row, Claude Code stops with an "Autocompact is thrashing" error instead of looping.

**4. Memory and persistence**
- CLAUDE.md files hold human-written instructions and load in full (up to 4 MiB).
- Auto memory has a `MEMORY.md` index; the first 200 lines or 25 KB load each session, with topic files read on demand.
- Claude Code reminds the model to shorten `MEMORY.md` when it nears that cap.
- Transcripts are stored per project and can be resumed with `--resume` / `--continue`.

**5. Robustness**
- API retries default to 10 (`CLAUDE_CODE_MAX_RETRIES`), with a separate backoff for 529 errors.
- `--max-turns` / `CLAUDE_CODE_MAX_TURNS` exists but is not set by default.
- The docs do not describe a repeated-call detector **(unverified)**.

**6. Cache design** (prompt-caching page)
- Requests are layered: system prompt and tools, then project context, then conversation. New content is only ever appended.
- Plan mode and skill loading add their instructions as messages, not as system-prompt edits.
- File-change notices are added mid-conversation as system reminders instead of editing earlier reads.
- Switching model or effort level breaks the cache.
- Compaction and tool-result clearing count as expected cache rebuilds.

## OpenAI Codex CLI

Source: [openai/codex @ 35145ab](https://github.com/openai/codex/tree/35145aba212e923f987ccefaf9086ceba31e3b7c). Paths are under `codex-rs/`.

**1. Tools and loading** (`core/src/tools/spec_plan.rs`)
- The tool set is assembled per model and per config:
  - `exec_command` plus `write_stdin` (PTY), or a one-shot `shell` / `shell_command`
  - `apply_patch`, freeform on supported models
  - `update_plan`, `view_image`, `web_search`, `request_user_input`
  - multi-agent tools such as `spawn_agent`
  - `get_context_remaining` / `new_context_window`
- Each tool has an exposure mode: Direct, Deferred, CodeModeOnly or Hidden.
- Deferred MCP tools are found through `tool_search` (`core/src/tools/handlers/tool_search.rs`).

**2. Output caps**
- `models-manager/models.json` gives each model a `truncation_policy`, typically 10,000 tokens. The fallback is 10,000 bytes (`protocol/src/openai_models.rs`).
- Truncation keeps the head and tail 50/50 with a "…N tokens truncated…" marker (`utils/string/src/truncate.rs`).
- A warning header states the original token count (`utils/output-truncation/src/lib.rs`).
- AGENTS.md is capped at 32 KiB (`config/src/config_toml.rs`).

**3. Context management**
- Auto-compaction fires at min(configured limit, window × 9/10). The effective window is 95% of nominal (`openai_models.rs`).
- Compaction also runs on ContextWindowExceeded and when switching to a smaller-window model (`core/src/session/turn.rs`).
- The prompt (`prompts/templates/compact/prompt.md`) asks for a handoff checkpoint covering progress, decisions, remaining work and key data.
- `summary_prefix.md` presents the summary as coming from another model.
- After compaction, Codex rebuilds history from:
  - the initial context
  - recent user messages, newest first, up to `COMPACT_USER_MESSAGE_MAX_TOKENS` = 20,000 (`core/src/compact.rs`)
  - the summary
- Alternatives exist: remote (server-side) compaction, and a model-driven `new_context_window` tool.

**4. Memory and persistence**
- Rollouts are saved as JSONL and can be resumed.
- A two-phase background pipeline writes memories to `~/.codex/memories` (`memories/README.md`).

**5. Robustness**
- Bad tool calls come back as "failed to parse function arguments" or "unsupported call" errors.
- Stream retries 5, request retries 4 (model-provider-info defaults).
- `core/src/context_manager/normalize.rs` inserts "aborted" outputs for calls with no result, so the history always pairs up.
- No doom-loop detector found **(unverified)**.

**6. Cache design**
- A `prompt_cache_key` is sent per conversation (`core/src/client.rs`).
- Synthetic IDs are stable, and deferred tools are kept out of the cached prefix.

## Cline (SDK rewrite)

Source: [cline/cline @ 146894b](https://github.com/cline/cline/tree/146894b6a42a7a554c6ff37f7bb33fe5122cc33d). Paths are under `sdk/packages/core/src/`. The older VS Code extension, which kept half or a quarter of the window, is historical **(unverified at this commit)**.

**1. Tools**
- Nine tools are always loaded: `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `editor`, `skills`, `ask_question`, `submit_and_exit`, and `apply_patch` (which replaces `editor` on GPT models).

**2. Output caps** (`extensions/tools/executors/output-limits.ts`, `session/services/message-builder.ts`)
- Command output is capped at 48k chars, with middle truncation and a hint to refine the command.
- Reads are capped at 2000 lines and 2000 chars per line. Editor arguments are capped at 6000.
- There is an 8000-char backstop on every tool result.
- A file read that a later read supersedes is rewritten to "[outdated - see the latest file content]".

**3. Context management** (`extensions/context/compaction-shared.ts`, `summarize-conversation.ts`)
- Usable input is 0.9 × window (default maximum 128k). Compaction triggers at 0.9 of that and targets 0.7.
- The last 20k tokens are preserved.
- The summary is capped at 8,192 output tokens and has these sections: Goal / State / Highlights / Next / Files.
- The summarizer system prompt asks for a continuation note of at most about 800 words. Tool results are cut to 2000 chars for the summarizer.
- The default strategy is "agentic", with "basic" as the fallback. Overflow recovery forces "basic".

**4. Memory**
- Skills and rules files. No separate memory store found **(unverified)**.

**5. Robustness**
- `runtime/safety/loop-detection.ts`: 3 identical consecutive calls trigger a soft warning, 5 trigger a hard escalation.
- `maxConsecutiveMistakes` 6 (`types/config.ts`).

**6. Cache**
- Anthropic `cache_control` breakpoints are applied.

## Roo Code

Source: [RooCodeInc/Roo-Code @ b867ec9](https://github.com/RooCodeInc/Roo-Code/tree/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16). The last commit is 2026-05-15, so the project may be wound down **(unverified)**.

**1. Tools**
- About 23 native tools, filtered by mode (Code, Architect, Ask, Debug, custom).

**2. Output caps**
- Terminal output shows a 10 KB preview. The rest is paged with `read_command_output` (`src/core/prompts/tools/native-tools/read_command_output.ts`).
- `read_file` is capped at 2000 lines.

**3. Context management** (`src/core/context-management/index.ts`, `src/core/condense/index.ts`)
- The usable budget is window × (1 − 0.1) − reserved output tokens. Condensing triggers at `autoCondenseContextPercent` or at that budget.
- The summary is sent as a "fresh start" user message.
- The condense prompt asks for an `<analysis>` scratchpad, then numbered sections.
- Condensed messages are tagged with `condenseParent` rather than deleted.
- Orphaned tool calls get synthetic tool results.
- If condensing fails, Roo drops 50% of the history without destroying it.

**5. Robustness**
- Consecutive-mistake limit of 3.
- `src/core/tools/ToolRepetitionDetector.ts` blocks identical repeated calls.

## Goose

Source: [block/goose @ d8de0e7](https://github.com/block/goose/tree/d8de0e789f1931cd54d6764dee931166b6c091ca) (2026-11-16).

**1. Tools and loading**
- The developer extension provides `shell`, `write`, `edit`, `tree` and `read_image` (`crates/goose/src/agents/platform_extensions/developer/mod.rs`). Other extensions are MCP servers.
- The agent can enable or disable extensions mid-session (`platform_extensions/ext_manager.rs`).
- A code-execution mode (`code_execution.rs`) lets the model call tools from a script instead of one call at a time.
- An older "tool router" appears to have been removed **(unverified)**.

**2. Output caps**
- Shell output is capped at 2000 lines and 50 KB. The full output is saved to a private temp file, with 8 rotating slots. Preview constants are 50 lines / 10 KB (`developer/shell.rs`).
- Any text result over 200,000 chars is written to a file instead (`agents/large_response_handler.rs`).
- Images are capped at 20 MB (`developer/image.rs`).

**3. Context management** (`crates/goose/src/context_mgmt/mod.rs`, `crates/goose-context-management/`)
- Trigger: usage > `GOOSE_AUTO_COMPACT_THRESHOLD` (default 0.8), lowered so that compaction never waits past 225,000 tokens (`DEFAULT_AUTO_COMPACT_TOKEN_LIMIT`).
- The whole visible history is summarized.
- **The most recent user message is re-appended verbatim** after the summary, together with that turn's context event. Manual `/compact` skips this.
- The prompt (`prompts/compaction.md`) asks for a discarded `<analysis>` checklist, then exactly one JSON block. Its fields: `user_intent`, `technical_concepts`, `files`, `errors_and_fixes`, `problem_solving`, `user_messages`, `pending_tasks`, `current_work`, `next_step`. The JSON is rendered through `compaction_summary.md`.
- Separately, **tool-pair summarization** condenses the oldest tool call/result pairs in batches. It starts once the count passes `3 × effective_limit / 20,000` (clamped to 10–500), and the current turn's calls are protected.

**4. Memory and persistence**
- Sessions are stored in a local database.
- Per-turn context (working directory, time, extension hints) is added as a turn-context message, called MOIM (`agents/moim.rs`), rather than edited into the system prompt. It is skipped for windows under 32k.

**5. Robustness**
- `GOOSE_MAX_TURNS` defaults to 1000. Once half the turns are used, each turn carries a `<turn-budget>N/M used</turn-budget>` hint. At the cap, Goose asks the user whether to continue (`crates/goose-agent/src/max_turns.rs`).
- An empty model response is retried up to 3 times with a short nudge (`empty_response.rs`).
- The repetition inspector (`tool_monitor.rs`) is off unless `max_repetitions` is set.
- Provider retry policy is in `crates/goose-provider-types/src/retry.rs`.

**6. Cache**
- Keeping per-turn context out of the system prompt (MOIM) keeps the prefix stable.

## Manus (published lessons)

Source: Yichao "Peak" Ji, [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), 2025-07-18. This is a blog post, not code, so the numbers are the author's.

1. **Design around the KV-cache.**
   - The input-to-output ratio is about 100:1, and cached tokens cost a tenth as much on the cited model.
   - Keep the prefix stable; a timestamp at the top of the system prompt is a classic mistake.
   - Keep history append-only and serialize JSON deterministically.
   - Mark cache breakpoints explicitly when the provider needs it.
2. **Mask, don't remove.**
   - Adding or removing tools mid-task breaks the cache and leaves earlier calls pointing at tools that no longer exist.
   - Manus keeps every tool defined and restricts choice by masking logits.
   - It uses function-calling modes (auto / required / specified, the last enforced by prefilling up to the function name).
   - Tool names share prefixes (`browser_`, `shell_`) so a whole group can be allowed or blocked at once.
3. **Use the file system as context.**
   - Compression should be restorable: drop a page's content but keep its URL, or a document's text but keep its path.
4. **Recite the plan.**
   - A typical task takes about 50 tool calls.
   - Rewriting `todo.md` keeps the goal near the end of the context, where attention is strongest.
5. **Keep the wrong stuff in.**
   - Failed actions and errors stay visible so the model updates its beliefs and does not repeat them.
6. **Don't get few-shotted.**
   - A run of near-identical actions, such as reviewing 20 resumes, makes the model drift into a rut.
   - The fix is small, controlled variation in serialization and phrasing.

## Anthropic API context features

Sources: platform.claude.com docs: [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing), [compaction](https://platform.claude.com/docs/en/build-with-claude/compaction), [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool). Read 2026-11-16. These are server features of Claude models only; zWork's GLM and DeepSeek routes cannot use them, but they show what Anthropic considers good defaults.

**Server-side compaction** (`compact_20260112`, beta `compact-2026-01-12`)
- `trigger` defaults to 150,000 input tokens, minimum 50,000.
- `instructions` replaces the default prompt entirely. The default asks for state, next steps and learnings inside `<summary>` tags.
- `pause_after_compaction` lets the client edit messages before continuing.
- The response begins with a `compaction` block, and later requests ignore everything before the last one.

**Context editing** (beta `context-management-2025-06-27`)
- `clear_tool_uses_20250919` parameters:
  - `trigger`: default 100k input tokens, or a tool-use count
  - `keep`: default the last 3 tool uses
  - `clear_at_least`: a minimum per clear so each clear is worth the cache rebuild
  - `exclude_tools`
  - `clear_tool_inputs`: default false
- `clear_thinking_20251015` keeps the last N thinking turns.
- Clearing invalidates the cache from the cleared point onward, so clears should be batched.

**Tool search** (`tool_search_tool_regex_20251119` / `_bm25_20251119`)
- All tool definitions are still sent with each request; deferred tools (`defer_loading: true`) only enter context when a search returns them as `tool_reference` blocks.
- Each search returns 5 tools by default. Up to 10,000 tools can be deferred.
- Recommendations:
  - Keep the 3–5 most used tools loaded.
  - Prefix tool names by service (e.g. `github_`) so one search matches the whole group.
  - Skip tool search for fewer than 10 tools.
- The docs say selection accuracy degrades past 30–50 tools.
- Deferred tools can't carry `cache_control`.

**Memory tool** (`memory_20250818`)
- The tool is client-side: the app runs the file operations on `/memories` itself.
- Commands: view, create, str_replace, insert, delete, rename.
- The API automatically adds a protocol to the system prompt telling the model to view memory first and to assume interruption.
- It is designed to pair with clearing and compaction, so state outlives the context.

---

## Patterns worth copying

### What the strong harnesses agree on

1. **Spill big output to disk instead of dropping it.**
   - pi (bash), Goose (shell, and anything over 200k), Claude Code (Bash over 30k, MCP over 50k) and Roo (`read_command_output`) all save the full output and give the model a path plus a slice.
   - The truncation notice always says what was cut and how to get the rest: an offset, a file path, or a hint to refine the command.
   - Manus states the same principle as restorable compression.
2. **Head for files, tail for commands, middle when unsure.**
   - Reads keep the start (pi, Claude Code).
   - Command output keeps the end, because errors print last (pi, Goose).
   - Codex and Cline keep both ends with a marker in the middle.
3. **Compact well before the hard limit, and keep the recent tail verbatim.**
   - Codex compacts at 90% of the window, Cline at about 81%, and Goose at 80% (capped at 225k).
   - pi compacts at the window minus a 16k reserve.
   - Three harnesses keep about 20k tokens of recent material verbatim: pi (recent tail), Cline (recent tail) and Codex (recent user messages).
4. **Use a structured checkpoint summary, not prose.**
   - Every summarizer asks for roughly the same sections: goal and intent; constraints and preferences; done / in progress / blocked; decisions; files touched; next step.
   - Goose and Roo add a discarded `<analysis>` pass first.
   - pi updates the previous summary instead of re-summarizing the summary.
5. **Re-inject what must not be lost after compaction.**
   - Claude Code re-reads its memory files, skills, plan and recently modified files.
   - Codex re-injects the initial context.
   - Goose re-appends the latest user message verbatim.
   - pi carries file lists in the compaction entry.
6. **Make the cache prefix stable.**
   - Keep the system prompt and tools fixed, and append everything else as messages: Claude Code system reminders, Goose MOIM, pi system-prompt diffs.
   - Keep dates out of the system prompt (pi, Manus) and serialize JSON deterministically (Manus).
7. **Turn errors into tool results, not crashes.**
   - All the harnesses return unknown tools, bad JSON and schema failures to the model as error results.
   - Codex and Roo also repair orphaned calls with synthetic results so the history always pairs up.
8. **Cap repetition in two stages.**
   - First the model is warned or steered, then the run stops. Cline (3 then 5) and Roo work this way, and so does zWork's own detector.
   - Separate counters cap consecutive mistakes: Cline 6, Roo 3.

### Where they differ

- **How many tools load at once.**
  - Minimalists load a few tools upfront: pi 4, Cline 9, Codex about 6–10.
  - Claude Code loads many built-ins but defers MCP tools behind search.
  - Goose lets the agent switch whole extensions on and off.
  - Manus keeps everything defined and masks choices.
- **What compaction keeps.**
  - Goose summarizes everything and keeps only the latest user message.
  - pi and Cline keep a 20k token tail.
  - Codex keeps recent user messages but no tool output.
- **Clearing as a cheaper step before full compaction.**
  - Some harnesses rewrite old tool output without summarizing: Anthropic `clear_tool_uses`, Cline's outdated-read marker, Goose's tool-pair summaries, Claude Code's tool-result clearing (parameters unverified).
  - pi, Codex and Roo go straight to summarizing.
- **Turn caps.** Goose 1000, Claude Code off by default, pi none. Cost-capped products need one; developer tools mostly don't.

### Fit for zWork: a non-technical office agent on GLM 5.3 and DeepSeek

zWork keeps pi's defaults: a 16,384-token reserve, a 20k recent tail, 2000 lines / 50 KB output caps, and the structured summary prompt (`sidecar-rust/src/harness/compaction.rs`, `harness/tools/truncate.rs`). It adds three things of its own:
- a doom-loop guard that steers once, then stops (`agent/mod.rs`)
- an 80-turn cap with a turn-budget line meant to appear after 50%, the same idea as Goose (`agent/harness_turn.rs`, `agent/orientation.rs`). In practice the line never appears: the bridge always passes turn 1 (see M1 in [zwork-context-audit.md](zwork-context-audit.md)).
- 39 tool definitions on a normal turn, 50 with the specialist keyword tools (counted in [zwork-tool-audit.md](zwork-tool-audit.md))

Suggestions follow. These are my recommendations, not findings, so check each against [zwork-context-audit.md](zwork-context-audit.md).

1. **Add a ratio cap to the compaction trigger.**
   - On a large window, "window − 16k" lets context grow far past where mid-tier models stay sharp.
   - Use the smallest of: window − reserve, about 0.8 × window, and a fixed ceiling. Goose's 225k is precedent.
   - [context-engineering.md](context-engineering.md) has the evidence on long-context degradation.
2. **Always keep the latest user request verbatim (Goose) and make the summary office-shaped.**
   - pi's 20k tail usually contains the latest request, but a single huge turn (a spreadsheet dump, many screenshots) can push it into the split-turn summary.
   - Add summary sections for files produced and where they were saved, figures and totals computed with their inputs, user preferences (formats, recipients), and actions waiting for the user's approval.
3. **Clear old tool output before summarizing.**
   - Screenshots, page snapshots and file extracts dominate an office agent's context.
   - Replace old results with a one-line restorable stub (the path or URL plus "re-read if needed") and keep the last few. That follows Manus, Cline's outdated-read marker and Anthropic's `keep: 3`.
   - Clear in batches so each clear pays for its cache rebuild, as `clear_at_least` does. DeepSeek and GLM prefix caching is assumed **(unverified here)**.
4. **Re-inject after compaction what users can't re-explain.**
   - The todo list, saved memory, the active skill or template, and the paths of files the agent wrote (Claude Code pattern).
   - A non-technical user can't repair a lost thread the way a developer can.
5. **Load fewer tools, and change them only at turn boundaries.**
   - At about 40 tools, zWork is past the 30–50 range where Anthropic reports selection accuracy degrading. Mid-tier models are likely more sensitive **(unverified)**.
   - Anthropic's server-side tool search isn't available on these routes, and Manus-style logit masking isn't exposed by hosted APIs.
   - The practical options are prefix-named groups (`browser_`, `desktop_`, `doc_`) switched by task mode, as in Roo modes or Goose extensions, or a local `tool_search` like pi's BM25 extension.
   - Never change the tool list mid-turn, or the cache breaks.
6. **Add a consecutive-mistake counter next to the doom-loop guard.**
   - Count invalid arguments, unknown tools and repeated errors, steer at 3 and stop at about 6 (Cline and Roo numbers).
   - Also retry empty responses up to 3 times with a nudge (Goose). Mid-tier models produce empty responses and malformed calls more often than frontier models **(unverified, but consistent with zWork's phantom-tool-loop history)**.
7. **Recite the plan, and vary repetitive batches.**
   - Office paperwork often means 20 near-identical items: receipts, invoices, resumes. That is exactly Manus's few-shot rut.
   - Keep the todo list refreshed near the end of context.
   - Hand batches to a script or subagent instead of 20 identical tool-call cycles.
   - Leave failed attempts visible but capped.
8. **Keep the prefix stable.**
   - No clock or date in the system prompt; send it in the per-turn context block, which zWork already uses.
   - Use deterministic tool-schema and argument serialization.
   - Keep the tool order fixed across turns.

---

## Sources

**Code**, pinned at the commits read:
- pi-mono: `742d49fcd8c51c90bbef704dc0f1a1c326bef728` (2026-11-16), https://github.com/badlogic/pi-mono
- Codex: `35145aba212e923f987ccefaf9086ceba31e3b7c` (2026-11-16), https://github.com/openai/codex
- Cline: `146894b6a42a7a554c6ff37f7bb33fe5122cc33d` (2026-11-16), https://github.com/cline/cline
- Roo Code: `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16` (2026-05-15), https://github.com/RooCodeInc/Roo-Code
- Goose: `d8de0e789f1931cd54d6764dee931166b6c091ca` (2026-11-16), https://github.com/block/goose

**Docs**, read 2026-11-16:
- Claude Code: https://code.claude.com/docs/en/ (pages: how-claude-code-works, context-window, prompt-caching, tools-reference, mcp, memory, model-config, env-vars, troubleshooting)
- Anthropic API: the context-editing, compaction, tool-search-tool and memory-tool pages linked above

**Posts:**
- Manus context-engineering post (2025-07-18), linked above
- Anthropic's "Effective context engineering for AI agents" post is linked from the tool-search docs but was not read for this note

**zWork** (read-only):
- `sidecar-rust/src/harness/compaction.rs`
- `sidecar-rust/src/harness/tools/truncate.rs`
- `sidecar-rust/src/agent/mod.rs`
- `sidecar-rust/src/agent/harness_turn.rs`
- `sidecar-rust/src/agent/orientation.rs`
