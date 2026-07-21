import { useEffect, useState } from "react";
import { AlertTriangle, Activity, Clock, Zap } from "lucide-react";
import {
  AreaChartCard,
  BarChartCard,
  DonutCard,
  LineChartCard,
  SERIES_PALETTE,
  type SeriesPoint,
} from "./shared";
import { cn } from "../../lib/cn";

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
  "2xx": "#10b981",
  "3xx": "#3b82f6",
  "4xx": "#f59e0b",
  "5xx": "#ef4444",
  unknown: "#9ca3af",
};

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  tone?: "default" | "warn" | "error" | "ok";
}) {
  const toneColor =
    tone === "warn"
      ? "text-amber-500"
      : tone === "error"
        ? "text-red-500"
        : tone === "ok"
          ? "text-emerald-500"
          : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-paper-raised p-4">
      <div className="flex items-center gap-2 text-ink-muted">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className={cn("mt-2 text-2xl font-semibold", toneColor)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

function pct(v: number | null | undefined, suffix = "%") {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}${suffix}`;
}
function ms(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

export function HealthTab({ apiFetch }: { apiFetch: <T>(path: string) => Promise<T> }) {
  const [health, setHealth] = useState<HealthOverview | null>(null);
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr("");
    Promise.all([
      apiFetch<HealthOverview>(`/api/admin/metrics/health?days=${days}`),
      apiFetch<ProviderHealth[]>(`/api/admin/metrics/providers?days=${days}`),
    ])
      .then(([h, p]) => {
        if (cancelled) return;
        setHealth(h);
        setProviders(p);
      })
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days, apiFetch]);

  if (loading && !health) {
    return <div className="flex items-center justify-center py-20 text-sm text-ink-muted">Loading…</div>;
  }
  if (err || !health) {
    return <div className="flex items-center justify-center py-20 text-sm text-red-500">{err || "No data"}</div>;
  }

  const errorTone = health.error_rate >= 0.05 ? "error" : health.error_rate >= 0.02 ? "warn" : "ok";

  const dailyLatency: SeriesPoint[] = health.daily.map((d) => ({
    date: d.date.slice(5),
    p50: d.p50_latency_ms,
    p95: d.p95_latency_ms,
    p99: d.p99_latency_ms,
  }));
  const dailyError: SeriesPoint[] = health.daily.map((d) => ({
    date: d.date.slice(5),
    error_rate: Number((d.error_rate * 100).toFixed(2)),
  }));
  const dailyTtft: SeriesPoint[] = health.daily.map((d) => ({
    date: d.date.slice(5),
    p50: d.p50_ttft_ms,
    p95: d.p95_ttft_ms,
  }));
  const failingModels: SeriesPoint[] = health.top_failing_models.map((m) => ({
    name: m.model_id.length > 24 ? m.model_id.slice(0, 22) + "…" : m.model_id,
    failures: m.failed_requests,
  }));
  const statusDonut = health.status_breakdown.map((s) => ({
    name: s.bucket,
    value: s.count,
    color: STATUS_COLORS[s.bucket] ?? SERIES_PALETTE[7],
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-muted">Window:</span>
        {[1, 7, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              days === d ? "bg-accent text-white" : "bg-paper-sunken text-ink-muted hover:text-ink",
            )}
          >
            {d === 1 ? "24h" : `${d}d`}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Activity} label="Total Requests" value={health.total_requests.toLocaleString()} sub={`${health.window_days}d window`} />
        <StatCard icon={AlertTriangle} label="Error Rate" value={pct(health.error_rate)} tone={errorTone as "ok" | "warn" | "error"} sub={`${health.failed_requests.toLocaleString()} failed`} />
        <StatCard icon={Clock} label="p95 Latency" value={ms(health.latency_p95_ms)} sub={`p99 ${ms(health.latency_p99_ms)}`} />
        <StatCard icon={Zap} label="p95 TTFT" value={ms(health.ttft_p95_ms)} sub={`p50 ${ms(health.ttft_p50_ms)}`} />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={AlertTriangle} label="Retried Requests" value={health.retried_requests.toLocaleString()} />
        <StatCard icon={Clock} label="p50 Latency" value={ms(health.latency_p50_ms)} />
        <StatCard icon={Zap} label="p50 TTFT" value={ms(health.ttft_p50_ms)} />
        <StatCard icon={Activity} label="Failed" value={health.failed_requests.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
            valueFormatter={(v) => ms(v)}
          />
        </div>
        <DonutCard
          title="Status codes"
          sub={`${health.window_days}d`}
          data={statusDonut}
          valueFormatter={(v) => v.toLocaleString()}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Time to first token"
            sub="streaming TTFT, per day"
            data={dailyTtft}
            xKey="date"
            series={[
              { key: "p50", label: "p50" },
              { key: "p95", label: "p95" },
            ]}
            valueFormatter={(v) => ms(v)}
          />
        </div>
        <LineChartCard
          title="Error rate"
          sub="per day, %"
          data={dailyError}
          xKey="date"
          series={[{ key: "error_rate", label: "error %", color: "#ef4444" }]}
          valueFormatter={(v) => `${v}%`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BarChartCard
          title="Top failing models"
          sub={`last ${health.window_days} days`}
          data={failingModels}
          xKey="name"
          series={[{ key: "failures", label: "Failures", color: "#ef4444" }]}
        />
      </div>

      {/* Provider cards */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">Providers</h3>
        {providers.length === 0 ? (
          <p className="text-sm text-ink-muted">No provider activity in this window.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {providers.map((p) => {
              const sat = p.saturation_pct;
              const satTone = sat === null ? "default" : sat >= 80 ? "error" : sat >= 50 ? "warn" : "ok";
              const failTone = p.failure_rate >= 0.05 ? "error" : p.failure_rate >= 0.02 ? "warn" : "ok";
              return (
                <div key={p.provider_name} className="rounded-xl border border-line bg-paper-raised p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-mono text-sm font-semibold text-ink">{p.provider_name}</div>
                      {p.last_model_id && <div className="text-xs text-ink-muted">{p.last_model_id}</div>}
                    </div>
                    {p.last_status !== null && (
                      <span className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-bold",
                        p.last_status < 300 ? "bg-emerald-100 text-emerald-700" :
                        p.last_status < 400 ? "bg-blue-100 text-blue-700" :
                        p.last_status < 500 ? "bg-amber-100 text-amber-700" :
                        "bg-red-100 text-red-700",
                      )}>
                        {p.last_status}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-ink-muted">Requests</div>
                      <div className="font-medium text-ink">{p.total_requests.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-ink-muted">Fail rate</div>
                      <div className={cn(
                        "font-medium",
                        failTone === "error" ? "text-red-500" : failTone === "warn" ? "text-amber-500" : "text-ink",
                      )}>{(p.failure_rate * 100).toFixed(1)}%</div>
                    </div>
                    <div>
                      <div className="text-ink-muted">p95 latency</div>
                      <div className="font-medium text-ink">{ms(p.p95_latency_ms)}</div>
                    </div>
                    <div>
                      <div className="text-ink-muted">Avg latency</div>
                      <div className="font-medium text-ink">{ms(p.avg_latency_ms)}</div>
                    </div>
                  </div>
                  {sat !== null && (
                    <div className="mt-3">
                      <div className="mb-1 flex items-center justify-between text-xs text-ink-muted">
                        <span>Rate-limit saturation</span>
                        <span className={cn(
                          "font-medium",
                          satTone === "error" ? "text-red-500" : satTone === "warn" ? "text-amber-500" : "text-ink",
                        )}>{sat.toFixed(0)}%</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper-sunken">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            satTone === "error" ? "bg-red-500" : satTone === "warn" ? "bg-amber-500" : "bg-emerald-500",
                          )}
                          style={{ width: `${Math.min(100, Math.max(0, sat))}%` }}
                        />
                      </div>
                      <div className="mt-1 text-[10px] text-ink-muted">
                        {p.requests_remaining_day?.toLocaleString() ?? "—"} / {p.requests_limit_day?.toLocaleString() ?? "—"} remaining today
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
