/** Small pieces shared by the Finance views. */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { FinanceQuote } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useFinance } from "./financeStore";

export const up = "rgb(var(--success))";
export const down = "rgb(var(--error))";
export const tone = (n: number | null | undefined) => (n == null ? undefined : n >= 0 ? up : down);

export function price(n: number | null | undefined, digits = 2) {
  return n == null || !Number.isFinite(n) ? "–" : n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 1.2T, 340B, 12.5M, 980K. */
export function big(n: number | null | undefined, prefix = "") {
  if (n == null || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const f = (v: number, u: string) => `${sign}${prefix}${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${u}`;
  if (a >= 1e12) return f(a / 1e12, "T");
  if (a >= 1e9) return f(a / 1e9, "B");
  if (a >= 1e6) return f(a / 1e6, "M");
  if (a >= 1e4) return f(a / 1e3, "K");
  return `${sign}${prefix}${a.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function pct(n: number | null | undefined, signed = true, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "–";
  return `${signed && n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function Change({ q, className }: { q: Pick<FinanceQuote, "change" | "changePct">; className?: string }) {
  if (q.changePct == null) return <span className={cn("text-ink-faint", className)}>–</span>;
  const pos = q.changePct >= 0;
  return (
    <span className={cn("tabular-nums", className)} style={{ color: pos ? up : down }}>
      {q.change != null && `${pos ? "+" : ""}${price(q.change)} `}
      {q.change != null ? `(${pct(q.changePct)})` : pct(q.changePct)}
    </span>
  );
}

/** A tiny line of closes; plain SVG so rows stay cheap. */
export function Sparkline({ points, positive, width = 64 }: { points?: number[]; positive: boolean; width?: number }) {
  if (!points || points.length < 2) return <span className="inline-block h-6 shrink-0" style={{ width }} />;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const d = points.map((p, i) => `${((i / (points.length - 1)) * width).toFixed(1)},${(22 - ((p - min) / span) * 20).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height="24" viewBox={`0 0 ${width} 24`} aria-hidden="true" className="shrink-0">
      <polyline points={d} fill="none" stroke={positive ? up : down} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** A titled panel. `panel` names it for the chat's page actions, which flash the panel they changed. */
export function Card({
  title,
  action,
  children,
  className,
  panel,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  panel?: string;
}) {
  const flash = useFinance((s) => (panel && s.flash?.panel === panel ? s.flash.at : 0));
  return (
    <section data-panel={panel} className={cn("fin-card relative min-w-0 rounded-2xl border border-line bg-paper-raised p-4", className)}>
      {flash > 0 && <div key={flash} className="setting-flash pointer-events-none absolute inset-0 rounded-[inherit]" aria-hidden="true" />}
      {(title || action) && (
        <div className="fin-card-head mb-3 flex min-h-[24px] items-center justify-between gap-2">
          {title && <h2 className="min-w-0 truncate text-[13px] font-semibold text-ink">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-24 items-center justify-center", className)}>
      <Loader2 className="h-4 w-4 animate-spin text-ink-faint" aria-label="Loading" />
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[12.5px] text-ink-muted">{children}</p>;
}

export function Stat({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-[11.5px] text-ink-faint">{label}</div>
      <div className="truncate text-[13px] tabular-nums text-ink">{value}</div>
    </div>
  );
}

export function timeAgo(sec: number | null | undefined) {
  if (!sec) return "";
  const m = Math.round((Date.now() / 1000 - sec) / 60);
  if (m < 60) return `${Math.max(m, 1)}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/**
 * Loads `fn()` whenever `key` changes, dropping answers that arrive after the key moved on.
 * Returns [data, error]; data is null while loading.
 */
export function useLoad<T>(key: string, fn: () => Promise<T>): [T | null, string] {
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({ key: "", data: null, error: "" });
  useEffect(() => {
    let live = true;
    setState({ key, data: null, error: "" });
    fn()
      .then((data) => live && setState({ key, data, error: "" }))
      .catch((e) => live && setState({ key, data: null, error: String(e?.message || e || "Failed") }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? [state.data, state.error] : [null, ""];
}

/** Market status in New York. shortcut: ignores exchange holidays and half days; add a holiday list if people notice. */
export function marketStatus(now = new Date()): { label: string; open: boolean } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return { label: "Market closed", open: false };
  if (mins >= 570 && mins < 960) return { label: "Market open", open: true };
  if (mins >= 240 && mins < 570) return { label: "Pre-market", open: false };
  if (mins >= 960 && mins < 1200) return { label: "After hours", open: false };
  return { label: "Market closed", open: false };
}

/** Rows a keyboard can walk with j/k; returns the active index and a setter. */
export function useListKeys(count: number, onEnter: (i: number) => void): [number, (i: number) => void] {
  const [i, setI] = useState(-1);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "j") setI((x) => Math.min(x + 1, count - 1));
      else if (e.key === "k") setI((x) => Math.max(x - 1, 0));
      else if (e.key === "Enter" && i >= 0) onEnter(i);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [count, i, onEnter]);
  return [i, setI];
}

/** A CSS color token ("success", "ink") as an rgba() string, for canvas charts that can't read var(). */
export function cssColor(name: string, alpha = 1) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  const [r, g, b] = (v || "128 128 128").split(/[\s,/]+/).map(Number);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Bumps when the theme or color scheme changes (class or inline vars on <html>), so canvas charts can repaint. */
export function useThemeKey() {
  const [k, setK] = useState(0);
  useEffect(() => {
    const o = new MutationObserver(() => setK((x) => x + 1));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => o.disconnect();
  }, []);
  return k;
}
