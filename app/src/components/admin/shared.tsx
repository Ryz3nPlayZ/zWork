import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Download, Loader2, RotateCw } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "../../lib/cn";
import { Badge, Button, Segmented, type Tone } from "../page/Page";

export type ApiFetch = <T>(path: string) => Promise<T>;

// Semantic series colors, resolved from the theme tokens so charts follow
// light/dark like the rest of the UI. Use these for good/bad series and the
// categorical palette below for everything else.
export const TONE_COLOR = {
  success: "rgb(var(--success))",
  warning: "rgb(var(--warning))",
  error: "rgb(var(--error))",
  info: "rgb(var(--info))",
  muted: "rgb(var(--ink-faint))",
} as const;

// Categorical palette for multi-series charts. 8 distinct hues that read well
// on both light and dark themes.
export const SERIES_PALETTE = [
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#3b82f6", // blue
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
];

const tooltipStyle = {
  backgroundColor: "rgb(var(--paper-raised))",
  border: "1px solid rgb(var(--line))",
  borderRadius: "8px",
  fontSize: "12px",
  color: "rgb(var(--ink))",
} as const;

const axisProps = {
  tick: { fontSize: 11, fill: "rgb(var(--ink-muted))" },
  stroke: "rgb(var(--line))",
  tickLine: false,
} as const;

export function ChartCard({
  title,
  sub,
  actions,
  children,
  className,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-2xl border border-line bg-paper-raised p-4", className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
          {sub && <p className="mt-0.5 text-[12px] text-ink-muted">{sub}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function NoChartData({ height }: { height: number }) {
  return (
    <div className="flex items-center justify-center text-[12px] text-ink-faint" style={{ height }}>
      No data in this window
    </div>
  );
}

export interface SeriesPoint {
  [key: string]: string | number | null;
}

export function LineChartCard({
  title,
  sub,
  data,
  series,
  xKey,
  height = 240,
  valueFormatter,
}: {
  title: string;
  sub?: string;
  data: SeriesPoint[];
  series: { key: string; label: string; color?: string }[];
  xKey: string;
  height?: number;
  valueFormatter?: (v: number) => string;
}) {
  return (
    <ChartCard title={title} sub={sub}>
      {data.length === 0 ? <NoChartData height={height} /> : (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} />
          <YAxis {...axisProps} tickFormatter={valueFormatter ? (v) => valueFormatter(Number(v)) : undefined} />
          <Tooltip
            separator=": "
            contentStyle={tooltipStyle}
            labelStyle={{ color: "rgb(var(--ink-muted))" }}
            formatter={valueFormatter ? (v: number) => valueFormatter(v) : undefined}
          />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length]}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

export function AreaChartCard({
  title,
  sub,
  data,
  series,
  xKey,
  height = 240,
  valueFormatter,
}: {
  title: string;
  sub?: string;
  data: SeriesPoint[];
  series: { key: string; label: string; color?: string }[];
  xKey: string;
  height?: number;
  valueFormatter?: (v: number) => string;
}) {
  // Gradient ids are document-global; two charts with the same series key
  // would otherwise share (and overwrite) one gradient.
  const gid = useId().replace(/:/g, "");
  return (
    <ChartCard title={title} sub={sub}>
      {data.length === 0 ? <NoChartData height={height} /> : (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <defs>
            {series.map((s, i) => {
              const color = s.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length];
              return (
                <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              );
            })}
          </defs>
          <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} />
          <YAxis {...axisProps} tickFormatter={valueFormatter ? (v) => valueFormatter(Number(v)) : undefined} />
          <Tooltip
            separator=": "
            contentStyle={tooltipStyle}
            labelStyle={{ color: "rgb(var(--ink-muted))" }}
            formatter={valueFormatter ? (v: number) => valueFormatter(v) : undefined}
          />
          {series.map((s, i) => {
            const color = s.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length];
            return (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={color}
                strokeWidth={2}
                fill={`url(#${gid}-${s.key})`}
                connectNulls
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

export function BarChartCard({
  title,
  sub,
  data,
  series,
  xKey,
  height = 240,
  valueFormatter,
  stacked,
}: {
  title: string;
  sub?: string;
  data: SeriesPoint[];
  series: { key: string; label: string; color?: string }[];
  xKey: string;
  height?: number;
  valueFormatter?: (v: number) => string;
  stacked?: boolean;
}) {
  return (
    <ChartCard title={title} sub={sub}>
      {data.length === 0 ? <NoChartData height={height} /> : (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} />
          <YAxis {...axisProps} tickFormatter={valueFormatter ? (v) => valueFormatter(Number(v)) : undefined} />
          <Tooltip
            separator=": "
            contentStyle={tooltipStyle}
            labelStyle={{ color: "rgb(var(--ink-muted))" }}
            formatter={valueFormatter ? (v: number) => valueFormatter(v) : undefined}
            cursor={{ fill: "rgb(var(--line-soft) / 0.4)" }}
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId={stacked ? "a" : undefined}
              fill={s.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length]}
              radius={stacked ? 0 : [3, 3, 0, 0]}
              maxBarSize={48}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

export interface DonutSlice {
  name: string;
  value: number;
  color?: string;
}

export function DonutCard({
  title,
  sub,
  data,
  height = 240,
  valueFormatter,
}: {
  title: string;
  sub?: string;
  data: DonutSlice[];
  height?: number;
  valueFormatter?: (v: number) => string;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <ChartCard title={title} sub={sub}>
      {total === 0 ? <NoChartData height={height} /> : (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius="55%"
            outerRadius="80%"
            paddingAngle={1.5}
            stroke="rgb(var(--paper-raised))"
            strokeWidth={2}
          >
            {data.map((d, i) => (
              <Cell key={d.name} fill={d.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip
            separator=": "
            contentStyle={tooltipStyle}
            labelStyle={{ color: "rgb(var(--ink-muted))" }}
            formatter={valueFormatter ? (v: number) => valueFormatter(v) : undefined}
          />
        </PieChart>
      </ResponsiveContainer>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center gap-1.5 text-xs">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: d.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length] }}
            />
            <span className="text-ink-muted">{d.name}</span>
            <span className="font-medium text-ink">
              {total > 0 ? `${((d.value / total) * 100).toFixed(1)}%` : "—"}
            </span>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}


// ---- Data loading ----

/**
 * One fetch per tab. Re-runs when `path` or `refreshKey` changes (the header
 * Refresh button bumps refreshKey), keeps the previous data while reloading
 * so the page doesn't flash, and exposes `reload` for the error box's Retry.
 */
export function useAdminData<T>(apiFetch: ApiFetch, path: string, refreshKey = 0) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    apiFetch<T>(path)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [apiFetch, path, refreshKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload, setData };
}

/** Loading / error placeholder shown before a tab has any data. */
export function TabStatus({ loading, error, onRetry }: { loading: boolean; error: string; onRetry?: () => void }) {
  if (error) return <ErrorBox message={error} onRetry={onRetry} />;
  if (loading)
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  return <div className="py-20 text-center text-[13px] text-ink-muted">No data</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-2xl border border-error/25 bg-error/10 px-4 py-3 text-[12.5px] text-error"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">Couldn't load this: {message}</span>
      {onRetry && (
        <Button icon={<RotateCw />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// ---- Toolbar ----

export function WindowPicker({
  value,
  options,
  onChange,
}: {
  value: number;
  options: number[];
  onChange: (days: number) => void;
}) {
  return (
    <Segmented
      label="Time window"
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={options.map((d) => ({ value: String(d), label: d === 1 ? "24h" : `${d}d` }))}
    />
  );
}

/** Window picker on the left, extra controls (export, filters) on the right. */
export function TabToolbar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

// ---- Stats ----

export type StatTone = "default" | "ok" | "warn" | "error";

const STAT_TONE: Record<StatTone, string> = {
  default: "text-ink",
  ok: "text-success",
  warn: "text-warning",
  error: "text-error",
};

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "default",
  hint,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  icon?: React.ElementType;
  tone?: StatTone;
  /** Shown on hover: how the number is computed. */
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-paper-raised p-4" title={hint}>
      <div className="flex items-center gap-1.5 text-ink-muted">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate text-[12px] font-medium">{label}</span>
      </div>
      <div className={cn("mt-1.5 truncate text-[22px] font-semibold tabular-nums tracking-tight", STAT_TONE[tone])}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11.5px] text-ink-faint">{sub}</div>}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

/** Thresholds for "higher is worse" rates (error rate, failure rate). */
export function rateTone(rate: number, warn = 0.02, bad = 0.05): StatTone {
  return rate >= bad ? "error" : rate >= warn ? "warn" : "ok";
}

// ---- Badges ----

export function statusTone(code: number | null): Tone {
  if (code === null) return "neutral";
  if (code < 300) return "success";
  if (code < 400) return "info";
  if (code < 500) return "warning";
  return "error";
}

export function StatusBadge({ code }: { code: number | null }) {
  return <Badge tone={statusTone(code)}>{code ?? "no response"}</Badge>;
}

const TIER_TONE: Record<string, Tone> = { free: "neutral", pro: "info", max: "warning" };

export function TierBadge({ tier }: { tier: string }) {
  return <Badge tone={TIER_TONE[tier] ?? "neutral"}>{tier}</Badge>;
}

// ---- Table ----

export interface Column<T> {
  key: string;
  label: string;
  /** Cell content. Defaults to the raw value. */
  render?: (row: T) => ReactNode;
  /** Value used for sorting and CSV export. Defaults to row[key]. */
  value?: (row: T) => string | number | null | undefined;
  /** Numbers right-align and use tabular figures. */
  numeric?: boolean;
  mono?: boolean;
  /** Leave out of the CSV (action columns). */
  noExport?: boolean;
  /** Not sortable (action columns). */
  noSort?: boolean;
}

type SortDir = "asc" | "desc";

function cellValue<T>(row: T, c: Column<T>) {
  if (c.value) return c.value(row);
  return (row as Record<string, unknown>)[c.key] as string | number | null | undefined;
}

/**
 * Sortable table with optional CSV export and expandable rows. Click a header
 * to sort (numbers start descending, text ascending); click again to flip.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  defaultSort,
  empty = "Nothing here yet.",
  exportName,
  expand,
  limit,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  defaultSort?: { key: string; dir: SortDir };
  empty?: string;
  /** File name stem for "Export CSV"; no button when omitted. */
  exportName?: string;
  /** Details shown under a row when it is clicked. */
  expand?: (row: T) => ReactNode;
  /** Show the first N rows with a "Show all" toggle. */
  limit?: number;
}) {
  const [sort, setSort] = useState(defaultSort ?? null);
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = cellValue(a, col);
      const vb = cellValue(b, col);
      // Missing values always sink to the bottom.
      if (va === null || va === undefined || va === "") return 1;
      if (vb === null || vb === undefined || vb === "") return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
      return String(va).localeCompare(String(vb)) * mul;
    });
  }, [rows, columns, sort]);

  const visible = limit && !showAll ? sorted.slice(0, limit) : sorted;

  function toggleSort(c: Column<T>) {
    if (c.noSort) return;
    setSort((s) =>
      s?.key === c.key
        ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: c.key, dir: c.numeric ? "desc" : "asc" },
    );
  }

  return (
    <div className="space-y-2">
      {exportName && rows.length > 0 && (
        <div className="flex justify-end">
          <Button
            icon={<Download />}
            onClick={() => {
              const cols = columns.filter((c) => !c.noExport);
              const csv = toCSV(
                sorted.map((r) => Object.fromEntries(cols.map((c) => [c.key, cellValue(r, c)]))),
                cols,
              );
              downloadCSV(`${exportName}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
            }}
          >
            Export CSV
          </Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-2xl border border-line bg-paper-raised">
        <table className="w-full text-left text-[12px]">
          <thead className="border-b border-line">
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                    className={cn("whitespace-nowrap px-3 py-2 font-medium text-ink-muted", c.numeric && "text-right")}
                  >
                    {c.noSort ? (
                      c.label
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleSort(c)}
                        className={cn(
                          "ring-focus inline-flex items-center gap-1 rounded hover:text-ink",
                          active && "text-ink",
                        )}
                      >
                        {c.label}
                        {active &&
                          (sort!.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-ink-muted">
                  {empty}
                </td>
              </tr>
            ) : (
              visible.map((r) => {
                const k = rowKey(r);
                const isOpen = open === k;
                return (
                  <TableRow
                    key={k}
                    row={r}
                    columns={columns}
                    open={isOpen}
                    onToggle={expand ? () => setOpen(isOpen ? null : k) : undefined}
                    details={isOpen && expand ? expand(r) : null}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {limit && sorted.length > limit && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="ring-focus rounded text-[12px] text-ink-muted hover:text-ink"
        >
          {showAll ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

function TableRow<T>({
  row,
  columns,
  open,
  onToggle,
  details,
}: {
  row: T;
  columns: Column<T>[];
  open: boolean;
  onToggle?: () => void;
  details: ReactNode;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={cn(
          "border-b border-line/60 last:border-0",
          onToggle && "cursor-pointer",
          open ? "bg-line/20" : "hover:bg-line/25",
        )}
      >
        {columns.map((c) => {
          const raw = cellValue(row, c);
          return (
            <td
              key={c.key}
              className={cn(
                "px-3 py-2 align-top text-ink",
                c.numeric && "whitespace-nowrap text-right tabular-nums",
                c.mono && "font-mono text-[11.5px]",
              )}
            >
              {c.render ? c.render(row) : raw === null || raw === undefined || raw === "" ? "—" : String(raw)}
            </td>
          );
        })}
      </tr>
      {details && (
        <tr className="border-b border-line/60 bg-line/20">
          <td colSpan={columns.length} className="px-3 pb-3 pt-0">
            {details}
          </td>
        </tr>
      )}
    </>
  );
}

/** Two-line user cell: name over email. */
export function UserCell({ name, email }: { name: string | null; email: string | null }) {
  return (
    <div className="min-w-0">
      <div className="truncate font-medium text-ink">{name || "—"}</div>
      <div className="truncate text-ink-muted">{email || "—"}</div>
    </div>
  );
}

// ---- CSV ----

export function toCSV(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(v);
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const head = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((row) => columns.map((c) => esc(row[c.key])).join(",")).join("\n");
  return `${head}\n${body}`;
}

export function downloadCSV(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
