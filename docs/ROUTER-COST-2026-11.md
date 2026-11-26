# Router cost and usage limits, November 2026

What the hosted `zwork-auto` router cost over the last 30 days, where the money
went, and what changes make it cheaper so the usage limits can go up.

Source: prod `gateway_requests`, read-only, 30 days to 2026-11-24 (traffic
started Nov 1). Costs are billed OpenRouter dollars (`estimated_cost_usd`).
No user content or emails here; users are only counted.

## The numbers

**Volume.** 725 requests from 10 users (7 free, 2 Pro, 1 Max). $2.24 spent in
total: free $0.93, Pro $1.00, Max $0.31. No upstream errors. No scheduled runs
at all in the 30 days.

**Where the money went, by route**

| Route | Model | Requests | Spend | Share |
|---|---|---|---|---|
| escalated | MiMo Pro | 233 | $1.33 | 59% |
| vision | Gemini Flash | 47 | $0.47 | 21% |
| flash | DeepSeek Flash | 417 | $0.42 | 19% |
| A/B (GLM) | GLM Flash | 13 | $0.02 | 1% |

A third of the requests cost three fifths of the money. Escalated runs are 29%
of agent runs and about 80% of agent-run spend.

**One agent run**

| | Runs | Median cost | Average | Slowest 10% | Median calls |
|---|---|---|---|---|---|
| Stays on Flash | 62 | $0.0024 | $0.0073 | $0.019 | 2 |
| Escalated | 25 | $0.039 | $0.070 | $0.174 | 5 |

**Why runs were escalated.** The one-word classifier said "hard" for 20 of the
78 runs it saw (26%). Struggle checks escalated 4 more (repeated tool call 4,
long run 1). The classifier itself costs about $0.00003 a call.

**The classifier read the wrong text.** The desktop app puts its own context
(time, earlier work in the chat, crew, skills, artifact mode, headlines) in
front of what the user typed. The classifier read the first 4,000 characters,
so it mostly judged the app's context: 17 of the 20 "hard" verdicts had that
context in front, and in 4 the user's words were cut off entirely. Those 17
runs cost $0.82, more than a third of all spend.

**Titles count as tasks.** Chat titles (`x-zwork-trigger: background`) are
18% of the "new task" rows but 0.01% of spend. They were counted as new tasks
for the task limit and in the message counts.

**Caching works.** Later calls in a run bill at 17% (MiMo) to 45% (DeepSeek)
of list price, so sticky routes are doing their job. Input is 74–97% of cost;
the average prompt grows from 37k tokens on a run's first call to 68k by call
16. Capping output length would save under 5%.

**Limits.** 4 of the 7 users with traffic ran into a limit. The paying Pro
user hit both the weekly ($0.99 against $0.92) and the 5-hour window ($0.52
against $0.32). Two free users hit the weekly cap, three hit the 5-hour one.
The 5-hour window is the one people hit most.

## Changes (in `cloud-src/api/src/main.rs`)

| Change | Setting | Saving on the measured month |
|---|---|---|
| Classifier reads the end of the message (what the user typed), drops the app's context block, and is told the context comes first | — | part of the $0.82 behind context-led "hard" verdicts; est. $0.15–0.30 beyond the hand-back below |
| A run escalated by the classifier hands back to Flash after 6 escalated calls. Runs escalated for struggling stay on MiMo. No second hand-back; runs with images stay | `ROUTER_ESCALATED_HANDBACK_CALLS=6` (0 = off) | about $0.35 |
| A/B slice off: too few paid runs to learn anything, and Haiku lists at $1/$5 | `ROUTER_AB_PERCENT` 5 → 0 | small now; avoids Haiku cost later |
| Long-run escalation at 60 calls instead of 40; the repeat and error checks still catch stuck runs | `ROUTER_ESCALATE_AFTER_CALLS` 40 → 60 | small |
| Titles count as part of an existing task, not as new tasks | `x-zwork-trigger: background` | none; frees a task slot, cleaner counts |

Hand-back estimate at other settings (classifier-escalated runs only, MiMo
calls after the Kth moved to Flash at Flash's billed rate):

| K | Calls moved | Saving |
|---|---|---|
| 4 | 109 | $0.45 |
| 6 | 93 | $0.35 |
| 8 | 80 | $0.23 |
| 12 | 61 | $0.19 |

6 was picked because the median escalated run is 5 calls: short hard tasks
finish on MiMo, and only long ones hand back.

**Pending change that adds cost.** The Flash route already on `main`, GLM 5.3
Flash first, then DeepSeek V4.1 Flash 1017, costs about 1.3× DeepSeek Flash
per call on measured runs (1017 costs about 4× but only serves as fallback).
On this month that is about +$0.12 on the $0.42 Flash share.

**Net.** The measured month would have cost about $1.60–1.75 instead of $2.24,
25–30% less for the same work. Every escalated run is also capped near six
MiMo calls unless it is struggling.

**Not counted above: the steadier desktop prompt (9733646).** A run's first
call is billed at about list price: $0.44 of the $2.13 chat spend (21%). Since
9733646 the system prompt stays byte-for-byte the same all day (the time moved
into each message), so a first call can reuse the cache another run left. If
the shared system-and-tools prefix (most of the 37k tokens) hits, first calls
cost roughly half to a third as much: another $0.20–0.30 a month, 10–13%. It
only hits while the cache is warm, and at today's traffic it will often be
cold, so the limits below don't count on it.

## Images, provider stickiness and false "stuck" alarms

**Images stay on Flash.** GLM 5.3 Flash and both DeepSeek V4.1 Flash models
accept images (OpenRouter model list, `input_modalities`, read 2026-11-25).
Gemini Flash lists at about 7× their input price and 11× their output price,
and was 21% of the month's spend ($0.47). Screenshots now stay on Flash, and
only images in the newest messages count, so an old screenshot no longer
keeps a run on an image route. Moved to Flash prices, the vision share would
have cost well under $0.10: a saving of about $0.35–0.40.
`ROUTER_VISION_FOR_IMAGES=1` turns Gemini back on.

**Cache misses in one run.** A 16-call run on Nov 24 (`ab-glm` arm) missed
the cache on calls 2, 4 and 11, about 70k of its 103k uncached tokens:

- Calls 1–10 were all GLM 5.3 Flash, first attempt, no failover. Misses on 2
  and 4 came with no model change, so OpenRouter served them from a different
  GLM provider than the call before (each provider has its own cache).
  OpenRouter only keeps a conversation on one provider after it sees a cache
  hit, and may not at all with `:floor` price sorting. Fix: every call now
  sends the run id as `session_id`, which OpenRouter uses as the sticky key
  from the first successful call.
- Call 11 moved to MiMo (`repeated_tool_call`): `desktop_capture` with the
  same arguments three times among the last eight calls, with key presses in
  between. That is normal look-act-look work, not a stuck run. It cost $0.015,
  over half the run. Fix: only identical calls in a row count.

The gateway doesn't record which OpenRouter provider served a call (that is
in OpenRouter's `/generation` metadata, not the response), so the provider
switch is inferred from the cache pattern, not seen directly.

## New limits

| Setting | Before | After |
|---|---|---|
| `PRO_WEEKLY_USD` | $0.92 | $1.50 |
| `MAX_WEEKLY_USD` | $3.83 | $6.00 |
| `FIVE_HOUR_SHARE` | 0.35 | 0.25 |
| `FREE_USER_WEEKLY_MAX_USD` | $0.10 | $0.25 |
| `FREE_USER_WEEKLY_MIN_USD` | $0.03 | $0.05 |
| `FREE_POOL_WEEKLY_USD` | $15 | $15 (unchanged) |
| `FREE_ESCALATIONS_30D` | 3 | 3 (unchanged) |

What this means in work, with the cheaper routing:

| Plan | Weekly | 5-hour window | Work per week vs before | Work per 5 hours vs before |
|---|---|---|---|---|
| Free | $0.25 | $0.0625 (was $0.035) | about 3.5× | about 2.5× |
| Pro | $1.50 | $0.375 (was $0.32) | about 2.2× | about 1.6× |
| Max | $6.00 | $1.50 (was $1.34) | about 2.2× | about 1.6× |

A 5-hour window is a quarter of the week, so it takes four full sessions to use
up a week: one heavy day can't. The heaviest 5-hour stretch measured ($0.52,
the Pro user) costs about $0.37 with the cheaper routing, so it now just fits.

### Margin

Net price after Stripe (2.9% + $0.30 a charge): Pro $11.35 a month ($9.69 on
the annual plan), Max $48.25 ($40.43 annual). A week of cap is 4.33 weeks a
month.

| Plan | Cost cap a month | Margin if every week is maxed | Same, annual plan | Before (monthly) |
|---|---|---|---|---|
| Pro | $6.50 | $4.85 (43%) | $3.19 (33%) | $7.36 (65%) |
| Max | $26.00 | $22.25 (46%) | $14.43 (36%) | $31.65 (66%) |

Edge case: a run already under way may go 1.5× past the cap
(`CONTINUATION_HEADROOM`). A user whose every week ended that way would cost
Pro $9.75 a month: still positive on monthly billing, about break-even on
annual. In practice only the run that crosses the line overshoots.

Expected case: the one paying Pro user spent $1.00 in 30 days while hitting
both limits. If the higher limits double that, the margin is about $9.35 (82%).

Free: one heavy free user can now cost $1.08 a month plus three escalated runs
(about $0.06 each after the hand-back). The $15 weekly pool still caps free
spend in total; the measured month's free spend was $0.93.

## Follow-ups (not in this change)

- **Prompt size.** A run's first call is 37k tokens, mostly tool schemas.
  Input is most of the cost, so trimming tools per task is the next big lever.
- **Vision.** Gemini is 21% of spend with 77k-token prompts, because every
  screenshot stays in the history. Dropping old screenshots in the desktop app
  would shrink these prompts.
- **Plan copy.** The plan page and gallery list message counts ("200 messages
  every 5 hours") that don't follow from the dollar caps. They need new wording.
- **Price table.** `estimate_cost` lists DeepSeek Flash at $0.035/$0.14 per
  million; first calls bill about 1.65× that. Only matters where the estimate
  is used without a billed cost.
- **Record the serving provider.** Store OpenRouter's provider name per call
  (from `/generation?id=…`) so cache misses can be traced directly.
- **Measure after deploy.** Count `routing_decision.why.reason` per week:
  `classifier` share should fall from 26%, and `handback` runs should finish
  as often as other runs.
