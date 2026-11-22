import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartSpec } from "./chartSpec";

// Ink first, then the status hues; a fifth series repeats the first colour.
const COLORS = ["rgb(var(--ink))", "rgb(var(--info))", "rgb(var(--success))", "rgb(var(--warning))"];

export const tooltipStyle = {
  backgroundColor: "rgb(var(--paper-raised))",
  border: "1px solid rgb(var(--line))",
  borderRadius: "8px",
  fontSize: "12px",
  color: "rgb(var(--ink))",
} as const;

export const axisProps = {
  tick: { fontSize: 11, fill: "rgb(var(--ink-muted))" },
  stroke: "rgb(var(--line))",
  tickLine: false,
} as const;

/** 1234567890 → "1.23B"; keeps small numbers as they are. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function ChartBlock({ spec }: { spec: ChartSpec }) {
  // "$B" → "$391B", "%" → "12.3%": a leading $ goes in front, the rest after.
  const pre = spec.unit?.startsWith("$") ? "$" : "";
  const suf = (spec.unit ?? "").replace(/^\$/, "");
  const fmt = (v: number) => `${pre}${compact(Number(v))}${suf}`;
  const common = {
    data: spec.data,
    margin: { top: 8, right: 8, bottom: 0, left: 0 },
  };
  const axes = (
    <>
      <CartesianGrid stroke="rgb(var(--line-soft))" strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey={spec.x} {...axisProps} minTickGap={16} />
      <YAxis {...axisProps} width={56} tickFormatter={fmt} domain={["auto", "auto"]} />
      <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "rgb(var(--ink-muted))" }} formatter={(v) => fmt(Number(v))} />
      {spec.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
    </>
  );
  return (
    <figure className="my-2 rounded-xl border border-line bg-paper-raised p-3">
      {spec.title && <figcaption className="mb-2 text-[12.5px] font-medium text-ink">{spec.title}</figcaption>}
      <div className="h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === "bar" ? (
            <BarChart {...common}>
              {axes}
              {spec.series.map((k, i) => (
                <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} maxBarSize={36} />
              ))}
            </BarChart>
          ) : (
            <LineChart {...common}>
              {axes}
              {spec.series.map((k, i) => (
                <Line key={k} dataKey={k} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} type="monotone" />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
