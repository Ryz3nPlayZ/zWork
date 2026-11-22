/**
 * Plain-English parsing for the command bar and the screener's "describe it" box.
 * Pure and dependency-free so app/scripts/finance-selfcheck.ts can test it with node.
 */

export interface Screen {
  sector: string; // GICS sector name, or "" for all
  capMin: number | null; // dollars
  capMax: number | null;
  peMax: number | null;
  peMin: number | null;
  yieldMin: number | null; // percent
  growthMin: number | null; // revenue growth, percent
  marginMin: number | null; // net margin, percent
  ytdMin: number | null; // percent
  ytdMax: number | null;
  sort: string; // a FinanceStock key
  desc: boolean;
}

export const EMPTY_SCREEN: Screen = {
  sector: "", capMin: null, capMax: null, peMax: null, peMin: null, yieldMin: null,
  growthMin: null, marginMin: null, ytdMin: null, ytdMax: null, sort: "marketCap", desc: true,
};

export const SECTORS = [
  "Information Technology", "Financials", "Health Care", "Consumer Discretionary", "Communication Services",
  "Industrials", "Consumer Staples", "Energy", "Utilities", "Real Estate", "Materials",
];

const SECTOR_WORDS: [RegExp, string][] = [
  [/\b(tech|technology|software|semis?|chips?|semiconductors?)\b/, "Information Technology"],
  [/\b(banks?|financials?|finance|insurance|insurers)\b/, "Financials"],
  [/\b(health ?care|healthcare|pharma|biotech|medical)\b/, "Health Care"],
  [/\b(retail|retailers|consumer discretionary|autos?|restaurants?)\b/, "Consumer Discretionary"],
  [/\b(media|telecom|communications?|communication services)\b/, "Communication Services"],
  [/\b(industrials?|aerospace|defen[cs]e|airlines?|railroads?)\b/, "Industrials"],
  [/\b(staples|consumer staples|food|beverages?|grocery)\b/, "Consumer Staples"],
  [/\b(energy|oil|gas)\b/, "Energy"],
  [/\b(utilities|utility|power)\b/, "Utilities"],
  [/\b(real estate|reits?|property)\b/, "Real Estate"],
  [/\b(materials|chemicals?|mining|miners|metals?)\b/, "Materials"],
];

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const LESS = String.raw`(?:under|below|less than|<|at most|max)`;
const MORE = String.raw`(?:over|above|more than|>|at least|min)`;

function money(n: string, unit: string | undefined) {
  const v = Number(n);
  const u = (unit || "b").toLowerCase();
  return v * (u.startsWith("t") ? 1e12 : u.startsWith("m") ? 1e6 : 1e9);
}

/** "tech under 20 pe with dividends" → a Screen, or null when nothing in the text is a filter. */
export function parseScreen(text: string): Screen | null {
  const t = ` ${text.toLowerCase().replace(/p\/e|p\.e\.|price.to.earnings/g, "pe")} `;
  const s: Screen = { ...EMPTY_SCREEN };
  let hit = false;
  const m = (re: string) => t.match(new RegExp(re));
  for (const [re, sector] of SECTOR_WORDS) {
    if (re.test(t)) {
      s.sector = sector;
      hit = true;
      break;
    }
  }
  let r: RegExpMatchArray | null;
  if ((r = m(`pe (?:ratio )?${LESS} ${NUM}`) || m(`${LESS} ${NUM} pe`))) (s.peMax = Number(r[1])), (hit = true);
  if ((r = m(`pe (?:ratio )?${MORE} ${NUM}`) || m(`${MORE} ${NUM} pe`))) (s.peMin = Number(r[1])), (hit = true);
  if (/\b(cheap|value|low pe)\b/.test(t) && s.peMax == null) (s.peMax = 15), (hit = true);
  if ((r = m(`(?:yield|dividend yield|dividends?) ${MORE} ${NUM}`) || m(`${MORE} ${NUM} ?% (?:dividend )?yield`))) (s.yieldMin = Number(r[1])), (hit = true);
  else if (/\b(dividends?|pays? a dividend|income)\b/.test(t)) (s.yieldMin = 0.01), (hit = true);
  if ((r = m(`(?:revenue |sales )?grow(?:th|ing)? ${MORE} ${NUM}`) || m(`grow(?:ing)? (?:revenue |sales )?(?:by )?${MORE} ${NUM}`))) (s.growthMin = Number(r[1])), (hit = true);
  else if (/\b(growing|growth)\b/.test(t)) (s.growthMin = 10), (hit = true);
  if ((r = m(`margins? ${MORE} ${NUM}`))) (s.marginMin = Number(r[1])), (hit = true);
  else if (/\bprofitable\b/.test(t)) (s.marginMin = 0.01), (hit = true);
  if ((r = m(`(?:market cap|cap|worth) ${MORE} \\$?${NUM} ?(t|b|m|trillion|billion|million)?`))) (s.capMin = money(r[1], r[2])), (hit = true);
  else if ((r = m(`(?:market cap|cap|worth) ${LESS} \\$?${NUM} ?(t|b|m|trillion|billion|million)?`))) (s.capMax = money(r[1], r[2])), (hit = true);
  else if (/\b(mega ?caps?|megacaps?|biggest|largest)\b/.test(t)) (s.capMin = 200e9), (hit = true);
  else if (/\b(large ?caps?|big companies)\b/.test(t)) (s.capMin = 10e9), (hit = true);
  else if (/\b(small(?:er)? (?:caps?|companies)|smallest)\b/.test(t)) (s.capMax = 20e9), (hit = true);
  if (/\b(up|gainers?|winners?|best) (?:this year|ytd|year to date)\b/.test(t)) (s.ytdMin = 0), (s.sort = "changeYtd"), (hit = true);
  if (/\b(down|losers?|worst) (?:this year|ytd|year to date)\b/.test(t)) (s.ytdMax = 0), (s.sort = "changeYtd"), (s.desc = false), (hit = true);
  if (/\bhighest yield|top dividend/.test(t)) (s.sort = "dividendYield"), (hit = true);
  if (/\bfastest growing\b/.test(t)) (s.sort = "revenueGrowth"), (hit = true);
  if (/\bscreen(er)?\b|\bstocks?\b/.test(t) && !hit) return { ...EMPTY_SCREEN };
  return hit ? s : null;
}

export type Command =
  | { kind: "symbol"; symbol: string }
  | { kind: "compare"; symbols: string[] }
  | { kind: "view"; view: "markets" | "calendar" | "portfolio" | "screener" }
  | { kind: "screen"; screen: Screen };

const TICKER = /^\^?[A-Za-z][A-Za-z0-9.=-]{0,9}$/;

/** What a command-bar line means, before falling back to company search or the chat. */
export function parseCommand(text: string): Command | null {
  const t = text.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const parts = lower.split(/\s+(?:vs\.?|versus|and|,)\s+|\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  if (/\bvs\.?\b|\bversus\b|^compare\b/.test(lower)) {
    const syms = parts.map((p) => p.replace(/^compare\s+/, "").toUpperCase()).filter((p) => TICKER.test(p));
    if (syms.length >= 2) return { kind: "compare", symbols: syms.slice(0, 5) };
  }
  if (/^(earnings|calendar|economic|this week|earnings (this|next) week|who reports)/.test(lower)) return { kind: "view", view: "calendar" };
  if (/^(portfolio|holdings|my stocks|practice|paper trad)/.test(lower)) return { kind: "view", view: "portfolio" };
  if (/^(markets?|overview|heatmap|movers|today)$/.test(lower)) return { kind: "view", view: "markets" };
  if (/^(screener|screen)$/.test(lower)) return { kind: "view", view: "screener" };
  // A question goes to the chat, even when it mentions a sector.
  if (!/^(what|why|how|when|who|should|is|are|can|do|does|tell|explain|write|summari[sz]e|brief)\b/.test(lower) && !lower.endsWith("?")) {
    const screen = /\s/.test(t) ? parseScreen(t) : null;
    if (screen) return { kind: "screen", screen };
    if (TICKER.test(t) && t.length <= 6) return { kind: "symbol", symbol: t.toUpperCase() };
  }
  return null;
}

/** One line a person can read back: "Information Technology · P/E under 20". */
export function describeScreen(s: Screen): string {
  const out: string[] = [];
  if (s.sector) out.push(s.sector);
  const cap = (n: number) => (n >= 1e12 ? `$${n / 1e12}T` : n >= 1e9 ? `$${n / 1e9}B` : `$${n / 1e6}M`);
  if (s.capMin != null) out.push(`market cap over ${cap(s.capMin)}`);
  if (s.capMax != null) out.push(`market cap under ${cap(s.capMax)}`);
  if (s.peMax != null) out.push(`P/E under ${s.peMax}`);
  if (s.peMin != null) out.push(`P/E over ${s.peMin}`);
  if (s.yieldMin != null) out.push(s.yieldMin < 0.1 ? "pays a dividend" : `yield over ${s.yieldMin}%`);
  if (s.growthMin != null) out.push(`revenue growth over ${s.growthMin}%`);
  if (s.marginMin != null) out.push(s.marginMin < 0.1 ? "profitable" : `net margin over ${s.marginMin}%`);
  if (s.ytdMin != null) out.push("up this year");
  if (s.ytdMax != null) out.push("down this year");
  return out.join(", ") || "All S&P 500 companies";
}

/** The numbers a screen filters on; a FinanceStock fits. */
export interface ScreenRow {
  sector: string;
  marketCap: number | null;
  pe: number | null;
  dividendYield: number | null;
  revenueGrowth: number | null;
  netMargin: number | null;
  changeYtd: number | null;
}

/** Rows that pass every filter in the screen, sorted by its key (missing values last). */
export function applyScreen<T extends ScreenRow>(rows: T[], s: Screen): T[] {
  const min = (v: number | null, m: number | null) => m == null || (v != null && v >= m);
  const max = (v: number | null, m: number | null) => m == null || (v != null && v <= m);
  const out = rows.filter(
    (r) =>
      (!s.sector || r.sector === s.sector) &&
      min(r.marketCap, s.capMin) && max(r.marketCap, s.capMax) &&
      // P/E filters skip companies with no earnings (pe is null when EPS ≤ 0).
      min(r.pe, s.peMin) && max(r.pe, s.peMax) &&
      min(r.dividendYield, s.yieldMin) && min(r.revenueGrowth, s.growthMin) && min(r.netMargin, s.marginMin) &&
      min(r.changeYtd, s.ytdMin) && max(r.changeYtd, s.ytdMax),
  );
  const key = s.sort as keyof T;
  return out.sort((a, b) => {
    const x = a[key] as unknown as number | null;
    const y = b[key] as unknown as number | null;
    if (x == null) return y == null ? 0 : 1;
    if (y == null) return -1;
    return s.desc ? y - x : x - y;
  });
}
