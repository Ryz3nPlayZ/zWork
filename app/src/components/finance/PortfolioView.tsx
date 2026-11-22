/**
 * Your portfolio (entered by hand or imported from a broker CSV) and a practice
 * account with pretend money. Also price alerts and the morning brief schedule.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Pencil, Plus, Sparkles, Sunrise, Trash2, Upload, X } from "lucide-react";
import { api, type FinanceAlert, type FinanceChart, type FinanceHolding, type FinanceOrder, type FinancePractice, type ScheduledTask } from "../../lib/api";
import { useApp } from "../../lib/store";
import { cn } from "../../lib/cn";
import { Segmented } from "../page/Page";
import { CandleChart } from "./CandleChart";
import { parseBrokerCsv } from "./csv";
import { useFinance } from "./financeStore";
import { FINANCE } from "./FinanceChat";
import { Card, Empty, pct, price, Spinner, Stat, timeAgo, tone, useLoad } from "./ui";

const BRIEF_TITLE = "Morning market brief";
const BRIEF_PROMPT =
  "Write my morning market brief. Cover: how futures and the major indexes are set up, what moved overnight and why, my holdings and watchlist (call get_portfolio and use market data), any of my companies reporting earnings this week, today's economic releases, and the 3 headlines that matter most. Keep it under 300 words with short sections.";
const field = "h-8 min-w-0 rounded-lg border border-line bg-paper px-2 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none";
const btn = "press ring-focus inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px]";

/** Keep quotes fresh for these symbols while the view is open. */
function useQuotes(symbols: string[]) {
  const key = [...new Set(symbols)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    const refresh = () => {
      for (let i = 0; i < list.length; i += 20) api.financeQuotes(list.slice(i, i + 20)).then(useFinance.getState().mergeQuotes).catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [key]);
  return useFinance((s) => s.quotes);
}

/** Today's holdings valued over the past year, so the line shows how this mix would have done. */
function holdingsChart(holdings: FinanceHolding[], charts: (FinanceChart | null)[]): FinanceChart | null {
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const series = holdings.map((h, i) => ({ h, by: new Map((charts[i]?.points ?? []).map((p) => [day(p.t), p])) }));
  if (series.some((s) => s.by.size === 0)) return null;
  const dates = [...series[0].by.keys()].filter((d) => series.every((s) => s.by.has(d))).sort();
  if (dates.length < 2) return null;
  const points = dates.map((d) => {
    const sum = (k: "o" | "h" | "l" | "c") => series.reduce((t, s) => t + s.by.get(d)![k] * s.h.shares, 0);
    const c = sum("c");
    return { t: series[0].by.get(d)!.t, o: c, h: c, l: c, c, v: 0 };
  });
  const last = points[points.length - 1].c;
  return { symbol: "Your holdings", name: "Your holdings", range: "1y", points, price: last, previousClose: points[points.length - 2].c, change: null, changePct: null };
}

function Summary({ value, dayChange, cost, label }: { value: number; dayChange: number; cost: number | null; label?: React.ReactNode }) {
  const gain = cost ? value - cost : null;
  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
      <div>
        <div className="flex items-center gap-2 text-[12px] text-ink-faint">Value {label}</div>
        <div className="text-[28px] font-semibold tabular-nums tracking-tight text-ink">{price(value)}</div>
      </div>
      <Stat label="Today" value={<span style={{ color: tone(dayChange) }}>{dayChange >= 0 ? "+" : "−"}{price(Math.abs(dayChange))} ({pct(value - dayChange ? (dayChange / (value - dayChange)) * 100 : 0)})</span>} />
      {gain != null && cost != null && <Stat label="Total gain" value={<span style={{ color: tone(gain) }}>{gain >= 0 ? "+" : "−"}{price(Math.abs(gain))} ({pct((gain / cost) * 100)})</span>} />}
    </div>
  );
}

function HoldingsTable({ holdings, quotes, onRemove }: { holdings: FinanceHolding[]; quotes: ReturnType<typeof useQuotes>; onRemove?: (s: string) => void }) {
  const open = useFinance((s) => s.open);
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="fin-table w-full min-w-[620px] text-[12.5px] tabular-nums">
        <thead>
          <tr className="text-ink-faint">
            <th className="py-1 text-left font-normal">Symbol</th>
            <th className="py-1 text-right font-normal">Shares</th>
            <th className="py-1 text-right font-normal">Avg cost</th>
            <th className="py-1 text-right font-normal">Price</th>
            <th className="py-1 text-right font-normal">Today</th>
            <th className="py-1 text-right font-normal">Value</th>
            <th className="py-1 text-right font-normal">Gain</th>
            {onRemove && <th className="w-8" />}
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => {
            const q = quotes[h.symbol];
            const v = q?.price != null ? q.price * h.shares : null;
            const g = v != null && h.cost != null ? v - h.cost * h.shares : null;
            return (
              <tr key={h.symbol} className="border-t border-line-soft hover:bg-state-hover">
                <td className="py-1.5">
                  <button type="button" onClick={() => open(h.symbol)} className="ring-focus rounded font-semibold text-ink hover:underline">{h.symbol}</button>
                  {q?.name && <span className="ml-2 hidden truncate text-ink-muted [@container(min-width:720px)]:inline">{q.name}</span>}
                </td>
                <td className="py-1.5 text-right text-ink">{+h.shares.toFixed(4)}</td>
                <td className="py-1.5 text-right text-ink-muted">{h.cost == null ? "–" : price(h.cost)}</td>
                <td className="py-1.5 text-right text-ink">{price(q?.price)}</td>
                <td className="py-1.5 text-right" style={{ color: tone(q?.changePct) }}>{pct(q?.changePct)}</td>
                <td className="py-1.5 text-right text-ink">{v == null ? "–" : price(v)}</td>
                <td className="py-1.5 text-right" style={{ color: tone(g) }}>{g == null ? "–" : `${g >= 0 ? "+" : "−"}${price(Math.abs(g))}`}</td>
                {onRemove && (
                  <td className="py-1.5 text-right">
                    <button type="button" aria-label={`Remove ${h.symbol}`} onClick={() => onRemove(h.symbol)} className="ring-focus inline-flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-state-hover hover:text-ink"><X className="h-3 w-3" /></button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Totals for a set of holdings at current quotes. */
/** `orders` (practice only): shares filled after the last trade didn't live through today's move. */
function totals(holdings: FinanceHolding[], quotes: ReturnType<typeof useQuotes>, orders: FinanceOrder[] = []) {
  let value = 0, day = 0, cost = 0, costKnown = true;
  for (const h of holdings) {
    const q = quotes[h.symbol];
    if (q?.price == null) continue;
    value += q.price * h.shares;
    const late = orders.filter((o) => o.symbol === h.symbol && o.status === "filled" && (o.filledAt ?? 0) > (q.marketTime ?? Infinity)).reduce((n, o) => n + (o.side === "buy" ? o.shares : -o.shares), 0);
    day += (q.change ?? 0) * Math.max(h.shares - late, 0);
    if (h.cost == null) costKnown = false;
    else cost += h.cost * h.shares;
  }
  return { value, day, cost: costKnown && cost > 0 ? cost : null };
}

function Allocation({ holdings, quotes }: { holdings: FinanceHolding[]; quotes: ReturnType<typeof useQuotes> }) {
  const [u] = useLoad("universe", () => api.financeUniverse());
  const parts = useMemo(() => {
    const by = new Map<string, number>();
    for (const h of holdings) {
      const p = quotes[h.symbol]?.price;
      if (p == null) continue;
      const sector = u?.rows.find((r) => r.symbol === h.symbol)?.sector || (quotes[h.symbol]?.type === "ETF" ? "Funds" : "Other");
      by.set(sector, (by.get(sector) ?? 0) + p * h.shares);
    }
    const total = [...by.values()].reduce((a, b) => a + b, 0);
    return [...by].map(([name, v]) => ({ name, v, share: total ? v / total : 0 })).sort((a, b) => b.v - a.v);
  }, [holdings, quotes, u]);
  if (!parts.length) return <Empty>Prices are loading.</Empty>;
  // Shades of ink, darkest for the biggest slice, so the bar reads without a legend color key.
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-state-hover" role="img" aria-label="Allocation by sector">
        {parts.map((p, i) => (
          <div key={p.name} style={{ width: `${p.share * 100}%`, background: `rgb(var(--ink) / ${Math.max(0.85 - i * 0.12, 0.15)})` }} className="border-r border-paper-raised last:border-r-0" />
        ))}
      </div>
      <ul className="flex flex-col gap-1">
        {parts.map((p, i) => (
          <li key={p.name} className="flex items-center gap-2 text-[12.5px]">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: `rgb(var(--ink) / ${Math.max(0.85 - i * 0.12, 0.15)})` }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-ink-soft">{p.name}</span>
            <span className="tabular-nums text-ink-muted">{pct(p.share * 100, false, 1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RealPortfolio() {
  const [saved, setSaved] = useState<FinanceHolding[] | null>(null);
  const [draft, setDraft] = useState<FinanceHolding[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [row, setRow] = useState({ symbol: "", shares: "", cost: "" });
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.getPortfolio().then((r) => setSaved(r.holdings)).catch((e) => setError(String(e?.message || e)));
  }, []);
  const holdings = draft ?? saved ?? [];
  const quotes = useQuotes([...holdings.map((h) => h.symbol), "^GSPC"]);
  const t = totals(holdings, quotes);
  const syms = holdings.map((h) => h.symbol).join(",");
  const [charts] = useLoad(`hold|${syms}`, () => Promise.all([...holdings.map((h) => api.financeChart(h.symbol, "1y").catch(() => null)), api.financeChart("^GSPC", "1y").catch(() => null)]));
  const mine = useMemo(() => (charts && holdings.length ? holdingsChart(holdings, charts.slice(0, -1)) : null), [charts, holdings]);
  const spx = charts?.[charts.length - 1] ?? null;

  const save = async () => {
    if (!draft) return;
    try {
      const r = await api.setPortfolio(draft);
      setSaved(r.holdings);
      setDraft(null);
      setNote("Saved.");
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  };
  const addRow = () => {
    const symbol = row.symbol.trim().toUpperCase();
    const shares = Number(row.shares);
    if (!symbol || !(shares > 0)) return setNote("Enter a symbol and a number of shares.");
    const cost = row.cost === "" ? null : Number(row.cost);
    setDraft([...holdings.filter((h) => h.symbol !== symbol), { symbol, shares, cost: cost != null && cost >= 0 ? cost : null }]);
    setRow({ symbol: "", shares: "", cost: "" });
    setNote("");
  };
  const importFile = async (f: File) => {
    const r = parseBrokerCsv(await f.text());
    if ("error" in r) return setNote(r.error);
    setDraft(r.holdings);
    setNote(`Found ${r.holdings.length} holding${r.holdings.length === 1 ? "" : "s"} in ${f.name}${r.kind === "orders" ? " (added up from your orders)" : ""}. Check them, then save.`);
  };

  if (error && !saved) return <Card><Empty>Your portfolio couldn't be loaded: {error}</Empty></Card>;
  if (!saved) return <Spinner className="h-64" />;
  const editing = draft != null;

  return (
    <div className="flex flex-col gap-4">
      {holdings.length > 0 && (
        <Card panel="portfolio">
          <Summary value={t.value} dayChange={t.day} cost={t.cost} />
          <div className="mt-4">
            {!charts ? <Spinner className="h-[260px]" /> : mine && spx ? <CandleChart chart={mine} compare={[spx]} height={240} /> : <Empty>The history chart needs a year of prices for every holding.</Empty>}
            <p className="mt-1 text-[11.5px] text-ink-faint">Today's holdings over the past year, compared with the S&P 500. Buys and sells along the way aren't counted.</p>
          </div>
        </Card>
      )}
      <Card
        panel="holdings"
        title="Holdings"
        action={
          <div className="flex items-center gap-1">
            <input ref={file} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
            <button type="button" onClick={() => file.current?.click()} className={cn(btn, "text-ink-muted hover:bg-state-hover hover:text-ink")} title="Fidelity, Schwab, Robinhood or Webull CSV export"><Upload className="h-3.5 w-3.5" /> Import CSV</button>
            {!editing && <button type="button" onClick={() => setDraft(saved)} className={cn(btn, "text-ink-muted hover:bg-state-hover hover:text-ink")}><Pencil className="h-3.5 w-3.5" /> Edit</button>}
          </div>
        }
      >
        {holdings.length === 0 && !editing ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="max-w-[420px] text-[13px] text-ink-muted">Add what you own to see your value, today's move and how you compare with the market. Nothing here connects to your broker.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setDraft([])} className={cn(btn, "bg-ink text-paper")}><Plus className="h-3.5 w-3.5" /> Add holdings</button>
              <button type="button" onClick={() => file.current?.click()} className={cn(btn, "border border-line text-ink")}><Upload className="h-3.5 w-3.5" /> Import a CSV</button>
            </div>
          </div>
        ) : (
          <HoldingsTable holdings={holdings} quotes={quotes} onRemove={editing ? (s) => setDraft(holdings.filter((h) => h.symbol !== s)) : undefined} />
        )}
        {editing && (
          <div className="mt-3 flex flex-col gap-3">
            <form onSubmit={(e) => { e.preventDefault(); addRow(); }} className="flex flex-wrap items-center gap-2">
              <input value={row.symbol} onChange={(e) => setRow({ ...row, symbol: e.target.value })} placeholder="Symbol" aria-label="Symbol" className={cn(field, "w-24 uppercase")} />
              <input value={row.shares} onChange={(e) => setRow({ ...row, shares: e.target.value })} placeholder="Shares" aria-label="Shares" inputMode="decimal" className={cn(field, "w-24")} />
              <input value={row.cost} onChange={(e) => setRow({ ...row, cost: e.target.value })} placeholder="Avg cost (optional)" aria-label="Average cost per share" inputMode="decimal" className={cn(field, "w-40")} />
              <button type="submit" className={cn(btn, "border border-line text-ink")}><Plus className="h-3.5 w-3.5" /> Add</button>
            </form>
            <div className="flex gap-2">
              <button type="button" onClick={() => void save()} className={cn(btn, "bg-ink text-paper")}>Save holdings</button>
              <button type="button" onClick={() => { setDraft(null); setNote(""); }} className={cn(btn, "text-ink-muted hover:bg-state-hover hover:text-ink")}>Cancel</button>
            </div>
          </div>
        )}
        {note && <p className="mt-2 text-[12px] text-ink-muted" role="status">{note}</p>}
      </Card>
      {holdings.length > 0 && (
        <Card panel="allocation" title="By sector"><Allocation holdings={holdings} quotes={quotes} /></Card>
      )}
    </div>
  );
}

function Practice() {
  const [p, setP] = useState<FinancePractice | null>(null);
  const [error, setError] = useState("");
  const [order, setOrder] = useState({ symbol: "", side: "buy" as "buy" | "sell", type: "market" as "market" | "limit", shares: "", limit: "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const symbol = useFinance((s) => (s.view === "portfolio" ? s.symbol : ""));
  useEffect(() => {
    api.getPractice().then(setP).catch((e) => setError(String(e?.message || e)));
  }, []);
  useEffect(() => {
    if (symbol) setOrder((o) => (o.symbol ? o : { ...o, symbol }));
  }, [symbol]);
  const quotes = useQuotes([...(p?.positions ?? []).map((h) => h.symbol), ...(order.symbol ? [order.symbol.toUpperCase()] : [])]);
  if (error) return <Card><Empty>The practice account couldn't be loaded: {error}</Empty></Card>;
  if (!p) return <Spinner className="h-64" />;
  const t = totals(p.positions, quotes, p.orders);
  const total = p.cash + t.value;
  const q = quotes[order.symbol.trim().toUpperCase()];
  const est = q?.price != null && Number(order.shares) > 0 ? (order.type === "limit" && order.limit ? Number(order.limit) : q.price) * Number(order.shares) : null;
  const open = p.orders.filter((o) => o.status === "open");
  const recent = p.orders.filter((o) => o.status !== "open").slice(0, 8);

  const place = async () => {
    const shares = Number(order.shares);
    const symbol = order.symbol.trim().toUpperCase();
    if (!symbol || !(shares > 0)) return setMsg("Enter a symbol and a number of shares.");
    if (order.type === "limit" && !(Number(order.limit) > 0)) return setMsg("Enter the limit price.");
    setBusy(true);
    try {
      const next = await api.practiceOrder({ symbol, side: order.side, type: order.type, shares, limit: order.type === "limit" ? Number(order.limit) : null });
      setP(next);
      const last = next.orders[0];
      setMsg(last?.status === "filled" ? `Practice order filled: ${last.side} ${last.shares} ${last.symbol} at ${price(last.price)}.` : last?.status === "open" ? `Limit order placed. It fills when ${symbol} reaches ${price(last.limit)} (checked every 15 minutes).` : last?.note || "Order placed.");
      setOrder({ ...order, shares: "", limit: "" });
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card panel="practice">
        <Summary value={total} dayChange={t.day} cost={p.start} label={<span className="rounded-full border border-line px-1.5 py-px text-[10.5px] text-ink-muted">Practice money</span>} />
        <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
          <Stat label="Cash" value={price(p.cash)} />
          <Stat label="Invested" value={price(t.value)} />
          <Stat label="Started with" value={price(p.start)} />
        </div>
      </Card>
      <Card panel="order" title="Place a practice order" action={<span className="text-[11.5px] text-ink-faint">No real money. Prices are delayed about 15 minutes.</span>}>
        <form onSubmit={(e) => { e.preventDefault(); void place(); }} className="flex flex-wrap items-end gap-2">
          <Segmented label="Buy or sell" options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} value={order.side} onChange={(side) => setOrder({ ...order, side })} />
          <input value={order.symbol} onChange={(e) => setOrder({ ...order, symbol: e.target.value })} placeholder="Symbol" aria-label="Symbol" className={cn(field, "w-24 uppercase")} />
          <input value={order.shares} onChange={(e) => setOrder({ ...order, shares: e.target.value })} placeholder="Shares" aria-label="Shares" inputMode="decimal" className={cn(field, "w-24")} />
          <Segmented label="Order type" options={[{ value: "market", label: "At market" }, { value: "limit", label: "Limit" }]} value={order.type} onChange={(type) => setOrder({ ...order, type })} />
          {order.type === "limit" && <input value={order.limit} onChange={(e) => setOrder({ ...order, limit: e.target.value })} placeholder="Limit price" aria-label="Limit price" inputMode="decimal" className={cn(field, "w-28")} />}
          <button type="submit" disabled={busy} className={cn(btn, "bg-ink text-paper disabled:opacity-60")}>{order.side === "buy" ? "Buy" : "Sell"}{est != null ? ` about ${price(est)}` : ""}</button>
        </form>
        {q?.price != null && <p className="mt-2 text-[12px] text-ink-faint">{q.name || q.symbol} last traded at {price(q.price)}.</p>}
        {msg && <p className="mt-2 text-[12px] text-ink-muted" role="status">{msg}</p>}
      </Card>
      <Card panel="positions" title="Practice positions">
        {p.positions.length === 0 ? <Empty>No positions yet. Buy something above to start.</Empty> : <HoldingsTable holdings={p.positions} quotes={quotes} />}
      </Card>
      {(open.length > 0 || recent.length > 0) && (
        <Card panel="orders" title="Orders">
          <ul className="flex flex-col">
            {[...open, ...recent].map((o) => (
              <li key={o.id} className="fin-row flex items-center gap-3 border-t border-line-soft py-1.5 text-[12.5px] first:border-t-0">
                <span className={cn("w-10 shrink-0 font-medium", o.side === "buy" ? "text-ink" : "text-ink-soft")}>{o.side === "buy" ? "Buy" : "Sell"}</span>
                <span className="min-w-0 flex-1 truncate tabular-nums text-ink">{+o.shares.toFixed(4)} {o.symbol} {o.type === "limit" ? `limit ${price(o.limit)}` : "at market"}</span>
                <span className="shrink-0 text-[11.5px] text-ink-faint">{o.status === "filled" ? `Filled ${price(o.price)}` : o.status === "open" ? "Waiting" : o.status === "cancelled" ? "Cancelled" : o.note || "Rejected"}</span>
                <span className="w-16 shrink-0 text-right text-[11.5px] text-ink-faint">{timeAgo(o.filledAt ?? o.created)}</span>
                {o.status === "open" && <button type="button" onClick={() => void api.practiceCancel(o.id).then(setP)} className="ring-focus rounded px-1.5 text-[11.5px] text-ink-muted hover:bg-state-hover hover:text-ink">Cancel</button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div>
        <button type="button" onClick={() => { if (window.confirm("Start over with $100,000 in practice money? Your practice positions and orders will be cleared.")) void api.practiceReset().then(setP); }} className={cn(btn, "text-ink-muted hover:bg-state-hover hover:text-ink")}>Start over with $100,000</button>
      </div>
    </div>
  );
}

function Alerts() {
  const [list, setList] = useState<FinanceAlert[] | null>(null);
  const [form, setForm] = useState({ symbol: "", dir: "above" as "above" | "below", at: "" });
  const [msg, setMsg] = useState("");
  const load = useCallback(() => api.getAlerts().then(setList).catch(() => setList([])), []);
  useEffect(() => void load(), [load]);
  const add = async () => {
    const symbol = form.symbol.trim().toUpperCase();
    const at = Number(form.at);
    if (!symbol || !(at > 0)) return setMsg("Enter a symbol and a price.");
    try {
      setList(await api.addAlert({ symbol, [form.dir]: at }));
      setForm({ ...form, symbol: "", at: "" });
      setMsg("");
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    }
  };
  return (
    <Card panel="alerts" title={<span className="inline-flex items-center gap-1.5"><Bell className="h-3.5 w-3.5 text-ink-faint" /> Price alerts</span>}>
      <p className="mb-2 text-[12px] text-ink-muted">Checked every 15 minutes while zWork is open. Alerts arrive in your Inbox.</p>
      <form onSubmit={(e) => { e.preventDefault(); void add(); }} className="flex flex-wrap items-center gap-1.5">
        <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="Symbol" aria-label="Alert symbol" className={cn(field, "w-20 uppercase")} />
        <select value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value as "above" | "below" })} aria-label="Direction" className={cn(field, "w-[88px]")}>
          <option value="above">rises to</option>
          <option value="below">falls to</option>
        </select>
        <input value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} placeholder="Price" aria-label="Alert price" inputMode="decimal" className={cn(field, "w-20")} />
        <button type="submit" className={cn(btn, "border border-line text-ink")}>Add</button>
      </form>
      {msg && <p className="mt-2 text-[12px] text-ink-muted" role="status">{msg}</p>}
      {list && list.length > 0 && (
        <ul className="mt-3 flex flex-col">
          {list.map((a) => (
            <li key={a.id} className="fin-row flex items-center gap-2 border-t border-line-soft py-1.5 text-[12.5px]">
              <span className="w-12 shrink-0 font-semibold text-ink">{a.symbol}</span>
              <span className="min-w-0 flex-1 truncate tabular-nums text-ink-muted">{a.above != null ? `rises to ${price(a.above)}` : `falls to ${price(a.below)}`}</span>
              {a.triggered && <span className="shrink-0 text-[11.5px] text-ink-faint">Hit {timeAgo(a.triggered)}</span>}
              <button type="button" aria-label={`Delete ${a.symbol} alert`} onClick={() => void api.deleteAlert(a.id).then(setList)} className="ring-focus inline-flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-state-hover hover:text-ink"><Trash2 className="h-3 w-3" /></button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MorningBrief() {
  const [task, setTask] = useState<ScheduledTask | null | undefined>(undefined);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.listSchedules().then((r) => setTask(r.tasks.find((t) => t.crew_id === FINANCE && t.title === BRIEF_TITLE) ?? null)).catch(() => setTask(null));
  }, []);
  const turnOn = async () => {
    try {
      const r = await api.createSchedule({ title: BRIEF_TITLE, prompt: BRIEF_PROMPT, daily_time: "08:00", daily_weekdays: [1, 2, 3, 4, 5], crew_id: FINANCE, enabled: true });
      if (r.error) setMsg(r.error);
      else setTask(r.task);
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    }
  };
  const toggle = async () => {
    if (!task) return;
    try {
      const r = await api.updateSchedule(task.id, { enabled: !task.enabled });
      setTask(r.task);
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    }
  };
  return (
    <Card panel="brief" title={<span className="inline-flex items-center gap-1.5"><Sunrise className="h-3.5 w-3.5 text-ink-faint" /> Morning brief</span>}>
      <p className="text-[12px] text-ink-muted">Every weekday at 8:00, zWork writes up the markets, your holdings and what's on the calendar, and puts it in your Inbox.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {task === undefined ? null : task ? (
          <>
            <span className="text-[12.5px] text-ink">{task.enabled ? "On, weekdays at 8:00" : "Paused"}</span>
            <button type="button" onClick={() => void toggle()} className={cn(btn, "border border-line text-ink")}>{task.enabled ? "Pause" : "Turn back on"}</button>
          </>
        ) : (
          <button type="button" onClick={() => void turnOn()} className={cn(btn, "bg-ink text-paper")}>Turn on</button>
        )}
        <button type="button" onClick={() => void useApp.getState().send(BRIEF_PROMPT)} className={cn(btn, "text-ink-muted hover:bg-state-hover hover:text-ink")}><Sparkles className="h-3.5 w-3.5" /> Write one now</button>
      </div>
      {msg && <p className="mt-2 text-[12px] text-ink-muted" role="status">{msg}</p>}
    </Card>
  );
}

export function PortfolioView() {
  const [mode, setMode] = useState<"real" | "practice">(() => {
    try {
      return localStorage.getItem("zwork.financePortfolioMode") === "practice" ? "practice" : "real";
    } catch {
      return "real";
    }
  });
  const pick = (m: "real" | "practice") => {
    setMode(m);
    try {
      localStorage.setItem("zwork.financePortfolioMode", m);
    } catch {
      /* fine: it just won't be remembered */
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[20px] font-semibold tracking-tight text-ink">Portfolio</h1>
        <Segmented label="Portfolio" options={[{ value: "real", label: "What I own" }, { value: "practice", label: "Practice" }]} value={mode} onChange={pick} />
      </div>
      <div className="grid gap-4 [@container(min-width:980px)]:grid-cols-[1fr_300px]">
        <div className="min-w-0">{mode === "real" ? <RealPortfolio /> : <Practice />}</div>
        <div className="flex min-w-0 flex-col gap-4">
          <MorningBrief />
          <Alerts />
        </div>
      </div>
      <p className="text-[11.5px] text-ink-faint">zWork isn't a financial advisor. Prices are delayed and may be wrong; check with your broker before you trade.</p>
    </div>
  );
}
