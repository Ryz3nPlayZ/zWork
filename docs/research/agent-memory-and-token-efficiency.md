# Agent memory and token efficiency: open-source survey

Researched 2026-11-21. Star counts and licences were read from the GitHub API and each repo's LICENSE file on that date. Benchmark numbers come from the project's own paper, README or blog unless marked otherwise. "Self-reported" means nobody outside the authors has reproduced the number, as far as I could find.

This doc builds on two earlier ones and does not repeat them:

- [context-engineering.md](context-engineering.md): the Complexity Trap result, LOCA-bench, the study on rules lost in compaction, Letta's filesystem memory vs Mem0, caching basics, and how memory errors spread (Xiong et al.).
- [zwork-context-audit.md](zwork-context-audit.md): findings F1 to F14 and M1 to M5 about zWork's own loop. This doc cites those finding numbers.

## How entries are ranked

Each entry gets three scores from 1 to 3:

- **Innovation:** how new the mechanism is.
- **Evidence:** 3 means peer-reviewed with released code, or reproduced by someone else; 2 means a paper or an open benchmark runner but no outside reproduction; 1 means only vendor claims, or no benchmark at all.
- **Fit for zWork:** 3 means it is a pure prompt or loop technique, or can be written in the Rust sidecar; 2 means the idea carries over but needs real work; 1 means it needs a Python service, a database server, GPU access or model training.

The rank is the product of the three scores. Ties go to the higher fit score, then the higher evidence score. Fit counts for this much because zWork users are non-technical. They will not install Python, Postgres or Neo4j, and the sidecar has to ship as one signed binary.

## Summary

Agent memory, top 3:

1. **ACE (ace-agent/ace).** An evolving playbook of small bullets, each with helpful and harmful counters, edited by a Reflector and a Curator. It is prompt-only, peer-reviewed (ICLR 2026), and suits recurring paperwork.
2. **Mastra Observational Memory.** An Observer and a Reflector turn old turns into dated observations in a prefix that is only ever appended to, so the cache keeps hitting. It is the cleanest fix for zWork's missing cross-turn summary (F7). Its scores are self-reported.
3. **LightMem (zjunlp/LightMem).** A cheap filter, then grouping by topic, then consolidation offline during "sleep time". The paper (ICLR 2026) reports up to 38× fewer tokens and up to 30× fewer API calls. zWork's scheduler could run the offline step.

Token efficiency, top 3:

1. **ACON (microsoft/acon).** Compression guidelines in plain language, refined by studying failed runs. It was tested on OfficeBench and AppWorld, cut peak tokens by 26 to 54%, and is prompt-only.
2. **Observation masking (JetBrains-Research/the-complexity-trap).** Old tool outputs are replaced by a placeholder and the reasoning is kept. It halves cost and matches or beats LLM summarisation. Do the masking only at cache-safe moments, as opencode's DCP plugin does.
3. **Source-judged compaction (arXiv 2610.20927).** Before a summary is used, drop any summary line that no source message supports. Most failures after compaction trace back to one unsupported line. It is prompt-plus-loop only.

One caution covers both areas. Two papers from October 2026, both called "Memory Tax" ([2610.29823](https://arxiv.org/abs/2610.29823), [2610.34073](https://arxiv.org/abs/2610.34073)), found that dedicated memory systems often lose to plain RAG or to simply keeping the full context on a strong model. Compression has a cost too: one paper measured 21 retrieval calls rising to 64 per task with no gain in completion ([2608.16370](https://arxiv.org/abs/2608.16370)). Measure before adopting anything heavier than a prompt change.

## What zWork does today

The only agent loop is the pi-harness port. `sidecar-rust/src/agent/harness_turn.rs` bridges it to zWork's chat store and tools. All paths below are relative to `sidecar-rust/src/`.

### Context window and turn budget

- The model's context window is capped at 200k tokens. `ZWORK_CONTEXT_WINDOW` overrides the cap (`agent/harness_turn.rs:49-60`, applied at `:1424`).
- A run is capped at 80 turns (`DEFAULT_MAX_TURNS`, `agent/harness_turn.rs:45`); `ZWORK_MAX_TURNS` overrides it (`:62`).
- Once a run is at least halfway through its turns, the turn-context block tells the model how many turns are left (`agent/orientation.rs:19`, `:57`).
- `DoomLoopDetector` catches repeated identical tool calls (`agent/mod.rs:570-662`).
- Token counts are estimated at 4 characters per token, and each image counts as 4,800 characters (`harness/estimate.rs:11`).

### How a run's context is built

- Each run gets a durable session named `{chat_id}__{uuid}` (`agent/harness_turn.rs:901`). Old ones are pruned at `:931`.
- Earlier turns of the chat are replayed as plain user and assistant text, with no tool calls or tool results (`history_to_messages`, `agent/harness_turn.rs:1584-1619`).
- The chat store adds a "Work done so far" digest of earlier tool activity, capped at 4,000 characters (`chatstore.rs:430-436`, `:515`). Within it, each call's arguments are cut to 120 characters and each result digest to 200.
- `project_memory.md` is pasted into the project context under "Notes from earlier work in this project" (`agent/harness_turn.rs:1781-1784`).

### Compaction

Compaction is pi's design: an LLM summary of the older part of the conversation.

- The settings reserve 16,384 tokens and keep the last 20,000 tokens verbatim (`harness/compaction.rs:45-49`).
- The code finds a cut point (`:217`), serialises the older messages with each tool result cut to 2,000 characters (`:340`, `:364`), and asks for a structured summary (`:435`). A second prompt updates an existing summary (`:468`), and a third summarises the first half of a turn that gets split (`:507`).
- It runs at three points:
  - Inside the run, at a threshold, as a durable step (`agent/harness_turn.rs:958-962`).
  - Before a run starts (`:1947-1956`).
  - After the provider rejects a request as too long, followed by a retry (`:1080-1135`).
- The summary request turns caching off (`cache_retention: "none"`, `harness/compaction.rs:547`).

Known gaps from the audit are still present in the code today:

- **F1.** The fields that mark and summarise a split turn are created but never used (`harness/runtime/drive/structural.rs:79-81`, `harness/runtime/drive.rs:935-937`).
- **F9.** The space reserved for the reply is set to the whole context window (`let reserve = config.context_window.unwrap_or(model.context_window);`, `structural_generation.rs:287`).
- **F7.** The chat store has `compacted_summary` and `compaction_cursor` fields, but nothing ever writes them (`chatstore.rs:45`, `:47`). So a summary dies with its run, and the next turn starts again from plain-text history.

The audit's benchmark never saw compaction fire.

### Tool output limits

- The generic truncation helpers allow 2,000 lines or 50 KB. `truncate_or_spill` writes anything larger to a file and leaves a pointer to it (`harness/tools/truncate.rs:9-10`, `:228`).
- Composio results are shaped and capped at 8,000 characters (`connectors/composio.rs:589`). Gmail returns 25 messages by default and at most 100 (`:597`, `:601`).
- One Composio path cuts by bytes rather than characters (`:860`, F3).

### Prompt caching

- **Anthropic.** Cache breakpoints go on the system prompt, the last tool and the last message, using `ephemeral` by default and the 1-hour cache when retention is "long" (`harness/providers/anthropic_messages.rs:169-175`, `:325-339`, `:364`, `:417`, `:431`). Cache reads and writes are recorded in usage (`:551-581`).
- **OpenAI Responses.** It sends `prompt_cache_key` set to the session id (`harness/providers/openai_responses.rs:263-268`).
- **OpenAI-compatible endpoints.** Cache markers are added only for `anthropic/*` models on OpenRouter (`harness/providers/openai_completions.rs:105`, `:505`, `:540`).
- zWork never sets `cache_retention`, so every provider uses its short default (`agent/harness_turn.rs:943-949`, `openai_completions.rs:205`).
- The system prompt contains the current time to the minute (`memory.rs:290`, inserted at `settings.rs:259-263`). The prompt therefore changes every minute, and every new turn misses the cache (F5).

Within one run the cache works: the audit measured a median hit ratio of 0.97.

### Long-term memory

- `memory.rs` keeps three small stores, separated by `\n§\n`:
  - MEMORY: 2,200 characters (`memory.rs:6-11`).
  - USER: 1,375 characters.
  - TASK: 1,500 characters.
- They are loaded as a snapshot (`:77`), and the timeline block is added to the prompt (`:272`).
- The model can only append, through `save_memory` (`tools/mod.rs:333`, dispatched at `:788-815`, which calls `append` and `append_task`).
- `replace` (`memory.rs:200`) and `remove` (`:235`) exist, but nothing calls them, so memory can only grow until it hits the character cap.
- The prompt says to note deadlines in memory (`settings.rs:263`) and also says "NEVER proactively save" (`:280`). These contradict each other (F13).

What this means: zWork already has decent truncation, a summary design, and caching within a run. It lacks any memory that carries across turns, a way to edit memory, and caching across turns. Every pick below is judged against those three gaps.

## Agent memory

A note on benchmarks before the table:

- **LoCoMo has known faults.** An audit by Penfield found 99 of its 1,540 answer keys are wrong (6.4%). The audit also found that the gpt-4o-mini judge most papers use accepted 62.81% of answers that were deliberately wrong ([write-up](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg), [data](https://github.com/dial481/locomo-audit)). Differences of a few points on LoCoMo mean little.
- **LongMemEval-S** ([xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval), MIT) is the better-regarded test. But vendors tune for it too.

| Rank | Repo | Stars | Licence | One line |
|---|---|---|---|---|
| 1 | [ace-agent/ace](https://github.com/ace-agent/ace) | 1.5k | Apache-2.0 | A playbook of bullets with helpful and harmful counters, edited in small changes rather than rewritten |
| 2 | [mastra-ai/mastra](https://github.com/mastra-ai/mastra) (Observational Memory) | 29.7k | Apache-2.0, except `ee/` folders | An Observer and a Reflector write dated observations into an append-only prefix that stays cacheable |
| 3 | [zjunlp/LightMem](https://github.com/zjunlp/LightMem) | 1.2k | MIT | A cheap filter, grouping by topic, then offline "sleep-time" consolidation |
| 4 | [letta-ai/letta-code](https://github.com/letta-ai/letta-code) (MemFS) | 3.9k (old server [letta-ai/letta](https://github.com/letta-ai/letta) 25.5k) | Apache-2.0 | Memory as a git-backed folder of markdown files; one folder is always loaded, the rest is searched |
| 5 | [google-research/reasoning-bank](https://github.com/google-research/reasoning-bank) | 646 | Apache-2.0 | Strategies learned from both successful and failed runs, found again when a similar task comes up |
| 6 | [mem0ai/mem0](https://github.com/mem0ai/mem0) | 69.3k | Apache-2.0 | Pull facts out of a conversation, then choose ADD, UPDATE, DELETE or NONE against the facts already stored |
| 7 | [getzep/graphiti](https://github.com/getzep/graphiti) (Zep) | 33.0k | Apache-2.0 | A knowledge graph where every fact has the dates it was true |
| 8 | [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | 62.5k | MIT | Four kinds of memory (world facts, experiences, entity summaries, beliefs) and three operations: retain, recall, reflect |
| 9 | [WujiangXu/A-mem](https://github.com/WujiangXu/A-mem) | 1.0k | MIT | Zettelkasten-style notes that link to each other and get revised as new notes arrive |
| 10 | [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 118.9k | Apache-2.0 | An observer turns tool activity into short notes; search reveals detail in three steps |

Scores (innovation, evidence, fit; product):

1. ACE: 3, 3, 3; 27.
2. Mastra OM: 3, 2, 3; 18.
3. LightMem: 3, 3, 2; 18.
4. Letta MemFS: 2, 2, 3; 12.
5. ReasoningBank: 3, 2, 2; 12.
6. Mem0: 2, 1, 3; 6.
7. Graphiti: 3, 2, 1; 6.
8. Hindsight: 3, 2, 1; 6.
9. A-MEM: 2, 3, 1; 6.
10. claude-mem: 2, 1, 2; 4.

### 1. ACE: Agentic Context Engineering

**What it does.** Three roles run in a loop.

- The **Generator** does the task.
- The **Reflector** reads the run and works out what helped and what hurt.
- The **Curator** turns those lessons into small changes to a playbook of bullets.

Each bullet has an id and counts of how often it helped or hurt. The playbook is edited only through these small changes, never rewritten whole. The paper names two failures this avoids: "context collapse", where repeated full rewrites shrink a playbook until it loses detail, and "brevity bias", where summaries drop the specific tips that mattered. Sources: [arXiv 2510.04618](https://arxiv.org/abs/2510.04618) (ICLR 2026), [repo](https://github.com/ace-agent/ace).

**Evidence.** The paper reports:

- +10.6% on agent tasks (AppWorld) and +8.6% on finance benchmarks.
- Offline, 82.3% less adaptation latency than GEPA.
- Online, 91.5% less latency and 83.6% lower token cost than Dynamic Cheatsheet.

It is peer-reviewed and the code is released. I found no reproduction outside the authors.

**Licence.** Apache-2.0 (see the [repo](https://github.com/ace-agent/ace)).

**What zWork could adopt.** This is the best match for zWork's positioning: the same paperwork, done again every week.

- Give each project, or each recurring automation, a `playbook.md` of short bullets in the form `[id] tip (helped 3, hurt 0)`.
- After a run finishes, one cheap model call, the Reflector, reads the run trace (the chatstore digest already exists, `chatstore.rs:515`). It outputs JSON changes such as `{add, update(id), tag(id, helped|hurt), remove(id)}`.
- Plain Rust code, the Curator, applies those changes. This is exactly the case for the `replace` and `remove` functions that already exist and are never called (`memory.rs:200`, `:235`).
- Load the playbook the way `project_memory.md` is loaded today (`agent/harness_turn.rs:1781-1784`).
- Prune bullets whose "hurt" count is higher than their "helped" count.

The effort is about 3 to 5 days: one prompt, one JSON schema, file read and write, and a hook after the run. No Python is needed.

### 2. Mastra Observational Memory

**What it does.** Raw history is replaced by two background agents.

- Once unobserved messages pass a token threshold, the **Observer** compresses them into dated, prioritised observations. A third-party write-up puts the default threshold at about 30k tokens; I did not confirm that in code.
- Once the observations themselves grow too large (about 40k tokens), the **Reflector** condenses them.

The observation block is only ever appended to between reflections, so the prompt prefix stays the same and the provider cache keeps hitting. Sources: [research page](https://mastra.ai/research/observational-memory), [code](https://github.com/mastra-ai/mastra/tree/main/packages/memory/src/processors/observational-memory), [benchmark runner](https://github.com/mastra-ai/mastra/tree/main/explorations/longmemeval).

**Evidence.** All scores are self-reported, but the runner is public. On LongMemEval-S, with gemini-2.5-flash as both Observer and Reflector:

| Answering model | Score |
|---|---|
| gpt-5-mini | 94.87% |
| gemini-3-pro | 93.27% |
| gemini-3-flash | 89.20% |
| gpt-4o | 84.23% |

Mastra also reports 82.4% for an "oracle" baseline and 60.2% for full context. It reports about 6× compression.

**Licence.** Apache-2.0 for the repo. The `ee/` folders are under a separate enterprise licence ([ee/LICENSE](https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE)). The memory package is outside `ee/`, but check before copying any code.

**What zWork could adopt.** zWork already has most of the parts.

- The summary prompts in `harness/compaction.rs:435` and `:468` can act as Observer and Reflector.
- The missing piece is to keep the result per chat. Write `compacted_summary` and `compaction_cursor` in `chatstore.rs` (F7).
- On each new turn, send the observation block followed by only the messages after the cursor, instead of `history_to_messages` replaying everything.
- Put the block straight after the system prompt and only ever append to it. With F5 fixed, it then becomes cache-friendly.

The effort is about 4 to 6 days, mostly wiring and tests. It is the largest single quality gain for long chats.

### 3. LightMem

**What it does.** The design follows the Atkinson-Shiffrin model of human memory, in three stages:

1. A cheap **sensory filter** compresses each input and drops filler.
2. **Short-term memory** groups what is left by topic.
3. **Long-term updates** are separated from answering: consolidation runs offline, in "sleep time", so the agent does not pay for it on every turn.

Sources: [arXiv 2510.18866](https://arxiv.org/abs/2510.18866) (ICLR 2026), [repo](https://github.com/zjunlp/LightMem).

**Evidence.** On LongMemEval, the paper reports accuracy up to 7.7% higher (29.3% on another backbone). It cuts tokens by up to 38× (20.9×), and API calls by up to 30× (55.5×). It is peer-reviewed; I found no outside reproduction.

**Licence.** MIT.

**What zWork could adopt.** The idea that carries over is to run consolidation offline, not the Python code.

- zWork has a scheduler for automations. A nightly or idle-time job could do three things:
  1. Merge duplicate memory entries.
  2. Fold the day's task notes into MEMORY.md.
  3. Apply pending ACE playbook changes.
- This keeps consolidation off the live turn, so users never wait for it.

The effort is about 2 to 3 days once `replace` and `remove` are wired up. The cost is one small model call per day per user.

### 4. Letta MemFS (filesystem memory)

**What it does.** Letta Code keeps agent memory as a git repository of markdown files.

- A `system/` folder is always loaded into the prompt. Everything else is read on demand with file and search tools.
- Subagents for reflection and clean-up ("defrag") edit memory in separate git worktrees and merge their changes back.

Sources: [MemFS docs](https://docs.letta.com/letta-code/memfs), [blog: context repositories](https://www.letta.com/blog/context-repositories). The old Letta server repo now points to letta-code. The older code is on its `archive` branch ([letta-ai/letta](https://github.com/letta-ai/letta)).

**Evidence.** Letta reports that a plain filesystem agent on GPT-4o mini scored 74.0% on LoCoMo, against Mem0's reported 68.5% ([blog, 2025-08-12](https://www.letta.com/blog/benchmarking-ai-agent-memory)). That is self-reported, and [context-engineering.md](context-engineering.md) already covers it. The MemoryTax paper ([2610.29823](https://arxiv.org/abs/2610.29823)) points the same way: with a strong model, simple files plus search beat dedicated memory systems.

**Licence.** Apache-2.0.

**What zWork could adopt.** zWork's projects already contain `context.md` and `project_memory.md`.

- The cheapest step is to let memory grow past the 2,200-character cap by splitting it: a small always-loaded index, plus topic files the model reads with the existing file tools.
- Git is not needed for non-technical users. A dated backup of each file before every edit gives "undo" without exposing any version control.

The effort is about 2 days.

### 5. ReasoningBank

**What it does.** After each task, the agent turns the run into a reusable strategy item, from failures as well as successes, and stores it. When a similar task comes up, the matching items are fetched and added to the prompt. The paper also adds memory-aware test-time scaling (MaTTS), which spends extra compute on a task to produce richer memories. Sources: [arXiv 2509.25140](https://arxiv.org/abs/2509.25140) (ICLR 2026), [repo](https://github.com/google-research/reasoning-bank).

**Evidence.** It is peer-reviewed with code, evaluated on WebArena, Mind2Web and SWE-Bench. The abstract gives no figures. I remember about +34% effectiveness and 16% fewer steps but have **not verified** those numbers against the paper.

**Licence.** Apache-2.0.

**What zWork could adopt.** It overlaps heavily with ACE. The part worth keeping is the rule to learn from failures as well. A run that ended in an error or a user correction produces a "don't" bullet. Fold this into the ACE Reflector prompt rather than building a separate store. The extra effort is under a day once ACE exists.

### 6. Mem0

**What it does.** An LLM pulls candidate facts out of each exchange. A second call compares each candidate with similar stored memories and picks one of four actions: ADD, UPDATE, DELETE or NONE ([prompts.py](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)). An optional graph variant stores the facts as entities and relations. Sources: [arXiv 2504.19413](https://arxiv.org/abs/2504.19413), [repo](https://github.com/mem0ai/mem0), [benchmark harness](https://github.com/mem0ai/memory-benchmarks).

**Evidence.** The numbers are disputed and self-reported.

- **The paper** claims a 26% relative gain over OpenAI's memory on LLM-judge scores, 91% lower p95 latency, and over 90% fewer tokens than full context.
- **The README** now quotes LoCoMo 71.4 → 92.5 and LongMemEval 67.8 → 94.4 at about 7k tokens per query. Those numbers are for Mem0's managed platform, and the README says open-source users should expect lower.
- **Zep's reply.** Zep says the paper set Zep up wrongly, scoring it 65.99%. Zep's corrected run gives Zep 75.14% (±0.17), Mem0 Graph 68.44% and Mem0 Base 66.88%. Zep also notes that a full-context baseline (about 73%) beat Mem0 ([Zep blog](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)).
- **Mem0's counter.** Mem0's team then showed that Zep's own earlier 84% LoCoMo claim had included the adversarial category. Zep admitted the calculation error and kept 75.14% as its corrected figure ([getzep/zep-papers#5](https://github.com/getzep/zep-papers/issues/5)).

Treat every number in this dispute as unsettled.

**Licence.** Apache-2.0.

**What zWork could adopt.** Do not adopt the service. It is Python with a vector store, which zWork would have to host or bundle. Adopt the four-way decision instead.

- Today `save_memory` can only append (`tools/mod.rs:788-815`).
- Add an `op` field (`add | update | delete`) and an entry id, and call the existing `replace` and `remove`.
- At save time, or in the nightly job from LightMem, have the model compare the new fact with the current entries and pick an op. This stops duplicates and stale facts piling up against the 2,200-character cap.

The effort is about 1 to 2 days, and it is a prerequisite for ranks 1, 3 and 4.

### 7. Zep / Graphiti

**What it does.** Graphiti builds a knowledge graph that changes over time.

- Each fact is an edge carrying two time ranges: when it was true in the world, and when the system learned it.
- When a newer fact contradicts an old one, the old edge is closed off rather than deleted.
- Search combines meaning-based matching, keyword search (BM25) and walking the graph.

Sources: [arXiv 2501.13956](https://arxiv.org/abs/2501.13956), [graphiti](https://github.com/getzep/graphiti), [zep](https://github.com/getzep/zep) (5.0k stars, Apache-2.0).

**Evidence.** The paper reports 94.8% on the DMR benchmark against MemGPT's 93.4%, up to 18.5% better on LongMemEval, and 90% lower latency. These are self-reported, and the LoCoMo dispute under rank 6 involves Zep too.

**Licence.** Apache-2.0.

**What zWork could adopt.** Graphiti needs a graph database (Neo4j or FalkorDB) and runs in Python, which is a heavy cost for zWork. The cheap part to copy is fact validity. Store each memory entry with `since:` and, once replaced, `until:` dates, and keep superseded entries in an archive file rather than deleting them. Office facts go stale: "my manager is Sam", "the budget code is 4410". With validity dates, the agent can answer "what was it in March". This adds about a day on top of the rank 6 work.

### 8. Hindsight

**What it does.** Memory is split into four networks: world facts, the agent's own experiences, summaries of entities, and beliefs that carry a confidence level. Three operations act on them: retain, recall and reflect. Source: [arXiv 2512.12818](https://arxiv.org/abs/2512.12818).

**Evidence.**

- The paper reports that a 20B open model went from 39% to 83.6% on LongMemEval.
- With a larger model it reports 91.4% on LongMemEval and 89.61% on LoCoMo.
- The README calls the results independently reproduced by Virginia Tech and the Washington Post. But the Virginia Tech researchers are co-authors of the paper, so this is **not** an independent reproduction.
- It also has a feature for redacting personal data and secrets from memory ("Memory Defense").

**Licence.** MIT.

**What zWork could adopt.** It needs a Python server and Postgres, which is a heavy cost for zWork. Two ideas are worth copying:

- Keep "beliefs" (inferences, with a confidence level) separate from facts the user actually stated. This avoids the problem of mistaken memories spreading that Xiong et al. describe (see [context-engineering.md](context-engineering.md)).
- Redact secrets before anything is saved to memory.

Both fit in `memory.rs`. The effort is about 1 to 2 days.

### 9. A-MEM

**What it does.** Each memory is a note with keywords, tags and a context description. When a note is added, the system links it to related notes, and it can rewrite older notes' context in light of the new one ("memory evolution"). Sources: [arXiv 2502.12110](https://arxiv.org/abs/2502.12110) (NeurIPS 2025), [repo](https://github.com/WujiangXu/A-mem). There is also an [agiresearch fork](https://github.com/agiresearch/A-mem) (1.2k, MIT) and a follow-up, FlexA-Mem ([arXiv 2610.33274](https://arxiv.org/abs/2610.33274), [repo](https://github.com/WujiangXu/Flex-Amem), MIT).

**Evidence.** It is peer-reviewed with code, and the paper shows gains on LoCoMo over MemGPT-style baselines across six models.

**Licence.** MIT.

**What zWork could adopt.** Little that ranks 1, 4 and 6 do not already cover more cheaply. Linking notes only pays off once memory holds hundreds of entries, and zWork's memory today is about 5k characters in total. Revisit it after the split into topic files (rank 4).

### 10. claude-mem

**What it does.** An observer agent watches a coding agent's tool activity and writes short observations, stored in SQLite (with FTS5 full-text search) and Chroma. It retrieves in three steps to save tokens:

1. Search returns ids and titles.
2. A timeline gives the surrounding context.
3. Full details are fetched only for chosen ids.

Source: [repo](https://github.com/thedotmack/claude-mem).

**Evidence.** It has no benchmark, only popularity (the most-starred repo in this survey). The hosted observer now comes as a 30-day trial behind a checkout page, so the free path is self-hosted only.

**Licence.** Apache-2.0.

**What zWork could adopt.** Two pieces:

- The three-step search. Any future search over memory should return ids and one-line titles first, never full entries.
- SQLite FTS5 is available in Rust through `rusqlite` with the bundled feature, so this needs no service.

The effort is about 2 days, but only once memory is big enough to need search.

### Also surveyed, not ranked

These were skipped for low fit (a Python service or a hosted dependency), overlap with an entry above, or only vendor evidence. All licences are permissive unless marked.

- [MemTensor/MemOS](https://github.com/MemTensor/MemOS) (12.5k, Apache-2.0). Treats memory like an operating system manages resources. Self-reported LoCoMo 88.83 and LongMemEval 89.20 ([arXiv 2507.03724](https://arxiv.org/abs/2507.03724)).
- [EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS), formerly EverMemOS (14.0k, Apache-2.0). Self-reported LoCoMo 94.61%, re-judged on the 99 disputed questions, and LongMemEval 94.00%. Its hybrid search uses no LLM and has a median time of 0.27 s.
- [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) (31.7k, MIT). Calls itself number one, with 95% Recall@15 on LongMemEval at about 720 tokens. It publishes a [MemoryBench](https://github.com/supermemoryai/memorybench) (MIT).
- [topoteretes/cognee](https://github.com/topoteretes/cognee) (33.5k, Apache-2.0). Graph plus vector memory in Python ([arXiv 2505.24478](https://arxiv.org/abs/2505.24478)). Self-reported BEAM score of 0.79 at 100K.
- [Mirix-AI/MIRIX](https://github.com/Mirix-AI/MIRIX) (3.5k, Apache-2.0). Six memory types. Reports 35% better on ScreenshotVQA with 99.9% less storage, and 85.4% on LoCoMo ([arXiv 2507.07957](https://arxiv.org/abs/2507.07957)).
- [BAI-LAB/MemoryOS](https://github.com/BAI-LAB/MemoryOS) (1.6k, Apache-2.0). Reports 49.11% higher F1 on LoCoMo ([arXiv 2506.06326](https://arxiv.org/abs/2506.06326)).
- [aiming-lab/SimpleMem](https://github.com/aiming-lab/SimpleMem) (3.9k, MIT). Reports 26.4% higher F1 with up to 30× fewer tokens ([arXiv 2601.02553](https://arxiv.org/abs/2601.02553)).
- [MemoriLabs/Memori](https://github.com/MemoriLabs/Memori), formerly GibsonAI (17.6k). Its LICENSE file is Apache 2.0, though GitHub shows NOASSERTION. Reports 87% on LoCoMo at 721 tokens ([arXiv 2603.19935](https://arxiv.org/abs/2603.19935)).
- [NevaMind-AI/memU](https://github.com/NevaMind-AI/memU) (14.6k, Apache 2.0 in LICENSE.txt).
- [memodb-io/memobase](https://github.com/memodb-io/memobase) (3.0k, Apache-2.0). User profiles plus event logs.
- [langchain-ai/langmem](https://github.com/langchain-ai/langmem) (1.8k, MIT). Memory tools the agent calls mid-turn, plus a background manager.
- [zorazrw/agent-workflow-memory](https://github.com/zorazrw/agent-workflow-memory) (487, Apache-2.0). Learns reusable workflows; overlaps with ReasoningBank.

Not permissive:

- [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) (4.7k) is **AGPL-3.0**. It is markdown-file memory, a similar idea to rank 4.
- [volcengine/OpenViking](https://github.com/volcengine/OpenViking) (42.6k) is **AGPL-3.0**. It is a filesystem-style context database.
- Copying code from either would put zWork under AGPL obligations. Reading them for ideas is fine.

### Critiques worth reading before building memory

- **"MemoryTax: The Bitter Lesson of Agent Memory"** ([arXiv 2610.29823](https://arxiv.org/abs/2610.29823), 2026-10-21).
  - With Opus 5.5, the pi harness with plain context scored 99% at less than half the cost of full context.
  - Mem0 beat full context only on GPT-4o-mini, and building its memory cost more than one full-context run.
  - Memory quality is capped by the model that writes it.
  - The test is small: one LoCoMo conversation, 152 questions, one run per cell.
- **"Memory Tax: Dissecting the Net Value of Agent Memory"** ([arXiv 2610.34073](https://arxiv.org/abs/2610.34073), [repo](https://github.com/hexuan21/MemoryTax), MIT, 2026-10-25). It finds that many dedicated memory systems do worse than plain RAG in many cases.

Together these argue for a specific kind of memory in zWork. It should hold what the context cannot: cross-session lessons, preferences and validity-dated facts. It should not be retrieval machinery standing in for history the model could simply read.

## Token efficiency

A caution before the table. Compression is not free. "What Does Context Compression Cost an Agent?" ([arXiv 2608.16370](https://arxiv.org/abs/2608.16370)) found that compression raised retrieval calls from 21.0 to 63.9 per task on GPT-5.5, while task completion stayed the same. So a smaller context can mean more turns. Each technique below should be judged on total tokens per finished task, not on context size alone.

| Rank | Repo | Stars | Licence | One line |
|---|---|---|---|---|
| 1 | [microsoft/acon](https://github.com/microsoft/acon) | 132 | MIT | Compression guidelines in plain language, refined by looking at where compressed runs failed |
| 2 | [JetBrains-Research/the-complexity-trap](https://github.com/JetBrains-Research/the-complexity-trap) | 20 | MIT | Observation masking: old tool outputs become placeholders and the reasoning is kept; it matches LLM summaries at half the cost |
| 3 | Source-judged compaction ([GuanghuiMin/sjc](https://github.com/GuanghuiMin/sjc)) | 1 | none declared | Check every summary line against the original messages and drop the ones nothing supports |
| 4 | [toon-format/toon](https://github.com/toon-format/toon) / [toon-rust](https://github.com/toon-format/toon-rust) | 25.6k / 190 | MIT | A compact, table-like encoding for uniform JSON arrays |
| 5 | [multimodal-art-projection/TACO](https://github.com/multimodal-art-projection/TACO) | 48 | Apache-2.0 | Compression rules for tool output that the agent discovers and improves itself, with no training |
| 6 | [mksglu/context-mode](https://github.com/mksglu/context-mode) | 34.4k | **Elastic License 2.0** | Run tools in a sandbox and index their output; the model searches it instead of reading it all |
| 7 | [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) | 6.8k | MIT | A small model decides which tokens to keep, for up to 20× prompt compression |
| 8 | [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) | 80.3k | Apache-2.0 | A proxy with reversible compression (originals kept locally) and a checker for parts of the prompt that keep changing |
| 9 | [LMCache/LMCache](https://github.com/LMCache/LMCache) | 12.4k | Apache-2.0 | Reuses the model's KV cache across requests on self-hosted servers |
| 10 | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) | 87.4k | Apache-2.0 (rtk-oss) / **BUSL-1.1** engine and proxy | A Rust command proxy with 100+ output filters, one per command |
| 11 | [liyucheng09/Selective_Context](https://github.com/liyucheng09/Selective_Context) | 426 | unclear (README says MIT, no LICENSE file) | Remove the tokens that carry the least information |

Scores (innovation, evidence, fit; product):

1. ACON: 3, 3, 3; 27.
2. Complexity Trap: 2, 3, 3; 18.
3. SJC: 3, 2, 3; 18.
4. TOON: 2, 2, 3; 12.
5. TACO: 3, 2, 2; 12.
6. context-mode: 3, 1, 3; 9.
7. LLMLingua: 3, 3, 1; 9.
8. Headroom: 3, 1, 2; 6.
9. LMCache: 2, 3, 1; 6.
10. RTK: 2, 1, 2; 4.
11. Selective Context: 2, 2, 1; 4.

Prompt caching is not ranked as a repo, because the work is configuration in zWork's own providers rather than adopting a project. It is still the cheapest saving available. It is covered under the adoption order, step 1.

### 1. ACON: Agent Context Optimization

**What it does.** ACON compresses both the conversation history and individual tool outputs using a guideline written in plain language. It improves that guideline from failures:

1. Find tasks that succeed with the full context but fail once it is compressed.
2. Have an LLM explain what the compression lost.
3. Update the guideline to say what must be kept.

Optionally, the tuned compressor can then be distilled into a small model. Sources: [arXiv 2510.00615](https://arxiv.org/abs/2510.00615) (ICML 2026), [repo](https://github.com/microsoft/acon).

**Evidence.** Tested on AppWorld, **OfficeBench** and multi-objective QA. Peak tokens fell by 26 to 54% while task performance held, and small models improved by up to 46% when they used the distilled compressors. It is peer-reviewed with code. OfficeBench is the closest public benchmark to zWork's actual workload.

**Licence.** MIT.

**What zWork could adopt.** Do the optimisation by hand, once, offline. zWork does not need the training part.

- Run the bench tasks (`bench/lite`, which includes the office tasks) with compaction forced to trigger early.
- Collect the cases that fail, and rewrite the summary prompt (`harness/compaction.rs:435`, `:468`, `:507`) with office-specific "must keep" rules: exact file paths, recipient addresses, figures and totals, dates, the user's exact request word for word, and steps already completed so they are not done twice.
- Ship it as a prompt change.

The effort is about 2 to 3 days including bench runs. It also answers the audit's point that compaction has never been tested.

### 2. Observation masking (The Complexity Trap)

**What it does.** Instead of asking an LLM to summarise old turns, replace the content of old tool results with a short placeholder ("output omitted, re-run the tool if needed") and keep every reasoning and action message. Sources: [arXiv 2508.21433](https://arxiv.org/abs/2508.21433), [repo](https://github.com/JetBrains-Research/the-complexity-trap). [context-engineering.md](context-engineering.md) covers it in more depth.

**Evidence.** On SWE-bench Verified across five models, masking cut cost by about 50% and matched or beat LLM summaries. A hybrid (mask first, summarise only when needed) saved a further 7 to 11%. It is peer-reviewed with code. The tasks are coding tasks, but the mechanism has nothing coding-specific in it.

**Licence.** MIT.

**A related idea: removing duplicate calls.** opencode's [DCP plugin](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (4.5k, **AGPL-3.0**: copy the idea, not the code) does three things:

- When the same tool is called again with the same arguments, it keeps only the latest output.
- It replaces removed outputs with a placeholder.
- It recalculates pruning only when compaction happens, so the cached prefix is not broken on every turn.

That last point matters. Masking a little more on every turn changes the prompt prefix each turn and wipes out the 0.97 cache hit ratio zWork has today.

**What zWork could adopt.** Add a masking pass in `harness/compaction.rs`, run just before the LLM summary is considered.

- Mask tool results older than the last N turns, starting with the largest.
- Collapse repeated identical reads, keeping the latest.
- Run the pass only when the context passes a threshold, the same moment `should_compact` (`:117`) fires, so the cache is broken once and not every turn.
- If masking alone gets under the target, skip the LLM summary.

The effort is about 2 days, all in Rust.

### 3. Source-judged compaction ("Prune the Summary, Not the History")

**What it does.** After writing a compaction summary, the system checks each line of it against the original messages. Any line that no source supports is dropped before the summary goes into the context. Sources: [arXiv 2610.20927](https://arxiv.org/abs/2610.20927) (2026-10-14), [code](https://github.com/GuanghuiMin/sjc).

**Evidence.**

- On AppWorld and OfficeBench, reliability improved by 2.1 to 8.9%.
- 83% of the failures after compaction traced back to one unsupported line in the summary.
- The paper is new, has not been reproduced, and its repo is tiny.

**Licence.** The repo declares **no licence**, so its code cannot be reused. The method is in the paper and is simple to re-implement.

**What zWork could adopt.** After `compact()` (`harness/compaction.rs:848`), make one cheap model call over the summary lines and the serialised source, marking each line "supported" or "unsupported", and drop the unsupported ones. Combined with ACON's must-keep rules, this targets the specific way zWork could fail: a summary that says "sent the invoice" when it was never sent. The effort is about 1 day, and it adds one cheap call per compaction.

### 4. TOON (Token-Oriented Object Notation)

**What it does.** TOON encodes a uniform array of objects once as a header of field names followed by rows, much like CSV with indentation. Repeated keys are not written out on every object. Sources: [spec and benchmarks](https://github.com/toon-format/toon), [Rust crate](https://github.com/toon-format/toon-rust).

**Evidence.** The authors report about 40% fewer tokens on uniform arrays (self-reported). The README is honest about its limits: compact JSON wins on nested or irregular data, and plain CSV wins on purely tabular data.

**Licence.** MIT, for both the spec and toon-rust.

**What zWork could adopt.** Composio results such as Gmail lists, calendar events and sheet rows are often uniform arrays, and today they are shaped and capped at 8,000 characters (`connectors/composio.rs:589`).

- Encode them as TOON (or CSV) only when every item in the array has the same keys. Fall back to compact JSON otherwise.
- Use the MIT crate, or about 100 lines of hand-written Rust.

This is an experiment. Measure answer accuracy on the bench before shipping it, because some models read JSON more reliably. The effort is about 1 day plus a bench run.

### 5. TACO

**What it does.** TACO is a training-free framework for terminal agents. It finds, refines and reuses structured rules for compressing tool output, learned from past runs, so noisy output is filtered and the parts that matter for the task are kept. Sources: [arXiv 2604.19572](https://arxiv.org/abs/2604.19572), [repo](https://github.com/multimodal-art-projection/TACO).

**Evidence.**

- On TerminalBench 1.0 and 2.0, accuracy rose by 1 to 4%, and by 2 to 3% at an equal token budget.
- It used fewer tokens on SWE-Bench Lite, CompileBench, DevEval and CRUST-Bench.
- The abstract gives no token-reduction percentage, and I did not verify one in the full paper.

**Licence.** Apache-2.0.

**What zWork could adopt.** The method fits outputs that repeat with the same structure every time: Composio and browser snapshots. Learn per-tool trimming rules offline from zWork's own traces in `agent.jsonl`, review them by hand, and ship them as data. This pairs with rank 10 (RTK), which writes such filters by hand. The effort is about 3 to 5 days. Do it only after step 3 of the adoption order, a shared output cap.

### 6. context-mode

**What it does.** It is an MCP server. Tools run in a sandbox, and their full output goes into a local index rather than the context. The model gets a short summary and searches the index for detail. Source: [repo](https://github.com/mksglu/context-mode), formerly `claude-context-mode`.

**Evidence.** It reports a 99.4% median saving in output bytes (self-reported, with no benchmark of how well tasks then succeed).

**Licence.** **Elastic License 2.0**. This is source-available, not open source under OSI. It forbids offering the code as a managed service. Copy the idea, not the code.

**What zWork could adopt.** zWork already spills large outputs to a file and leaves a pointer (`truncate_or_spill`, `harness/tools/truncate.rs:228`). The missing half is search.

- Index spilled files with SQLite FTS5 (`rusqlite`, bundled), per run.
- Add a `search_output(query)` tool that returns matching lines with line numbers.
- Make every large-output path use this, including Composio, which today truncates instead (F3).

The effort is about 2 to 3 days. Watch the retrieval-call trade-off from [2608.16370](https://arxiv.org/abs/2608.16370).

### 7. LLMLingua and LLMLingua-2

**What it does.** A small language model scores tokens and drops the unimportant ones. LLMLingua-2 replaces that with a token classifier the size of BERT, distilled from GPT-4 labels, which is faster and works on any task. Sources: [repo](https://github.com/microsoft/LLMLingua), [LongLLMLingua, arXiv 2310.06839](https://arxiv.org/abs/2310.06839), [LLMLingua-2, arXiv 2403.12968](https://arxiv.org/abs/2403.12968).

**Evidence.** It reports up to 20× compression with small losses, and LongLLMLingua reports 21.4% better RAG with a quarter of the tokens. These are peer-reviewed and widely reproduced.

**Licence.** MIT.

**What zWork could adopt.** Not now.

- It is Python plus a model of a few hundred MB, which is a heavy cost for zWork. Running the classifier in Rust through ONNX (the `ort` crate) is possible, but it adds an inference runtime and model download to every install.
- It also compresses at token level, which produces text that breaks the cache and is harder to read for content the user later sees.

Revisit it only for long documents the user attaches, where masking does not help.

### 8. Headroom

**What it does.** Headroom is a local proxy between the agent and the provider.

- It compresses large JSON and logs, and keeps the originals locally ("CCR", reversible compression) so the model can fetch them back on demand.
- Its `CacheAligner` flags parts of the prompt that keep changing (such as timestamps) and would break the prefix cache.

Source: [repo](https://github.com/headroomlabs-ai/headroom).

**Evidence.** It reports 21 to 57% fewer input tokens, and over 90% on repeated JSON and logs. All of it is self-reported.

**Licence.** Apache-2.0.

**What zWork could adopt.** Not the proxy: zWork owns its providers already. Take two ideas:

- **Fetch-back on demand**, which is the same pattern as rank 6.
- **A cache-alignment test.** A unit test that builds the system prompt twice, a few minutes apart, and fails if the bytes differ. That test would have caught F5. It takes about half a day.

### 9. LMCache

**What it does.** It stores and reuses the transformer's KV cache across requests and servers, for vLLM and SGLang deployments. Source: [repo](https://github.com/LMCache/LMCache).

**Evidence.** It is peer-reviewed and in production use.

**Licence.** Apache-2.0.

**What zWork could adopt.** Nothing directly. zWork calls hosted APIs, where the provider controls the KV cache. The same goal is reached by keeping the prefix stable and using the providers' own caching. It is listed so the option is on record as ruled out, not missed.

### 10. RTK

**What it does.** A Rust CLI proxy rewrites shell commands through more than 100 filters, one per command. They shorten `git`, test-runner, `ls` and similar output. A filter ships only if it cuts output by at least 20%. Source: [repo](https://github.com/rtk-ai/rtk).

**Evidence.**

- It reports up to 90% less command output (self-reported).
- Its own docs warn that a 90% cut in output is not a 90% cut in cost, because output is only part of the context. This honesty is rare and worth noting.

**Licence.** It is split. The `rtk-oss` edition is Apache-2.0. The main edition's engine and the proxy are **BUSL-1.1** (Business Source License, not open source). Use only the oss edition.

**What zWork could adopt.** zWork's users do not run git or test suites, so the filters themselves do not apply. The idea that carries over is to write a filter for each tool and keep it only if it measurably cuts tokens. A few hand-written shapers for zWork's noisiest tools (browser snapshots, calendar lists, spreadsheet reads) would cover most of the gain. The effort is about 1 to 2 days per batch.

### 11. Selective Context

**What it does.** A small language model measures how much information each phrase or sentence carries, and the least informative ones are removed. Sources: [arXiv 2310.06201](https://arxiv.org/abs/2310.06201) (EMNLP 2023), [repo](https://github.com/liyucheng09/Selective_Context).

**Evidence.** It is peer-reviewed. Later work (LLMLingua) replaced it.

**Licence.** Unclear: the README says MIT but there is no LICENSE file.

**What zWork could adopt.** Nothing. It is listed as a baseline for rank 7.

### Also surveyed, not ranked

- [MIT-MI/MEM1](https://github.com/MIT-MI/MEM1) (360, MIT). Compresses state with RL-trained models; it needs training.
- [Alibaba-NLP/DeepResearch](https://github.com/Alibaba-NLP/DeepResearch) (20.2k, Apache-2.0). Its AgentFold method ([arXiv 2510.24699](https://arxiv.org/abs/2510.24699)) is trained.
- Latent context compression ([arXiv 2611.06500](https://arxiv.org/abs/2611.06500)) reports 70 to 89% fewer tokens but needs a trained model.
- [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) (94k, MIT) ships several condensers. I did not verify how they work in detail.
- [anomalyco/opencode](https://github.com/anomalyco/opencode) (228k, MIT) and [earendil-works/pi](https://github.com/earendil-works/pi) (123k, MIT, the source of zWork's harness) are covered in [opencode-internals.md](opencode-internals.md) and [harness-engineering.md](harness-engineering.md).

## Recommended adoption order

Every step below runs inside the Rust sidecar or is a prompt change. None of them needs Python, a database server or a GPU. The Python memory services surveyed above (Mem0, Graphiti, Hindsight, Cognee, LightMem, MemOS) would each mean bundling a Python runtime and usually a database into a signed desktop app, then supporting it on non-technical users' machines. That cost is larger than any benchmark gain shown for them, especially given the MemoryTax results.

1. **Fix what the audit already found (about 2 days).**
   - F5: move the current time out of the system prompt and into the per-turn context, or round it to the day. Add the cache-alignment test from Headroom (token rank 8).
   - Set `cache_retention` to "long" for Anthropic, OpenAI Responses and OpenRouter models, so the cache survives the gap between a user's turns.
   - F9: reserve tokens for the reply, not the whole window.
   - F1: wire up the split-turn fields.
   - F13: remove the "NEVER proactively save" contradiction.
2. **Observation masking at compaction time (about 2 days).** Token rank 2, with duplicate calls collapsed DCP-style and run only when the threshold is crossed, so the cache breaks once.
3. **One output cap with spill and search for every tool (about 2 to 3 days).** Token rank 6. Make Composio use `truncate_or_spill` (F3) and add `search_output` over SQLite FTS5.
4. **An office-aware summary prompt (about 3 days).**
   - Use ACON-style must-keep rules learned from forced-compaction bench runs (token rank 1).
   - Keep the user's latest request word for word.
   - Add the source check before the summary is used (token rank 3).
5. **Keep the summary per chat, OM-style (about 4 to 6 days).** Memory rank 2. Write `compacted_summary` and `compaction_cursor` (F7), and keep the observation block append-only so it stays cached.
6. **Make memory editable, then add a playbook (about 4 to 6 days).**
   - Add `op: add|update|delete` to `save_memory`, wired to `replace` and `remove` (memory rank 6), with `since` and `until` dates (rank 7).
   - Then a per-project or per-automation ACE playbook with helped and hurt counters (memory rank 1), including lessons from failures (rank 5).
7. **Optional: nightly consolidation (about 2 to 3 days).** Memory rank 3. A scheduler job that merges duplicates and applies pending playbook changes, plus splitting memory into an index and topic files (rank 4).
8. **Optional experiments, measured on `bench/lite` before shipping.**
   - TOON for uniform Composio arrays (token rank 4).
   - Per-tool shapers (token ranks 5 and 10).

Steps 1 to 4 are about a week and a half of work, need no new dependencies, and address every gap the audit found in compaction and caching. Steps 5 and 6 are where zWork's memory gets better than "append until full".

## Not verified

- The ReasoningBank figures (about +34% effectiveness and 16% fewer steps). They come from memory, not from the paper.
- The default Observer threshold in Mastra OM (about 30k tokens). It comes from a third-party write-up, not from the code.
- TACO's token-reduction percentage. Only the abstract was read.
- How OpenHands condensers work in detail.
- Claude Code's compaction internals. It is closed source.
- Hindsight's "independent" reproduction claim. The reproducers are co-authors.

## Sources

Agent memory:

- ACE: https://github.com/ace-agent/ace, https://arxiv.org/abs/2510.04618
- Mastra Observational Memory:
  - https://mastra.ai/research/observational-memory
  - https://github.com/mastra-ai/mastra/tree/main/packages/memory/src/processors/observational-memory
  - https://github.com/mastra-ai/mastra/tree/main/explorations/longmemeval
  - https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE
- LightMem: https://github.com/zjunlp/LightMem, https://arxiv.org/abs/2510.18866
- Letta:
  - https://github.com/letta-ai/letta-code
  - https://github.com/letta-ai/letta
  - https://docs.letta.com/letta-code/memfs
  - https://www.letta.com/blog/context-repositories
  - https://www.letta.com/blog/benchmarking-ai-agent-memory
- ReasoningBank: https://github.com/google-research/reasoning-bank, https://arxiv.org/abs/2509.25140
- Mem0:
  - https://github.com/mem0ai/mem0
  - https://arxiv.org/abs/2504.19413
  - https://github.com/mem0ai/memory-benchmarks
  - https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py
- Zep and Graphiti:
  - https://github.com/getzep/graphiti
  - https://github.com/getzep/zep
  - https://arxiv.org/abs/2501.13956
  - https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
  - https://github.com/getzep/zep-papers/issues/5
- Hindsight: https://github.com/vectorize-io/hindsight, https://arxiv.org/abs/2512.12818
- A-MEM:
  - https://github.com/WujiangXu/A-mem
  - https://github.com/agiresearch/A-mem
  - https://arxiv.org/abs/2502.12110
  - https://arxiv.org/abs/2610.33274
  - https://github.com/WujiangXu/Flex-Amem
- claude-mem: https://github.com/thedotmack/claude-mem
- Benchmarks and the LoCoMo audit:
  - https://github.com/xiaowu0162/LongMemEval
  - https://github.com/snap-research/locomo
  - https://github.com/dial481/locomo-audit
  - https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg
- Critiques:
  - https://arxiv.org/abs/2610.29823
  - https://arxiv.org/abs/2610.34073
  - https://github.com/hexuan21/MemoryTax
- Also surveyed:
  - https://github.com/MemTensor/MemOS, https://arxiv.org/abs/2507.03724
  - https://github.com/EverMind-AI/EverOS
  - https://github.com/supermemoryai/supermemory, https://github.com/supermemoryai/memorybench
  - https://github.com/topoteretes/cognee, https://arxiv.org/abs/2505.24478
  - https://github.com/Mirix-AI/MIRIX, https://arxiv.org/abs/2507.07957
  - https://github.com/BAI-LAB/MemoryOS, https://arxiv.org/abs/2506.06326
  - https://github.com/aiming-lab/SimpleMem, https://arxiv.org/abs/2601.02553
  - https://github.com/MemoriLabs/Memori, https://arxiv.org/abs/2603.19935
  - https://github.com/NevaMind-AI/memU
  - https://github.com/memodb-io/memobase
  - https://github.com/langchain-ai/langmem
  - https://github.com/zorazrw/agent-workflow-memory
  - https://github.com/basicmachines-co/basic-memory
  - https://github.com/volcengine/OpenViking

Token efficiency:

- ACON: https://github.com/microsoft/acon, https://arxiv.org/abs/2510.00615
- The Complexity Trap: https://github.com/JetBrains-Research/the-complexity-trap, https://arxiv.org/abs/2508.21433
- DCP: https://github.com/Opencode-DCP/opencode-dynamic-context-pruning
- Source-judged compaction: https://arxiv.org/abs/2610.20927, https://github.com/GuanghuiMin/sjc
- Cost of compression: https://arxiv.org/abs/2608.16370
- TOON: https://github.com/toon-format/toon, https://github.com/toon-format/toon-rust
- TACO: https://github.com/multimodal-art-projection/TACO, https://arxiv.org/abs/2604.19572
- context-mode: https://github.com/mksglu/context-mode
- LLMLingua:
  - https://github.com/microsoft/LLMLingua
  - https://arxiv.org/abs/2310.06839
  - https://arxiv.org/abs/2403.12968
- Headroom: https://github.com/headroomlabs-ai/headroom
- LMCache: https://github.com/LMCache/LMCache
- RTK: https://github.com/rtk-ai/rtk
- Selective Context: https://github.com/liyucheng09/Selective_Context, https://arxiv.org/abs/2310.06201
- Also surveyed:
  - https://github.com/MIT-MI/MEM1
  - https://github.com/Alibaba-NLP/DeepResearch, https://arxiv.org/abs/2510.24699
  - https://arxiv.org/abs/2611.06500
  - https://github.com/OpenHands/OpenHands
  - https://github.com/anomalyco/opencode
  - https://github.com/earendil-works/pi

zWork code: every reference in "What zWork does today" points to files under `sidecar-rust/src/`, read on 2026-11-21 on branch `site/redesign`.
