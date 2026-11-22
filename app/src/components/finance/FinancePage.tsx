/**
 * Finance: a market dashboard with its own zWork chat beside it.
 * Data comes from the sidecar's /api/finance/* (Yahoo prices, SEC EDGAR
 * filings, Google News). The chat runs as the built-in "finance" crew member,
 * which always has the market, filings and news tools loaded.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Loader2, Plus, SquarePen, X } from "lucide-react";
import {
  api,
  type FinanceChart,
  type FinanceFinancials,
  type FinanceNewsItem,
  type FinanceQuote,
  type FinanceSearchHit,
} from "../../lib/api";
import { useApp } from "../../lib/store";
import { cn } from "../../lib/cn";
import { Segmented } from "../page/Page";
import { ChatInput } from "../ChatInput";
import { axisProps, compact, tooltipStyle } from "./ChartBlock";

const ChatView = lazy(() => import("../ChatView").then((m) => ({ default: m.ChatView })));

const FINANCE = "finance";
const MARKETS = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "Nasdaq" },
  { symbol: "^DJI", label: "Dow" },
  { symbol: "^TNX", label: "10-yr yield" },
];
const RANGES = [
  { value: "1d", label: "1D" },
  { value: "5d", label: "5D" },
  { value: "1mo", label: "1M" },
  { value: "6mo", label: "6M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "5y", label: "5Y" },
] as const;
type Range = (typeof RANGES)[number]["value"];

const up = "rgb(var(--success))";
const down = "rgb(var(--error))";

function price(n: number | null | undefined) {
  return n == null ? "–" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Change({ q, className }: { q: Pick<FinanceQuote, "change" | "changePct">; className?: string }) {
  if (q.changePct == null) return <span className={cn("text-ink-faint", className)}>–</span>;
  const pos = q.changePct >= 0;
  return (
    <span className={cn("tabular-nums", className)} style={{ color: pos ? up : down }}>
      {q.change != null && `${pos ? "+" : ""}${price(q.change)} `}
      {q.change != null ? `(${pos ? "+" : ""}${q.changePct.toFixed(2)}%)` : `${pos ? "+" : ""}${q.changePct.toFixed(2)}%`}
    </span>
  );
}

/** A tiny line of today's closes; plain SVG so rows stay cheap. */
function Sparkline({ points, positive }: { points?: number[]; positive: boolean }) {
  if (!points || points.length < 2) return <span className="inline-block h-6 w-16" />;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const d = points.map((p, i) => `${((i / (points.length - 1)) * 64).toFixed(1)},${(22 - ((p - min) / span) * 20).toFixed(1)}`).join(" ");
  return (
    <svg width="64" height="24" viewBox="0 0 64 24" aria-hidden="true" className="shrink-0">
      <polyline points={d} fill="none" stroke={positive ? up : down} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function Card({ title, action, children, className }: { title?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border border-line bg-paper-raised p-4", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-[13px] font-semibold text-ink">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function Spinner() {
  return (
    <div className="flex h-24 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-ink-faint" />
    </div>
  );
}

function timeAgo(sec: number | null) {
  if (!sec) return "";
  const m = Math.round((Date.now() / 1000 - sec) / 60);
  if (m < 60) return `${Math.max(m, 1)}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// ---- Symbol search (adds to the watchlist) ----

function SymbolSearch({ onPick }: { onPick: (hit: FinanceSearchHit) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<FinanceSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (!term) return setHits([]);
    const t = setTimeout(() => {
      api.financeSearch(term).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="relative w-full max-w-[260px]">
      <input
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            onPick(hits[0]);
            setQ("");
            setOpen(false);
          }
        }}
        placeholder="Add a company or ticker"
        aria-label="Add a company or ticker"
        className="h-8 w-full rounded-lg border border-line bg-paper px-3 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
      />
      {open && hits.length > 0 && (
        <ul className="absolute right-0 top-9 z-30 w-[320px] overflow-hidden rounded-xl border border-line bg-paper-raised py-1 shadow-lg">
          {hits.map((h) => (
            <li key={h.symbol}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(h);
                  setQ("");
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-state-hover"
              >
                <span className="w-16 shrink-0 text-[12.5px] font-semibold text-ink">{h.symbol}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted">{h.name}</span>
                <span className="shrink-0 text-[11px] text-ink-faint">{h.exchange}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Price chart for the selected symbol ----

function PriceChart({ chart }: { chart: FinanceChart }) {
  const intraday = chart.range === "1d" || chart.range === "5d";
  const data = chart.points.map((p) => ({ t: p.t * 1000, c: p.c }));
  const first = data[0]?.c ?? 0;
  const last = data[data.length - 1]?.c ?? 0;
  const color = last >= (chart.range === "1d" ? chart.previousClose ?? first : first) ? up : down;
  const fmtTick = (t: number) =>
    new Date(t).toLocaleString(undefined, intraday ? { hour: "numeric", minute: "2-digit" } : chart.range === "5y" ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" });
  return (
    <div className="h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="fin-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.16} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={fmtTick} {...axisProps} minTickGap={40} />
          <YAxis {...axisProps} orientation="right" width={56} domain={["auto", "auto"]} tickFormatter={(v) => compact(Number(v))} />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={{ color: "rgb(var(--ink-muted))" }}
            labelFormatter={(t) => new Date(Number(t)).toLocaleString(undefined, intraday ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { dateStyle: "medium" })}
            formatter={(v) => [price(Number(v)), chart.symbol]}
          />
          <Area dataKey="c" stroke={color} strokeWidth={1.75} fill="url(#fin-fill)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-ink-faint">{label}</div>
      <div className="text-[13px] tabular-nums text-ink">{value}</div>
    </div>
  );
}

function FinancialsCard({ symbol }: { symbol: string }) {
  const [data, setData] = useState<FinanceFinancials | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true; // a slow answer for the previous symbol must not land on this one
    setData(null);
    setError("");
    api
      .financeFinancials(symbol)
      .then((d) => live && setData(d))
      .catch(() => live && setError("none"));
    return () => {
      live = false;
    };
  }, [symbol]);
  if (error)
    return (
      <Card title="Financials">
        <p className="text-[12.5px] text-ink-muted">Yearly results come from SEC filings, so they show for US-listed companies, not funds or indexes.</p>
      </Card>
    );
  if (!data) return <Card title="Financials"><Spinner /></Card>;
  const rows = data.years.map((y) => ({
    year: String(y.year),
    Revenue: y.revenue != null ? y.revenue / 1e9 : null,
    "Net income": y.netIncome != null ? y.netIncome / 1e9 : null,
  }));
  const last = data.years[data.years.length - 1];
  return (
    <>
      <Card title="Financials" action={<span className="text-[11.5px] text-ink-faint">Fiscal years, US$ billions · SEC</span>}>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="year" {...axisProps} />
              <YAxis {...axisProps} width={44} tickFormatter={(v) => `$${compact(Number(v))}`} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgb(var(--line-soft) / 0.4)" }} formatter={(v) => `$${Number(v).toFixed(1)}B`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Revenue" fill="rgb(var(--ink) / 0.75)" radius={[3, 3, 0, 0]} maxBarSize={28} />
              <Bar dataKey="Net income" fill="rgb(var(--info))" radius={[3, 3, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {last && (
          <div className="mt-3 grid grid-cols-3 gap-3 border-t border-line pt-3">
            <Stat label={`Revenue ${last.year}`} value={last.revenue != null ? `$${compact(last.revenue)}` : "–"} />
            <Stat label="Operating income" value={last.operatingIncome != null ? `$${compact(last.operatingIncome)}` : "–"} />
            <Stat label="EPS (diluted)" value={last.eps != null ? `$${last.eps.toFixed(2)}` : "–"} />
          </div>
        )}
      </Card>
      {data.filings.length > 0 && (
        <Card title="Recent filings">
          <ul className="-mx-2">
            {data.filings.slice(0, 6).map((f) => (
              <li key={f.url}>
                <a href={f.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-state-hover">
                  <span className="w-12 shrink-0 text-[12px] font-semibold text-ink">{f.form}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted">{f.title === f.form ? formDescription(f.form) : f.title}</span>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-ink-faint">{f.date}</span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function formDescription(form: string) {
  return (
    { "10-K": "Annual report", "10-Q": "Quarterly report", "8-K": "Company announcement", "20-F": "Annual report (foreign issuer)", "6-K": "Company announcement (foreign issuer)", "DEF 14A": "Proxy statement" } as Record<string, string>
  )[form] ?? form;
}

function NewsCard({ query, title }: { query: string; title: string }) {
  const [items, setItems] = useState<FinanceNewsItem[] | null>(null);
  useEffect(() => {
    let live = true;
    setItems(null);
    api
      .financeNews(query)
      .then((n) => live && setItems(n))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [query]);
  return (
    <Card title={title}>
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="text-[12.5px] text-ink-muted">No recent headlines.</p>
      ) : (
        <ul className="-mx-2">
          {items.slice(0, 8).map((n) => (
            <li key={n.url}>
              <a href={n.url} target="_blank" rel="noreferrer" className="block rounded-lg px-2 py-2 hover:bg-state-hover">
                <div className="text-[13px] leading-snug text-ink">{n.title}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-faint">
                  {n.source}
                  {n.published ? ` · ${timeAgo(n.published)}` : ""}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- The chat panel ----

function FinanceChat({ symbol, name, isCompany }: { symbol: string; name: string; isCompany: boolean }) {
  const hasChat = useApp((s) => !!s.activeChatId && s.chats[s.activeChatId]?.crewId === FINANCE);
  const startNew = () => useApp.setState({ activeChatId: null, newChatCrewId: FINANCE });
  const short = name.split(/[ ,]/)[0] || symbol;
  const ideas = isCompany
    ? [
        `How did ${short} do in its latest quarter?`,
        `Chart ${symbol}'s revenue and profit over five years`,
        `Compare ${symbol} with its closest competitors`,
        "What moved the market today?",
      ]
    : [
        "What moved the market today?",
        `How has the ${name} done this year?`,
        "Summarize this week's biggest market news",
        "Which big companies report earnings this week?",
      ];
  return (
    // shortcut: breakpoints assume the sidebar is open (280px); container queries would track the real width.
    <aside className="flex w-[320px] min-w-0 min-[1400px]:w-[400px] shrink-0 flex-col border-l border-line bg-paper">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-4">
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">
          {symbol ? `Ask zWork about ${isCompany ? symbol : name}` : "Ask zWork"}
        </span>
        {hasChat && (
          <button
            type="button"
            onClick={startNew}
            className="press ring-focus inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-muted hover:bg-state-hover hover:text-ink"
          >
            <SquarePen className="h-3.5 w-3.5" /> New chat
          </button>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1">
        {hasChat ? (
          <Suspense fallback={<Spinner />}>
            <ChatView embedded />
          </Suspense>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col justify-end gap-3 p-4">
            <p className="text-[13px] leading-relaxed text-ink-muted">
              This chat sees the stock you have open, reads live prices, SEC filings and market news, and draws charts. It gives research, not personal investment advice.
            </p>
            <div className="flex flex-col items-start gap-1.5">
              {ideas.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => void useApp.getState().send(t)}
                  className="press ring-focus rounded-lg border border-line bg-paper-raised px-3 py-1.5 text-left text-[12.5px] text-ink hover:bg-state-hover"
                >
                  {t}
                </button>
              ))}
            </div>
            <ChatInput placeholder="Ask about a stock, a filing or the market" compact />
          </div>
        )}
      </div>
    </aside>
  );
}

// ---- Page ----

export function FinancePage() {
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [quotes, setQuotes] = useState<Record<string, FinanceQuote>>({});
  const [selected, setSelected] = useState("");
  const [range, setRange] = useState<Range>("1d");
  const [chart, setChart] = useState<FinanceChart | null>(null);
  const [chartError, setChartError] = useState("");
  const [loadError, setLoadError] = useState("");

  // The page's chat is the "finance" crew member: resume the latest one, or start fresh.
  useEffect(() => {
    const s = useApp.getState();
    const current = s.activeChatId && s.chats[s.activeChatId]?.crewId === FINANCE;
    useApp.setState({ newChatCrewId: FINANCE });
    if (!current) {
      const latest = s.chatSummaries
        .filter((c) => c.crew_id === FINANCE)
        .sort((a, b) => b.updated_at - a.updated_at)[0];
      if (latest) void s.openChat(latest.id);
      else useApp.setState({ activeChatId: null });
    }
    return () => {
      if (useApp.getState().newChatCrewId === FINANCE) useApp.setState({ newChatCrewId: "" });
    };
  }, []);

  useEffect(() => {
    api
      .getWatchlist()
      .then((r) => {
        setWatchlist(r.watchlist);
        setSelected((s) => s || r.watchlist[0] || "^GSPC");
      })
      .catch(() => {
        setLoadError("zWork couldn't load your watchlist. Check your connection, then reopen Finance.");
        setSelected("^GSPC");
      });
  }, []);

  const allSymbols = useMemo(() => [...MARKETS.map((m) => m.symbol), ...watchlist], [watchlist]);
  const refreshQuotes = useCallback(() => {
    if (!allSymbols.length) return;
    api
      .financeQuotes(allSymbols)
      .then((list) => setQuotes((prev) => ({ ...prev, ...Object.fromEntries(list.map((q) => [q.symbol, q])) })))
      .catch(() => {});
  }, [allSymbols]);
  useEffect(() => {
    refreshQuotes();
    // shortcut: polls every minute while the page is open; prices are ~15 min delayed anyway.
    const t = setInterval(refreshQuotes, 60_000);
    return () => clearInterval(t);
  }, [refreshQuotes]);

  const chartReq = useRef(0);
  useEffect(() => {
    if (!selected) return;
    const id = ++chartReq.current;
    setChart(null);
    setChartError("");
    api
      .financeChart(selected, range)
      .then((c) => id === chartReq.current && setChart(c))
      .catch(() => id === chartReq.current && setChartError("Prices for this symbol aren't available right now."));
  }, [selected, range]);

  const saveWatchlist = (next: string[]) => {
    setWatchlist(next);
    api.setWatchlist(next).then((r) => setWatchlist(r.watchlist)).catch(() => {});
  };
  const add = (hit: FinanceSearchHit) => {
    if (!watchlist.includes(hit.symbol)) saveWatchlist([...watchlist, hit.symbol]);
    setSelected(hit.symbol);
  };
  const remove = (sym: string) => {
    const next = watchlist.filter((s) => s !== sym);
    saveWatchlist(next);
    if (selected === sym) setSelected(next[0] ?? "^GSPC");
  };

  const q = quotes[selected] ?? chart;
  const isCompany = !!selected && !selected.startsWith("^") && (q?.type ?? "EQUITY") === "EQUITY";
  const name = q?.name || selected;

  // Tell the finance chat what's on screen, so "how did it do?" means this stock.
  const focusPrice = q?.price;
  const focusPct = q?.changePct;
  useEffect(() => {
    if (!selected) return;
    const move = focusPrice == null ? "" : `, last price ${focusPrice}${q?.currency ? ` ${q.currency}` : ""}${focusPct == null ? "" : ` (${focusPct >= 0 ? "+" : ""}${focusPct.toFixed(2)}% today)`}`;
    useApp.setState({ financeFocus: `${name} (${selected})${move}, chart showing ${range}` });
  }, [selected, name, focusPrice, focusPct, q?.currency, range]);
  useEffect(() => () => useApp.setState({ financeFocus: "" }), []);

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden bg-paper">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-6 pb-16 pt-2">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[22px] font-semibold tracking-tight text-ink">Finance</h1>
              <p className="mt-0.5 text-[13px] text-ink-muted">Prices are delayed about 15 minutes.</p>
            </div>
            <SymbolSearch onPick={add} />
          </header>

          {loadError && <p className="rounded-lg border border-line bg-paper-sunken px-3 py-2 text-[12.5px] text-ink-muted">{loadError}</p>}

          {/* Market strip */}
          <div className="grid grid-cols-2 gap-2 min-[1200px]:grid-cols-4">
            {MARKETS.map((m) => {
              const mq = quotes[m.symbol];
              return (
                <button
                  key={m.symbol}
                  type="button"
                  onClick={() => setSelected(m.symbol)}
                  className={cn(
                    "press ring-focus flex items-center justify-between gap-2 rounded-xl border bg-paper-raised px-3 py-2.5 text-left transition-colors hover:border-line-strong",
                    selected === m.symbol ? "border-line-strong" : "border-line",
                  )}
                >
                  <div className="min-w-0">
                    <div className="text-[12px] text-ink-muted">{m.label}</div>
                    <div className="text-[14px] font-semibold tabular-nums text-ink">
                      {mq ? (m.symbol === "^TNX" ? `${mq.price?.toFixed(2)}%` : price(mq.price)) : "–"}
                    </div>
                    {mq && <Change q={{ change: null, changePct: mq.changePct }} className="text-[11.5px]" />}
                  </div>
                  <Sparkline points={mq?.points} positive={(mq?.changePct ?? 0) >= 0} />
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 min-[1400px]:grid-cols-[1fr_280px]">
            {/* Selected symbol */}
            <Card>
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-ink-muted">
                    {name} <span className="text-ink-faint">{selected}</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-[26px] font-semibold tracking-tight tabular-nums text-ink">{price(q?.price)}</span>
                    <span className="text-[12px] text-ink-faint">{q?.currency}</span>
                    {q && <Change q={q} className="text-[13px]" />}
                  </div>
                </div>
                <Segmented label="Time range" options={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={range} onChange={setRange} />
              </div>
              {chartError ? <p className="py-16 text-center text-[12.5px] text-ink-muted">{chartError}</p> : chart ? <PriceChart chart={chart} /> : <div className="h-[260px]"><Spinner /></div>}
              {q && (
                <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 min-[1100px]:grid-cols-4">
                  <Stat label="Previous close" value={price(q.previousClose)} />
                  <Stat label="Day range" value={q.dayLow != null ? `${price(q.dayLow)} – ${price(q.dayHigh)}` : "–"} />
                  <Stat label="52-week range" value={q.yearLow != null ? `${price(q.yearLow)} – ${price(q.yearHigh)}` : "–"} />
                  <Stat label="Volume" value={q.volume ? compact(q.volume) : "–"} />
                </div>
              )}
            </Card>

            {/* Watchlist */}
            <Card title="Watchlist" className="self-start">
              {watchlist.length === 0 ? (
                <p className="text-[12.5px] text-ink-muted">Search above to add companies you want to follow.</p>
              ) : (
                <ul className="-mx-2">
                  {watchlist.map((sym) => {
                    const wq = quotes[sym];
                    return (
                      <li key={sym} className="group/row relative">
                        <button
                          type="button"
                          onClick={() => setSelected(sym)}
                          className={cn(
                            "press ring-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-state-hover",
                            selected === sym && "bg-state-selected",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-[12.5px] font-semibold text-ink">{sym}</div>
                            <div className="truncate text-[11.5px] text-ink-faint">{wq?.name ?? ""}</div>
                          </div>
                          <Sparkline points={wq?.points} positive={(wq?.changePct ?? 0) >= 0} />
                          <div className="w-[68px] shrink-0 text-right">
                            <div className="text-[12.5px] tabular-nums text-ink">{price(wq?.price)}</div>
                            {wq && <Change q={{ change: null, changePct: wq.changePct }} className="text-[11px]" />}
                          </div>
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${sym} from watchlist`}
                          title="Remove"
                          onClick={() => remove(sym)}
                          className="absolute -left-1 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-paper text-ink-faint hover:text-ink group-hover/row:flex focus-visible:flex"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {selected && !watchlist.includes(selected) && !selected.startsWith("^") && (
                <button
                  type="button"
                  onClick={() => saveWatchlist([...watchlist, selected])}
                  className="press ring-focus mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink-muted hover:bg-state-hover hover:text-ink"
                >
                  <Plus className="h-3.5 w-3.5" /> Add {selected}
                </button>
              )}
            </Card>
          </div>

          {isCompany ? (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className="flex flex-col gap-4">
                <FinancialsCard symbol={selected} />
              </div>
              <div className="flex flex-col gap-4">
                <NewsCard query={name} title={`${selected} news`} />
                <NewsCard query="" title="Market news" />
              </div>
            </div>
          ) : (
            <NewsCard query="" title="Market news" />
          )}
        </div>
      </div>
      <FinanceChat symbol={selected} name={name} isCompany={isCompany} />
    </div>
  );
}
