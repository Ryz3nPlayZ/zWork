/** One stock (or index): header with price and actions, then tabs. */
import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Bell, ExternalLink, GitCompare, Sparkles, Star } from "lucide-react";
import { api, type FinanceChart, type FinanceProfile, type FinanceStatements } from "../../lib/api";
import { useApp } from "../../lib/store";
import { cn } from "../../lib/cn";
import { Segmented } from "../page/Page";
import { axisProps, compact, tooltipStyle } from "./ChartBlock";
import { CandleChart, INDICATORS, type Indicator } from "./CandleChart";
import { isIndex, RANGES, useFinance, type Range, type StockTab } from "./financeStore";
import { big, Card, Change, Empty, pct, price, Spinner, Stat, timeAgo, tone, useLoad } from "./ui";

const TABS: { value: StockTab; label: string; company?: boolean }[] = [
  { value: "overview", label: "Overview" },
  { value: "chart", label: "Chart" },
  { value: "financials", label: "Financials", company: true },
  { value: "earnings", label: "Earnings", company: true },
  { value: "filings", label: "Filings", company: true },
  { value: "ownership", label: "Ownership", company: true },
  { value: "news", label: "News" },
];

const ask = (text: string) => void useApp.getState().send(text);

/** Loads the chart for the open symbol and range; shared by the header and the chart tabs. */
function useChart(symbol: string, range: Range) {
  return useLoad<FinanceChart>(`${symbol}|${range}`, () => api.financeChart(symbol, range));
}

export function StockView() {
  const { symbol, tab, setTab, range, setRange, watchlist, toggleWatch, setCompare, go } = useFinance();
  const quote = useFinance((s) => s.quotes[symbol]);
  const [chart, chartError] = useChart(symbol, range);
  const q = quote ?? chart;
  const company = !isIndex(symbol) && (q?.type ?? "EQUITY") === "EQUITY";
  const tabs = TABS.filter((t) => company || !t.company);
  const watching = watchlist.includes(symbol);
  // An index or fund has no Financials tab; fall back to Overview if one was remembered.
  const shown = tabs.some((t) => t.value === tab) ? tab : "overview";

  useEffect(() => {
    if (!quote) api.financeQuotes([symbol]).then(useFinance.getState().mergeQuotes).catch(() => {});
  }, [symbol, quote]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="truncate text-[20px] font-semibold tracking-tight text-ink">{q?.name || symbol}</h1>
            <span className="shrink-0 text-[13px] text-ink-faint">{symbol}{q?.exchange ? ` · ${q.exchange}` : ""}</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-[28px] font-semibold tracking-tight tabular-nums text-ink">{price(q?.price)}</span>
            <span className="text-[12px] text-ink-faint">{q?.currency}</span>
            {q && <Change q={q} className="text-[13.5px]" />}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {!isIndex(symbol) && (
            <button type="button" onClick={() => toggleWatch(symbol)} title="Watch (w)" className={cn("press ring-focus inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px]", watching ? "border-line-strong text-ink" : "border-line text-ink-muted hover:text-ink")}>
              <Star className={cn("h-3.5 w-3.5", watching && "fill-current")} /> {watching ? "Watching" : "Watch"}
            </button>
          )}
          <button type="button" onClick={() => { setCompare([symbol]); go("compare"); }} className="press ring-focus inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] text-ink-muted hover:text-ink">
            <GitCompare className="h-3.5 w-3.5" /> Compare
          </button>
          <button type="button" onClick={() => ask(`Alert me when ${symbol} moves 5% from ${price(q?.price)}`)} title="Ask zWork to set a price alert" className="press ring-focus inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] text-ink-muted hover:text-ink">
            <Bell className="h-3.5 w-3.5" /> Alert
          </button>
        </div>
      </header>

      <nav role="tablist" aria-label="Stock sections" className="-mb-1 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.value}
            role="tab"
            type="button"
            aria-selected={shown === t.value}
            onClick={() => setTab(t.value)}
            className={cn("ring-focus -mb-px shrink-0 border-b-2 px-2.5 pb-2 pt-1 text-[13px] transition-colors", shown === t.value ? "border-ink font-medium text-ink" : "border-transparent text-ink-muted hover:text-ink")}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {shown === "overview" && <Overview symbol={symbol} company={company} chart={chart} chartError={chartError} range={range} setRange={setRange} />}
      {shown === "chart" && <ChartTab chart={chart} chartError={chartError} range={range} setRange={setRange} />}
      {shown === "financials" && <Financials symbol={symbol} />}
      {shown === "earnings" && <Earnings symbol={symbol} />}
      {shown === "filings" && <Filings symbol={symbol} />}
      {shown === "ownership" && <Ownership symbol={symbol} />}
      {shown === "news" && <News symbol={symbol} name={q?.name || symbol} max={30} />}
    </div>
  );
}

function RangePicker({ range, setRange }: { range: Range; setRange: (r: Range) => void }) {
  return <Segmented label="Time range" options={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={range} onChange={setRange} />;
}

function Overview({ symbol, company, chart, chartError, range, setRange }: { symbol: string; company: boolean; chart: FinanceChart | null; chartError: string; range: Range; setRange: (r: Range) => void }) {
  const q = useFinance((s) => s.quotes[symbol]) ?? chart;
  const [profile] = useLoad(company ? `p|${symbol}` : "", () => (company ? api.financeProfile(symbol) : Promise.resolve(null)));
  return (
    <div className="grid grid-cols-1 gap-4 [@container(min-width:820px)]:grid-cols-[1fr_300px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card panel="chart" action={<RangePicker range={range} setRange={setRange} />} title="Price">
          {chartError ? <Empty>Prices for this symbol aren't available right now.</Empty> : chart ? <CandleChart chart={chart} kind="line" height={260} /> : <Spinner className="h-[285px]" />}
          {q && (
            <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 [@container(min-width:560px)]:grid-cols-4">
              <Stat label="Previous close" value={price(q.previousClose)} />
              <Stat label="Day range" value={q.dayLow != null ? `${price(q.dayLow)} – ${price(q.dayHigh)}` : "–"} />
              <Stat label="52-week range" value={q.yearLow != null ? `${price(q.yearLow)} – ${price(q.yearHigh)}` : "–"} />
              <Stat label="Volume" value={q.volume ? big(q.volume) : "–"} />
              {profile && (
                <>
                  <Stat label="Market cap" value={big(profile.marketCap, "$")} />
                  <Stat label="Dividend yield" value={profile.yield != null ? pct(profile.yield, false) : "None"} />
                  <Stat label="Sector" value={profile.sector || "–"} title={profile.industry} />
                  <Stat label="Ex-dividend" value={profile.exDividend || "–"} />
                </>
              )}
            </div>
          )}
        </Card>
        {company && profile?.description && (
          <Card title="About">
            <p className="text-[13px] leading-relaxed text-ink-soft">{profile.description}</p>
            {profile.website && (
              <a href={profile.website} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-ink-muted hover:text-ink">
                {profile.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </Card>
        )}
        <News symbol={symbol} name={q?.name || symbol} max={6} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {company && profile && <Analysts a={profile.analysts} last={q?.price ?? null} />}
        {company && <Peers symbol={symbol} sector={profile?.sector} />}
        <Card title="Ask about it">
          <ul className="-mx-2 flex flex-col">
            {(company
              ? [`What's the bull and bear case for ${symbol}?`, `Summarize ${symbol}'s latest earnings call`, `Write a one-page brief on ${symbol} as a Word doc`]
              : [`Why did ${q?.name || symbol} move today?`, "What's on the economic calendar this week?"]
            ).map((t) => (
              <li key={t}>
                <button type="button" onClick={() => ask(t)} className="press ring-focus flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink-muted hover:bg-state-hover hover:text-ink">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Analysts({ a, last }: { a: FinanceProfile["analysts"]; last: number | null }) {
  const total = (a.buy ?? 0) + (a.hold ?? 0) + (a.sell ?? 0);
  if (!a.rating && !a.target && !total) return null;
  const upside = a.target != null && last ? ((a.target - last) / last) * 100 : null;
  return (
    <Card title="Analysts" panel="analysts" action={<span className="text-[11.5px] text-ink-faint">Nasdaq consensus</span>}>
      <div className="flex items-baseline justify-between">
        <span className="text-[16px] font-semibold text-ink">{a.rating ?? "–"}</span>
        {a.target != null && (
          <span className="text-[12.5px] text-ink-muted">
            Target {price(a.target)} {upside != null && <span style={{ color: tone(upside) }}>({pct(upside, true, 1)})</span>}
          </span>
        )}
      </div>
      {total > 0 && (
        <>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-paper-sunken" aria-hidden="true">
            <div style={{ width: `${((a.buy ?? 0) / total) * 100}%`, background: "rgb(var(--success))" }} />
            <div style={{ width: `${((a.hold ?? 0) / total) * 100}%`, background: "rgb(var(--ink-faint))" }} />
            <div style={{ width: `${((a.sell ?? 0) / total) * 100}%`, background: "rgb(var(--error))" }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[11.5px] text-ink-muted">
            <span>{a.buy ?? 0} buy</span>
            <span>{a.hold ?? 0} hold</span>
            <span>{a.sell ?? 0} sell</span>
          </div>
        </>
      )}
      {a.low != null && a.high != null && <p className="mt-2 text-[11.5px] text-ink-faint">Targets range {price(a.low)} – {price(a.high)}</p>}
    </Card>
  );
}
/** Other S&P 500 companies in the same sector, from the screener data, biggest first. */
function Peers({ symbol, sector }: { symbol: string; sector?: string }) {
  const [u] = useLoad("universe", () => api.financeUniverse());
  const open = useFinance((s) => s.open);
  const row = u?.rows.find((r) => r.symbol === symbol);
  const sec = row?.sector || sector;
  const peers = u && sec ? u.rows.filter((r) => r.sector === sec && r.symbol !== symbol).sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, 6) : [];
  if (!peers.length) return null;
  return (
    <Card title="Peers" action={<span className="text-[11.5px] text-ink-faint">{sec}</span>}>
      <ul className="-mx-2">
        {peers.map((p) => (
          <li key={p.symbol}>
            <button type="button" onClick={() => open(p.symbol)} className="press ring-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-state-hover">
              <span className="w-14 shrink-0 text-[12.5px] font-semibold text-ink">{p.symbol}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{p.name}</span>
              <span className="shrink-0 text-[12px] tabular-nums" style={{ color: tone(p.changePct) }}>{pct(p.changePct)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ChartTab({ chart, chartError, range, setRange }: { chart: FinanceChart | null; chartError: string; range: Range; setRange: (r: Range) => void }) {
  const [kind, setKind] = useState<"candle" | "line">("candle");
  const [ind, setInd] = useState<Indicator[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("zwork.financeIndicators") || "[]");
    } catch {
      return [];
    }
  });
  const toggle = (i: Indicator) => {
    const next = ind.includes(i) ? ind.filter((x) => x !== i) : [...ind, i];
    setInd(next);
    try {
      localStorage.setItem("zwork.financeIndicators", JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };
  const intraday = range === "1d" || range === "5d";
  return (
    <Card panel="chart">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Chart type" options={[{ value: "candle", label: "Candles" }, { value: "line", label: "Line" }]} value={intraday ? "line" : kind} onChange={(v) => setKind(v as "candle" | "line")} />
          <div className="flex flex-wrap gap-1" role="group" aria-label="Indicators">
            {INDICATORS.map((i) => (
              <button
                key={i.value}
                type="button"
                aria-pressed={ind.includes(i.value)}
                onClick={() => toggle(i.value)}
                className={cn("press ring-focus h-7 rounded-md border px-2 text-[11.5px]", ind.includes(i.value) ? "border-line-strong bg-state-selected text-ink" : "border-line text-ink-muted hover:text-ink")}
              >
                {i.label}
              </button>
            ))}
          </div>
        </div>
        <RangePicker range={range} setRange={setRange} />
      </div>
      {chartError ? <Empty>Prices for this symbol aren't available right now.</Empty> : chart ? <CandleChart chart={chart} kind={kind} indicators={ind} height={420} /> : <Spinner className="h-[445px]" />}
      <p className="mt-2 text-[11.5px] text-ink-faint">Keys 1–7 change the range. Indicators use the closes in this range, so long averages need a long range.</p>
    </Card>
  );
}

// ---- Financials: income, balance sheet, cash flow from SEC filings ----

function fmtCell(v: number | null, kind: string) {
  if (v == null) return "–";
  if (kind === "pct") return pct(v, false, 1);
  if (kind === "eps") return price(v);
  if (kind === "shares") return big(v);
  return big(v, "$");
}

function Financials({ symbol }: { symbol: string }) {
  const [period, setPeriod] = useState<"annual" | "quarterly">("annual");
  const [data, error] = useLoad<FinanceStatements>(`${symbol}|${period}`, () => api.financeStatements(symbol, period));
  if (error) return <Card><Empty>Statements come from SEC filings, so they show for US-listed companies, not funds or indexes.</Empty></Card>;
  if (!data) return <Card><Spinner /></Card>;
  const income = data.sections[0];
  const pick = (label: string) => income?.rows.find((r) => r.label === label)?.values ?? [];
  const rev = pick("Revenue");
  const ni = pick("Net income");
  const bars = data.periods.map((p, i) => ({ p, Revenue: rev[i] != null ? (rev[i] as number) / 1e9 : null, "Net income": ni[i] != null ? (ni[i] as number) / 1e9 : null }));
  return (
    <div className="flex flex-col gap-4">
      <Card
        panel="financials"
        title="Revenue and profit"
        action={<Segmented label="Period" options={[{ value: "annual", label: "Annual" }, { value: "quarterly", label: "Quarterly" }]} value={period} onChange={(v) => setPeriod(v as "annual" | "quarterly")} />}
      >
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bars} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="p" {...axisProps} />
              <YAxis {...axisProps} width={48} tickFormatter={(v) => `$${compact(Number(v))}B`} domain={[(m: number) => Math.min(0, m), "auto"]} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgb(var(--line-soft) / 0.4)" }} formatter={(v) => `$${Number(v).toFixed(2)}B`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Revenue" fill="rgb(var(--ink) / 0.75)" radius={[3, 3, 0, 0]} maxBarSize={28} />
              <Bar dataKey="Net income" fill="rgb(var(--info))" radius={[3, 3, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      {data.sections.map((sec) => (
        <Card key={sec.title} title={sec.title} action={<span className="text-[11.5px] text-ink-faint">US$ · SEC filings</span>}>
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="fin-table w-full min-w-[520px] text-[12.5px] tabular-nums">
              <thead>
                <tr className="text-ink-faint">
                  <th className="py-1 text-left font-normal" />
                  {data.periods.map((p) => (
                    <th key={p} className="py-1 pl-3 text-right font-normal">{p}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sec.rows.map((r) => (
                  <tr key={r.label} className="border-t border-line-soft">
                    <td className={cn("py-1.5 pr-3 text-left", r.kind === "pct" ? "text-ink-muted" : "text-ink")}>{r.label}</td>
                    {r.values.map((v, i) => (
                      <td key={i} className={cn("py-1.5 pl-3 text-right", r.kind === "pct" ? "text-ink-muted" : "text-ink")}>{fmtCell(v, r.kind)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Earnings({ symbol }: { symbol: string }) {
  const [e, error] = useLoad(`e|${symbol}`, () => api.financeEarnings(symbol));
  if (error) return <Card><Empty>Earnings history isn't available for {symbol}.</Empty></Card>;
  if (!e) return <Card><Spinner /></Card>;
  const rows = [...e.quarters].reverse().map((q) => ({ q: q.quarter, Actual: q.eps, Estimate: q.estimate }));
  return (
    <div className="grid grid-cols-1 gap-4 [@container(min-width:820px)]:grid-cols-[1fr_300px]">
      <Card panel="earnings" title="Earnings per share" action={<span className="text-[11.5px] text-ink-faint">Actual vs. analyst estimate</span>}>
        {rows.length === 0 ? (
          <Empty>No reported quarters yet.</Empty>
        ) : (
          <>
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="q" {...axisProps} />
                  <YAxis {...axisProps} width={40} tickFormatter={(v) => `$${Number(v).toFixed(2)}`} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgb(var(--line-soft) / 0.4)" }} formatter={(v) => `$${Number(v).toFixed(2)}`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Estimate" fill="rgb(var(--ink-faint) / 0.6)" radius={[3, 3, 0, 0]} maxBarSize={22} />
                  <Bar dataKey="Actual" fill="rgb(var(--info))" radius={[3, 3, 0, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <table className="fin-table mt-3 w-full text-[12.5px] tabular-nums">
              <thead>
                <tr className="text-ink-faint">
                  <th className="py-1 text-left font-normal">Quarter</th>
                  <th className="py-1 text-left font-normal">Reported</th>
                  <th className="py-1 text-right font-normal">EPS</th>
                  <th className="py-1 text-right font-normal">Estimate</th>
                  <th className="py-1 text-right font-normal">Surprise</th>
                </tr>
              </thead>
              <tbody>
                {e.quarters.map((q) => (
                  <tr key={q.quarter} className="border-t border-line-soft">
                    <td className="py-1.5 text-ink">{q.quarter}</td>
                    <td className="py-1.5 text-ink-muted">{q.date}</td>
                    <td className="py-1.5 text-right text-ink">{price(q.eps)}</td>
                    <td className="py-1.5 text-right text-ink-muted">{price(q.estimate)}</td>
                    <td className="py-1.5 text-right" style={{ color: tone(q.surprisePct) }}>{pct(q.surprisePct, true, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
      <div className="flex flex-col gap-4">
        <Card title="Next report">
          <p className="text-[15px] font-semibold text-ink">{e.next || "Not announced"}</p>
          <p className="mt-1 text-[12px] text-ink-muted">Date from Nasdaq. Companies sometimes move it.</p>
        </Card>
        {e.release && (
          <Card title="Latest results">
            <p className="text-[12.5px] text-ink-muted">Press release filed with the SEC on {e.release.date}.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={e.release.url} target="_blank" rel="noreferrer" className="press ring-focus inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] text-ink-muted hover:text-ink">
                Read release <ExternalLink className="h-3 w-3" />
              </a>
              <button type="button" onClick={() => ask(`Read ${symbol}'s latest earnings press release (${e.release!.url}) and summarize it: headline numbers vs. estimates, guidance, and what changed. Cite the release.`)} className="press ring-focus inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-2.5 text-[12.5px] text-paper">
                <Sparkles className="h-3.5 w-3.5" /> Summarize with zWork
              </button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

export function formDescription(form: string) {
  return (
    {
      "10-K": "Annual report", "10-Q": "Quarterly report", "8-K": "Company announcement", "20-F": "Annual report (foreign issuer)",
      "6-K": "Company announcement (foreign issuer)", "DEF 14A": "Proxy statement", "4": "Insider trade", "S-1": "Registration", "SC 13G": "Big shareholder stake", "SC 13D": "Activist stake",
    } as Record<string, string>
  )[form] ?? form;
}

const ITEM_NAMES: Record<string, string> = { "2.02": "Results", "5.02": "Leadership change", "7.01": "Regulation FD", "8.01": "Other events", "1.01": "Major agreement", "5.07": "Shareholder vote", "2.05": "Restructuring", "1.05": "Cybersecurity incident" };

function Filings({ symbol }: { symbol: string }) {
  const [list, error] = useLoad(`f|${symbol}`, () => api.financeFilings(symbol));
  const [form, setForm] = useState("All");
  if (error) return <Card><Empty>Filings come from SEC EDGAR, so they show for US-listed companies.</Empty></Card>;
  if (!list) return <Card><Spinner /></Card>;
  const forms = ["All", ...new Set(list.map((f) => f.form))].slice(0, 8);
  const shown = form === "All" ? list : list.filter((f) => f.form === form);
  return (
    <Card panel="filings" title="SEC filings" action={<Segmented label="Form" options={forms.map((f) => ({ value: f, label: f }))} value={form} onChange={setForm} />}>
      <ul className="-mx-2">
        {shown.map((f) => (
          <li key={f.url} className="group/f flex items-center gap-2 rounded-lg px-2 hover:bg-state-hover">
            <a href={f.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-3 py-1.5">
              <span className="w-14 shrink-0 text-[12px] font-semibold text-ink">{f.form}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted">
                {formDescription(f.form)}
                {f.items && <span className="text-ink-faint"> · {f.items.split(",").map((i) => ITEM_NAMES[i.trim()] ?? i.trim()).join(", ")}</span>}
              </span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-ink-faint">{f.date}</span>
            </a>
            <button type="button" onClick={() => ask(`Read this ${symbol} ${f.form} from ${f.date} (${f.url}) and tell me what matters in it, with quotes.`)} title="Ask zWork to read it" aria-label={`Ask zWork to read the ${f.form} from ${f.date}`} className="ring-focus hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint hover:text-ink group-hover/f:flex focus-visible:flex">
              <Sparkles className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Ownership({ symbol }: { symbol: string }) {
  const [o, error] = useLoad(`o|${symbol}`, () => api.financeOwnership(symbol));
  if (error) return <Card><Empty>Ownership data isn't available for {symbol}.</Empty></Card>;
  if (!o) return <Card><Spinner /></Card>;
  return (
    <div className="grid grid-cols-1 gap-4 [@container(min-width:820px)]:grid-cols-2">
      <Card panel="insiders" title="Insider trades" action={<span className="text-[11.5px] text-ink-faint">SEC Form 4</span>}>
        {o.insiders.length === 0 ? (
          <Empty>No recent insider trades.</Empty>
        ) : (
          <ul className="-mx-2">
            {o.insiders.slice(0, 14).map((t, i) => {
              const sell = /sell|sale|disposition/i.test(t.type);
              return (
                <li key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-ink">{t.name}</div>
                    <div className="truncate text-[11.5px] text-ink-faint">{t.role} · {t.date}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[12.5px] tabular-nums" style={{ color: sell ? "rgb(var(--error))" : "rgb(var(--success))" }}>
                      {sell ? "Sold" : /buy|purchase/i.test(t.type) ? "Bought" : t.type} {big(t.shares)}
                    </div>
                    {t.price != null && t.shares != null && <div className="text-[11.5px] tabular-nums text-ink-faint">{big(t.price * t.shares, "$")} at {price(t.price)}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Largest institutional holders" action={o.institutionalPct != null && <span className="text-[11.5px] text-ink-faint">{pct(o.institutionalPct, false, 1)} held by institutions</span>}>
        {o.holders.length === 0 ? (
          <Empty>No institutional filings found.</Empty>
        ) : (
          <ul className="-mx-2">
            {o.holders.slice(0, 14).map((h) => (
              <li key={h.name} className="flex items-center gap-2 px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-ink">{h.name}</div>
                  <div className="text-[11.5px] text-ink-faint">{big(h.shares)} shares · {h.date}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[12.5px] tabular-nums text-ink">{big(h.value, "$")}</div>
                  {h.changePct != null && <div className="text-[11.5px] tabular-nums" style={{ color: tone(h.changePct) }}>{pct(h.changePct, true, 1)}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function News({ symbol, name, max, title }: { symbol: string; name: string; max: number; title?: string }) {
  const [items] = useLoad(`n|${symbol}|${name}`, () => api.financeNews(name === symbol ? "" : name, symbol));
  return (
    <Card panel="news" title={title ?? `${symbol.startsWith("^") ? name : symbol} news`}>
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty>No recent headlines.</Empty>
      ) : (
        <ul className="-mx-2">
          {items.slice(0, max).map((n) => (
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
