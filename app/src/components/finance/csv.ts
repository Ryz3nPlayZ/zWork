/**
 * Turn a broker's CSV export into holdings. Handles position exports (Fidelity,
 * Schwab: one row per holding) and order/activity exports (Webull, Robinhood:
 * buys and sells that add up to holdings). Pure so the self-check can test it.
 */
export interface ParsedHolding {
  symbol: string;
  shares: number;
  cost: number | null; // average cost per share
}

/** RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((f) => f.trim()));
}

/** "$1,234.50", "(12.00)", "--", "10 S" → number or null. */
function num(s: string | undefined): number | null {
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const n = Number(s.replace(/[^0-9.]/g, ""));
  if (!s.replace(/[^0-9]/g, "") || !Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const find = (head: string[], ...pats: RegExp[]) => {
  for (const p of pats) {
    const i = head.findIndex((h) => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
};

/** A ticker, or null for cash lines, totals and money-market sweeps (Fidelity marks those "SPAXX**"). */
function ticker(s: string): string | null {
  if (!s || s.endsWith("*")) return null;
  const t = s.toUpperCase().replace(/\s+/g, "");
  return /^[A-Z][A-Z0-9.\-/]{0,9}$/.test(t) ? t.replace("/", ".") : null;
}

export function parseBrokerCsv(text: string): { holdings: ParsedHolding[]; kind: "positions" | "orders" } | { error: string } {
  const rows = csvRows(text.replace(/^﻿/, ""));
  // Schwab and others put a title line or two above the header.
  const at = rows.findIndex((r) => r.some((c) => /^(symbol|ticker|instrument)$/i.test(c)));
  if (at < 0) return { error: "This file has no Symbol column. Export your positions (or orders) as CSV from your broker and try again." };
  const head = rows[at].map((h) => h.toLowerCase());
  const body = rows.slice(at + 1).filter((r) => r.length > 1);
  const sym = find(head, /^(symbol|ticker)$/, /^instrument$/);
  const side = find(head, /^(side|trans code|action|type)$/);

  if (side >= 0) {
    // Orders / activity: replay buys and sells oldest first (both brokers export newest first).
    const qty = find(head, /^filled$/, /^(quantity|qty|shares)/, /^total qty$/);
    const px = find(head, /^avg price$/, /^price$/);
    const status = find(head, /^status$/);
    if (qty < 0) return { error: "Couldn't find a quantity column in this file." };
    const when = find(head, /^filled time$/, /^activity date$/, /date|time/);
    const t = (r: string[]) => (when >= 0 ? Date.parse(r[when].replace(/\s+[A-Z]{2,4}$/, "")) : NaN); // drop "EST"
    const trades = body.filter((r) => ticker(r[sym]) && num(r[qty]) && (status < 0 || /fill/i.test(r[status] || "")));
    const ordered = trades.every((r) => !Number.isNaN(t(r))) ? [...trades].sort((a, b) => t(a) - t(b)) : trades;
    const book = new Map<string, { shares: number; cost: number }>();
    // shortcut: sells take shares out at average cost; exact tax lots don't matter for a P&L view.
    for (const r of ordered) {
      const s = ticker(r[sym]);
      const kind = (r[side] || "").toLowerCase();
      const q = Math.abs(num(r[qty]) ?? 0);
      if (!s || !q) continue;
      const p = px >= 0 ? (num(r[px]) ?? 0) : 0;
      const b = book.get(s) ?? { shares: 0, cost: 0 };
      if (/^(buy|b|bto)$/.test(kind)) {
        b.cost += q * Math.abs(p);
        b.shares += q;
      } else if (/^(sell|s|stc)$/.test(kind) && b.shares > 0) {
        const avg = b.cost / b.shares;
        b.shares = Math.max(b.shares - q, 0);
        b.cost = avg * b.shares;
      } else continue;
      book.set(s, b);
    }
    const holdings = [...book].filter(([, b]) => b.shares > 1e-9).map(([symbol, b]) => ({ symbol, shares: round(b.shares), cost: b.cost > 0 ? round(b.cost / b.shares) : null }));
    return holdings.length ? { holdings, kind: "orders" } : { error: "No filled buys were found in this file." };
  }

  const qty = find(head, /^(quantity|qty|shares)/);
  const avg = find(head, /^(average cost basis|avg cost|average cost|cost\/share|cost per share|unit cost)/);
  const total = find(head, /^cost basis( total)?$/, /^(total cost|cost basis)/);
  if (qty < 0) return { error: "Couldn't find a quantity column in this file." };
  const merged = new Map<string, ParsedHolding>();
  for (const r of body) {
    const s = ticker(r[sym]);
    const q = num(r[qty]);
    if (!s || !q || q <= 0) continue;
    const t = total >= 0 ? num(r[total]) : null;
    const c = avg >= 0 ? num(r[avg]) : t != null ? t / q : null;
    const m = merged.get(s);
    // Same symbol in two accounts: add shares, weight the cost.
    if (m) {
      m.cost = m.cost != null && c != null ? round((m.cost * m.shares + c * q) / (m.shares + q)) : null;
      m.shares = round(m.shares + q);
    } else merged.set(s, { symbol: s, shares: round(q), cost: c != null && c >= 0 ? round(c) : null });
  }
  const holdings = [...merged.values()];
  return holdings.length ? { holdings, kind: "positions" } : { error: "No holdings were found in this file." };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
