/** Compare 2–5 symbols: one chart in percent change, then their numbers side by side. */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { api, type FinanceStock } from "../../lib/api";
import { Segmented } from "../page/Page";
import { CandleChart } from "./CandleChart";
import { RANGES, useFinance, type Range } from "./financeStore";
import { big, Card, Empty, pct, price, Spinner, tone, useLoad } from "./ui";

const ROWS: { label: string; get: (r: FinanceStock) => number | null; fmt: (n: number | null) => string; colored?: boolean }[] = [
  { label: "Price", get: (r) => r.price, fmt: (n) => price(n) },
  { label: "Today", get: (r) => r.changePct, fmt: (n) => pct(n), colored: true },
  { label: "Past month", get: (r) => r.change1m, fmt: (n) => pct(n, true, 1), colored: true },
  { label: "This year", get: (r) => r.changeYtd, fmt: (n) => pct(n, true, 1), colored: true },
  { label: "Market value", get: (r) => r.marketCap, fmt: (n) => big(n, "$") },
  { label: "P/E", get: (r) => r.pe, fmt: (n) => (n == null ? "–" : n.toFixed(1)) },
  { label: "Revenue growth", get: (r) => r.revenueGrowth, fmt: (n) => pct(n, true, 1), colored: true },
  { label: "Net margin", get: (r) => r.netMargin, fmt: (n) => pct(n, false, 1) },
  { label: "Dividend yield", get: (r) => r.dividendYield, fmt: (n) => (n == null ? "None" : pct(n, false)) },
];

export function CompareView() {
  const { compare, setCompare, open } = useFinance();
  const [range, setRange] = useState<Range>("1y");
  const [text, setText] = useState("");
  const key = `${compare.join(",")}|${range}`;
  const [charts, error] = useLoad(key, () => Promise.all(compare.map((s) => api.financeChart(s, range).catch(() => null))));
  const [u] = useLoad("universe", () => api.financeUniverse());
  const rows = compare.map((s) => u?.rows.find((r) => r.symbol === s) ?? null);
  const ok = (charts ?? []).filter((c): c is NonNullable<typeof c> => !!c);

  const add = () => {
    const syms = text.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (syms.length) setCompare([...compare, ...syms]);
    setText("");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-1 text-[20px] font-semibold tracking-tight text-ink">Compare</h1>
        {compare.map((s) => (
          <span key={s} className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-paper-raised pl-2.5 pr-1 text-[12.5px] text-ink">
            <button type="button" onClick={() => open(s)} className="ring-focus rounded font-semibold hover:underline">{s}</button>
            <button type="button" aria-label={`Remove ${s}`} onClick={() => setCompare(compare.filter((c) => c !== s))} className="ring-focus inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-faint hover:bg-state-hover hover:text-ink">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {compare.length < 5 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-line pl-2.5 pr-1"
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add ticker" aria-label="Add a ticker to compare" className="w-24 bg-transparent text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none" />
            <button type="submit" aria-label="Add" className="ring-focus inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-faint hover:bg-state-hover hover:text-ink">
              <Plus className="h-3 w-3" />
            </button>
          </form>
        )}
      </div>

      {compare.length < 2 ? (
        <Card>
          <Empty>Add at least two tickers, like MSFT and GOOGL, or type “aapl vs msft” in search.</Empty>
        </Card>
      ) : (
        <>
          <Card panel="chart" title="Change over the period" action={<Segmented label="Time range" options={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={range} onChange={setRange} />}>
            {error ? <Empty>Prices aren't available right now.</Empty> : !charts ? <Spinner className="h-[345px]" /> : ok.length < 2 ? <Empty>Prices for these symbols aren't available.</Empty> : <CandleChart chart={ok[0]} compare={ok.slice(1)} height={320} />}
          </Card>
          <Card panel="compare-table" title="Side by side" action={<span className="text-[11.5px] text-ink-faint">S&P 500 companies; others show prices only</span>}>
            <div className="overflow-x-auto">
              <table className="fin-table w-full min-w-[420px] text-[12.5px] tabular-nums">
                <thead>
                  <tr className="text-ink-faint">
                    <th className="py-1 text-left font-normal" />
                    {compare.map((s) => (
                      <th key={s} className="py-1 text-right font-semibold text-ink">{s}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((row) => (
                    <tr key={row.label} className="border-t border-line-soft">
                      <td className="py-1.5 text-ink-muted">{row.label}</td>
                      {rows.map((r, i) => {
                        const v = r ? row.get(r) : row.label === "Price" ? (charts?.[i]?.price ?? null) : null;
                        return (
                          <td key={compare[i]} className="py-1.5 text-right text-ink" style={row.colored ? { color: tone(v) } : undefined}>
                            {row.fmt(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
