# Context and harness research: summary

Date: 2026-11-16. The question was whether zWork's model is working with broken tools or badly managed context, how that compares with opencode, and whether offering too many tools hurts.

Seven notes sit in this folder. This page is the summary; the notes have the evidence and file:line references.

| Note | What it covers |
|---|---|
| [context-engineering.md](context-engineering.md) | Published research on tool count, long-context decline, compaction, memory and caching, plus a checklist for zWork |
| [harness-engineering.md](harness-engineering.md) | How pi-mono, Claude Code, Codex, Cline, Roo, Goose and Manus handle tools, output, compaction and loops |
| [opencode-internals.md](opencode-internals.md) | What opencode 2.0.26 actually does on GLM 5.3, from its source |
| [zwork-context-audit.md](zwork-context-audit.md) | How zWork builds and keeps the model's context; findings F1–F14, M1–M5 |
| [zwork-tool-audit.md](zwork-tool-audit.md) | zWork's tool list, its cost, and the tools that break; findings B1–B8 and a grouping proposal |
| [desktop-control-and-omp.md](desktop-control-and-omp.md) | A 2M-token run explained, the false CuaDriver permission cards, why desktop control fails, CuaDriver vs alternatives, and what to take from oh-my-pi |
| [agent-memory-and-token-efficiency.md](agent-memory-and-token-efficiency.md) | Added 2026-11-21. Open-source agent memory (ACE, Mastra Observational Memory, LightMem and others) and token-saving work (ACON, observation masking, source-judged compaction and others), ranked by how new, how proven and how well each fits zWork, with an adoption order and licence warnings |

Every finding listed below as confirmed was checked against the code on `site/redesign` at `66636d9`. External claims spot-checked in source: Codex compacts at 90% of the window (`openai_models.rs` `auto_compact_token_limit`), and Goose at 80% capped at 225k (`context_mgmt/mod.rs`).

## Short answer

**Yes, the model is sometimes working with broken tools and a damaged context.** None of it showed up in the bench, for three reasons:

- the bench tasks are single-turn;
- they stay small (the first step is about 12.5k tokens), so no compaction ever ran;
- they don't use the browser, the desktop or connected apps.

The two misses that cost zWork against opencode came from not checking its work, which `66636d9` addressed. The problems below appear in longer chats and real use. The local app log already shows several of them.

**Tool bloat is real, but the main harm is not what we expected.**

- The 39-tool list costs about 6k tokens on every model call, roughly 40% of a bench prompt. The model used 9 of those tools across 408 calls.
- In the bench, GLM 5.3 never picked a wrong or nonexistent tool. Wrong tool choice is not shown on our tasks.
- The worst damage comes from two other things:
  - **Tools offered when they can't work.** Desktop control is offered without permissions, and the browser tools are offered with Chrome disconnected.
  - **Tool results that are far too big.** One browser screenshot is about 80–90k tokens of base64 text.
- Research supports a leaner list for open models: vendor guidance says fewer than 20 tools, and open models lose a lot as catalogs grow. That research starts at about 49 tools, though, so it doesn't prove that 39 is worse than 15 for GLM 5.3. A bisection on our own bench would settle that; the design is below.

**opencode is not better at context management.**

- It has no pruning and no loop guard.
- It compacts at about 900k tokens on GLM 5.3, so it effectively never compacts.
- It re-sends everything on every step.

What it does better is simpler and copyable:

- 12 short tools;
- one generic output cap for every tool (2,000 lines / 50 KB, with the full output saved to a file);
- a 15-line system prompt.

## Confirmed problems, worst first

### The model gets broken input or loses the task

| # | Problem | When it bites | Where |
|---|---|---|---|
| 1 | **`browser_screenshot` returns the PNG as base64 text.** That is 308k–356k chars, about 80–90k tokens per call. The model can't see an image, so it retries; two real chats repeated the same call 4 times. | Every screenshot | `tools/mod.rs:943`, `browser_bridge.rs:100`, `harness_turn.rs:371` (F2, B1) |
| 2 | **Mid-run compaction drops the user's request.** Only the history before this turn is summarized. The start of the current turn (the request, the turn context, early tool work) is neither summarized nor kept. | Any run that passes ~184k estimated tokens (~112k on `zwork-auto`) | `structural_generation.rs:241` ignores `turn_prefix_messages` / `is_split_turn` (F1) |
| 3 | **A crashed tool reports an empty success.** The Composio result cap cuts at byte 8,000, which panics on non-ASCII text, and the bridge turns any tool panic into `Ok("")`. "Check my email" can come back as "nothing there". | Gmail results over 8 KB with curly quotes, accents or emoji | `composio.rs:860, 869`; `harness_turn.rs:309, 371` (F3) |
| 4 | **The overflow retry re-runs the whole turn.** Emails get sent again and files written again, the text of both attempts is shown, and the turn counter isn't reset. | A provider overflow error mid-run | `harness_turn.rs:1067-1120` (F4) |
| 5 | **`read` on a PDF or Office file returns raw bytes** and doesn't mention `extract_document`. | Any `read` of a .pdf/.docx/.xlsx | `harness/tools/read.rs:166` (B3) |
| 6 | **Tools offered that can't work.** The 11 desktop tools are offered on every Mac, even without permissions (`desktop_capture` failed 3/3 in real use). The 8 browser tools are offered with Chrome disconnected, alongside three conflicting instructions. `browser_eval` failed 8/8 in real use (page security policy). | Real use, not the bench | `cua/mod.rs:46`, B4–B6 |
| 7 | **Plan mode still offers Composio write actions** such as sending email, although the plan-mode prompt says it can't. | Plan mode with a connected app | `harness_turn.rs:1864` (B8) |
| 8 | **The compaction model is guessed by name on the same endpoint.** `gpt-oss` becomes `gpt-4.1-mini` on Ollama, a 404; gateway ids get first-party names. Compaction fails, and the turn runs uncompacted. | Ollama gpt-oss, OpenRouter and other gateways | `harness_turn.rs:2352` (F8) |

### The model's context is worse than it needs to be

| # | Problem | Where |
|---|---|---|
| 9 | **No output cap on zWork's own ~40 tools.** Real results: `desktop_list_apps` 40,871 chars, `read_skill` up to 63,746, every `browser_click` ~9.7k. Only pi's core tools and Composio have caps. | `harness_turn.rs:296-380` (F12, B2) |
| 10 | **The system prompt changes every minute** (it contains "Current time: HH:MM"), so each new message misses the prompt cache for the whole chat. The academic tool set also switches on and off with the wording of each message. | `memory.rs:272`, `settings.rs:539, 716`, `harness_turn.rs:1719` (F5) |
| 11 | **Earlier turns come back as plain text only.** Attachment paths, tool results and the expanded `/command` are gone on the next turn; a ≤4 KB "Work done so far" digest stands in. | `harness_turn.rs:1552`, `chatstore.rs:476` (F6) |
| 12 | **The bridge's compaction summary is never saved.** Past the threshold, a long chat re-summarizes everything on every turn. `compacted_summary` and `compaction_cursor` are never written. | `chatstore.rs:43-45` (F7) |
| 13 | **The summary is written for code.** It asks for function names, not figures, recipients, what was sent, or the request word for word. | `harness/compaction.rs:435-530` (F14) |
| 14 | **Limits computed wrong.** Summaries may write up to 131k–160k tokens, instead of pi's ~13k (F9). The 200k cap makes valid answers look like overflow on 1M-window models (F10). `zwork-auto` is sized by the 128k/16k fallback (M5). Nothing sets Ollama's context length (S1, still to check live). | `structural_generation.rs:287`, `harness_turn.rs:53, 1407`, `catalog.rs:25` |
| 15 | **The turn budget is never shown**, so the model hits the 80-step stop without warning. The bridge always passes turn 1. | `harness_turn.rs:1814` (M1) |
| 16 | **Memory rules contradict each other** ("note deadlines" vs "NEVER proactively save"), and memory can only grow: `replace`/`remove` have no callers, so once a file is full every save fails. | `settings.rs:263, 280`, `memory.rs:200, 235` (F13) |
| 17 | **Coding-agent instruction files leak into zWork's prompt.** It loads up to 64 KB from `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, opencode's and pi's files, plus any `AGENTS.md`/`CLAUDE.md` above the workspace. | `harness/context_files.rs:13-24` (M4) |
| 18 | **Descriptions promise things the tools don't do.** `spawn_agent` claims to return a task ID, `deploy_web_app` a public URL, `browser_navigate` "no login walls". `web_search` silently falls back to headlines. `save_memory` and Telegram report failure as success. There are duplicates too: `ask_question` = `ask_user`, six planner tools. | B7 and §3–4 of the tool audit |

Not checked here: F11 (early `length` stops treated as overflow), M2, M3, and S2. They are in the audit, marked as such.

## zWork, opencode and the others side by side

| | zWork today | opencode 2.0.26 | Others |
|---|---|---|---|
| Tools per call | 39 (≈6k tokens), 50 with specialist words, +Gmail ≈2.5k | 12 | pi 4, Cline 9, Codex ~6–10; Claude Code and Codex defer extra tools behind a search tool |
| System prompt | ≈7k tokens, changes each minute | 15 lines for GLM | pi and Manus keep dates out of it |
| Output cap | pi core tools only; Composio 8 KB (byte cut) | Every tool: 2,000 lines / 50 KB, rest saved to a file | pi, Goose, Claude Code, Roo save to a file and return a path plus a slice |
| Compaction starts | min(window, 200k) − 16k ≈ 184k (≈112k on `zwork-auto`) | window − max(10%, 16k) ≈ 900k on GLM 5.3 | Codex 90%, Cline ~81%, Goose 80% capped at 225k |
| What survives | Summary of earlier chat + ~20k tail; **the current request can be lost** (#2) | Structured summary + ~15k flattened tail | pi/Cline 20k tail, Codex recent user messages, Goose re-appends the latest request word for word |
| Old tool output | Kept in full until compaction | Kept in full | Cline marks outdated reads; Anthropic clears old tool results |
| Loop control | Repeat guard, 80-step cap (no warning, #15) | None; 10 retries | Cline warns at 3 repeats and stops after 6 mistakes; Goose shows a budget hint at half |

Research targets for GLM and DeepSeek, from LOCA-bench: keep the working context under about 32k tokens and compact by 48–64k. Both models lose about half their score by 64k. zWork's 184k threshold and opencode's 900k are both far past that. GLM 5.3 is newer than the GLM-4.7 that was measured, so the right number for it needs our own bench.

## Fix plan

### Phase 1: stop feeding the model broken tools

Small, independent changes, each with a test.

1. **Screenshots.** `browser_screenshot` returns an image block, downscaled to JPEG, to vision models. Other models get a saved file path. A data URL never goes in as text (#1).
2. **One output cap for every native tool.** Reuse pi's `truncate_or_spill`: head plus tail, with the full text saved to a file and its path in the note. `read_skill` lists its sections and loads them on demand (#9).
3. **Crashes become errors.** Cut Composio results at a char boundary. A tool stream that ends without a result reports "the tool crashed", not an empty success (#3).
4. **`read` on PDF/Office** points to `extract_document` instead of returning bytes (#5).
5. **Offer only tools that can work.**
   - Browser tools only while the extension is connected.
   - Desktop tools only with permissions granted.
   - Plan mode drops Composio write actions.
   - One plain-language line explains what's unavailable and why (#6, #7).
6. **Honest descriptions**, and remove `ask_question` (#18).

### Phase 2: keep the context intact

7. **Durable compaction keeps the request.** Summarize the turn prefix on a split turn, as the older `compact()` path does, and carry the user's request word for word. Use an office summary template: request, constraints and exclusions, figures and totals with their sources, what was sent or written, still to do (#2, #13).
8. **Summarize with the model the user is on.** Drop the cheap-model guess. Research found a smaller summarizer halved task scores (Tübingen), and it also fixes #8.
9. **No whole-turn rerun on overflow.** Retry only when no tool has run yet, and reset the run state before retrying (#4).
10. **A stable cache prefix.**
    - Move the time and the browser status into the per-turn context.
    - Keep the tool set fixed for the chat.
    - Put anything variable at the end (#10).
11. **Correct limits.**
    - Summary `max_tokens` comes from the reserve.
    - Overflow detection uses the real window.
    - Router tiers get explicit window and output sizes.
    - Ollama gets `num_ctx` of at least 64k (#14).
12. **Persist across turns.** Save the compaction summary and cursor. Save attachment paths and the expanded command with the user row (#11, #12).
13. **Small fixes.**
    - Show the turn budget (#15).
    - Pick one memory rule and expose replace/remove (#16).
    - Load only zWork's own `AGENTS.md` (#17).
14. **Clear old tool output before summarizing.** Past a budget, old results become one-line notes saying where to re-read them. Keep only the newest screenshot or snapshot in full. Clear in batches so the cache breaks rarely. The threshold gets tuned on the bench.

### Phase 3: a leaner tool list, after measuring

15. **Tool groups**, from the tool audit's §5:
    - A core of 14 tools stays on (≈2.35k tokens).
    - The browser, desktop, office, organiser, per-app Composio and academic groups are added at the start of a turn, only when they can work and the message calls for them.
    - Once added, a group stays for the rest of the chat, in a fixed order, so the cache holds.
    - This saves about 3.6k tokens per call.
16. **Tool-count bisection on the lite bench**, to check that 15 actually beats 39 before betting on it:
    - Arms: core only (~14), core plus the task's group (~20–25), today's list (39), and today's plus specialist (50).
    - Models: GLM 5.3 first, then DeepSeek, then gpt-oss on Ollama with `num_ctx` ≥ 64k.
    - Runs: 17 tasks × 4 arms × 2 runs = 136 runs for GLM.
    - Measure: pass rate, prompt tokens, wrong or unknown tool calls, steps used.

### Bench additions, so these stay fixed

The current bench can't see most of the above. Add:

- a long task run with `ZWORK_CONTEXT_WINDOW` lowered (e.g. 40k) so compaction fires, with an exclusion stated early ("skip anyone marked cancelled") that the grader checks at the end;
- a two-turn task whose follow-up refers to an attachment from turn one;
- a connected-app style task whose tool result is over 8 KB with non-ASCII text;
- a check that fails if any tool result over the cap reaches the model.
