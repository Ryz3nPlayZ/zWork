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

## M1 — pi-ai/core completions

- ⬜ Image content: full magic-byte detection (png/jpeg/gif/webp/bmp, reject
      APNG/JPEG-XR) + base64 (`harness/tools/image.rs`)
- ⬜ Usage helpers `empty_usage`/`add_usage` (optional cache_write_1h/reasoning)
- ⬜ Output-capture parity: head-or-tail retention + slide-window diffs
- ⬜ Prompt templates: `.md` + frontmatter loader, invocation formatting,
      system-prompt exposure
- ⬜ Model pricing at `build_model` so `Usage::calculate_cost` is live
- ⬜ Overflow classification coverage check vs pi-ai `overflow.ts`

## M2 — Usage & cost surfacing

- ⬜ Per-turn usage accumulation; `usage` SSE event; persisted per message +
      per-chat totals; `GET /api/chats/:id/usage`
- ⬜ Frontend: usage store handler, per-message token/cost caption, chat total

## M3 — Session core (`SPEC.md` §session)

- ⬜ Entry tree (message | compaction | branch_summary | custom), write-once
- ⬜ Typed values/lists with reserved `pi.*` namespaces
- ⬜ Usage ledger (per-entry attribution)
- ⬜ `Storage` contract + in-memory backend + SQLite backend (+ conformance
      suite ported from pi's `session/testing/conformance`)
- ⬜ MutationLine, commit validation (monotonic seq, parent-exists)
- ⬜ Fork (branch-scope / tree-scope) + fork policy (excluded namespaces)
- ⬜ Chatstore becomes projection; non-destructive truncate
- ⬜ Server `POST /api/chats/:id/fork`; rewind w/ optional branch summary
- ⬜ Frontend: fork from message, branch picker

## M4 — Durable runtime (`SPEC.md` §runtime + durability specs)

- ⬜ Effect gate (abort wins admission races)
- ⬜ 13-state durable operation machine; intent→effect→settlement commits
- ⬜ Tool replay policies: `safe` re-executes, `never` synthesizes
      "interrupted, outcome unknown"
- ⬜ Mid-stream assistant durability (bounded durable partial frames)
- ⬜ Checkpoint inbox drain, compaction threshold, finish decisions
- ⬜ Recovery / reconcile / terminal records
- ⬜ `Harness` facade: prompt/compact/navigate/resume/abort/steer/followUp/
      nextRun/cancelQueued/recordUsage/watch
- ⬜ 11-hook registry; ZworkHooks (doom guard, turn cap, compaction) mapped on
- ⬜ Re-base `harness_turn.rs` on Harness; delete legacy Agent/agent_loop
- ⬜ Resume-on-restart (open operations at startup)
- ⬜ Re-attach SSE + run event cursor + gate polling endpoint

## M5 — Queue while busy

- ⬜ steer / followUp / nextRun / cancelQueued over the wire; queue modes
      (all / one-at-a-time); composer queue UI; unconsumed returned on abort

## M6 — Compaction persistence + sub-agent parity

- ⬜ Compaction as first-class durable entries; reloads skip re-compaction
- ⬜ Sub-agents: parallel spawn, fuller gated toolset, cap raise, 1 nesting lvl

## M7 — Wrap-up

- ⬜ pi bundled SKILL.md content (docx/pptx/xlsx/pdf) license check
- ⬜ Final audit vs this file + SPEC §0.9; CHANGELOG; merge to main

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
