# pi Port Parity Checklist

Tracking full feature parity with [pi-mono](https://github.com/badlogic/pi-mono)
`packages/agent` + `packages/ai` — **pinned at tag `v0.87.1`**. Re-pin only at
milestone boundaries; never chase HEAD (~15 commits/day upstream). Normative
spec: `sidecar-rust/src/harness/SPEC.md` (+ tool/assistant durability specs).

Status: ✅ done · 🚧 in progress · ⬜ remaining · ➖ excluded (with reason)

## Core agent loop — ✅ ported (2026-09-21..22, commits da4725b..94f53df)

- ✅ Agent + agent-loop (streaming, tool execution, steering primitives)
- ✅ pi-ai subset: types, OpenAI-completions + Anthropic-messages adapters,
  transform-messages, estimate, json-parse, validation, retry, SSE, transcript
- ✅ Compaction: threshold estimation, cut points, summary generation,
  branch-summarization file-ops (function-for-function with v0.87.1)
- ✅ Skills loader + system-prompt builder
- ✅ Core tools: bash, read, write, edit, edit-diff, grep, find, ls, truncate,
  output-accumulator, path-utils, walk, file-mutation-queue
- ✅ Sub-agents on the pi loop (sequential, read-only, 12-turn cap — see M6)
- ✅ Bridge to zWork wire events / chatstore / gates / traces
- ✅ grep/find/ls kept although upstream moved them to its product layer
      (ours are shipped + risk-gated; deliberate divergence)

## M1 — pi-ai/core completions — ✅ done (2026-09-23)

- ✅ Image content: full magic-byte detection (png/jpeg/gif/webp/bmp, reject
      APNG/JPEG-XR) + base64 (`harness/tools/image.rs`)
- ✅ Usage helpers `Usage::empty`/`Usage::add` (optional cache_write_1h/reasoning)
- ✅ Output-capture parity: control-char sanitization + head retention
      (`output_accumulator.rs`). The replace|append|slide diff protocol is
      ➖ excluded: its consumers are pi's remote transcript sync, which zWork
      excludes; the bridge throttles bounded snapshots at 100ms.
- ✅ Prompt templates: loader + shell-style arg parsing + $1/$@/$ARGUMENTS/
      ${@:N}[:L] substitution (`harness/prompt_templates.rs`). pi does not
      list templates in the system prompt; invocation wiring lands with the
      M4 Harness facade (`prompt_from_template`).
- ✅ Model pricing at `build_model` (`harness/pricing.rs`, mirrors cloud
      estimate_cost) so `Usage::calculate_cost` is live
- ✅ Overflow classification: full port of pi-ai `overflow.ts`
      (`harness/overflow.rs`) — 24 provider phrasings, rate-limit exclusions,
      silent + length-stop overflow; wired into the bridge's
      compact-and-retry

## M2 — Usage & cost surfacing — 🚧 backend done, frontend in tree (2026-09-23)

- ✅ Per-run usage accumulation (`Usage::add`); `usage` SSE event per
      assistant message; persisted per message (running total) + per-chat
      totals (deltas only — no double counting); `GET /api/chats/:id/usage`
- ✅ Pricing live via M1 table; unknown models show no cost, not fake-zero
- 🚧 Frontend (implemented + typechecked, uncommitted — rides with the
      in-flight UI batch): `usage` store handler, per-message token/cost
      caption in the action row, chat-total chip in the header

## M3 — Session core (`SPEC.md` §session)

- ✅ Entry tree (message | compaction | branch_summary | custom), write-once
      (`harness/session/types.rs`)
- ✅ Typed values/lists with reserved `pi.*` namespaces
      (`harness/session/values.rs`)
- ✅ Usage ledger (per-row attribution, adjustment rows)
- ✅ `Storage` contract + in-memory backend + SQLite backend (+ conformance
      suite; both backends pass it)
- ✅ MutationLine, commit validation (monotonic seq, duplicate ids,
      parent-exists)
- ✅ Fork (branch-scope / tree-scope) + fork policy (lane state resets,
      config kept, op/pending/result/usage excluded)
- ✅ 13-leaf durable `OperationState` vocabulary (types ready for M4)
- ✅ Chatstore projection mechanisms; non-destructive truncate (dropped
      tails park as restorable `BranchRecord`s); fork copies ancestry with
      zeroed usage totals; restore/delete branch records
- ✅ Server `POST /api/chats/:id/fork`, `GET .../branches`,
      `POST|DELETE .../branches/:id` — verified end-to-end
- ✅ Frontend: fork-from-message button + branch picker (implemented +
      typechecked in tree; uncommitted with the in-flight UI batch)
- Note: the entry tree becomes the model-facing source of truth at the
      M4 cutover (bridge drives the durable runtime) — no throwaway mirror
      layer between chatstore and sessions was built in M3

## M4 — Durable runtime (`SPEC.md` §runtime + durability specs)

- ✅ Effect gate (abort wins admission races) — runtime/effect_gate.rs
- ✅ 13-state durable operation machine; intent→effect→settlement commits
      (dispatcher + Lane command core + drive claim loop)
- ✅ Tool replay policies: `safe` re-executes, `never` synthesizes
      "interrupted, outcome unknown" (tool_exec + drive/tools)
- ✅ Mid-stream assistant durability (bounded durable partial frames —
      assistant_frame.rs codec + progress channels)
- ✅ Checkpoint inbox drain, compaction threshold, finish decisions
      (drive/checkpoint + boundary)
- ✅ Recovery / reconcile / terminal records; navigation commit
- ✅ 11-hook registry (runtime/hooks.rs) + ZworkHooks mapped: doom guard on
      `before_tool`, turn cap via durable `request_operation_abort`,
      pre-run/overflow compaction bridge-level (mid-run threshold waits M6)
- ✅ `Harness` facade (67299e9): event bus w/ replay cursor, startup restore
      w/ intent validation, lane lifecycle, global config, convenience ops
      (prompt/skill/resume/abort/steer/followUp/nextRun/cancelQueued/
      recordUsage/navigate)
- ✅ Re-based `harness_turn.rs` on Harness; legacy Agent/agent_loop deleted
      (8ed24f9, -2.8k lines); sub-agents run on the durable runtime too
- ✅ Resume-on-restart (58c0aff): startup scan auto-resumes interrupted
      runs from `zwork.turn.*` metadata (credentials re-resolved, never
      persisted); volatile api_key/max_tokens resolve from live config so a
      restored snapshot can't fire an unauthenticated retry; kill -9 smoke
      settles from committed frames with zero extra provider calls
- ✅ Re-attach SSE + gate polling + recovery display (agent/run_state.rs):
      `GET /api/chats/:id/run/live` replays from `?after=<cursor>` then
      streams live until RunEnd (works during startup recovery too);
      `GET /api/chats/:id/gates` polls unanswered permission gates so a
      dropped stream no longer eats the silent 10-min auto-deny; recovery
      output lands in the crashed run's own assistant row (reused via
      `zwork.turn.assistant_msg_id`, seeded from its persisted state —
      no stray empty rows). Stop is durable now: `request_stop` records
      CancelRequested so a killed task reconciles as `reconciled-aborted`
      at restart instead of auto-resuming. Also fixed: turns requested
      with an unknown chat id persist against the created row, not the
      requested id (silent data loss before).

Remaining slice stubs in the dispatcher: summary.*/deferred.* leaves land
with M6 durable compaction (deferred is excluded from the port).

## M5 — Queue while busy

- ✅ Backend wire surface (agent/run_state.rs over the live lane):
      POST steer / follow-up / next-run (durable queue entries, entry ids
      back), GET queue (kind + text snapshot), POST queue/:id/cancel
      (cancelled | consumed | not_found), PUT queue/mode (steering +
      followUp, all / one-at-a-time)
- ✅ QueueUpdate → `{"type":"queue","items":[…]}` on the live stream AND
      the run/live re-attach replay (composer chips can track either)
- ✅ Consumption semantics smoke-proven with a mock provider: steer joins
      the in-flight context at the next checkpoint drain; a queued
      follow-up drives a whole next run at the finish boundary (queue
      modes apply); cancel removes before consumption
- ✅ Stop returns unconsumed steer/follow-up texts so the composer can
      restore them (`POST /stop` → `{steer, follow_up}`)
- ⬜ Frontend: send-while-busy, queued-message chips, mode picker — rides
      with the in-flight app/ batch

## M6 — Compaction persistence + sub-agent parity — ✅ done (2026-09-25)

- ✅ Durable compaction (dd51299): summary.deciding/ready/effect_pending/
      retry_wait procedures over the configured stream; result staged
      durably (pi.op.summary) before the effect so a crash never re-bills;
      CompactionEntry commits with summary + retained tail + usage and the
      branch tip chains through it; ResumeCheckpoint resumption (queued
      steer becomes the trigger, needed assistant re-arms generation);
      before_compaction hook (decline / hook summary); bridge cutover to
      real CompactionSettings for chat turns + startup resume (mid-run
      threshold + overflow now durable; pre-run + post-failure overflow
      retry stay bridge-level); compaction wire events on the live stream
      and re-attach projection. Unit golden path + crash-recovery (zero
      re-bill) + live 7-turn smoke.
- ✅ Sub-agent parity (119ab9b): fuller toolset (pi coding tools incl.
      bash/write/edit behind the same risk evaluator — destructive actions
      denied with a report-don't-act message since sub-agents run
      unattended; web/document/academic lookups; interactive tools
      excluded), cap raised 12 → 40 with ZWORK_SUBAGENT_MAX_TURNS
      override, one nesting level (depth-bound spawn tool; grandchildren
      get none), and ZWORK_PARALLEL_TOOLS=1 runs tool batches — several
      spawn_agent calls in one turn — concurrently (runtime run_parallel).
      Smoke-verified: parent delegates → sub-agent session durable →
      result flows back.

## M7 — Wrap-up

- ✅ pi bundled SKILL.md license check (2026-09-25): pi-agent-core ships NO
      document skills — the docx/pptx/xlsx/pdf SKILL.mds in pi-mono are
      coding-agent TEST FIXTURES (excluded product layer); repo .pi/skills
      are dev-workflow docs. Nothing to adopt; zWork's own skills system
      stands. (pi-mono is MIT regardless.)
- ✅ Final audit vs SPEC §0.9 (2026-09-25): every remaining §0.9 item is
      either ported-and-covered, or excluded by the confirmed scope —
      J1 JSONL compaction N/A (our backend is SQLite), C1 RemoteSession
      excluded (single-process sidecar), R12 watchSession not stubbed here
      (the event bus subscribe + run registry cover the watch need), T1
      telemetry excluded (agent.jsonl traces), S3 search excluded
      (upstream skeleton), R11 migrations N/A (storage_version 1, our own
      schema), WP08 named-branch/streaming forks: fork + policy landed in
      M3 (streaming JSONL/SQLite transfer N/A — no cross-session
      transfer in zWork's model), H1 contract closure tracked as upstream
      debt. The only SliceNotImplemented left in OUR tree is `deferred`
      (excluded by scope).
- ⬜ CHANGELOG entry + merge harness/pi-port → main + release — gated on
      the user's in-flight frontend batch (M2 usage captions, M4
      re-attach/queue UI, M5 composer queue chips ride in the uncommitted
      app/ tree) and the release decision (releases push to ALL users).

## Excluded (serve pi's TUI/multi-client architecture, not the agent)

- ➖ `pico3/*` — experimental successor kernel; tracked, not ported
- ➖ `proxy.ts` + strict-JSON snapshot/watch/reducer — remote multi-client sync
- ➖ `search/` — unimplemented skeleton upstream (S3)
- ➖ pi auth/OAuth + provider catalog + model store — zWork has cloud gateway +
      secrets + own resolution
- ➖ Deferred/background generation — OpenAI background mode unused here
- ➖ Telemetry spans — mapped onto existing `agent.jsonl` traces
- ➖ `legacy-v3` session migration — pi's own old format
- ➖ Additional wire adapters (google-native, openai-responses, bedrock, …) —
      zWork's matrix is OpenAI-compat + Anthropic (confirmed 2026-09-23)
