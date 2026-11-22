/** Markets: the index strip, an S&P 500 heatmap, movers, today's events, watchlist and top stories. */
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, type FinanceStock } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Segmented } from "../page/Page";
import { useFinance } from "./financeStore";
import { News } from "./StockView";
import { squarify } from "./treemap";
import { big, Card, Change, Empty, pct, price, Sparkline, Spinner, tone, useListKeys, useLoad } from "./ui";

export const INDEX_STRIP = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "Nasdaq" },
  { symbol: "^DJI", label: "Dow" },
  { symbol: "^RUT", label: "Russell 2000" },
  { symbol: "^VIX", label: "VIX" },
  { symbol: "^TNX", label: "10-yr yield" },
  { symbol: "CL=F", label: "Oil" },
  { symbol: "GC=F", label: "Gold" },
  { symbol: "EURUSD=X", label: "EUR/USD" },
  { symbol: "DX-Y.NYB", label: "Dollar" },
];

export function IndexStrip() {
  const quotes = useFinance((s) => s.quotes);
  const open = useFinance((s) => s.open);
  return (
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
      {INDEX_STRIP.map((m) => {
        const q = quotes[m.symbol];
        const value = q?.price == null ? "–" : m.symbol === "^TNX" ? `${q.price.toFixed(2)}%` : m.symbol.includes("=X") ? q.price.toFixed(4) : price(q.price);
        return (
          <button
            key={m.symbol}
            type="button"
            onClick={() => open(m.symbol)}
            className="fin-tile press ring-focus flex min-w-[148px] shrink-0 items-center justify-between gap-2 rounded-xl border border-line bg-paper-raised px-3 py-2 text-left transition-colors hover:border-line-strong"
          >
            <div className="min-w-0">
              <div className="truncate text-[11.5px] text-ink-muted">{m.label}</div>
              <div className="text-[13.5px] font-semibold tabular-nums text-ink">{value}</div>
              {q && <Change q={{ change: null, changePct: q.changePct }} className="text-[11px]" />}
            </div>
            <Sparkline points={q?.points} positive={(q?.changePct ?? 0) >= 0} width={52} />
          </button>
        );
      })}
    </div>
  );
}

type Basis = "changePct" | "change1m" | "changeYtd";
const BASIS: { value: Basis; label: string; scale: number }[] = [
  { value: "changePct", label: "Today", scale: 3 },
  { value: "change1m", label: "1M", scale: 10 },
  { value: "changeYtd", label: "YTD", scale: 30 },
];

/** One company per name: share classes (GOOGL/GOOG) each report the whole company's cap. */
export function dedupeClasses(rows: FinanceStock[]) {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = r.name.replace(/\s*\(Class [A-Z]\)$/, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function Heatmap({ rows }: { rows: FinanceStock[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [basis, setBasis] = useState<Basis>("changePct");
  const open = useFinance((s) => s.open);
  const H = useFinance((s) => (s.density === "terminal" ? 320 : 400));
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const o = new ResizeObserver(() => setW(el.clientWidth));
    o.observe(el);
    setW(el.clientWidth);
    return () => o.disconnect();
  }, []);

  const tiles = useMemo(() => {
    if (!w) return { sectors: [], stocks: [] };
    const priced = dedupeClasses(rows).filter((r) => r.marketCap);
    const groups = new Map<string, FinanceStock[]>();
    for (const r of priced) groups.set(r.sector, [...(groups.get(r.sector) ?? []), r]);
    const capOf = (list: FinanceStock[]) => list.reduce((s, r) => s + (r.marketCap ?? 0), 0);
    const sectors = squarify([...groups.entries()], ([, list]) => capOf(list), { x: 0, y: 0, w, h: H });
    const stocks = sectors.flatMap((s) => {
      const head = s.h > 60 && s.w > 70 ? 17 : 0;
      return squarify(s.item[1], (r) => r.marketCap ?? 0, { x: s.x + 1, y: s.y + head + 1, w: s.w - 2, h: s.h - head - 2 });
    });
    return { sectors, stocks };
  }, [rows, w, H]);

  const scale = BASIS.find((b) => b.value === basis)!.scale;
  return (
    <Card
      panel="heatmap"
      title="S&P 500 by sector"
      action={<Segmented label="Color by" options={BASIS.map((b) => ({ value: b.value, label: b.label }))} value={basis} onChange={setBasis} />}
    >
      <div ref={box} className="relative overflow-hidden rounded-lg" style={{ height: H }} role="img" aria-label="Heatmap of S&P 500 companies: tile size is market value, color is the price move">
        {tiles.sectors.map((s) => (
          <div key={s.item[0]} className="pointer-events-none absolute" style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
            {s.h > 60 && s.w > 70 && <div className="truncate px-1.5 pt-px text-[10.5px] font-medium text-ink-muted">{s.item[0]}</div>}
          </div>
        ))}
        {tiles.stocks.map((t) => {
          const v = t.item[basis];
          const a = v == null ? 0 : Math.min(Math.abs(v) / scale, 1) * 0.75 + 0.1;
          const color = v == null ? "rgb(var(--paper-sunken))" : `rgb(var(--${v >= 0 ? "success" : "error"}) / ${a.toFixed(2)})`;
          const size = Math.max(9.5, Math.min(t.w / 4.2, t.h / 2.6, 18));
          return (
            <button
              key={t.item.symbol}
              type="button"
              tabIndex={-1}
              onClick={() => open(t.item.symbol)}
              title={`${t.item.name} (${t.item.symbol})\n${price(t.item.price)}  ${pct(v)}\nMarket cap ${big(t.item.marketCap, "$")}`}
              className="absolute flex flex-col items-center justify-center overflow-hidden border border-paper-raised text-ink transition-[filter] hover:brightness-110"
              style={{ left: t.x, top: t.y, width: t.w, height: t.h, background: color }}
            >
              {t.w > 30 && t.h > 18 && <span className="font-semibold leading-none" style={{ fontSize: size }}>{t.item.symbol}</span>}
              {t.w > 40 && t.h > 36 && <span className="mt-0.5 tabular-nums leading-none text-ink-soft" style={{ fontSize: size * 0.72 }}>{pct(v, true, 1)}</span>}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function Movers({ rows }: { rows: FinanceStock[] }) {
  const [side, setSide] = useState<"up" | "down">("up");
  const open = useFinance((s) => s.open);
  const list = useMemo(() => {
    const priced = dedupeClasses(rows).filter((r) => r.changePct != null);
    priced.sort((a, b) => (side === "up" ? b.changePct! - a.changePct! : a.changePct! - b.changePct!));
    return priced.slice(0, 8);
  }, [rows, side]);
  return (
    <Card
      panel="movers"
      title="Biggest moves"
      action={<Segmented label="Movers" options={[{ value: "up", label: "Gainers" }, { value: "down", label: "Losers" }]} value={side} onChange={setSide} />}
    >
      <ul className="-mx-2">
        {list.map((r) => (
          <li key={r.symbol}>
            <button type="button" onClick={() => open(r.symbol)} className="fin-row press ring-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-state-hover">
              <span className="w-12 shrink-0 text-[12.5px] font-semibold text-ink">{r.symbol}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{r.name}</span>
              <span className="text-[12.5px] tabular-nums text-ink">{price(r.price)}</span>
              <span className="w-[58px] text-right text-[12.5px] tabular-nums" style={{ color: tone(r.changePct) }}>{pct(r.changePct)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Today() {
  const [cal, error] = useLoad("cal1", () => api.financeCalendar(1));
  const open = useFinance((s) => s.open);
  const go = useFinance((s) => s.go);
  const earnings = useMemo(() => [...(cal?.earnings ?? [])].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, 6), [cal]);
  return (
    <Card
      panel="today"
      title="Coming up"
      action={
        <button type="button" onClick={() => go("calendar")} className="press ring-focus rounded-md px-1.5 py-0.5 text-[12px] text-ink-muted hover:bg-state-hover hover:text-ink">
          Full calendar
        </button>
      }
    >
      {error ? (
        <Empty>The calendar isn't available right now.</Empty>
      ) : !cal ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="mb-1 text-[11.5px] text-ink-faint">Earnings</h3>
            {earnings.length === 0 ? (
              <p className="text-[12.5px] text-ink-muted">No large companies report next.</p>
            ) : (
              <ul className="-mx-2">
                {earnings.map((e) => (
                  <li key={e.symbol}>
                    <button type="button" onClick={() => open(e.symbol, "earnings")} className="fin-row press ring-focus flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-state-hover">
                      <span className="w-12 shrink-0 text-[12.5px] font-semibold text-ink">{e.symbol}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{e.name}</span>
                      <span className="shrink-0 text-[11.5px] text-ink-faint">{e.time || shortDate(e.date)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {cal.economy.length > 0 && (
            <div>
              <h3 className="mb-1 text-[11.5px] text-ink-faint">Economy</h3>
              <ul className="flex flex-col gap-1">
                {cal.economy.slice(0, 5).map((e, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-[12px]">
                    <span className="w-12 shrink-0 tabular-nums text-ink-faint">{e.time}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-soft" title={e.event}>{e.event}</span>
                    {e.consensus && <span className="shrink-0 tabular-nums text-ink-faint">est. {e.consensus}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

export function Watchlist() {
  const { watchlist, quotes, open, toggleWatch, symbol, view } = useFinance();
  const [active] = useListKeys(watchlist.length, (i) => open(watchlist[i]));
  return (
    <Card panel="watchlist" title="Watchlist" action={<span className="text-[11.5px] text-ink-faint">j k to move</span>}>
      {watchlist.length === 0 ? (
        <p className="text-[12.5px] text-ink-muted">Open a stock and press w to watch it.</p>
      ) : (
        <ul className="-mx-2">
          {watchlist.map((sym, i) => {
            const q = quotes[sym];
            return (
              <li key={sym} className="group/row relative">
                <button
                  type="button"
                  onClick={() => open(sym)}
                  className={cn(
                    "fin-row press ring-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-state-hover",
                    (i === active || (view === "stock" && symbol === sym)) && "bg-state-selected",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-ink">{sym}</div>
                    <div className="truncate text-[11.5px] text-ink-faint">{q?.name ?? ""}</div>
                  </div>
                  <Sparkline points={q?.points} positive={(q?.changePct ?? 0) >= 0} />
                  <div className="w-[68px] shrink-0 text-right">
                    <div className="text-[12.5px] tabular-nums text-ink">{price(q?.price)}</div>
                    {q && <Change q={{ change: null, changePct: q.changePct }} className="text-[11px]" />}
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={`Stop watching ${sym}`}
                  title="Stop watching"
                  onClick={() => toggleWatch(sym)}
                  className="absolute -left-1 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-paper text-ink-faint hover:text-ink focus-visible:flex group-hover/row:flex"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function MarketsView() {
  const [u, error] = useLoad("universe", () => api.financeUniverse());
  return (
    <div className="flex flex-col gap-4">
      <IndexStrip />
      {error ? <Card><Empty>The S&P 500 heatmap isn't available right now.</Empty></Card> : !u ? <Card><Spinner className="h-[400px]" /></Card> : <Heatmap rows={u.rows} />}
      <div className="grid grid-cols-1 gap-4 [@container(min-width:640px)]:grid-cols-2 [@container(min-width:980px)]:grid-cols-3">
        {u ? <Movers rows={u.rows} /> : <Card title="Biggest moves"><Spinner /></Card>}
        <Today />
        <Watchlist />
      </div>
      <News symbol="" name="" max={10} title="Top stories" />
    </div>
  );
}
