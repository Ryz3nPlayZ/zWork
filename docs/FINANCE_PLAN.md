# zWork Finance: the plan

Written 2026-11-22. The goal is a Finance tab that combines:

- **Perplexity Finance:** answers grounded in sources.
- **TradingView:** real charts.
- **Webull:** a portfolio, screeners and an earnings calendar.
- **A small Bloomberg terminal:** dense, keyboard-first, many panels at once.

This doc covers:

- what is wrong today;
- what we build, in shippable phases;
- where the data comes from and what it costs;
- what we deliberately skip;
- the decisions only you can make.

## 1. Where it stands today

Shipped so far: `b110a02`, `8f7ad81` and `58bf46a`.

| Area | Today | Problem |
|---|---|---|
| Layout | One page: index strip, one stock, a watchlist, financials, two news lists, and a chat on the right | It is a single stock card, not a product. There is nowhere to go. |
| Chart | Recharts area chart, 7 ranges | No candles, volume, crosshair readout, comparison or indicators. It looks like a widget, not a chart. |
| Financials | Annual revenue and net income bars | No quarterly data, statements, margins, ratios, EPS or cash flow. |
| News | Google News RSS search on the company name | Mixed with junk results ("Apple Overview · CME Group", "Apple Share Price & Chart"). There is no ticker-level feed. |
| Market overview | 4 US indices | No movers, sectors, heatmap, market hours, rates curve, commodities or FX. |
| Discovery | Type a ticker | No screener, earnings calendar or "what's moving". |
| Your money | A watchlist of tickers | No holdings, gains and losses, allocation, alerts or paper trading. |
| Chat | Sees the open stock and can use market, filings and news tools; draws inline charts | Read-only. It can't drive the page (open a ticker, change range, add to watchlist). There are no briefs and no scheduled reports. |
| Speed | Each card fetches on its own; nothing is cached on the backend | Slow when switching tickers. Yahoo rate limits will bite as usage grows. |
| Panel | Fixed width, white slab over wallpapers, crammed empty state | **Fixed in `58bf46a`:** resizable, transparent, centered empty state with a full-size input. |

## 2. What it should be

**One line:** a markets desk that explains itself. You see the market the way a trader does, and you can ask about anything on screen in plain words.

How each reference maps onto zWork:

| From | We take | We leave |
|---|---|---|
| Perplexity Finance | Cited answers, the earnings view, side-by-side company comparisons, the market summary | Licensed data (FactSet, transcripts), crypto (for now) |
| TradingView | Candles, volume, crosshair, compare overlays, a few indicators, heatmaps | Pine Script, the social feed, 100+ indicators, drawing tools (until much later) |
| Webull | Watchlists with live rows, screeners, earnings calendar, analyst ratings, paper trading | Real trading, Level 2, options flow |
| Bloomberg | Command bar, keyboard-first moves, a dense multi-panel layout, everything in one place | Mnemonics nobody can learn (`FA`, `DES`, `GP`). Plain English goes in the command bar instead. |

### It has to stay zWork

`docs/POSITIONING.md` puts zWork's wedge at recurring office paperwork for non-technical people. A Bloomberg clone for pros pulls away from that. Finance earns its place when it uses what only zWork has:

1. **Recurring jobs:** "Every weekday at 8am, brief me on my watchlist." The brief lands in the Inbox. Nobody in the reference set does this well for free.
2. **Documents:** "Write a 2-page brief on Nvidia's last quarter" produces a .docx in your folder, with charts and sources.
3. **Your files:** a broker CSV export turns into a portfolio with no account linking, so nothing leaves the computer.
4. **Plain words:** every number has a "what does this mean?" one click away.

Recommendation: build Finance as the best showcase of the agent, not as a separate trading product. That decides most of the cuts in section 6.

## 3. Information architecture

Finance becomes a section with its own sub-navigation. The chat stays docked on the right across all sub-views, and it knows which view and ticker are open.

```
Finance
├── Markets      overview: indices, movers, sector heatmap, rates, calendar today, top news
├── Stock        one ticker, with tabs:
│     Overview · Chart · Financials · Earnings · Filings · News · Ownership
├── Compare      2–5 tickers: overlaid chart and side-by-side metrics
├── Screener     filters → sortable table → open or watch
├── Calendar     earnings (by day, your watchlist first) and economic releases
└── Portfolio    holdings (manual or CSV), gains and losses, allocation, paper trading
```

The **command bar** (`/` or ⌘K inside Finance) takes plain English and tickers:

- `aapl` opens Apple;
- `aapl vs msft` opens Compare;
- `earnings this week` opens the Calendar;
- `tech under 20 pe` opens the Screener with those filters;
- anything else goes to the chat as a question.

### Wireframes

Markets (comfortable density):

```
┌────────────────────────────────────────────────────────────┬──────────────────────┐
│ Finance   Markets  Stock  Compare  Screener  Calendar  Portf│ Ask zWork about      │
│ [ / Search or ask… ]                    Market open · 2:41pm│ the market           │
├────────────────────────────────────────────────────────────┤                      │
│ S&P 500 ▁▂▃  Nasdaq ▁▂▃  Dow ▁▂▃  Russell ▁▂▃  10Y ▁▂▃  Oil│  (chat, resizable)   │
├───────────────────────────────┬────────────────────────────┤                      │
│ Sector heatmap (S&P 500)      │ Movers  Gainers|Losers|Vol │                      │
│ ┌────────┬─────┬───┐          │ NVDA  125.53  -14.0%       │                      │
│ │ Tech   │Fin  │HC │          │ ...                        │                      │
│ └────────┴─────┴───┘          │                            │                      │
├───────────────────────────────┼────────────────────────────┤                      │
│ Today: earnings + releases    │ Top stories (deduped)      │                      │
└───────────────────────────────┴────────────────────────────┴──────────────────────┘
```

Stock, Chart tab:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Apple Inc.  AAPL   342.56  -6.65 (-1.90%)   ☆ Watch   ⇄ Compare      │
│ Overview  Chart  Financials  Earnings  Filings  News  Ownership      │
├─────────────────────────────────────────────────────────────────────┤
│ 1D 5D 1M 6M YTD 1Y 5Y MAX   Candles|Line   + Compare   Indicators ▾  │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │  candles + crosshair readout (O H L C V at cursor)              │ │
│ │                                                                 │ │
│ ├─────────────────────────────────────────────────────────────────┤ │
│ │  volume bars                                                    │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│ Prev close · Day range · 52w range · Volume · Mkt cap · P/E · Yield │
└─────────────────────────────────────────────────────────────────────┘
```

Terminal density is a toggle, not a separate app. It shows the same panels in a fixed 2×3 grid with 28px rows and smaller type, and every panel stays keyboard reachable:

```
┌ Watchlist ─────┬ Chart: AAPL ───────────────┬ News ───────────┐
├ Movers ────────┼ Financials ───────────────┼ Calendar ────────┤
└────────────────┴───────────────────────────┴─────────────────┘
```

## 4. Features, by phase

Each phase ships on its own and is worth a release.

### Phase 1: Foundations (≈4–5 days)

The current page is shallow mostly because of the plumbing, so fix that first.

- **Backend data layer** (`sidecar-rust/src/finance/`):
  - one module per provider;
  - an in-memory TTL cache (quotes 60s, charts 5m, fundamentals 24h, filings 6h);
  - per-host rate limits;
  - a fallback chain, Yahoo → Stooq for prices;
  - a single batched `/api/finance/snapshot?symbols=` call for the page.
- **Real chart:**
  - swap Recharts for TradingView **Lightweight Charts** (Apache-2.0, free, about 45 KB) for price charts. Keep Recharts for the financials bars.
  - candles or line, a volume pane, a crosshair with an OHLCV readout, a MAX range, a compare overlay in % change, and a "previous close" line on 1D.
- **Stock page tabs:** Overview, Chart, Financials, News. The existing cards move into them.
- **News quality:**
  - use Yahoo's per-ticker news first, with Google News as the fallback;
  - drop titles that are just the company name or a quote-page title;
  - dedupe by normalized headline;
  - show the source's favicon.
- **Market hours** status pill, and a "delayed 15 min" note on every price.
- Sub-navigation shell plus the `/` command bar (tickers and "vs" only at first).

**Done when** opening a ticker takes under 300ms from cache, the chart has candles, volume and crosshair, and the news list has no junk rows.

### Phase 2: Markets overview (≈3–4 days)

- **Index strip:** S&P, Nasdaq, Dow, Russell 2000, VIX, 10Y, oil, gold, EUR/USD and DXY. The strip scrolls when narrow.
- **Sector heatmap:** S&P 500 tiles sized by market cap and colored by today's move. Click a sector to filter, click a tile to open the stock.
  - Constituents come from a bundled list refreshed monthly.
  - Market cap = price × SEC `EntityCommonStockSharesOutstanding`, so it stays free.
- **Movers:** gainers, losers and most active, computed from the same S&P 500 batch. No unofficial screener endpoint is needed.
- **Today:** the next earnings reports and economic releases (from the Calendar data).
- **Top stories:** deduped market news with one-line summaries. The summaries are generated lazily and cached.

### Phase 3: Research depth (≈5–6 days)

- **Financials tab:**
  - income statement, balance sheet and cash flow, annual and quarterly, from EDGAR `companyfacts`;
  - margins, growth and per-share values computed by us;
  - each chart has "Explain this" (sends the series to chat).
- **Earnings tab:**
  - EPS and revenue, actual vs estimate, for the last 8 quarters (Finnhub free tier);
  - the next date;
  - the 8-K press release (exhibit 99.1) with an AI summary.
- **Filings tab:**
  - the 10-K, 10-Q and 8-K list;
  - the reader opens a filing and jumps to sections: Risk Factors, MD&A, Segments;
  - "Summarize what changed since last year" is a chat action.
- **Ownership tab:** insider buys and sells (SEC Form 4) and top institutions (13F). Both are free from EDGAR.
- **Overview tab:** the business description, analyst consensus (Finnhub recommendation trends), key stats and peers.
- **Compare view:** an overlaid % chart plus a side-by-side metrics table for 2–5 tickers.

### Phase 4: The chat drives the desk (≈3–4 days)

This is where the Perplexity part becomes better than Perplexity.

- **Page actions as tools:** `open_ticker`, `set_chart`, `add_compare`, `add_to_watchlist` and `open_screener(filters)`. "Show me Apple against Microsoft over 5 years" changes the chart itself, not just the chat.
- **Grounded answers:** every number cites its source, such as an SEC filing link, the quote time or a news link. The "research, not advice" line stays in the finance crew prompt.
- **Briefs as documents:** "Write a brief on NVDA's quarter" produces a .docx or PDF in the workspace, with charts embedded. This reuses the existing document tools.
- **Scheduled briefs:** a "Morning brief" button on the watchlist creates a schedule. The result goes to the Inbox and needs Pro for daily runs. This uses the existing scheduler.
- **Alerts:** "tell me if AAPL drops below 330" creates a price check on the scheduler and sends a desktop notification. Checks run every 15 min while the app is open, and the app says so.

### Phase 5: Portfolio and paper trading (≈4–5 days)

- **Holdings:**
  - manual entry or CSV import, with column mapping for Fidelity, Schwab, Robinhood and Webull exports;
  - stored locally in `ZWORK_HOME/finance/portfolio.json`, never uploaded.
- **Gains and losses:** today's and total P&L per holding and in total, allocation by sector, a dividends list, and portfolio value over time compared with the S&P 500.
- **Paper trading:**
  - a practice account with a $100k play balance;
  - market and limit orders filled at the delayed price;
  - order history, labeled "Practice" everywhere.
  - Webull's most loved feature, and safe: no real money, no broker.
- **The chat sees holdings** when you are on Portfolio, for questions like "how concentrated am I in tech?".

### Phase 6: Screener and terminal mode (≈4 days)

- **Screener:**
  - filters for sector, market cap, P/E, dividend yield, 1-day/1-month/YTD change, revenue growth, margin and "reports earnings this week";
  - runs over a nightly-built S&P 500 + Nasdaq-100 table, cached locally;
  - saved screens;
  - "describe your screen in words" through the chat.
- **Terminal density:** the toggle plus the fixed grid layout from section 3. Arrow keys move between panels, Enter opens, Esc goes back.
- **Indicators:** SMA, EMA, RSI, MACD and Bollinger, computed client-side with about 100 lines of our own code. No new dependency.

### Later, only if people use it

- Drawing tools (trendlines, levels).
- Non-US exchanges.
- Crypto, using the CoinGecko keyless API once you say yes.
- A pinned always-on-top watchlist window.
- Earnings call audio summaries, if a free transcript source appears.

## 5. Data sources and costs

All of these are free at our scale. Check each provider's current terms before building on it, because free tiers change.

| Need | Source | Cost / limit | Risk |
|---|---|---|---|
| Quotes, charts, search, ticker news | Yahoo Finance (unofficial endpoints, in use now) | Free, no key | Unofficial: may break or block. Mitigated by cache plus Stooq fallback. |
| Daily price fallback | Stooq CSV | Free, no key | End of day only |
| Statements, filings, insiders, 13F, shares outstanding | SEC EDGAR JSON (in use now) | Free; 10 req/s with a User-Agent | US companies only |
| Earnings estimates and surprises, calendar, analyst ratings, company news | Finnhub free tier | Free key; about 60 calls/min | One key shared by all users. Proxy it through the zWork API to keep it private and cache it. |
| Rates, CPI, jobs, economic release dates | FRED | Free key; generous | No consensus forecasts (those are licensed) |
| Price charts | TradingView Lightweight Charts | Apache-2.0; requires a visible TradingView attribution | None |
| Market news fallback | Google News RSS (in use now) | Free | Noisy, so filter it (Phase 1) |

**Paid option**, if you'd rather not rely on unofficial Yahoo endpoints: Financial Modeling Prep or Polygon (Massive) cost about $20–30/month for an official quotes, fundamentals and calendar API. Proxy it through the zWork API so the key stays on our server. Real-time (not delayed) quotes need exchange licensing on top, so stay on 15-minute delayed data.

## 6. Deliberately not doing

- **Real trading or broker linking.** It is regulated and needs Plaid or broker APIs and compliance work, and it pulls the product away from its audience. Paper trading covers the "practice" urge.
- **Real-time quotes, Level 2, options flow.** These all need exchange or licensed data.
- **Live earnings call transcripts.** Licensed (Quartr, FactSet). We use 8-K press releases instead.
- **Crypto.** Not until you say so.
- **Personal advice.** No "buy" or "sell" calls. The chat explains, compares and summarizes, and the disclaimer stays visible on the empty chat.

## 7. Design direction

Follows `design.md` and the frontend-design guidance.

- **Numbers are the hero.** Use tabular figures everywhere, right-aligned in tables, with price and change always paired. Up and down colors (`--success`, `--error`) are the only color on the page. Everything else stays ink on paper, so the eye goes to what moved.
- **Two densities, one design.**
  - Comfortable: today's spacing.
  - Terminal: 28px rows, 12px type, hairline panel borders instead of rounded cards, and no card shadows.
  - Same tokens, same components, a single `data-density` switch.
- **No widget soup.** Panels have a title and content only. Charts have no gradient fills, except a faint one under the 1D line. No decorative icons on cards.
- **The chat belongs to the page.** It has no background of its own (done), a resizable edge (done), and a centered serif prompt when empty (done). When the chat changes the page (Phase 4), the panel it changed flashes once, using the existing `setting-flash` pattern, so you can see what moved.
- **Keyboard first, mouse friendly.** `/` opens the command bar, `j`/`k` move in lists, `1`–`7` pick the chart range, and `w` toggles watch. Every control is still clickable with a visible focus ring.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Yahoo blocks or changes endpoints | Cache, Stooq fallback, and the paid-API option above ready to switch on |
| Finance drifts from the paperwork positioning | Phase 4 (briefs, scheduled reports) comes before the trader features in Phases 5–6, so the zWork-only parts land first |
| Chat token cost: big tables inflate context and quota | Tools return compact summaries plus a chart spec, not raw JSON. Full statements load only when asked. |
| Legal: users read answers as advice | Disclaimer, no buy/sell language in the prompt, "Practice" labels on paper trading |
| Performance with 500-tile heatmaps and many sparklines | Plain SVG or canvas, one batched fetch, no per-tile React state |

## 9. Decisions for you

1. **Order.** The proposal is 1 → 2 → 3 → 4 → 5 → 6, about 4–5 weeks of work in total. Phase 4 could move ahead of Phase 3 if you want the "zWork-only" story sooner.
2. **Data.** Stay free (Yahoo, EDGAR, Finnhub, FRED) or pay about $25/month for an official API from day one?
3. **Paper trading:** in or out?
4. **Pro gating.** Should scheduled briefs, alerts and the screener be Pro-only? The recommendation is to gate scheduled briefs and alerts (they cost model runs) and leave everything on screen free.
5. **Positioning.** Is Finance a showcase inside zWork (recommended) or a second product with its own landing page?
