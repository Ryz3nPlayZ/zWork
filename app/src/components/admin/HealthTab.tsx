import { useState } from "react";
import { AlertTriangle, Activity, Clock, Zap } from "lucide-react";
import {
  AreaChartCard,
  BarChartCard,
  DataTable,
  DonutCard,
  LineChartCard,
  StatCard,
  StatGrid,
  StatusBadge,
  TabStatus,
  TabToolbar,
  TONE_COLOR,
  WindowPicker,
  rateTone,
  type ApiFetch,
  type SeriesPoint,
  type StatTone,
  useAdminData,
} from "./shared";
import { SectionHeading } from "../page/Page";
import { cn } from "../../lib/cn";
import { formatMs, formatNumber, formatPct, formatRelative, shortDate } from "./format";

interface HealthStatusSlice {
  bucket: string;
  count: number;
}
interface HealthDayPoint {
  date: string;
  requests: number;
  errors: number;
  error_rate: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  p99_latency_ms: number | null;
  p50_ttft_ms: number | null;
  p95_ttft_ms: number | null;
}
interface FailingModel {
  model_id: string;
  provider_name: string | null;
  total_requests: number;
  failed_requests: number;
  failure_rate: number;
}
interface ProviderHealth {
  provider_name: string;
  total_requests: number;
  failed_requests: number;
  failure_rate: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  requests_limit_day: number | null;
  requests_remaining_day: number | null;
  saturation_pct: number | null;
  last_status: number | null;
  last_model_id: string | null;
  observed_at: string | null;
}
interface HealthOverview {
  window_days: number;
  total_requests: number;
  failed_requests: number;
  error_rate: number;
  retried_requests: number;
  status_breakdown: HealthStatusSlice[];
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_p99_ms: number | null;
  ttft_p50_ms: number | null;
  ttft_p95_ms: number | null;
  daily: HealthDayPoint[];
  top_failing_models: FailingModel[];
}

const STATUS_COLORS: Record<string, string> = {
  "2xx": TONE_COLOR.success,
  "3xx": TONE_COLOR.info,
  "4xx": TONE_COLOR.warning,
  "5xx": TONE_COLOR.error,
  unknown: TONE_COLOR.muted,
};

const SAT_BAR: Record<StatTone, string> = {
  default: "bg-ink-faint",
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-error",
};

export function HealthTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const [days, setDays] = useState(7);
  const health = useAdminData<HealthOverview>(apiFetch, `/api/admin/metrics/health?days=${days}`, refreshKey);
  const providers = useAdminData<ProviderHealth[]>(apiFetch, `/api/admin/metrics/providers?days=${days}`, refreshKey);
  const h = health.data;

  const toolbar = (
    <TabToolbar>
      <WindowPicker value={days} options={[1, 7, 30, 90]} onChange={setDays} />
    </TabToolbar>
  );
  if (!h) {
    return (
      <div className="space-y-5">
        {toolbar}
        <TabStatus loading={health.loading} error={health.error} onRetry={health.reload} />
      </div>
    );
  }

  const dailyLatency: SeriesPoint[] = h.daily.map((d) => ({
    date: shortDate(d.date),
    p50: d.p50_latency_ms,
    p95: d.p95_latency_ms,
    p99: d.p99_latency_ms,
  }));
  const dailyError: SeriesPoint[] = h.daily.map((d) => ({
    date: shortDate(d.date),
    error_rate: Number((d.error_rate * 100).toFixed(2)),
  }));
  const dailyTtft: SeriesPoint[] = h.daily.map((d) => ({
    date: shortDate(d.date),
    p50: d.p50_ttft_ms,
    p95: d.p95_ttft_ms,
  }));
  const statusDonut = h.status_breakdown.map((s) => ({
    name: s.bucket,
    value: s.count,
    color: STATUS_COLORS[s.bucket] ?? TONE_COLOR.muted,
  }));
  const windowLabel = days === 1 ? "last 24h" : `last ${h.window_days} days`;

  return (
    <div className="space-y-5">
      {toolbar}

      <StatGrid>
        <StatCard icon={Activity} label="Requests" value={formatNumber(h.total_requests)} sub={windowLabel} />
        <StatCard
          icon={AlertTriangle}
          label="Error rate"
          value={formatPct(h.error_rate)}
          tone={rateTone(h.error_rate)}
          sub={`${formatNumber(h.failed_requests)} failed · ${formatNumber(h.retried_requests)} retried`}
          hint="Failed = no upstream response or status ≥ 400"
        />
        <StatCard
          icon={Clock}
          label="Latency p95"
          value={formatMs(h.latency_p95_ms)}
          sub={`p50 ${formatMs(h.latency_p50_ms)} · p99 ${formatMs(h.latency_p99_ms)}`}
        />
        <StatCard
          icon={Zap}
          label="First token p95"
          value={formatMs(h.ttft_p95_ms)}
          sub={`p50 ${formatMs(h.ttft_p50_ms)}`}
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <LineChartCard
            title="Latency percentiles"
            sub="total request duration, per day"
            data={dailyLatency}
            xKey="date"
            series={[
              { key: "p50", label: "p50" },
              { key: "p95", label: "p95" },
              { key: "p99", label: "p99" },
            ]}
            valueFormatter={(v) => formatMs(v)}
          />
        </div>
        <DonutCard title="Status codes" sub={windowLabel} data={statusDonut} valueFormatter={(v) => v.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <AreaChartCard
          title="Time to first token"
          sub="streaming TTFT, per day"
          data={dailyTtft}
          xKey="date"
          series={[
            { key: "p50", label: "p50" },
            { key: "p95", label: "p95" },
          ]}
          valueFormatter={(v) => formatMs(v)}
        />
        <LineChartCard
          title="Error rate"
          sub="per day, %"
          data={dailyError}
          xKey="date"
          series={[{ key: "error_rate", label: "error %", color: TONE_COLOR.error }]}
          valueFormatter={(v) => `${v}%`}
        />
      </div>

      <div>
        <SectionHeading title="Failing models" count={h.top_failing_models.length} className="mt-2" />
        <DataTable
          rows={h.top_failing_models}
          rowKey={(m) => `${m.provider_name ?? ""}/${m.model_id}`}
          defaultSort={{ key: "failed_requests", dir: "desc" }}
          empty="No failures in this window."
          exportName={`failing-models-${days}d`}
          columns={[
            { key: "model_id", label: "Model", mono: true },
            { key: "provider_name", label: "Provider" },
            { key: "total_requests", label: "Requests", numeric: true, render: (m) => formatNumber(m.total_requests) },
            { key: "failed_requests", label: "Failed", numeric: true, render: (m) => formatNumber(m.failed_requests) },
            {
              key: "failure_rate",
              label: "Fail rate",
              numeric: true,
              render: (m) => (
                <span className={cn(rateTone(m.failure_rate) === "error" && "text-error", rateTone(m.failure_rate) === "warn" && "text-warning")}>
                  {formatPct(m.failure_rate)}
                </span>
              ),
            },
          ]}
        />
        {h.top_failing_models.length > 0 && (
          <div className="mt-3">
            <BarChartCard
              title="Failures by model"
              sub={windowLabel}
              data={h.top_failing_models.map((m) => ({
                name: m.model_id.length > 24 ? m.model_id.slice(0, 22) + "…" : m.model_id,
                failures: m.failed_requests,
              }))}
              xKey="name"
              series={[{ key: "failures", label: "Failures", color: TONE_COLOR.error }]}
              height={200}
            />
          </div>
        )}
      </div>

      <div>
        <SectionHeading title="Providers" count={providers.data?.length} className="mt-2" />
        {!providers.data ? (
          <TabStatus loading={providers.loading} error={providers.error} onRetry={providers.reload} />
        ) : providers.data.length === 0 ? (
          <p className="text-[13px] text-ink-muted">No provider activity in this window.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {providers.data.map((p) => (
              <ProviderCard key={p.provider_name} p={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderHealth }) {
  const sat = p.saturation_pct;
  const satTone: StatTone = sat === null ? "default" : sat >= 80 ? "error" : sat >= 50 ? "warn" : "ok";
  const failTone = rateTone(p.failure_rate);
  return (
    <div className="rounded-2xl border border-line bg-paper-raised p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-ink">{p.provider_name}</div>
          <div className="truncate font-mono text-[11.5px] text-ink-muted">
            {p.last_model_id ?? "—"}
            {p.observed_at && <span className="font-sans text-ink-faint"> · {formatRelative(p.observed_at)}</span>}
          </div>
        </div>
        {p.last_status !== null && <StatusBadge code={p.last_status} />}
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-2 text-[12px]">
        <Metric label="Requests" value={formatNumber(p.total_requests)} />
        <Metric
          label="Fail rate"
          value={formatPct(p.failure_rate)}
          className={failTone === "error" ? "text-error" : failTone === "warn" ? "text-warning" : undefined}
        />
        <Metric label="p95" value={formatMs(p.p95_latency_ms)} />
        <Metric label="Avg" value={formatMs(p.avg_latency_ms)} />
      </dl>
      {sat !== null && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11.5px] text-ink-muted">
            <span>Daily rate limit used</span>
            <span className={cn("font-medium tabular-nums", satTone === "error" ? "text-error" : satTone === "warn" ? "text-warning" : "text-ink")}>
              {sat.toFixed(0)}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper-sunken">
            <div
              className={cn("h-full rounded-full", SAT_BAR[satTone])}
              style={{ width: `${Math.min(100, Math.max(0, sat))}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] text-ink-faint">
            {p.requests_remaining_day?.toLocaleString() ?? "—"} of {p.requests_limit_day?.toLocaleString() ?? "—"} left today
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-faint">{label}</dt>
      <dd className={cn("truncate font-medium tabular-nums text-ink", className)}>{value}</dd>
    </div>
  );
}
