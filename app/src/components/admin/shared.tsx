import { type ReactNode } from "react";
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

// Chart palette — uses the design-token RGB triplets from index.css so the
// dashboard matches the rest of the app in both light and dark themes.
export const CHART_COLORS = {
  accent: "rgb(var(--accent) / <alphaValue>)",
  ink: "rgb(var(--ink) / <alphaValue>)",
  inkMuted: "rgb(var(--ink-muted) / <alphaValue>)",
  line: "rgb(var(--line) / <alphaValue>)",
  success: "rgb(var(--success) / <alphaValue>)",
  warning: "rgb(var(--warning) / <alphaValue>)",
  error: "rgb(var(--error) / <alphaValue>)",
  info: "rgb(var(--info) / <alphaValue>)",
};

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
    <div className={cn("rounded-xl border border-line bg-paper-raised p-4", className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {sub && <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>}
        </div>
        {actions}
      </div>
      {children}
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
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} />
          <YAxis {...axisProps} tickFormatter={valueFormatter ? (v) => valueFormatter(Number(v)) : undefined} />
          <Tooltip
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
  return (
    <ChartCard title={title} sub={sub}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <defs>
            {series.map((s, i) => {
              const color = s.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length];
              return (
                <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
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
                fill={`url(#grad-${s.key})`}
                connectNulls
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
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
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} />
          <YAxis {...axisProps} tickFormatter={valueFormatter ? (v) => valueFormatter(Number(v)) : undefined} />
          <Tooltip
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
            contentStyle={tooltipStyle}
            labelStyle={{ color: "rgb(var(--ink-muted))" }}
            formatter={valueFormatter ? (v: number) => valueFormatter(v) : undefined}
          />
        </PieChart>
      </ResponsiveContainer>
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

// Export a small CSV-export helper for tables that want it.
export function toCSV(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  const head = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(",");
  const body = rows
    .map((row) =>
      columns
        .map((c) => {
          const v = row[c.key];
          if (v === null || v === undefined) return "";
          if (typeof v === "number") return String(v);
          return `"${String(v).replace(/"/g, '""')}"`;
        })
        .join(","),
    )
    .join("\n");
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
