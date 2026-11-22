/**
 * What the Finance section is showing. Its own small store so the command bar,
 * keyboard shortcuts and the chat's page actions (`finance-show` blocks) can all
 * move the page the same way.
 */
import { create } from "zustand";
import { api, type FinanceQuote } from "../../lib/api";
import type { Screen } from "./parse";

export type FinanceView = "markets" | "stock" | "compare" | "screener" | "calendar" | "portfolio";
export type StockTab = "overview" | "chart" | "financials" | "earnings" | "filings" | "news" | "ownership";
export const RANGES = [
  { value: "1d", label: "1D" },
  { value: "5d", label: "5D" },
  { value: "1mo", label: "1M" },
  { value: "6mo", label: "6M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "5y", label: "5Y" },
] as const;
export type Range = (typeof RANGES)[number]["value"] | "max";
export type Density = "comfortable" | "terminal";

const PREFS_KEY = "zwork.financePrefs";
function loadPrefs(): { density?: Density; range?: Range } {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}
function savePrefs(p: { density: Density; range: Range }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: preferences just aren't remembered */
  }
}

interface FinanceState {
  view: FinanceView;
  symbol: string;
  tab: StockTab;
  range: Range;
  compare: string[];
  screen: Screen | null;
  density: Density;
  watchlist: string[];
  quotes: Record<string, FinanceQuote>;
  /** The panel the chat last changed, so it can flash once. */
  flash: { panel: string; at: number } | null;
  commandOpen: boolean;

  go: (view: FinanceView) => void;
  open: (symbol: string, tab?: StockTab) => void;
  setTab: (tab: StockTab) => void;
  setRange: (range: Range) => void;
  setCompare: (symbols: string[]) => void;
  setScreen: (screen: Screen | null) => void;
  setDensity: (d: Density) => void;
  setWatchlist: (symbols: string[]) => void;
  toggleWatch: (symbol: string) => void;
  mergeQuotes: (list: FinanceQuote[]) => void;
  setCommandOpen: (open: boolean) => void;
}

const prefs = loadPrefs();

export const useFinance = create<FinanceState>((set, get) => ({
  view: "markets",
  symbol: "",
  tab: "overview",
  range: prefs.range ?? "1d",
  compare: [],
  screen: null,
  density: prefs.density ?? "comfortable",
  watchlist: [],
  quotes: {},
  flash: null,
  commandOpen: false,

  go: (view) => set({ view }),
  open: (symbol, tab) => set((s) => ({ view: "stock", symbol: symbol.toUpperCase(), tab: tab ?? (s.symbol === symbol.toUpperCase() ? s.tab : "overview") })),
  setTab: (tab) => set({ tab }),
  setRange: (range) => {
    set({ range });
    savePrefs({ density: get().density, range });
  },
  setCompare: (compare) => set({ compare: [...new Set(compare.map((c) => c.toUpperCase()))].slice(0, 5) }),
  setScreen: (screen) => set({ screen }),
  setDensity: (density) => {
    set({ density });
    savePrefs({ density, range: get().range });
  },
  setWatchlist: (watchlist) => set({ watchlist }),
  toggleWatch: (symbol) => {
    const cur = get().watchlist;
    const next = cur.includes(symbol) ? cur.filter((s) => s !== symbol) : [...cur, symbol];
    set({ watchlist: next });
    api.setWatchlist(next).then((r) => set({ watchlist: r.watchlist })).catch(() => set({ watchlist: cur }));
  },
  mergeQuotes: (list) => set((s) => ({ quotes: { ...s.quotes, ...Object.fromEntries(list.map((q) => [q.symbol, q])) } })),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
}));

export const isIndex = (symbol: string) => symbol.startsWith("^") || symbol.includes("=");
