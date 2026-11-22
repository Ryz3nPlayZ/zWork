/**
 * The "/" bar: type a ticker, a company, "aapl vs msft", "tech under 20 pe",
 * "earnings this week" or a question. Questions go to the Finance chat.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Building2, Filter, GitCompare, LayoutGrid, Search, Sparkles } from "lucide-react";
import { api, type FinanceSearchHit } from "../../lib/api";
import { useApp } from "../../lib/store";
import { cn } from "../../lib/cn";
import { useFinance } from "./financeStore";
import { describeScreen, parseCommand } from "./parse";

interface Row {
  key: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  hint?: string;
  run: () => void;
}

const VIEW_LABEL = { markets: "Markets overview", calendar: "Earnings and economic calendar", portfolio: "Your portfolio", screener: "Stock screener" } as const;

export function CommandBar() {
  const { commandOpen, setCommandOpen, open, go, setCompare, setScreen } = useFinance();
  const [text, setText] = useState("");
  const [hits, setHits] = useState<FinanceSearchHit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (commandOpen) {
      setText("");
      setHits([]);
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [commandOpen]);

  useEffect(() => {
    const t = text.trim();
    if (!t || t.length > 40 || t.split(/\s+/).length > 4) return setHits([]);
    const id = setTimeout(() => api.financeSearch(t).then(setHits).catch(() => setHits([])), 180);
    return () => clearTimeout(id);
  }, [text]);

  const close = () => setCommandOpen(false);
  const rows = useMemo<Row[]>(() => {
    const t = text.trim();
    if (!t) return [];
    const cmd = parseCommand(t);
    const out: Row[] = [];
    const exact = hits.find((h) => h.symbol.toUpperCase() === t.toUpperCase());
    if (exact) out.push(hitRow(exact));
    if (cmd?.kind === "compare")
      out.push({ key: "cmp", icon: <GitCompare className="h-4 w-4" />, label: `Compare ${cmd.symbols.join(", ")}`, run: () => { setCompare(cmd.symbols); go("compare"); } });
    if (cmd?.kind === "view") out.push({ key: "view", icon: <LayoutGrid className="h-4 w-4" />, label: VIEW_LABEL[cmd.view], run: () => go(cmd.view) });
    if (cmd?.kind === "screen")
      out.push({ key: "screen", icon: <Filter className="h-4 w-4" />, label: `Screen: ${describeScreen(cmd.screen)}`, run: () => { setScreen(cmd.screen); go("screener"); } });
    if (cmd?.kind === "symbol" && !exact && !hits.length)
      out.push({ key: "sym", icon: <Building2 className="h-4 w-4" />, label: `Open ${cmd.symbol}`, run: () => open(cmd.symbol) });
    for (const h of hits) if (h !== exact) out.push(hitRow(h));
    out.push({
      key: "ask",
      icon: <Sparkles className="h-4 w-4" />,
      label: (
        <>
          Ask zWork: <span className="text-ink">{t}</span>
        </>
      ),
      run: () => void useApp.getState().send(t),
    });
    return out.slice(0, 9);

    function hitRow(h: FinanceSearchHit): Row {
      return {
        key: h.symbol,
        icon: <span className="w-12 text-[12px] font-semibold text-ink">{h.symbol}</span>,
        label: h.name,
        hint: h.exchange,
        run: () => open(h.symbol),
      };
    }
  }, [text, hits, open, go, setCompare, setScreen]);

  if (!commandOpen) return null;
  const pick = (i: number) => {
    const r = rows[i];
    if (!r) return;
    close();
    r.run();
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/25 px-4 pt-[12vh]" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Go to a stock or ask a question"
        className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" />
          <input
            ref={input}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, rows.length - 1));
              else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
              else if (e.key === "Enter") pick(active);
              else return;
              e.preventDefault();
            }}
            placeholder="Ticker, company, “aapl vs msft”, “tech under 20 pe” or a question"
            aria-label="Go to a stock or ask a question"
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-line px-1.5 text-[11px] text-ink-faint">esc</kbd>
        </div>
        {rows.length > 0 ? (
          <ul role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
            {rows.map((r, i) => (
              <li key={r.key} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(i)}
                  className={cn("flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] text-ink-muted", i === active && "bg-state-hover")}
                >
                  <span className="flex shrink-0 items-center text-ink-faint">{r.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  {r.hint && <span className="shrink-0 text-[11px] text-ink-faint">{r.hint}</span>}
                  {i === active && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" />}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-4 py-3 text-[12px] text-ink-faint">
            <span><kbd className="font-sans text-ink-muted">/</kbd> open this bar</span>
            <span><kbd className="font-sans text-ink-muted">w</kbd> watch the open stock</span>
            <span><kbd className="font-sans text-ink-muted">1–7</kbd> chart range</span>
            <span><kbd className="font-sans text-ink-muted">j k</kbd> move through lists</span>
          </div>
        )}
      </div>
    </div>
  );
}
