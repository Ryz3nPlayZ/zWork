/** Screener over the S&P 500: describe it in words or set filters, save screens, sort columns. */
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Bookmark, Sparkles, X } from "lucide-react";
import { api, type FinanceStock } from "../../lib/api";
import { useApp } from "../../lib/store";
import { cn } from "../../lib/cn";
import { useFinance } from "./financeStore";
import { applyScreen, describeScreen, EMPTY_SCREEN, parseScreen, SECTORS, type Screen } from "./parse";
import { big, Card, Empty, pct, price, Spinner, tone, useListKeys, useLoad } from "./ui";

const SAVED_KEY = "zwork.financeScreens";
const PRESETS: { name: string; screen: Screen }[] = [
  { name: "Dividend payers", screen: { ...EMPTY_SCREEN, yieldMin: 3, sort: "dividendYield" } },
  { name: "Cheap and profitable", screen: { ...EMPTY_SCREEN, peMax: 15, marginMin: 10, sort: "pe", desc: false } },
  { name: "Fast growers", screen: { ...EMPTY_SCREEN, growthMin: 20, sort: "revenueGrowth" } },
  { name: "Biggest companies", screen: { ...EMPTY_SCREEN, capMin: 200e9 } },
];

function loadSaved(): { name: string; screen: Screen }[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  } catch {
    return [];
  }
}

const COLS: { key: keyof FinanceStock; label: string; fmt: (r: FinanceStock) => string; colored?: boolean }[] = [
  { key: "price", label: "Price", fmt: (r) => price(r.price) },
  { key: "changePct", label: "Today", fmt: (r) => pct(r.changePct), colored: true },
  { key: "changeYtd", label: "This year", fmt: (r) => pct(r.changeYtd, true, 1), colored: true },
  { key: "marketCap", label: "Market value", fmt: (r) => big(r.marketCap, "$") },
  { key: "pe", label: "P/E", fmt: (r) => (r.pe == null ? "–" : r.pe.toFixed(1)) },
  { key: "revenueGrowth", label: "Rev. growth", fmt: (r) => pct(r.revenueGrowth, true, 1), colored: true },
  { key: "netMargin", label: "Net margin", fmt: (r) => pct(r.netMargin, false, 1) },
  { key: "dividendYield", label: "Yield", fmt: (r) => (r.dividendYield == null ? "–" : pct(r.dividendYield, false)) },
];

/** A labelled number box; empty means "no filter". */
function NumFilter({ label, value, onChange, suffix }: { label: string; value: number | null; onChange: (v: number | null) => void; suffix?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11.5px] text-ink-faint">
      {label}
      <span className="flex h-8 items-center rounded-lg border border-line bg-paper px-2 focus-within:border-line-strong">
        <input
          type="number"
          inputMode="decimal"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          placeholder="Any"
          className="w-full min-w-0 bg-transparent text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none"
        />
        {suffix && <span className="text-[11.5px] text-ink-faint">{suffix}</span>}
      </span>
    </label>
  );
}

export function ScreenerView() {
  const { screen: stored, setScreen, open } = useFinance();
  const screen = stored ?? EMPTY_SCREEN;
  const [u, error] = useLoad("universe", () => api.financeUniverse());
  const [words, setWords] = useState("");
  const [miss, setMiss] = useState(false);
  const [saved, setSaved] = useState(loadSaved);
  const set = (patch: Partial<Screen>) => setScreen({ ...screen, ...patch });
  const rows = useMemo(() => (u ? applyScreen(u.rows, screen) : []), [u, screen]);
  const shown = rows.slice(0, 200);
  const [active] = useListKeys(shown.length, (i) => open(shown[i].symbol));

  const persist = (next: typeof saved) => {
    setSaved(next);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next));
    } catch {
      /* private mode: saved screens last until the window closes */
    }
  };
  const save = () => {
    const name = describeScreen(screen);
    persist([{ name, screen }, ...saved.filter((s) => s.name !== name)].slice(0, 12));
  };
  const sortBy = (key: string) => set(screen.sort === key ? { desc: !screen.desc } : { sort: key, desc: key !== "pe" });
  const capB = (n: number | null) => (n == null ? null : n / 1e9);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">Screener</h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">Companies in the S&P 500. Fundamentals are from the last full year of SEC filings.</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const s = parseScreen(words);
            setMiss(!s);
            if (s) setScreen(s);
          }}
          className="flex h-9 w-full max-w-[420px] items-center gap-2 rounded-xl border border-line bg-paper-raised pl-3 pr-1 focus-within:border-line-strong"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          <input
            value={words}
            onChange={(e) => {
              setWords(e.target.value);
              setMiss(false);
            }}
            placeholder="Describe it: “profitable tech under 25 pe”"
            aria-label="Describe a screen in words"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button type="submit" className="press ring-focus h-7 shrink-0 rounded-lg bg-ink px-2.5 text-[12px] text-paper">Apply</button>
        </form>
      </div>
      {miss && (
        <p className="-mt-2 text-[12px] text-ink-muted">
          That didn't match a filter. Try words like sector names, “under 20 pe”, “yield over 3”, “growing”, or{" "}
          <button type="button" className="underline hover:text-ink" onClick={() => void useApp.getState().send(`Screen the S&P 500 for: ${words}`)}>ask zWork</button>.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {[...PRESETS, ...saved].map((p, i) => (
          <span key={`${p.name}-${i}`} className="group/chip inline-flex items-center">
            <button
              type="button"
              onClick={() => setScreen(p.screen)}
              className={cn("press ring-focus h-7 rounded-full border px-2.5 text-[12px]", describeScreen(p.screen) === describeScreen(screen) && p.screen.sort === screen.sort ? "border-line-strong bg-state-selected text-ink" : "border-line text-ink-muted hover:text-ink")}
            >
              {i >= PRESETS.length && <Bookmark className="mr-1 inline h-3 w-3" />}
              {p.name}
            </button>
            {i >= PRESETS.length && (
              <button type="button" aria-label={`Delete saved screen ${p.name}`} onClick={() => persist(saved.filter((s) => s !== p))} className="ring-focus -ml-1 hidden h-5 w-5 items-center justify-center rounded-full text-ink-faint hover:text-ink focus-visible:inline-flex group-hover/chip:inline-flex">
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
      </div>

      <Card panel="screener-filters" title="Filters" action={
        <div className="flex gap-1">
          <button type="button" onClick={() => setScreen(null)} className="press ring-focus rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-state-hover hover:text-ink">Clear</button>
          <button type="button" onClick={save} className="press ring-focus inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-state-hover hover:text-ink"><Bookmark className="h-3 w-3" /> Save screen</button>
        </div>
      }>
        <div className="grid grid-cols-2 gap-3 [@container(min-width:620px)]:grid-cols-4 [@container(min-width:900px)]:grid-cols-7">
          <label className="col-span-2 flex min-w-0 flex-col gap-1 text-[11.5px] text-ink-faint [@container(min-width:900px)]:col-span-1">
            Sector
            <select value={screen.sector} onChange={(e) => set({ sector: e.target.value })} className="ring-focus h-8 rounded-lg border border-line bg-paper px-2 text-[12.5px] text-ink">
              <option value="">All sectors</option>
              {SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <NumFilter label="Market value over" suffix="$B" value={capB(screen.capMin)} onChange={(v) => set({ capMin: v == null ? null : v * 1e9 })} />
          <NumFilter label="P/E under" value={screen.peMax} onChange={(v) => set({ peMax: v })} />
          <NumFilter label="Yield over" suffix="%" value={screen.yieldMin} onChange={(v) => set({ yieldMin: v })} />
          <NumFilter label="Revenue growth over" suffix="%" value={screen.growthMin} onChange={(v) => set({ growthMin: v })} />
          <NumFilter label="Net margin over" suffix="%" value={screen.marginMin} onChange={(v) => set({ marginMin: v })} />
          <NumFilter label="This year over" suffix="%" value={screen.ytdMin} onChange={(v) => set({ ytdMin: v })} />
        </div>
      </Card>

      <Card
        panel="screener"
        title={u ? `${rows.length} of ${u.rows.length} companies` : "Results"}
        action={
          rows.length > 0 && (
            <button
              type="button"
              onClick={() => void useApp.getState().send(`Here's my screen (${describeScreen(screen)}). Top results: ${rows.slice(0, 15).map((r) => r.symbol).join(", ")}. What stands out, and what should I look at more closely?`)}
              className="press ring-focus inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-state-hover hover:text-ink"
            >
              <Sparkles className="h-3 w-3" /> Ask about these
            </button>
          )
        }
      >
        {error ? (
          <Empty>Screener data isn't available right now.</Empty>
        ) : !u ? (
          <Spinner className="h-64" />
        ) : rows.length === 0 ? (
          <Empty>No companies pass all of these filters. Loosen one and try again.</Empty>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="fin-table w-full min-w-[760px] text-[12.5px] tabular-nums">
              <thead>
                <tr className="text-ink-faint">
                  <th className="py-1.5 text-left font-normal">Company</th>
                  {COLS.map((c) => (
                    <th key={c.key} className="py-1.5 text-right font-normal">
                      <button type="button" onClick={() => sortBy(c.key)} className={cn("ring-focus inline-flex items-center gap-0.5 rounded hover:text-ink", screen.sort === c.key && "text-ink")} aria-label={`Sort by ${c.label}`}>
                        {c.label}
                        {screen.sort === c.key && (screen.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={r.symbol} onClick={() => open(r.symbol)} className={cn("cursor-pointer border-t border-line-soft hover:bg-state-hover", i === active && "bg-state-selected")}>
                    <td className="max-w-[240px] py-1.5 pr-2">
                      <button type="button" onClick={(e) => { e.stopPropagation(); open(r.symbol); }} className="ring-focus flex min-w-0 items-baseline gap-2 rounded text-left">
                        <span className="w-12 shrink-0 font-semibold text-ink">{r.symbol}</span>
                        <span className="truncate text-ink-muted">{r.name}</span>
                      </button>
                    </td>
                    {COLS.map((c) => (
                      <td key={c.key} className="py-1.5 text-right text-ink" style={c.colored ? { color: tone(r[c.key] as number | null) } : undefined}>
                        {c.fmt(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > shown.length && <p className="pt-2 text-center text-[11.5px] text-ink-faint">Showing the first 200. Add a filter to narrow it down.</p>}
          </div>
        )}
      </Card>
    </div>
  );
}
