# Context engineering for LLM agents: what the evidence says, and what it means for zWork

Research notes, 2026-11-16. Scope: tool-definition load, long-context degradation, compaction and history management, cross-session memory and sub-agents, and prompt caching. Sources are mostly primary (papers, vendor docs, vendor engineering posts) from 2024 to 2026.

How to read the strength tags:

- **strong**: several independent, peer-reviewed or reproducible studies agree, or it is documented API behavior.
- **moderate**: one solid study, or several weaker ones that agree, or published numbers that may not transfer to our models and tasks.
- **anecdotal/vendor claim**: internal vendor evals, blog posts, forum reports. Useful direction, unverifiable numbers.

A general caveat applies throughout. Almost no published study tests GLM 5.3 or the current DeepSeek release directly, and most agent studies use coding or web-research tasks rather than office paperwork. The nearest data points are GLM-4.5, GLM-4.7 and DeepSeek V3.x. Treat every threshold below as a starting point to calibrate on our own benchmark, not a constant.

---

## Summary

1. **[strong]** Tool-selection accuracy falls as the tool catalog grows, and the fall is much steeper for open-weight and smaller models than for frontier closed models. GPT-4o lost about 13% over a 49 to 741 tool sweep, while several open models lost 70 to 94% ([LongFuncEval](#q1-tool-count-and-tool-definition-size)). MCPVerse and LiveMCPBench show the same split.
2. **[moderate]** No study gives a clean cutoff, but vendor guidance clusters low. OpenAI suggests staying under about 20 functions at a time, and Anthropic says selection degrades past 30 to 50 tools and recommends deferred loading from about 10 tools or 10K tokens of definitions. Offering about 50 tools every turn exceeds all of these.
3. **[anecdotal/vendor claim]** Loading tools on demand improves accuracy on frontier models in vendor evals (Anthropic: Opus 4 from 49% to 74%) and cuts definition tokens by about 85%. More tools are not always worse, though. In MCPVerse, GLM-4.5 and Qwen3-235B scored higher with a broader relevant set than with the minimal one. Too few tools hurts as well.
4. **[strong]** Accuracy drops with context length even when retrieval is perfect, and distractors make it worse. In an agent benchmark with controlled context growth (LOCA-bench), GLM-4.7 fell from 76% at 8K to 43% at 32K and 15% at 96K. DeepSeek-V3.2 fell from 79% to 61% to 16%. Claude Opus 4.5 held 84% at 32K. Open models need a much tighter context budget.
5. **[moderate]** The cheapest effective compaction is to drop old tool outputs and leave a short placeholder, while keeping reasoning and actions. In SWE-agent this matched LLM summarization at about half the cost (JetBrains, NeurIPS 2025 workshop). LLM summaries also made runs about 15% longer, because they hid failure signals.
6. **[moderate]** Summaries lose rules. In a 2026 study, the first compaction already dropped about 1 of 3 explicit rules, and losses accumulated with each compaction. In real sessions, process instructions and scope exclusions were dropped about 6 times more often than feature requirements. A cheaper or smaller summarizer model made things clearly worse.
7. **[moderate]** What makes long tasks survive compaction is durable state outside the context: a todo or progress file the agent re-reads, files on disk, and IDs and paths it can re-fetch from. Manus, Anthropic and the 2026 compaction study all point here, by different routes.
8. **[anecdotal/vendor claim]** Sub-agents help read-only, breadth-first work. Anthropic reports +90% on research tasks, at about 15 times the tokens. They hurt shared-context work where actions carry implicit decisions, so writes should stay single-threaded (Cognition, 2025 and 2026).
9. **[strong]** Prompt caches match exact prefixes. Any change to the tool list or its order, or a timestamp in the system prompt, invalidates everything after it. Per-turn tool swapping that rewrites the tools array therefore throws away the cache on every turn. Tool loading has to be done by appending, masking, or fixing the set per task.
10. **[strong]** Reasoning replay rules differ by provider, and getting them wrong silently degrades or breaks the loop. DeepSeek returns HTTP 400 if reasoning_content is not passed back during tool calls. GLM's preserved thinking needs the reasoning sent back unmodified. gpt-oss needs its chain of thought until it reaches a final answer.

---

## Q1. Tool count and tool-definition size

### Size of the problem

- About 58 tools across five MCP servers cost about 55K tokens of definitions before any work starts. GitHub's 35 tools alone cost about 26K, and Anthropic saw setups reach 134K before optimization. ([Introducing advanced tool use on the Claude Developer Platform, Anthropic, 2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use)) **[vendor claim, but simple to reproduce: count our own tokens]**
- Tool definitions are billed as input tokens on every request ([Function calling guide, OpenAI](https://developers.openai.com/api/docs/guides/function-calling)). **[documented]**

### Accuracy versus catalog size

- **LongFuncEval** grew the catalog from 8K to 120K tokens, about 49, 102, 207, 417 and 741 tools, with the right tool placed at varying depths. ([LongFuncEval: Measuring the effectiveness of long context models for function calling, IBM Research, arXiv 2505.10570, 2025-04](https://arxiv.org/abs/2505.10570)) **[strong]**
  - Drops on the simple subset were GPT-4o 12.9%, Llama-3.1-70B 69.6%, BitAgent-8B 79%, DeepSeek-R1-Distill-Qwen-32B 89% and Mistral-Large 94%. Mistral-Large collapsed at 120K, producing verbose output and invented function names.
  - Position effects showed up: lost-in-the-middle for Granite-8B, and recency bias (the tool listed later was found more easily) for several others.
  - Typical errors were wrong format, wrong function, and right function with wrong arguments.
- **MCPVerse** reported success rates for three modes: Oracle (only the needed servers), Standard (about 220 tools, about 44K tokens) and Max-Scale (about 550 tools, about 147K tokens). ([MCPVerse: An Expansive, Real-World Benchmark for Agentic Tool Use, Lei et al., arXiv 2508.16260 v2, 2025](https://arxiv.org/abs/2508.16260)) **[moderate]**
  - Claude-4-Sonnet: 62.3 / 62.4 / 44.2.
  - Qwen3-235B-2507: 44.8 / 53.2 / 31.6.
  - GLM-4.5: 55.0 / 59.1 / not run.
  - DeepSeek-V3-0324: 46.8 / 32.7.
  - Qwen3-30B-A3B: 27.7 / 18.9.
  - Kimi-K2 and GPT-5 fell to 16 to 23 in Standard mode, but only under prompt-based function calling, which confounds the result.
  - **The finding that complicates things:** for capable agentic models, including GLM-4.5, a broader set of relevant tools scored higher than the minimal set. The harm comes from many irrelevant tools, not from having more than the bare minimum.
- **LiveMCPBench** used 527 tools across 70 servers. Claude-Sonnet-4 reached about 79% success and most models 30 to 50%. ([LiveMCPBench: Can Agents Navigate an Ocean of MCP Tools?, arXiv 2508.01780, 2025-08](https://arxiv.org/abs/2508.01780)) **[moderate]**
- **MCP-Bench** used 250 tools. Schema compliance has largely converged across models; the gaps that remain are in planning and in picking the right tools across steps. ([MCP-Bench, Accenture, arXiv 2508.20453, ICLR 2026](https://arxiv.org/abs/2508.20453)) **[moderate]**
- **RAG-MCP** retrieved only the relevant tool descriptions. Selection accuracy was 43% against 14% for putting every tool in the prompt, with half the prompt tokens. Its stress test suggests accuracy holds up to roughly 30 tools and collapses well before 100. ([RAG-MCP: Mitigating Prompt Bloat in LLM Tool Selection via Retrieval-Augmented Generation, Gan & Sun, arXiv 2505.03275, 2025-05](https://arxiv.org/abs/2505.03275)) **[anecdotal: weak methodology, a single model (qwen-max), thresholds read off a heat map]**
- **Vendor guidance.** **[vendor claim]**
  - Anthropic says Claude's selection accuracy degrades once it has more than 30 to 50 tools. It recommends deferred loading at 10 or more tools, or more than 10K tokens of definitions. ([Tool search tool docs, Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool))
  - OpenAI suggests aiming for fewer than about 20 functions available at the start of a turn, as a soft guideline. ([Function calling guide, OpenAI](https://developers.openai.com/api/docs/guides/function-calling))
- **gpt-oss.** No benchmark gives a tool-count threshold. An OpenAI forum user saw gpt-oss-20b's tool selection degrade with about 110 tools, and the advice in reply was to bisect the count empirically. ([OpenAI community thread, 2025](https://community.openai.com/t/tool-use-differences-between-gpt-oss-20b-and-o3-mini-in-multi-agent-setup/1338110)) **[anecdotal]**
  - Separately, a 2026 reproduction found that matching OpenAI's published gpt-oss scores required the native Harmony format. Converting through Chat Completions loses information. It reproduced 60.4% against the published 60.7% on SWE-bench Verified. ([In harmony with gpt-oss, arXiv 2604.00362, 2026-04](https://arxiv.org/abs/2604.00362)) **[moderate]**

### Description quality matters as much as count

- Rewriting only a tool's description, without changing its behavior, could make a model use it up to about 10 times more often than a competing tool. This was tested on GPT-4.1 and Qwen2.5-7B, among others. ([Tool Preferences in Agentic LLMs are Unreliable, Faghih et al., UMD, EMNLP 2025, arXiv 2505.18135](https://arxiv.org/abs/2505.18135)) **[strong]** Overlapping or vague descriptions are a selection hazard in their own right.
- Concise, standardized tool instructions cut tool-doc tokens by 70 to 97% and improved accuracy. ([EasyTool, arXiv 2401.06201, 2024](https://arxiv.org/abs/2401.06201)) **[moderate]**
- Anthropic recommends a set of practices for tool design. ([Writing effective tools for AI agents, Anthropic, 2025-09-11](https://www.anthropic.com/engineering/writing-tools-for-agents)) **[vendor claim]**
  - Consolidate overlapping tools into fewer, higher-level ones.
  - Namespace tools by service or resource.
  - Return readable IDs rather than opaque ones.
  - Offer a concise response mode (72 versus 206 tokens in their example).
  - Make error messages actionable.
  - Claude Code caps a tool response at 25K tokens.
- Adding concrete input examples to tool definitions raised accuracy on complex parameters from 72% to 90% ([advanced tool use, Anthropic, 2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use)). **[vendor claim]**

### Mitigations and their tradeoffs

| Mitigation | Evidence | Tradeoffs |
|---|---|---|
| **On-demand tool loading or search.** Keep a small core loaded; the model searches or loads the rest. | Anthropic tool search: Opus 4 49% to 74%, Opus 4.5 79.5% to 88.1%, about 85% fewer definition tokens. Keep the 3 to 5 most-used tools always loaded. ([Anthropic, 2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use); [docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)) **[vendor]**. MCP-Zero: the model requests tools itself; about 98% fewer tokens with accuracy kept on APIBank ([arXiv 2506.01056](https://arxiv.org/abs/2506.01056)) **[moderate]**. | Adds a search step and a failure mode where the tool is never found. Anthropic's version is cache-safe because loaded definitions arrive inline, not in the prefix. A homemade version on an OpenAI-compatible API is not cache-safe if it edits the tools array. |
| **Pre-selection by retrieval or rules** before the first call | RAG-MCP (weak). Dynamic tool trimming on edge devices cut run time by up to 70% and power by 40%, while improving accuracy ([Less is More, DATE 2025, arXiv 2411.15399](https://arxiv.org/abs/2411.15399)) **[moderate]**. | Recall risk: a wrong guess makes the task impossible. Needs a fallback "load more tools" path. |
| **Masking instead of removing.** All tools stay defined; the decoder is constrained per state. | Manus masks token logits with a state machine and prefilled tool-name prefixes (`browser_`, `shell_`), so the tool list and the cache stay stable ([Context Engineering for AI Agents: Lessons from Building Manus, Yichao Ji, 2025-07-18](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)) **[vendor claim]**. OpenAI's `allowed_tools` does the same at the API level and keeps the cache ([OpenAI guide](https://developers.openai.com/api/docs/guides/function-calling)). | Needs logit or prefill control. Not available on most hosted APIs (Z.ai, DeepSeek). It keeps every definition's tokens in context, which helps cost via caching but does nothing for long-context distraction. |
| **Code or programmatic calling.** The model writes a script that calls tools; only results come back. | Anthropic: programmatic tool calling cut tokens 37% and raised GIA from 46.5 to 51.2 ([2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use)). Code execution with MCP: 150K to 2K tokens by browsing tool files on disk ([Code execution with MCP, Anthropic, 2025-11-04](https://www.anthropic.com/engineering/code-execution-with-mcp)) **[vendor]**. LOCA-bench found it the most consistent gain across models, +6 to +13 points at 128K ([arXiv 2602.07962](https://arxiv.org/abs/2602.07962)) **[moderate]**. | Needs a sandbox. Errors move into code, and small models make argument mistakes without schema enforcement. Harder for the user to see and approve each action. |
| **Remove tools mid-session** | Manus warns this breaks the cache and leaves history pointing at tools that no longer exist, which leads to schema violations or invented calls ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). **[vendor claim]** | Avoid. |

---

## Q2. Long-context degradation

- **Context Rot** (Chroma) tested 18 models. ([Context Rot: How Increasing Input Tokens Impacts LLM Performance, Hong, Troynikov & Huber, Chroma, 2025-07-14](https://www.trychroma.com/research/context-rot)) **[moderate: well designed, not peer-reviewed]**
  - Performance falls as input grows, even on simple tasks.
  - A single distractor hurts, and four compound the damage. Low similarity between question and answer makes the drop worse.
  - Model families fail differently: Claude tends to abstain, GPT tends to hallucinate.
  - On LongMemEval, a focused prompt of about 300 tokens beat the full prompt of about 113K tokens.
- **NoLiMa** removes literal word overlap between question and answer. 11 of 13 models fell below half their short-context score by 32K tokens; GPT-4o went from 99.3 to 69.7. Drops were already visible at 2 to 8K. ([NoLiMa, Modarressi et al., Adobe Research, ICML 2025, arXiv 2502.05167](https://arxiv.org/abs/2502.05167)) **[strong]**
- **RULER**: effective context is much shorter than advertised. Only 4 of the models tested held up at 32K. ([RULER, Hsieh et al., NVIDIA, 2024, arXiv 2404.06654](https://arxiv.org/abs/2404.06654)) **[strong, though the models are older]**
- **Length alone hurts.** Accuracy dropped 13.9% to 85% even when every relevant fact was retrieved, and even when the filler was whitespace or masked out. Having the model recite the relevant evidence before answering recovered up to 4%. ([Context Length Alone Hurts LLM Performance Despite Perfect Retrieval, Du et al., EMNLP Findings 2025, arXiv 2510.05381](https://arxiv.org/abs/2510.05381)) **[strong]**
- **Agent-specific evidence.**
  - LOCA-bench grew the environment state an agent must handle from 8K to 256K tokens. ([LOCA-bench, arXiv 2602.07962, 2026-02](https://arxiv.org/abs/2602.07962)) **[moderate]** Accuracy by context length:

    | Model | 8K | 32K | 64K | 96K |
    |---|---|---|---|---|
    | Claude-4.5-Opus | 96 | 84 | 65 | 45 |
    | GPT-5.2 | 72 | 60 | 52 | 44 |
    | DeepSeek-V3.2-Thinking | 79 | 61 | 45 | 16 |
    | GLM-4.7 | 76 | 43 | 28 | 15 |

  - LOCA-bench's failure modes map directly onto office work:
    - The agent stops early, treating the first page of results as complete.
    - It misses explicit format constraints, such as using different CSV column names.
    - It misreports values it had already retrieved.
    - It reasons less well across several sources.
  - Web agents: success of 40 to 50% on short versions of tasks fell below 10% once the same tasks were embedded in 25K to 150K tokens of history. Failures were loops and losing track of the goal. ([Evaluating Long-Context Reasoning in LLM-Based WebAgents, arXiv 2512.04307, NeurIPS 2025 workshop](https://arxiv.org/abs/2512.04307)) **[moderate: I saw the numbers via a citing survey, not the paper itself]**
  - LongMemEval: chat assistants lost 30 to 60% accuracy on memory questions at about 115K tokens of history. ([LongMemEval, Wu et al., ICLR 2025, arXiv 2410.10813](https://arxiv.org/abs/2410.10813)) **[strong]**
  - Even frontier models erode: Opus 4.6 used as a monitor fell from 98.6% to 88% recall with 800K tokens of benign history prepended. ([Classifier Context Rot, arXiv 2605.12366, 2026](https://arxiv.org/abs/2605.12366)) **[moderate]**
  - LongFuncEval: long tool responses of 10 to 80K tokens cost GPT-4o 7%, but open models lost 30 to 91%. Aggregating and filtering inside a response was harder than extracting from it. Multi-turn conversations of 10 to 80K tokens lost 13 to 40% ([arXiv 2505.10570](https://arxiv.org/abs/2505.10570)). **[strong]**

**Takeaway.** For GLM- and DeepSeek-class models the useful working context is far smaller than the advertised window. Measured agent accuracy is already sharply down by 32K. Large tool outputs such as browser snapshots, email bodies and spreadsheets are the main cause. They hurt twice: once as raw length and once as distractors.

---

## Q3. Compaction and history management

### Strategies compared

- **Observation masking versus LLM summarization** ([The Complexity Trap, Lindenbauer et al., JetBrains Research, arXiv 2508.21433 v3, 2025-10, NeurIPS 2025 DL4Code workshop](https://arxiv.org/abs/2508.21433)). **[moderate: SWE-bench only]**
  - Masking replaced tool outputs older than the last 10 turns with a placeholder and kept all reasoning and actions. It roughly halved cost and matched or slightly beat LLM summarization on solve rate.
  - Summaries made runs 13 to 15% longer. The authors' reading is that a summary hides failure signals that would otherwise make the agent stop.
  - Summary calls rarely hit the cache. Once their cost is counted, summarization's efficiency edge largely disappears.
  - A hybrid (mask first, summarize late) cut cost a further 7 to 11%.
  - Gemini 2.5 Flash in thinking mode was hurt by both: 40.4% raw, 36.4% masked, 31.4% summarized. Compaction is not free for every model.
- **No strategy beat plain self-summarization** on three long benchmarks. Several variants clearly hurt. ([Benchmarks Are Surprisingly Compaction-Friendly, Salle et al., ELLIS / MPI Tübingen, arXiv 2610.31778, 2026-10-22](https://arxiv.org/abs/2610.31778)) **[moderate: recent, one group]**
  - Discarding reasoning blocks dropped GPT-5.4 from 0.59 to 0.43, though Opus 4.6 was unaffected.
  - A smaller summarizer (Haiku 4.5) dropped GPT-5.3-Codex from 0.38 to 0.18.
  - Compacting early hurt a model with a 400K window (about 0.38 at a 160K trigger against about 0.60 at 260K and above). The trigger point made no difference for 1M-context models.
  - The authors' explanation: benchmarks have a fixed objective and keep progress on disk, so an agent can rebuild state after a lossy summary. Real interactive sessions are less forgiving.
- **Constraint erosion** (same paper).
  - The first summary already dropped about 1 of 3 explicit anti-cheating rules on average. GPT-5.3-Codex dropped about 2.7 of 3 per compaction, Opus 4.6 about 0.5.
  - In real user sessions about 81% of user constraints survived compaction. Process instructions ("how to do it") and scope exclusions ("don't touch X") were dropped about 6 times more often than feature requirements.
  - For zWork, this is the most important single finding on compaction. Office tasks are full of exclusions: don't email the client, only Q3, skip the cancelled invoices. **[moderate]**
- **Anthropic context management.** **[vendor claim: internal evals]**
  - Context editing (clearing stale tool results) plus a file-based memory tool improved an agentic-search eval by 39%, and editing alone by 29%.
  - On a 100-turn web-search eval, editing cut token use by 84%.
  - Source: [Managing context on the Claude Developer Platform, Anthropic, 2025-09-29](https://claude.com/blog/context-management).
- **LOCA-bench** compared strategies at 128K, measuring change from each model's baseline. Effects are model-specific; there is no universal best. ([arXiv 2602.07962](https://arxiv.org/abs/2602.07962)) **[moderate]**
  - DeepSeek: tool-result clearing +1.3, compaction +2.6, a "context awareness" token counter -6.7, memory tool -2.7, programmatic tool calling +13.3.
  - GPT-5.2: compaction -2.7, thinking-block clearing -1.4.
  - Gemini Flash gained from almost everything.

### When to trigger

- There is no evidence-based universal trigger.
- Anthropic's defaults: context editing at 100K input tokens, keeping the last 3 tool uses; server-side compaction at 150K, with a minimum of 50K. ([Context editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing); [compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)) **[documented]**
- Those defaults are tuned for Claude on 200K or larger windows. The LOCA-bench curves suggest open models need action much earlier (see the checklist).
- Clearing invalidates the cache from the cleared point onward. Anthropic therefore offers `clear_at_least`, so that each cache break clears enough to be worth it. ([Context editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)) **[documented]**
- No official threshold for Claude Code's auto-compaction is published. Third-party claims conflict, so don't copy a number from them.

### What to preserve

- **Anthropic's compaction docs.** **[documented]** ([Compaction docs, Anthropic](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold))
  - The default summary keeps state, next steps and learnings, and custom summary instructions are supported.
  - Instructions that were in summarized system messages no longer apply, so restate them.
  - Images and documents in the summarized span are lost.
  - Compact before overflow, not at it.
  - Put cache breakpoints at the end of the system prompt and on the summary block.
- **Anthropic engineering guidance.** **[vendor claim]** ([Effective context engineering for AI agents, Anthropic, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents))
  - Claude Code's compaction keeps architectural decisions, unresolved bugs and implementation details, and re-opens the five most recently used files.
  - Tune the summary prompt for recall first, then trim for precision.
  - Clearing tool results is the lightest-touch form of compaction.
- **Manus.** **[vendor claim]** ([Manus, 2025-07-18](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus))
  - Make compression restorable. Drop a page's content but keep its URL; drop a file's content but keep its path.
  - Keep failed actions and error messages in context so the model updates its beliefs and avoids repeating them.
  - Have the agent rewrite a todo list as it goes, which pushes the goal back into recent attention. A typical Manus task runs about 50 tool calls.
  - Avoid near-identical repeated action–observation pairs, which lock the model into a pattern ("few-shot rut").

### Failure modes seen in practice

- Lost constraints and exclusions, compounding over repeated compactions (Tübingen).
- Summaries hiding failure signals, so the agent keeps going (JetBrains).
- Lost reasoning hurting some models (Tübingen GPT-5.4; JetBrains Gemini thinking).
- A weak summarizer model (Tübingen).
- Early stopping and misreported values as context grows (LOCA-bench).
- Cache misses on every summary call (JetBrains).
- Lost images and documents (Anthropic docs).

---

## Q4. Structured memory across sessions, and sub-agent isolation

### Memory and durable state

- **A long-running harness needs more than compaction.** ([Effective harnesses for long-running agents, Justin Young, Anthropic, 2025-11-26](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)) **[vendor claim, qualitative]**
  - Anthropic's harness uses a progress log, a JSON feature list with each item initially marked failing, git commits, and a fixed start-of-session routine: read the progress, pick the next item, verify the basics.
  - JSON was chosen for the feature list because the model was less likely to overwrite or rewrite it than prose.
  - The failure modes it targets: one-shotting and running out of context mid-way, and declaring the job done too early.
- **Structured note-taking** (a NOTES.md-style file) and just-in-time retrieval: keep identifiers in context and load the content when needed. ([Effective context engineering, Anthropic, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)) **[vendor claim]**
- **Memory can make things worse.** **[moderate]**
  - Agents copy the output of a retrieved memory record when the new task looks similar ("experience-following"), so errors stored in memory spread to later tasks.
  - Selective addition and deletion of records gave about 10% over naive add-everything. ([How Memory Management Impacts LLM Agents, Xiong et al., arXiv 2505.16067, 2025](https://arxiv.org/abs/2505.16067))
  - In LOCA-bench a memory tool hurt DeepSeek-V3.2 by 2.7 points, though it helped GPT-5.2 and Gemini.
- **Filesystem memory versus memory products.** Letta reported that a plain filesystem agent scored 74% on LoCoMo, against Mem0's self-reported 68.5%. ([Benchmarking AI Agent Memory: Is a Filesystem All You Need?, Letta, 2025-08-12](https://www.letta.com/blog/benchmarking-ai-agent-memory)) **[anecdotal/vendor claim: self-reported and disputed]** The direction is useful: simple files plus search are a reasonable baseline.

### Sub-agents

- **Multi-agent research.** ([How we built our multi-agent research system, Anthropic, 2025-06-13](https://www.anthropic.com/engineering/multi-agent-research-system)) **[vendor claim]**
  - Multi-agent beat a single agent by 90.2% on an internal research eval, at about 15 times the tokens. Token usage alone explained about 80% of the variance.
  - Anthropic calls it a poor fit for tasks where agents must share context or depend on each other, and names most coding work as an example.
  - Sub-agents should write their outputs to files and pass back lightweight references.
  - Vague delegation led to duplicated work.
  - Elsewhere, Anthropic suggests sub-agents return condensed summaries of about 1 to 2K tokens ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **The case against multi-agent writes.** ([Don't Build Multi-Agents, Walden Yan, Cognition, 2025-06-12](https://cognition.com/blog/dont-build-multi-agents)) **[vendor claim]**
  - Share full traces, not just messages.
  - Actions carry implicit decisions, so parallel writers make conflicting assumptions.
  - Prefer a single-threaded agent, with a separate model compressing history when needed.
- **What has worked since.** ([Multi-Agents: What's Actually Working, Walden Yan, Cognition, 2026-04-22](https://cognition.com/blog/multi-agents-working)) **[vendor claim, internal numbers]**
  - Writes stay single-threaded.
  - A reviewer with a clean context works well, catching about 2 bugs per PR in Cognition's code review.
  - Escalating to a "smart friend" model with forked context also works.
  - Parallel writers still fail.
- **A sub-agent scaffold can also hurt.** In LOCA-bench, Claude's agent scaffold scored 7.3 points below native calling, because spawned sub-agents lacked the tools they needed ([arXiv 2602.07962](https://arxiv.org/abs/2602.07962)). **[moderate]**

---

## Q5. Prompt-caching interactions

- **Anthropic.** **[documented]** ([Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); [Tool use with prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching))
  - Prefix hierarchy: tools, then system, then messages. A change at any level invalidates that level and everything after it.
  - Changing tool definitions invalidates everything.
  - Changes to tool_choice, images, thinking parameters or effort invalidate the message cache.
  - Each breakpoint looks back at most 20 blocks.
  - A timestamp or other per-request value at or before a breakpoint means every request pays a cache write and never gets a read.
  - Languages that randomize map key order when serializing JSON break caching. The docs name Swift and Go.
  - Pricing: cache writes cost 1.25 times base input for the 5-minute TTL and 2 times for the 1-hour TTL. Reads cost 0.1 times base.
- **OpenAI.** **[documented]** ([Prompt caching guide, OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching))
  - Caching is automatic for exact prefixes of 1,024 tokens or more, so put static content first.
  - Any change to a tool's name, description, schema or order breaks the prefix. Use `allowed_tools` to restrict tools without editing the list.
  - A cache key handles roughly 15 requests per minute before overflowing to other machines.
- **DeepSeek.** **[documented]** ([Context caching, DeepSeek](https://api-docs.deepseek.com/guides/kv_cache))
  - Prefix caching is automatic and best-effort, with no guaranteed hit rate.
  - Usage reports `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.
  - Cache entries expire after hours to days.
- **Z.ai (GLM).** Caching is implicit, with no manual cache markers ([Context caching, Z.ai](https://docs.z.ai/guides/capabilities/cache)). The cached-input discount varies by model and I could not confirm the current rate from the official pricing page. **[documented behavior; price unverified]**
- **Manus.** **[vendor claim]** ([Manus, 2025-07-18](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus))
  - Manus treats KV-cache hit rate as its single most important production metric.
  - Agents run at about 100 input tokens per output token, and cached tokens cost about 10 times less in its example.
  - Its rules: a stable prefix (no timestamps to the second), append-only context, deterministic serialization, and explicit cache breakpoints where the provider needs them.
- **Compaction and caching trade off directly.**
  - Every compaction or clearing event breaks the cache from that point on. JetBrains found summary calls rarely hit the cache.
  - So compact rarely and in large steps, rather than trimming a little every turn ([Anthropic context editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing): `clear_at_least`).
- **Reasoning replay** is not caching, but it decides whether the prefix stays byte-identical and whether the loop works at all.
  - **DeepSeek.** In thinking mode with tool calls, `reasoning_content` must be passed back in later requests, or the API returns 400. ([Thinking mode, DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/)) **[documented]**
  - **GLM.** Interleaved thinking is on by default. Preserved thinking (`clear_thinking: false`) requires the complete, unmodified `reasoning_content` to be sent back. Z.ai says this improves both quality and cache hits, and says not to reorder or edit reasoning blocks. ([Thinking mode, Z.ai](https://docs.z.ai/guides/capabilities/thinking-mode)) **[documented]** A third-party page claims preserved thinking is on by default for the coding-plan endpoint; I could not confirm this.
  - **gpt-oss.** The model can call tools inside its chain of thought, so the chain of thought must be fed back until a final answer is produced. OpenAI recommends the Responses API format, and notes that Chat Completions has no official spec for this. ([Verifying gpt-oss implementations, OpenAI Cookbook](https://developers.openai.com/cookbook/articles/gpt-oss/verifying-implementations)) **[documented]**
  - **Claude.** Thinking blocks must be passed back unmodified during tool use, and dropping them invalidates the message cache. ([Extended thinking docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking); prompt-caching invalidation table) **[documented]**
- **Ollama context length.** **[documented]** ([Context length, Ollama](https://docs.ollama.com/context-length))
  - The default context window depends on available VRAM and is small on typical laptops.
  - Ollama recommends at least 64K tokens for agents and tools, set with `OLLAMA_CONTEXT_LENGTH` or the app slider.
  - That page does not say what happens when a prompt exceeds the window, so verify that our system prompt and tool block cannot be silently cut off.

---

## What this means for zWork

This checklist is ordered by expected impact. I have not read zWork's agent code for this note, so items say what to check or change, not what is already in place. Each item cites its basis.

### Tools (biggest likely win)

- [ ] **Measure first.** Count the tokens of the full tool block per provider, since chat templates render it differently. Run a tool-count bisection on our benchmark tasks: about 8, 15, 25 and 50 tools offered, for GLM 5.3, DeepSeek and gpt-oss. No published data covers GLM 5.3, and MCPVerse shows a broader relevant set can beat a minimal one. Basis: [OpenAI forum advice](https://community.openai.com/t/tool-use-differences-between-gpt-oss-20b-and-o3-mini-in-multi-agent-setup/1338110), [MCPVerse](https://arxiv.org/abs/2508.16260).
- [ ] **Target per turn.**
  - Open models (GLM, DeepSeek, gpt-oss): about 10 to 15 tool definitions visible, with 20 as a soft ceiling.
  - Claude and GPT: up to about 20 to 30.
  - Never about 50 irrelevant ones.
  - Basis: OpenAI's under-20 guidance ([guide](https://developers.openai.com/api/docs/guides/function-calling)), Anthropic's 30 to 50 degradation point ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)), the open-model collapse in [LongFuncEval](https://arxiv.org/abs/2505.10570), and RAG-MCP's roughly 30-tool knee ([arXiv 2505.03275](https://arxiv.org/abs/2505.03275), weak).
- [ ] **Always-loaded core of about 6 to 10 tools:**
  - read, write and list files;
  - run a script;
  - update the todo or plan;
  - ask the user or request approval;
  - a tool loader or search.
  - Basis: Anthropic's keep-3-to-5-most-used rule ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
- [ ] **Load the rest per task, in a cache-safe way.** In order of preference:
  - **(a) Fixed per task.** Choose tool groups (browser, desktop, mail, calendar, documents) before the first model call from the request text, and keep them fixed for the task. Basis: [Less is More](https://arxiv.org/abs/2411.15399), plus the cache rules in [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching).
  - **(b) Mid-task loading.** Add a `load_tools(group)` tool for anything missed. Appending definitions costs one cache miss on Chat Completions-style APIs; accept that, but allow only a few loads per task.
  - **(c) Long tail of app actions.** Expose many app actions through two generic tools: search actions (returns schemas as text) and execute action (app, action, arguments). The tools array then never changes. Validate the arguments server-side and return actionable errors. Basis: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp), [programmatic tool calling](https://www.anthropic.com/engineering/advanced-tool-use), [LOCA-bench](https://arxiv.org/abs/2602.07962).
  - **On Claude,** use the native tool search with `defer_loading`. It keeps the cache intact ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
  - **On GPT,** use `allowed_tools` rather than editing the list ([OpenAI](https://developers.openai.com/api/docs/guides/function-calling)).
- [ ] **Never remove a tool mid-task** that earlier turns used. Basis: [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).
- [ ] **Tighten definitions.**
  - Use one consistent prefix per group (`browser_`, `desktop_`, `mail_`, `file_`).
  - Merge overlapping tools.
  - Keep each description short and say when not to use the tool.
  - Add one input example for tools with complex parameters.
  - Re-check any tool the model over- or under-uses, since description wording alone can shift usage about 10 times.
  - Basis: [Anthropic, Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents), [EasyTool](https://arxiv.org/abs/2401.06201), [Faghih et al.](https://arxiv.org/abs/2505.18135), [tool-use examples](https://www.anthropic.com/engineering/advanced-tool-use).

### Tool outputs and context budget

- [ ] **Cap each tool result.**
  - Use about 25K tokens as the absolute ceiling (Claude Code's limit), and far less for open models: around 5 to 10K tokens is a reasonable start to tune.
  - Save the full output to a file and return a head or summary plus the path.
  - Browser snapshots, email bodies and spreadsheet dumps are the main offenders.
  - Basis: [Anthropic, Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents); [LongFuncEval](https://arxiv.org/abs/2505.10570), where long responses cost open models 30 to 91%.
- [ ] **Keep only the latest screenshot or page snapshot in full.** Older ones become a one-line placeholder: what it was, the URL or window, and when it was taken. Basis: [JetBrains](https://arxiv.org/abs/2508.21433), [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).
- [ ] **Model-specific budgets.** Starting points to calibrate on our benchmark (GLM 5.3 is newer than GLM-4.7 and may do better):
  - **GLM and DeepSeek:** aim to keep the working context under about 32K tokens. Treat about 48 to 64K as the point where stage 2 below must already have run, even though the window is far larger.
  - **gpt-oss on Ollama:** same, and make sure the context length is set to at least 64K.
  - **Claude and GPT:** Anthropic's defaults of about 100K for clearing and about 150K for summarizing are reasonable.
  - Basis: [LOCA-bench](https://arxiv.org/abs/2602.07962) (GLM-4.7 76 to 43 by 32K, DeepSeek-V3.2 79 to 45 by 64K), [NoLiMa](https://arxiv.org/abs/2502.05167), [Anthropic defaults](https://platform.claude.com/docs/en/build-with-claude/context-editing), [Ollama](https://docs.ollama.com/context-length).

### Compaction pipeline

- [ ] **Stage 1, clearing.** When over budget, replace tool outputs older than the last 3 to 10 tool calls with restorable placeholders: the path, URL, message ID or row range, plus a one-line gist. Keep all assistant reasoning and actions. Clear a large batch at once, so the cache breaks rarely. Basis: [JetBrains](https://arxiv.org/abs/2508.21433) (last 10 turns), [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) (keep 3, `clear_at_least`), [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).
- [ ] **Stage 2, summarization.** Use it only if stage 1 is not enough.
  - Summarize with the same model the user is on, never a cheaper one.
  - Keep the last several turns verbatim.
  - Basis: [Tübingen](https://arxiv.org/abs/2610.31778) (a smaller summarizer halved the score); [JetBrains hybrid](https://arxiv.org/abs/2508.21433).
- [ ] **What a summary must carry.** Use a structured template, not free prose.
  - The user's original request, **verbatim**, and every later user instruction, verbatim.
  - All constraints and **exclusions** as a bullet list (people not to contact, date ranges, "don't send, just draft").
  - Files read or written, with paths; external IDs (email threads, URLs, sheet ranges).
  - Decisions made and why.
  - Current todo state.
  - Errors hit and what was already tried.
  - Figures already computed, with their source.
  - Basis: [Tübingen](https://arxiv.org/abs/2610.31778) (scope exclusions and process instructions drop about 6 times more often), [Anthropic compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold), [Anthropic, Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [LOCA-bench](https://arxiv.org/abs/2602.07962) (misreported values).
- [ ] **Never summarize the system prompt or the tool block.** They stay as the fixed head, and safety and approval rules are restated after every compaction. Basis: [Anthropic compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold).
- [ ] **Re-inject the plan after compaction.** Have the agent keep a todo or progress file for any multi-step task, rewrite it as it goes, and re-read it after each compaction. Basis: [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), [Anthropic harness post](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [Tübingen](https://arxiv.org/abs/2610.31778).
- [ ] **Keep errors visible.** Collapse repeated identical errors into one line with a count instead of deleting them. Basis: [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), [JetBrains](https://arxiv.org/abs/2508.21433) (hidden failure signals made runs longer).
- [ ] **Regression test for compaction.** Add benchmark tasks with an explicit exclusion stated early, such as "skip anyone marked cancelled", in a run long enough to compact at least once. Grade whether the exclusion survives. Basis: [Tübingen](https://arxiv.org/abs/2610.31778).

### Cache-safe request layout

- [ ] **Order the request** from most to least stable:
  1. Tools, in a fixed sorted order.
  2. The static system prompt, with no date, time, OS state or user data.
  3. Session-stable context: memory and project instructions.
  4. Conversation history, append-only.
  5. Per-turn dynamic facts (date and time, open windows, the current screen), placed in the newest user turn or tool result.
  - Basis: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).
- [ ] **Deterministic serialization.** Check that no Rust `HashMap` (randomized iteration order) is serialized into tool schemas, tool arguments or message bodies. Use ordered maps, or keep `serde_json`'s default ordered map. Basis: Anthropic's warning about randomized key order ([prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)); the HashMap point is general Rust behavior.
- [ ] **Do not edit earlier messages** except at a deliberate compaction event. Basis: [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- [ ] **On Claude, place cache breakpoints** at the end of tools and system, on the latest message, and on the compaction summary. Basis: [Anthropic compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold).
- [ ] **Log the cache hit rate per run**, where the provider reports it: DeepSeek `prompt_cache_hit_tokens`, OpenAI cached tokens, Anthropic `cache_read_input_tokens`. Track it alongside quality. Basis: [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), [DeepSeek](https://api-docs.deepseek.com/guides/kv_cache).

### Reasoning replay (correctness, not just cost)

- [ ] **DeepSeek:** pass `reasoning_content` back on every assistant message within a tool loop. Missing it causes a 400. Basis: [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/).
- [ ] **GLM:** decide on preserved thinking deliberately. If `clear_thinking: false`, send reasoning back byte-for-byte and in order. Check which mode our endpoint actually uses. Basis: [Z.ai thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode).
- [ ] **gpt-oss:** feed the chain of thought back until the final answer, and prefer a Harmony-native path over lossy Chat Completions conversion. Basis: [OpenAI Cookbook](https://developers.openai.com/cookbook/articles/gpt-oss/verifying-implementations), [arXiv 2604.00362](https://arxiv.org/abs/2604.00362).
- [ ] **Claude:** return thinking blocks unmodified in tool-use turns. Basis: [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking).
- [ ] **During compaction,** keep reasoning for at least the recent turns. Dropping it cost one model 16 points. Basis: [Tübingen](https://arxiv.org/abs/2610.31778).

### Memory and sub-agents

- [ ] **Keep cross-session memory small and curated.**
  - Store facts and preferences, not past trajectories as "how to" templates.
  - Add selectively, and let the user see and delete entries.
  - Don't save a run's approach as a lesson unless it was verified correct.
  - Basis: [Xiong et al.](https://arxiv.org/abs/2505.16067) (error propagation), [LOCA-bench](https://arxiv.org/abs/2602.07962) (a memory tool hurt DeepSeek).
- [ ] **For recurring scheduled tasks,** keep a per-task progress file read at the start of each run: last run, what changed, open items. Don't replay the old conversation. Basis: [Anthropic harness post](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
- [ ] **Use sub-agents only for read-only fan-out.** Examples: scan 40 emails, or read every file in a folder. Give each sub-agent the tools it needs and have it return a summary of at most about 1 to 2K tokens, with paths. All writes, sends and edits stay in the main agent. Basis: [Anthropic multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system), [Cognition 2025](https://cognition.com/blog/dont-build-multi-agents) and [2026](https://cognition.com/blog/multi-agents-working), [LOCA-bench](https://arxiv.org/abs/2602.07962) (sub-agents lacking tools).
- [ ] **Consider a clean-context checker** for the "check your work" step. A fresh call sees only the inputs, the output files and the request, and reports mismatches. It is the multi-agent pattern with the best reported results, and it avoids judging the work from inside a long, rotted context. Basis: [Cognition 2026](https://cognition.com/blog/multi-agents-working) (vendor claim); [Du et al.](https://arxiv.org/abs/2510.05381) (length alone hurts).

### Where the evidence is thin

- **No data on GLM 5.3 or the current DeepSeek release.** The nearest are GLM-4.5 (MCPVerse) and GLM-4.7 (LOCA-bench). Newer releases may be noticeably better.
- **Thresholds are not established.** The tool-count figures (20, 30 to 50) are vendor guidance. RAG-MCP's roughly 30-tool knee comes from a weak study. MCPVerse shows more relevant tools can help.
- **Compaction results disagree.** JetBrains favors masking, Tübingen found nothing beats self-summary, and LOCA-bench shows the sign of the effect flipping by model. Both kinds of study are mostly coding or research tasks; none use office paperwork.
- **Vendor numbers are internal.** Anthropic's 49 to 74, +39% and +90%, Manus's metrics and Cognition's review stats cannot be independently checked.
- **Claude Code's auto-compaction threshold is undocumented.**
