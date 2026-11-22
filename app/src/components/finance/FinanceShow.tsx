/**
 * The chat's ```finance-show block: JSON that says what to open on the Finance
 * page. A block that arrives in a live answer opens it once; any block renders as
 * a chip that opens it again.
 */
import { useEffect } from "react";
import { LayoutPanelLeft } from "lucide-react";
import { useApp } from "../../lib/store";
import { RANGES, useFinance, type Range, type StockTab } from "./financeStore";
import { describeScreen, EMPTY_SCREEN, type Screen } from "./parse";

export type FinanceShowSpec =
  | { view: "stock"; symbol: string; tab?: StockTab; range?: Range }
  | { view: "compare"; symbols: string[] }
  | { view: "screener"; screen: Screen }
  | { view: "markets" | "calendar" | "portfolio" };

const TABS: StockTab[] = ["overview", "chart", "financials", "earnings", "filings", "news", "ownership"];
const SYMBOL = /^\^?[A-Z][A-Z0-9.=-]{0,9}$/;
const PANEL: Record<StockTab, string> = { overview: "chart", chart: "chart", financials: "financials", earnings: "earnings", filings: "filings", news: "news", ownership: "insiders" };

/** Validated spec, or null while the block is still streaming or isn't one we understand. */
export function parseFinanceShow(code: string): FinanceShowSpec | null {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(code);
  } catch {
    return null;
  }
  if (!s || typeof s !== "object") return null;
  if (s.view === "stock") {
    const symbol = String(s.symbol ?? "").toUpperCase();
    if (!SYMBOL.test(symbol)) return null;
    const tab = TABS.includes(s.tab as StockTab) ? (s.tab as StockTab) : undefined;
    const range = RANGES.some((r) => r.value === s.range) ? (s.range as Range) : undefined;
    return { view: "stock", symbol, tab, range };
  }
  if (s.view === "compare") {
    const symbols = (Array.isArray(s.symbols) ? s.symbols : []).map((x) => String(x).toUpperCase()).filter((x) => SYMBOL.test(x));
    return symbols.length >= 2 ? { view: "compare", symbols: symbols.slice(0, 5) } : null;
  }
  if (s.view === "screener") {
    const raw = (s.screen && typeof s.screen === "object" ? s.screen : {}) as Record<string, unknown>;
    const screen: Screen = { ...EMPTY_SCREEN };
    for (const k of Object.keys(EMPTY_SCREEN) as (keyof Screen)[]) {
      const v = raw[k];
      if (k === "sector" || k === "sort") {
        if (typeof v === "string") (screen[k] as string) = v;
      } else if (k === "desc") {
        if (typeof v === "boolean") screen.desc = v;
      } else if (typeof v === "number" && Number.isFinite(v)) (screen[k] as number) = v;
    }
    return { view: "screener", screen };
  }
  if (s.view === "markets" || s.view === "calendar" || s.view === "portfolio") return { view: s.view };
  return null;
}

export function applyFinanceShow(spec: FinanceShowSpec) {
  const f = useFinance.getState();
  let panel = "";
  if (spec.view === "stock") {
    f.open(spec.symbol, spec.tab);
    if (spec.range) f.setRange(spec.range);
    panel = PANEL[spec.tab ?? "overview"];
  } else if (spec.view === "compare") {
    f.setCompare(spec.symbols);
    f.go("compare");
    panel = "chart";
  } else if (spec.view === "screener") {
    f.setScreen(spec.screen);
    f.go("screener");
    panel = "screener";
  } else {
    f.go(spec.view);
    panel = spec.view === "markets" ? "" : spec.view;
  }
  if (useApp.getState().view !== "finance") useApp.getState().setView("finance");
  // Panels mount after the view switch; flash once they're on screen.
  if (panel) setTimeout(() => useFinance.setState({ flash: { panel, at: Date.now() } }), 60);
}

function label(spec: FinanceShowSpec) {
  if (spec.view === "stock") return `${spec.symbol}${spec.tab && spec.tab !== "overview" ? `, ${spec.tab}` : ""}${spec.range ? `, ${RANGES.find((r) => r.value === spec.range)?.label ?? spec.range}` : ""}`;
  if (spec.view === "compare") return spec.symbols.join(" vs ");
  if (spec.view === "screener") return `Screener: ${describeScreen(spec.screen) || "all companies"}`;
  return spec.view[0].toUpperCase() + spec.view.slice(1);
}

// Blocks already acted on this session, so re-renders and re-opened chats don't yank the page around.
const applied = new Set<string>();

export function FinanceShow({ code }: { code: string }) {
  const spec = parseFinanceShow(code);
  useEffect(() => {
    if (!spec || applied.has(code)) return;
    applied.add(code);
    const s = useApp.getState();
    const live = !!(s.activeChatId && s.chats[s.activeChatId]?.working);
    if (live && s.view === "finance") applyFinanceShow(spec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, !!spec]);
  if (!spec) return null;
  return (
    <button
      type="button"
      onClick={() => applyFinanceShow(spec)}
      className="press ring-focus my-1 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-paper-raised px-2.5 py-1 text-[12.5px] text-ink-soft hover:bg-state-hover hover:text-ink"
    >
      <LayoutPanelLeft className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      <span className="truncate">Show on page: {label(spec)}</span>
    </button>
  );
}
