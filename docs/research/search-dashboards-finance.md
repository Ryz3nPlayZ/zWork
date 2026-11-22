# Free agentic search, AI-built dashboards, and a finance view

Researched 2026-11-22. Goal: make zWork good at everyday work beyond paperwork — looking things up, keeping an eye on things, money — at no per-user cost.

## 1. Agentic search (shipped in 8e2af49)

"Agentic" search means the model loops: search, open the best pages, notice gaps, search again, then answer with links. zWork already had the loop (`web_search` + `web_fetch` + the prompt telling it to open results). What was weak was the free sources behind it.

| Layer | Source | Cost | Limit | Role |
|---|---|---|---|---|
| Search | Exa hosted MCP (`mcp.exa.ai`), keyless | free | per-IP, unpublished; 429 when hit | first choice: semantic, returns page excerpts |
| Search | DuckDuckGo no-JS page (`html.duckduckgo.com`) | free | soft; can show a challenge | **new** fallback for general queries |
| Search | Google News RSS | free | generous | last fallback; empty query = headlines |
| Read | direct fetch + htmd → markdown | free | none | first choice |
| Read | Jina Reader (`r.jina.ai`), keyless | free | 20 req/min per IP | **new**: pages built by JavaScript or blocking plain requests |
| Read | built-in browser tools | free | slow | CAPTCHA walls, logins |

Why not the others:
- **Brave Search API**: no free tier since Feb 2026 ($5 monthly credit, card required).
- **Tavily / Serper / Firecrawl**: free tiers are per-account, so one key would be shared by every zWork user. Fine later as a server-side router feature, not as a client default.
- **Self-hosted SearXNG**: best quality-for-free, but it's a server we'd run and its upstream engines rate-limit a shared IP. Worth it only if Exa's keyless limit starts hurting.

Remaining compromise: Exa and Jina limits are per IP and unpublished/low. If heavy users hit them, the upgrade is a zWork-cloud search proxy (one Exa/Jina paid key behind the router, metered with the allowance) — no client change needed beyond the endpoint.

## 2. Kimi Work's Dashboard

Kimi Work (desktop agent, beta since June 2026) lets you ask in chat for a widget ("a countdown to my Tokyo trip with a packing list", "a watchlist of these 5 stocks"). It renders an interactive component, which you can:
- save to a **Dashboard** page that outlives the conversation;
- **pin** as its own small desktop window;
- **edit by annotation**: select an area and say what to change.

Kimi's pages don't say how widgets get live data; their market example uses data the user pastes in.

### Can zWork do this? Yes, mostly with parts it already has

- The chat already renders HTML in a sandboxed iframe (`Message.tsx`, `srcDoc`).
- The agent can already write files and run scheduled jobs (`manage_schedules`).

Smallest version ("Boards"):
1. A widget is one folder: `workspace/widgets/<id>/index.html` (self-contained, no network) + `data.json`.
2. A `save_widget(title, html, data?, refresh?)` tool writes it and returns the id. The prompt tells the model to put all numbers in `data.json` and read them with `fetch("data.json")`, so a refresh only rewrites data.
3. **Live data = a scheduled job**: `refresh: "every 30m"` creates a schedule whose prompt is "update data.json for widget X" — the agent fetches stock prices, unread email counts, a web page, etc. No widget ever needs network access or keys.
4. A **Dashboard** view in the app: a grid of sandboxed iframes (`sandbox="allow-scripts"`), each with Edit (opens a chat pre-filled "change widget X: …"), Refresh now, Remove. Pin-to-desktop = a small always-on-top Tauri window showing one widget (phase 2).

Why this beats Kimi for zWork's users: widgets fed by connected apps (Gmail, Calendar, Sheets) and scheduled refreshes, e.g. "invoices still unpaid", "this week's calendar load", "my 5 stocks".

Effort: ~1–2 days for steps 1–4 without pinning.

## 3. Perplexity Finance

The product has:
- market overview, per-ticker pages, an earnings hub with live call transcripts, watchlists;
- linked brokerage and bank accounts through Plaid (2026);
- answers grounded in filings and transcripts.

Its edge is **licensed data**: FactSet, Morningstar, PitchBook and Quartr transcripts. A free app can't match the professional tier.

What a free stack covers well:

| Need | Free source | Notes |
|---|---|---|
| Prices, history, charts | Yahoo chart endpoint (already in `get_stock_data`) | unofficial; Stooq CSV as fallback |
| Company financials | SEC EDGAR `companyfacts` / `submissions` JSON | official, free, needs a User-Agent; US only |
| Earnings releases | EDGAR 8-K exhibit 99.1 | press release text, same day |
| Macro (rates, CPI) | FRED | free key; could live on the router |
| Crypto | CoinGecko public API | keyless, rate-limited |
| News, commentary | the search stack above | |

The zWork version is mostly *skills plus dashboards*, not a new product area:
- A "markets" skill that teaches the model these endpoints, and adds EDGAR as a `get_company_filings` tool.
- Finance words now load the stock tool (this commit). Before, it loaded only for "stock price" or "ticker".
- A ready-made watchlist widget on Boards, refreshed by a schedule.

Skip:
- **brokerage linking**: Plaid is paid, and it's regulated-data territory;
- **live transcripts**: licensed.

**Caution:** answers should be research, not personal investment advice. Add one line to the skill saying so.

## Order

1. Done: DuckDuckGo search fallback, Jina reader fallback, and wider finance triggers.
2. Boards (dashboard and widgets): the most visible step, and useful for everyone, not only finance.
3. A markets skill plus an EDGAR tool, with the watchlist widget as its showcase.
4. A search proxy on the router, only if keyless limits start to show up in errors.

Sources:
- [Exa MCP docs](https://exa.ai/docs/reference/exa-mcp.md)
- [Jina Reader limits](https://jina.ai/reader)
- [Brave drops its free tier](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing.md)
- [Kimi Work Dashboard](https://www.kimi.ai/resources/kimi-work-dashboard)
- [Kimi Work intro](https://www.kimi.ai/resources/kimi-work-introduction)
- [Perplexity Finance overview](https://aiwiki.ai/wiki/perplexity_finance)
- [Perplexity × Quartr](https://quartr.com/customers/how-perplexity-leverages-quartr-api)
