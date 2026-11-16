# zWork context audit: how the model's context is built and kept

Date: 2026-11-16. Scope: the Rust sidecar (`sidecar-rust/`): the durable AgentHarness port of pi-mono and the bridge in `src/agent/harness_turn.rs`. Method: code reading along one conversation end to end, plus the existing unit tests and the agent traces from `bench/lite/runs/` (5 runs, 56 `agent.jsonl` files). No source was edited and nothing ran against the user's real data. Paths below are relative to `sidecar-rust/src/` unless they say otherwise.

Tests run (`cargo test --release <filter>`), all passing:

| Filter | Result |
|---|---|
| compaction | 20 passed |
| overflow | 5 passed |
| estimate | 3 passed |
| transform_messages | 3 passed |
| orientation | 5 passed |
| memory | 2 passed |

None of these tests covers the gaps listed below: durable split-turn compaction, gateway or Ollama compaction model ids, non-ASCII Composio truncation, or the overflow retry.

Bench baseline (GLM 5.3, single-turn tasks):

- First-step prompt (input + cache read): 12.5k to 12.8k tokens.
- Prompt-cache hit ratio per step: median 0.97, mean 0.86.
- Largest tool results: `read_skill` 61,006 chars, `read` 13,966, `bash` 5,230, `extract_document` 1,699.
- No compaction fired in any bench run, so none of the compaction paths has bench coverage.

---

## Ranked findings

Severity scale: **Breaks correctness**, **Degrades quality**, **Minor**. Each finding is tagged Confirmed (by code path or language semantics) or Suspicion (needs a live check).

### Breaks correctness

**F1. Mid-run compaction drops the start of the current turn, including the user's request.** Confirmed by code path.

- **Where**:
  - `harness/runtime/drive/structural_generation.rs:241` destructures only `{ messages_to_summarize, previous_summary, .. }`.
  - `:298-305` summarizes only `messages_to_summarize`.
  - `:626-643` commits `Compaction { summary, retained_tail, details: None }`.
  - The preparation does contain the missing part: `harness/runtime/drive/structural.rs:64-66, 79-81` stores `turn_prefix_messages` and `is_split_turn`, computed in `harness/compaction.rs:770-795`. Nothing in `harness/runtime` reads them (grep).
- **What happens**:
  - A long zWork run is one user turn with many tool steps. When the durable runtime compacts at a checkpoint (estimate above 200k minus 16,384), `find_cut_point` keeps the last ~20k tokens. That cut almost always lands inside the current turn, which makes it a split turn.
  - Only the history before the turn is summarized. That history is the small, plain-text earlier conversation, and it is often empty on a chat's first turn. The turn prefix is neither summarized nor kept: the user's request, the hidden `<turn-context>`/"Work done so far" prefix and all early tool work.
  - From then on the model sees a summary of earlier chat (or of nothing) followed by a tail that starts mid-task. It no longer knows what it was asked to do.
  - The classic `compact()` port in the same codebase does handle this (`harness/compaction.rs:848-895`: a second turn-prefix summary that is merged in). The durable path never calls it.
- **Evidence**: grep finds `turn_prefix_messages` and `is_split_turn` only at construction (`structural.rs:79-81`, `drive.rs:935-937`). `threshold_compaction_commits_and_completes` covers a non-split case only.
- **Fix**:
  - In `structural_generation.rs`, when `is_split_turn`, generate the turn-prefix summary with `TURN_PREFIX_SUMMARIZATION_PROMPT` and merge it, as `compact()` does.
  - Always carry the turn's first user message verbatim into the summary entry.
  - Store `file_ops` in `details` instead of `None`.

**F2. `browser_screenshot` feeds a base64 PNG to the model as text.** Confirmed by code path; not reproduced live (it needs the Chrome extension).

- **Where**:
  - `app/src-tauri/extension/background.js:53-58` returns `{ result: { dataUrl } }` from `captureVisibleTab(png)`.
  - `browser_bridge.rs` `send_command` returns `serde_json::to_string(&response)`.
  - `zbctl.rs:75-77`, then `tools/mod.rs:943-945`, then `agent/harness_turn.rs:371-373` (`AgentToolResult::text`).
  - The tool schema at `tools/mod.rs:564-566` even says "Returns base64-encoded PNG."
- **What happens**:
  - A full-tab PNG is typically hundreds of KB to over 1 MB of base64, which is roughly 50k to 250k+ tokens. One call can push the run past the 200k compaction window or the provider's limit.
  - The model gets no image, only noise. Even a text-only model is charged for it.
- **Fix**:
  - Decode the data URL and return an image content block, downscaled and as JPEG, for vision models.
  - Otherwise write the PNG to the scratch area and return its path.
  - Never return a raw data URL as tool text.

**F3. Composio results can panic on non-ASCII text, and a panicking tool returns an empty "success".** Confirmed by Rust semantics and the code path; not reproduced live.

- **Where**:
  - `connectors/composio.rs:860` and `:869`: `compact.truncate(SHAPED_RESULT_CAP)` and `t.truncate(SHAPED_RESULT_CAP)` cut at byte 8,000.
  - `String::truncate` panics when that byte is not a char boundary. `serde_json::to_string` writes non-ASCII as raw UTF-8: curly quotes, dashes, non-breaking spaces, emoji, any non-English mail.
  - The tool runs in `tokio::spawn` (`tools/mod.rs:724`). A panic drops the channel.
  - `NativeTool::run` (`agent/harness_turn.rs:308-373`) then ends its loop with `result_txt = ""` and `result_ok = true`, and returns `Ok(AgentToolResult::text(""))`.
- **What happens**:
  - The fallback runs whenever the JSON is still over 8 KB after per-string trimming. The Gmail fetch default of 25 messages hits it routinely.
  - The model receives an empty successful result for "check my email" and may confidently tell the user there is nothing.
  - The same empty-success path applies to a panic in any native tool.
- **Fix**:
  - Truncate at a char boundary (walk back to `is_char_boundary`).
  - In `NativeTool::run`, treat a stream that ends without a `tool_result` event as an error ("the tool crashed"), not an empty success.

**F4. The overflow retry re-runs the whole turn and repeats its side effects.** Confirmed by code.

- **Where**: `agent/harness_turn.rs:1067-1120` (`drive_durable`).
- **What happens**:
  - When the durable run fails with an overflow-looking error, the bridge compacts the pre-run `history` only and calls `run_durable_once` again on a brand-new session with the same prompt.
  - Every tool the failed attempt already ran runs again: mail sent, files written, tasks scheduled.
  - `accumulated_text`, `activities` and the `turn` counter on `TurnShared` are not reset; resets exist only in `consume_queued_message`, `:160-162`. The chat row therefore shows attempt 1's text followed by attempt 2's, and the retry starts partway through the 80-turn budget.
  - The durable runtime has already tried its own overflow compaction before reaching `Failed`. The overflow therefore usually comes from growth inside the turn, which compacting pre-run history cannot fix.
  - The probe only sees error text, so a silent overflow is not detected here.
- **Fix**:
  - Drop the bridge-level whole-turn retry, or limit it to the case where the run produced no tool calls.
  - If it stays, reset the per-run state before retrying.

### Degrades quality

**F5. The system prompt changes every minute, so every new turn misses the prompt cache.** Confirmed by code.

- **Where**:
  - `memory.rs:272-307`: `build_timeline_block` prints "Current time: HH:MM AM (tz)".
  - It is inserted near the top of the template (`settings.rs:259-261`, filled at `:539` and `:716`), so everything after it, including all history, misses the cache on the first step of each turn that starts in a new minute.
- **Other per-turn variables in the system prompt**:
  - `include_academic` is derived from each message's wording (`agent/harness_turn.rs:1719`). It changes prompt sections and the tool list (`settings.rs:595-732`).
  - Browser connected or not (`harness_turn.rs:1783-1792`; at the end of the prompt, which is fine).
  - Desktop driver availability, the connected-apps block, plan mode, and the MCP block.
- **Bench**: within one run the prompt is frozen (stored in the session), which is why the per-step cache hit is ~0.97. The bench is single-turn, so the cross-turn miss doesn't appear in it.
- **Duplication**: the current time also appears in `<turn-context>` (`agent/orientation.rs:57-79`).
- **Fix**:
  - Give the system-prompt timeline day granularity, or move it into the turn context, which already carries the time.
  - Keep the tool list independent of message wording.
  - Put any variable block at the end of the system prompt.

**F6. Earlier turns are replayed as plain text only.** Confirmed by code; partly by design.

- **Where**:
  - `agent/harness_turn.rs:1552-1587` (`history_to_messages`).
  - `chatstore.rs` `content_to_text` keeps only text blocks.
  - `harness_turn.rs:1671` stores only the typed user text.
  - The attachment listing exists only in that turn's prefix (`:1800-1804`).
- **What is lost on the next turn**:
  - tool calls and results;
  - reasoning;
  - images;
  - attachment paths;
  - the expansion of `/command args`: history shows the raw command, not the prompt it stood for (`:1828`).
- **The stand-in**: a ≤4 KB "Work done so far" digest (`chatstore.rs:424-428, 476-518`) with arguments cut to 120 chars and results to 200 chars, dropping the oldest lines first.
- **Effect**: follow-ups like "now fix row 12 of the sheet I sent" lose the file path unless it survives in a digest argument, and figures computed in a previous turn exist only as far as the assistant's prose repeated them.
- **Fix**:
  - Persist attachment names and paths with the user row and replay them.
  - Replay the expanded command prompt.
  - Consider keeping the last turn's tool results (capped) verbatim.

**F7. Bridge compaction is never saved, so long chats re-summarize everything every turn.** Confirmed by code.

- **Where**:
  - `chatstore.rs:43-45` defines `compacted_summary` and `compaction_cursor`. They are only defaulted (`:113-114`) and copied (`:562-563`), never written.
  - Pre-run compaction is at `agent/harness_turn.rs:1894-1904`, through `compact_history` (`:1124-1167`).
  - Each run's durable session (`{chat_id}__{uuid}`, `:884`) is discarded, so mid-run compaction results are not carried forward either.
- **What happens**:
  - Once a chat's flattened text crosses the threshold, every turn pays for a fresh full summary, which differs from the last one, so the cache never hits after it.
  - The summarizer input is unbounded: all messages in one request (`harness/compaction.rs` `generate_summary_with_usage`). Only tool results are clipped to 2,000 chars (`:340`).
  - Once the history exceeds the summarizer's real window, compaction fails every turn: a "compaction failed" event (`:1163`), then the turn runs uncompacted.
  - Realistically this needs a very long chat, since replay is plain text only.
- **Fix**: write the summary and cursor to chatstore and seed later turns from summary + messages after the cursor, which is what pi does by keeping one session.

**F8. The compaction model is guessed by name on the same endpoint.** Confirmed by code.

- **Where**: `agent/harness_turn.rs:1711-1713` calls `compaction_model_id(shape, real_model_id)` (`:2352-2377`), then `build_model(&resolved, …)`, which uses the same base URL and key.
- **Bad mappings**:
  - `gpt-oss:*` on Ollama becomes `gpt-4.1-mini` on localhost:11434, a guaranteed 404.
  - OpenRouter `openai/gpt-oss-*` becomes bare `gpt-4.1-mini`.
  - `anthropic/claude-*` becomes `claude-haiku-4-5-20251001`.
  - `deepseek/deepseek-v4-pro` becomes `deepseek-flash`.
  - None of these ids are valid on the gateway.
- **Scope**: the bridge-level paths (pre-run and overflow retry). Durable mid-run compaction resolves only the main model (`:921-923`), so it is unaffected.
- **Tests**: `:2838-2851` cover bare first-party ids only.
- **Fix**: substitute only when the resolved provider is that family's first-party API and the id exists in the catalog for that provider; otherwise keep the main model.

**F9. Mid-run summaries get a near-unbounded `max_tokens`.** The miscomputation is confirmed; provider rejection is a suspicion.

- **Where**: `harness/runtime/drive/structural_generation.rs:287` passes `config.context_window` as the `reserve_tokens` argument. `harness/compaction.rs:612-618, 637` then gives `min(0.8 × 200,000, model.max_tokens)`:
  - 131,072 for GLM 5.3;
  - 160,000 for DeepSeek;
  - versus 13,107 in pi (0.8 × 16,384).
- **What happens**: retries are 0 here (`:291-296`). A provider that rejects an oversized `max_tokens` fails the summary, which fails the run. Summaries can also run very long.
- **Fix**: pass `scope.settings.compaction.reserve_tokens`.

**F10. The 200k window cap makes valid answers look like overflow.** Confirmed by code.

- **Where**:
  - `agent/harness_turn.rs:48-58` and `:1407` overwrite `model.context_window` with min(catalog, 200k).
  - `harness/overflow.rs:86-90` treats a successful `Stop` with input + cache read above the window as a silent overflow.
  - `harness/runtime/drive/response.rs:147-149` uses that.
- **Why it matters**:
  - GLM 5.3 and DeepSeek have 1M windows (catalog).
  - A response that the provider accepted with input above 200k is discarded and overflow compaction runs.
  - The checkpoint threshold (~183.6k estimated) usually catches growth first. But the after-anchor estimate is chars/4 (`harness/estimate.rs:10, 37-39`), which under-counts base64, JSON and non-Latin text, so one big tool result can jump past 200k between checkpoints (see F2).
- **Fix**: use the real model window for overflow detection; apply the 200k cap only to the compaction threshold.

**F11. OpenAI-compatible calls request the full catalog output, and any early `length` stop counts as overflow.** Suspicion: depends on provider behavior.

- **Where**:
  - `agent/harness_turn.rs:926` sends `max_tokens: model.max_tokens`: 131,072 for GLM, 393,216 for DeepSeek.
  - The context clamp `harness/estimate.rs:134` is used only by `anthropic_messages.rs:126, 153`, not by `openai_completions.rs`.
  - `harness/runtime/drive/generation.rs:259, 288` set `intended_output_limit = model.max_tokens`.
  - `harness/overflow.rs:108-112` (`is_recoverable_length`) treats any `length` stop below that as overflow.
- **What happens**: a gateway or local server that silently caps output lower (Ollama, some routers) ends long answers or long tool-call arguments with `length`. That triggers compaction of a context that isn't full, and the partial answer is thrown away.
- **Fix**:
  - Clamp `max_tokens` to the context in the OpenAI path as the Anthropic path does.
  - Treat `length` as overflow only when input is near the window.

**F12. Large tool outputs have no shared cap.** Confirmed by code.

- **Where**: `tools/mod.rs:715-1200` (`execute_tool`) has no generic cap. Uncapped tools:
  - `read_skill` (`:767`; 61,006 chars in the bench, ~15k tokens in one call);
  - `browser_eval` (`:934`): `background.js:139-158` trims only DOM elements (4,000) and node lists (300 each), so a string such as `document.body.innerText` returns whole;
  - `spawn_agent` (`:949-959`, `harness_turn.rs:2053`);
  - `browser_screenshot` (F2).
- **Related**:
  - `browser_snapshot` ignores `include_text` (`zbctl.rs:17`) and cuts labels to 80 chars (`extension/content.js:122, 129`). The model therefore falls back to `browser_eval(innerText)` to read pages.
  - Composio is capped at 8,000 bytes (`connectors/composio.rs:589`) and hard-cut mid-JSON. A 25-email fetch leaves the model only the first few messages plus a truncation note.
  - pi's core tools do this well: 2,000 lines or 50 KB with a notice (`harness/tools/truncate.rs`). `doc_extract` uses `truncate_or_spill`.
- **Fix**: one cap in `execute_tool` (for example 50 KB) that spills the rest to a file and says so, using `truncate_or_spill`.

**F13. Memory instructions contradict each other, and memory fills up with no way to prune.** Confirmed by code.

- **Contradiction**: `settings.rs:263` tells the model to note deadlines in MEMORY.md via `save_memory`, while `:280` says "NEVER proactively save".
- **No prune tool**: `memory.rs:141` tells the model to "Remove older entries", but `replace`/`remove` are dead code (`:199, :234`) and the tool only appends. Once MEMORY.md reaches 2,200 chars (USER.md 1,375; task memory 1,500), every save fails until the user edits the files.
- **Uncapped fallback**: the legacy `memory.md` fallback (`memory.rs:84-117`) has no size cap.
- **Fix**:
  - Pick one rule.
  - Expose replace/remove through `save_memory`.
  - Cap the legacy fallback.

**F14. The compaction summary is written for code, not paperwork.** Confirmed by code; the quality impact is a judgment call.

- **Where**: `harness/compaction.rs:435-530`. The prompts ask to "preserve exact file paths, function names".
- **Problem**: zWork's tasks depend on figures, totals, recipients, dates and what was already sent. The prompt never asks to preserve those, or to restate the user's request verbatim.
- **Fix**: a zWork summary prompt with a "Request (verbatim)", "Figures and totals", "Done / sent / written" and "Still to do" structure.

### Minor

- **M1. The turn budget is never shown.**
  - `agent/harness_turn.rs:1813-1814` always passes `turn = 1` to `turn_context_block`, so `orientation.rs:19-26` never emits `<turn-budget>`, although the system prompt promises it (`settings.rs:265-267`).
  - The model gets no warning before the hard stop at 80 turns (`harness_turn.rs:45, 784-789`). Confirmed.
- **M2. The pre-run compaction estimate undercounts.** It runs over `seed_history` only (`harness_turn.rs:1897-1898`). The replayed assistant rows carry no usage (`:1574`), so the estimate is chars/4 of the text and excludes the ~12.5k-token system prompt and tools, the new prompt and attachments. The first request can therefore start over budget and need an overflow round-trip. Confirmed.
- **M3. The turn-cap stop message is never saved.** It is sent to the UI only (`harness_turn.rs:1929-1935`), so the next turn's history doesn't show that the previous turn was cut off. Confirmed.
- **M4. Developer instruction files can leak into the prompt.** `harness/context_files.rs:13-24` injects up to 64 KB each of `AGENTS.md`/`CLAUDE.md` from every ancestor of the sidecar's working directory (set to the workspace by `app/src-tauri/src/main.rs:235`), plus global coding-agent files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, opencode, pi). A user who also uses coding agents gets those coding instructions in zWork's office prompt. On this machine none exist apart from one empty file. Confirmed mechanism; impact depends on the user.
- **M5. The default hosted model is sized by the fallback.**
  - `zwork-auto` is the default (`harness_turn.rs:1493`). Neither it nor `zwork-apex` is in the catalog, so `catalog::build_model` gives them 128,000 context and 16,384 output (`harness/providers/catalog.rs:25-26, 314-315`).
  - `configure_router_model` (`harness_turn.rs:1425-1440`) sets the protocol, reasoning and images, but not the window or output.
  - Router chats therefore compact at ~111.6k estimated tokens, although the upstream routes have 1M windows, and they cap every answer and tool-call argument at 16,384 tokens.
  - This is conservative for cost but exposes router users to F1 and F7 earlier.
  - Fix: give the router tiers explicit limits in `configure_router_model`. Confirmed.

### Suspicions to check live

- **S1. Ollama context length.**
  - Nothing sets `num_ctx` or `OLLAMA_CONTEXT_LENGTH` (grep across sidecar, Tauri and frontend).
  - The built-in `ollama` provider lists no models, so `build_model` falls through to `find_model` (`harness/providers/catalog.rs:262-270, 289-292`), which takes the first provider anywhere in the catalog with the same id.
    - `gpt-oss:20b` and `gpt-oss:120b` pick up **ollama-cloud's** 131,072 context and 32,768 output.
    - Other local models (`qwen3:8b`, `llama3.2`) get the fallback of 128,000 and 16,384 (`:25-26`). They are also marked image-capable by default (`:311`), so an image attachment goes to a text-only local model.
  - Ollama's OpenAI-compatible endpoint uses the server default context and silently truncates the front of the prompt. With a ~12.5k-token system prompt, gpt-oss on a default Ollama install may never see the start of its instructions.
  - Overflow is never reported, so neither compaction path fires.
  - Check: one request with `ZWORK_HOME` scratch, then compare Ollama's `prompt_eval_count` with the expected size.
- **S2. Output caps.** DeepSeek and GLM may reject or quietly clamp `max_tokens` of 393,216 / 131,072, and 160,000 for summaries. Combined with F11 and F9 this matters only if they clamp silently or reject.

---

## 1. System prompt assembly

**Order** (`settings.rs:240-417` template, built by `build_system_prompt` at `:483-740`, then extended in `agent/harness_turn.rs:1763-1792`):

1. Model and provider line, user name, OS, workspace.
2. "CRITICAL RULE" and identity.
3. Personalization from `zwork.md`, uncapped (`settings.rs:526-536`).
4. Time and timeline: weekday, dates and the current minute (F5).
5. A note explaining `<turn-context>`.
6. Persistent memory: USER.md, then MEMORY.md, then the project block (`context.md`, `project_memory.md`, up to 50 project file paths; `harness_turn.rs:1731-1760`).
7. Behavior rules: default to action, check before saying done, capabilities, workspace folders.
8. Tools: the tool list, connected apps, the tool-priority block, rules and group workflows; then the runtime and research blocks (academic only); skills list and usage.
9. Desktop and browser behavior; sidebar output blocks; building apps (academic only); voice; permissions; plan mode; permission block.
10. Appended afterwards:
    - `AGENTS.md`/`CLAUDE.md` context files (M4);
    - the MCP block;
    - "Live environment status" with browser connected or not, at the end.

**Size**: the bench first step is ~12.5k tokens including tool schemas. The test `paperwork_prompt_stays_small` asserts the paperwork variant is under 18,000 chars.

**Cache behavior**:
- Tools are sorted by name (`harness_turn.rs:1893`), so their order is stable.
- The prompt is stored in the durable session and reused for every step of a run, so caching works within a run.
- Across turns it is broken by the minute-level time and by message-dependent sections and tools (F5).

**Per-turn prefix**: this is prepended to the user's message, not put in the system prompt (`harness_turn.rs:1796-1817`):
- `<turn-context>` (time, cwd, git branch and state; the budget line never appears, M1);
- "Work done so far" (≤4 KB);
- artifact-mode hint;
- attachment listing;
- any extra system prompt.

Prepending it keeps the history prefix cacheable.

**Duplicates and contradictions**:
- current time appears twice (timeline and turn context);
- the memory rules contradict each other (F13);
- the prompt promises a turn budget that never appears (M1).

## 2. History storage and replay between turns

**Source of truth**: the chatstore (SQLite/JSON rows).

- User rows hold the typed text only (`harness_turn.rs:1671`).
- Assistant rows hold the streamed text, activities and a `tool_trace` of name, 120-char arguments, ok and 200-char digest (`chatstore.rs:424-450`).

**Replay** (`history_to_messages`, `harness_turn.rs:1552-1587`):

- The text of each row becomes a user or assistant text message.
- Consecutive same-role rows are merged.
- Empty assistant rows and leading assistant rows are dropped.
- Nothing else is replayed: no tool calls or results, no reasoning, no images or attachments (F6).
- Prior tool work appears only as the "Work done so far" digest in the new prompt.

**Ordering and duplicates**: queued messages consumed mid-run are written in order as user row, then a new assistant row (`harness_turn.rs:139-165`), so the flat order matches what the user saw. No dropping or duplication was found in normal replay. The only duplication is the overflow retry (F4).

**Within a run**: messages live in the durable session (fresh per run, `{chat_id}__{uuid}`, `harness_turn.rs:884`), seeded by `lane.append_message` (`:981`). Before each call `transform_messages` (`harness/transform_messages.rs`):

- drops errored and aborted assistant turns;
- adds "No result provided" error results for orphaned tool calls (`:142-170`);
- holds system messages that fall between a call and its results.

**Per-provider transforms**:

- **DeepSeek**: `reasoning_content` is required on assistant messages and is added, empty if needed (`harness/providers/openai_completions.rs:131, 434-439`).
- **Other OpenAI-compatible providers**: thinking is echoed back through the field it arrived in (`:376-412`).
- **Z.ai**: uses its own thinking format and no `reasoning_effort` (`:113-136`).
- **Across turns**: reasoning never reaches a provider, because history is plain text.
- **Truncation on replay**: none inside a run. Across turns, tool results are dropped entirely rather than truncated.

## 3. Compaction

Three paths exist.

**(a) Bridge pre-run compaction** (`harness_turn.rs:1894-1904`):

- **Trigger**: `should_compact(estimate(seed_history), window)`, i.e. tokens > window − 16,384, with window = min(catalog, 200k) unless `ZWORK_CONTEXT_WINDOW` is set.
- **Estimate**: chars/4 of history text only (M2).
- **Model**: the guessed compaction model (F8).
- **Method**: `compact()`, which handles split turns, keeps ~20k recent tokens and appends file ops.
- **On failure**: a "compaction failed" event, and the turn continues uncompacted (`:1124-1167`, `max_retries` 2).
- **Persistence**: none (F7).

**(b) Durable mid-run compaction** (pi structural procedure):

- **When**: at each checkpoint after an assistant or tool step (`harness/runtime/drive/checkpoint.rs:143-153`, `structural.rs:21-67`).
- **Estimate**: anchored on the last assistant `usage`, plus chars/4 for what follows (`harness/estimate.rs:106-124`); accurate except for the trailing part.
- **Model**: the main model (only it resolves in `model_source`).
- **Summary budget**: `max_tokens` is wrong (F9).
- **Retries**: none (`max_retries: 0`).
- **What is kept**: the summary plus the retained tail. The split-turn prefix is lost (F1) and `details` is `None`, so file lists are lost too.
- **Overflow variant**: the same procedure runs on overflow, at most once per generation (`response.rs:147-170`).

**(c) Bridge overflow retry**: compacts pre-run history and re-runs the whole turn (F4).

**Prompt and what the summarizer sees** (`harness/compaction.rs`):

- `serialize_conversation` tags messages, clips tool results to 2,000 chars and drops images.
- The coding-oriented prompts are at `:435-530` (F14).
- File operations are tracked for tools named exactly `read`, `write` and `edit` (`:287-295`), which match pi's core tools, but not for `extract_document`, Office writers or browser downloads.
- There is no bound on summarizer input.

**Context windows**:

| Model | Catalog window | Effective window |
|---|---|---|
| GLM 5.3 (zai, zai-coding-plan) | 1,000,000 | 200,000 |
| DeepSeek flash / v4-pro | 1,000,000 | 200,000 |
| OpenRouter gpt-oss | 131,072 | 131,072 |
| Ollama `gpt-oss:*` | 131,072, borrowed from ollama-cloud (S1) | 131,072; real limit is the server's `num_ctx` |
| Other Ollama models | 128,000 fallback (S1) | 128,000 |
| `zwork-auto` / `zwork-apex` router (default) | not in catalog, so 128,000 and 16,384 output (M5) | 128,000 |

**Token estimation**: chars/4 with images counted as 4,800 chars (`harness/estimate.rs:10-11`). It is good for English prose and poor for base64, JSON and CJK text. System messages count as text plus tool deltas (`estimate.rs:53-62`), but the bridge estimate never sees the system prompt.

**Divergence from pi-mono**:

- zWork-only additions: the 200k cap, the bridge pre-run compaction, the whole-turn overflow retry, and the cheap compaction model.
- The durable session is discarded after each turn, so compactions don't accumulate across turns as they do in pi.
- The structural path ignores the split-turn prefix and passes the window as the reserve. There is no local pi-mono checkout to confirm whether upstream's durable path has the same gap. The classic `compact()` port here does it right, so at minimum zWork's two paths disagree.

## 4. Tool output caps and how truncation is signalled

| Tool or source | Cap | How it is signalled |
|---|---|---|
| pi core `read`, `bash`, `grep`, `find`, `ls` (`harness/tools/truncate.rs`) | 2,000 lines / 50 KB; grep lines 500 chars | explicit notice |
| `extract_document` (`doc_extract`, `truncate_or_spill`) | sheets 2,000 rows | spill-to-file with notice |
| Exa `web_search` (`tools/search.rs`) | 1,500 chars per result | silent per result |
| Composio (`connectors/composio.rs:589, 840-875`) | 8,000 bytes; long strings cut to half that first; Gmail default 25 results | trailing note; byte cut can panic (F3) |
| `browser_snapshot` | 80 elements, 80-char labels | none |
| `browser_eval` | DOM elements 4,000 chars, node lists 300 each, strings uncapped | none |
| `browser_screenshot` | uncapped base64 | none (F2) |
| `read_skill`, `spawn_agent` | uncapped | none |
| `desktop_capture` | description says ~100 elements | n/a |
| A tool that panics | empty text, `ok: true` | none (F3) |

## 5. Memory and session memory

- **Loading**: `load_snapshot` (`memory.rs:77-117`) is read once per run when the system prompt is built. USER.md is capped at 1,375 chars and MEMORY.md at 2,200. The legacy `memory.md` fallback is uncapped.
- **Mid-run saves**: `save_memory` appends with a `§` delimiter (`memory.rs:120-160`, `tools/mod.rs:774-806`). Saves land on disk and show up in the next run's prompt only, which keeps the prompt frozen within a run, as Hermes does.
- **Task memory**: `append_task`, 1,500 chars per scheduled task (`memory.rs:165-190`).
- **Project memory**: `project_memory.md` and `context.md` are injected uncapped, plus up to 50 file paths (`harness_turn.rs:1731-1760`).
- **`zwork.md`**: uncapped.
- **Growth**: bounded by the caps above, with the dead-end that the model can't prune (F13).
- **Session memory**: no per-chat session memory is injected beyond the "Work done so far" digest. The chatstore fields `compacted_summary` and `compaction_cursor` exist but are unused (F7).

## 6. Mid-run guards

- **`DoomLoopDetector`** (`agent/mod.rs:570-662`):
  - It tracks identical calls together with a hash of their results. A third identical call that returned the same result twice is refused with a steering note (`steer_reason`); repeating again stops the run.
  - Identical calls with changing results are allowed up to 12 in a row.
  - Keys, scrolls and waits count as progress.
  - No unit tests match the filter `doom`; the tests in `agent/mod.rs` cover error classification.
- **Turn cap**: `ZWORK_MAX_TURNS`, default 80 (`harness_turn.rs:45, 61-66`). It aborts the durable operation as turn 81 starts (`:775-790`). The user sees a message that is not saved (M3). The model gets no warning beforehand (M1).
- **Retries**:
  - Transient provider errors: 3 retries with backoff from 2 s (`harness_turn.rs:926-940`). Retries add a request-only nudge message (`harness/runtime/drive/generation.rs:215-237`).
  - Summaries: 0 retries mid-run, 2 at bridge level.
- **Overflow recovery**:
  - Detection uses error-text patterns, silent overflow (`Stop` above the window) and `length` with zero output (`harness/overflow.rs:15-112`).
  - Durable overflow compaction runs at most once per generation.
  - After that comes the bridge's whole-turn retry (F4).
  - The 200k cap and the `length` rule can trigger recovery on healthy responses (F10, F11).
