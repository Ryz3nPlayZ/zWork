/**
 * The Finance section: a markets desk beside its own zWork chat.
 * The shell owns the sub-nav, keyboard shortcuts, quote polling and what the
 * chat is told is on screen; each view lives in its own file.
 */
import { lazy, Suspense, useEffect, useMemo } from "react";
import { Rows3, Rows4, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../lib/store";
import { cn } from "../../lib/cn";
import { CommandBar } from "./CommandBar";
import { FINANCE, FinanceChat } from "./FinanceChat";
import { isIndex, RANGES, useFinance, type FinanceView } from "./financeStore";
import { INDEX_STRIP, MarketsView } from "./MarketsView";
import { describeScreen } from "./parse";
import { StockView } from "./StockView";
import { marketStatus, Spinner } from "./ui";

const CompareView = lazy(() => import("./CompareView").then((m) => ({ default: m.CompareView })));
const ScreenerView = lazy(() => import("./ScreenerView").then((m) => ({ default: m.ScreenerView })));
const CalendarView = lazy(() => import("./CalendarView").then((m) => ({ default: m.CalendarView })));
const PortfolioView = lazy(() => import("./PortfolioView").then((m) => ({ default: m.PortfolioView })));

const NAV: { value: FinanceView; label: string }[] = [
  { value: "markets", label: "Markets" },
  { value: "screener", label: "Screener" },
  { value: "calendar", label: "Calendar" },
  { value: "portfolio", label: "Portfolio" },
  { value: "compare", label: "Compare" },
];

function typing(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el?.closest("input, textarea, select, [contenteditable=true], [role=dialog]");
}

function MarketPill() {
  const s = marketStatus();
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 text-[11.5px] text-ink-muted" title="New York trading hours. Prices are delayed about 15 minutes.">
      <span className={cn("h-1.5 w-1.5 rounded-full", s.open ? "bg-success" : "bg-ink-faint")} aria-hidden="true" />
      {s.label}
    </span>
  );
}

export function FinancePage() {
  const { view, symbol, go, watchlist, setWatchlist, compare, density, setDensity, setCommandOpen, screen, range, tab } = useFinance();
  const quote = useFinance((s) => s.quotes[symbol]);

  // The page's chat is the "finance" crew member: resume the latest one, or start fresh.
  useEffect(() => {
    const s = useApp.getState();
    const current = s.activeChatId && s.chats[s.activeChatId]?.crewId === FINANCE;
    useApp.setState({ newChatCrewId: FINANCE });
    if (!current) {
      const latest = s.chatSummaries.filter((c) => c.crew_id === FINANCE).sort((a, b) => b.updated_at - a.updated_at)[0];
      if (latest) void s.openChat(latest.id);
      else useApp.setState({ activeChatId: null });
    }
    return () => {
      if (useApp.getState().newChatCrewId === FINANCE) useApp.setState({ newChatCrewId: "" });
    };
  }, []);

  useEffect(() => {
    api.getWatchlist().then((r) => setWatchlist(r.watchlist)).catch(() => {});
  }, [setWatchlist]);

  // shortcut: polls every minute while the page is open; prices are ~15 min delayed anyway.
  const polled = useMemo(() => [...new Set([...INDEX_STRIP.map((m) => m.symbol), ...watchlist, ...(symbol ? [symbol] : []), ...compare])], [watchlist, symbol, compare]);
  useEffect(() => {
    const refresh = () => {
      for (let i = 0; i < polled.length; i += 20) api.financeQuotes(polled.slice(i, i + 20)).then(useFinance.getState().mergeQuotes).catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [polled]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      const f = useFinance.getState();
      if (e.key === "/") setCommandOpen(true);
      else if (f.view === "stock" && /^[1-7]$/.test(e.key)) f.setRange(RANGES[Number(e.key) - 1].value);
      else if (e.key === "w" && f.view === "stock" && f.symbol && !isIndex(f.symbol)) f.toggleWatch(f.symbol);
      else if (e.key === "Escape" && f.view !== "markets") f.go("markets");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setCommandOpen]);

  const name = quote?.name || symbol;
  const isCompany = !!symbol && !isIndex(symbol) && (quote?.type ?? "EQUITY") === "EQUITY";

  // Tell the finance chat what's on screen, so "how did it do?" means this stock.
  const focus = useMemo(() => {
    if (view === "stock" && symbol) {
      const p = quote?.price;
      const move = p == null ? "" : `, last price ${p}${quote?.currency ? ` ${quote.currency}` : ""}${quote?.changePct == null ? "" : ` (${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(2)}% today)`}`;
      return `${name} (${symbol})${move}, chart showing ${range}, ${tab} tab`;
    }
    if (view === "compare") return compare.length ? `Comparing ${compare.join(", ")}` : "The Compare page";
    if (view === "screener") return `The stock screener${screen ? `: ${describeScreen(screen)}` : ""}`;
    if (view === "calendar") return "The earnings and economic calendar";
    if (view === "portfolio") return "The user's portfolio and practice account (call get_portfolio for holdings)";
    return "The markets overview: indexes, S&P 500 heatmap, movers";
  }, [view, symbol, name, quote?.price, quote?.currency, quote?.changePct, range, tab, compare, screen]);
  useEffect(() => useApp.setState({ financeFocus: focus }), [focus]);
  useEffect(() => () => useApp.setState({ financeFocus: "" }), []);

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden bg-paper" data-density={density}>
      <div className="min-w-0 flex-1 overflow-y-auto [container-type:inline-size]">
        <div className="fin-page mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-6 pb-16 pt-2">
          <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <nav aria-label="Finance sections" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
              <h1 className="mr-3 shrink-0 text-[18px] font-semibold tracking-tight text-ink">Finance</h1>
              {NAV.map((n) => (
                <button
                  key={n.value}
                  type="button"
                  aria-current={view === n.value ? "page" : undefined}
                  onClick={() => go(n.value)}
                  className={cn("press ring-focus h-7 shrink-0 rounded-lg px-2.5 text-[13px] transition-colors", view === n.value ? "bg-state-selected font-medium text-ink" : "text-ink-muted hover:bg-state-hover hover:text-ink")}
                >
                  {n.label}
                </button>
              ))}
              {symbol && (
                <button
                  type="button"
                  aria-current={view === "stock" ? "page" : undefined}
                  onClick={() => go("stock")}
                  className={cn("press ring-focus ml-1 h-7 shrink-0 rounded-lg border px-2.5 text-[13px] transition-colors", view === "stock" ? "border-line-strong font-medium text-ink" : "border-line text-ink-muted hover:text-ink")}
                >
                  {symbol}
                </button>
              )}
            </nav>
            <div className="flex shrink-0 items-center gap-1.5">
              <MarketPill />
              <button
                type="button"
                onClick={() => setDensity(density === "terminal" ? "comfortable" : "terminal")}
                aria-pressed={density === "terminal"}
                title={density === "terminal" ? "Comfortable spacing" : "Compact: fit more on screen"}
                className="press ring-focus inline-flex h-7 w-7 items-center justify-center rounded-lg border border-line text-ink-muted hover:text-ink"
              >
                {density === "terminal" ? <Rows3 className="h-3.5 w-3.5" /> : <Rows4 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => setCommandOpen(true)}
                className="press ring-focus inline-flex h-7 items-center gap-2 rounded-lg border border-line pl-2 pr-1.5 text-[12.5px] text-ink-muted hover:text-ink"
              >
                <Search className="h-3.5 w-3.5" /> Search
                <kbd className="rounded border border-line px-1 text-[10.5px] text-ink-faint">/</kbd>
              </button>
            </div>
          </header>

          <Suspense fallback={<Spinner className="h-64" />}>
            {view === "markets" && <MarketsView />}
            {view === "stock" && (symbol ? <StockView /> : <MarketsView />)}
            {view === "compare" && <CompareView />}
            {view === "screener" && <ScreenerView />}
            {view === "calendar" && <CalendarView />}
            {view === "portfolio" && <PortfolioView />}
          </Suspense>
        </div>
      </div>
      <FinanceChat symbol={symbol} name={name} isCompany={isCompany} view={view} />
      <CommandBar />
    </div>
  );
}
