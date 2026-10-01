import { Activity, AlertTriangle, DollarSign, Timer, TrendingUp, UserMinus, Users, Wallet } from "lucide-react";
import {
  AreaChartCard,
  ErrorBox,
  StatCard,
  StatGrid,
  TabStatus,
  rateTone,
  type ApiFetch,
  useAdminData,
} from "./shared";
import { formatMs, formatNumber, formatPct, formatUsd, shortDate } from "./format";
import type { ModelUsage, UsageRow } from "./UsageTab";

interface Metrics {
  total_users: number;
  active_users_30d: number;
  active_users_7d: number;
  new_users_this_week: number;
  new_users_this_month: number;
  churn_rate: number;
  paid_users: number;
  mrr: number;
  arpu: number;
  free_to_paid_conversion: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  estimated_cost_usd: number;
}

interface HealthHeadline {
  total_requests: number;
  failed_requests: number;
  error_rate: number;
  latency_p95_ms: number | null;
  ttft_p95_ms: number | null;
}

export function OverviewTab({
  apiFetch,
  refreshKey,
  onOpen,
}: {
  apiFetch: ApiFetch;
  refreshKey: number;
  onOpen: (tab: "health" | "models" | "usage") => void;
}) {
  const metrics = useAdminData<Metrics>(apiFetch, "/api/admin/metrics/overview", refreshKey);
  const usage = useAdminData<UsageRow[]>(apiFetch, "/api/admin/usage/by-time?days=30", refreshKey);
  const models = useAdminData<ModelUsage[]>(apiFetch, "/api/admin/usage/by-model?days=30", refreshKey);
  const health = useAdminData<HealthHeadline>(apiFetch, "/api/admin/metrics/health?days=1", refreshKey);

  const m = metrics.data;
  if (!m) return <TabStatus loading={metrics.loading} error={metrics.error} onRetry={metrics.reload} />;

  const chart = [...(usage.data ?? [])]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ date: shortDate(r.date), requests: r.requests }));
  const topModels = [...(models.data ?? [])]
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5);
  const maxReq = Math.max(1, ...topModels.map((x) => x.requests));
  const h = health.data;

  return (
    <div className="space-y-5">
      <StatGrid>
        <StatCard icon={Users} label="Users" value={formatNumber(m.total_users)} sub={`+${m.new_users_this_week} this week · +${m.new_users_this_month} this month`} />
        <StatCard icon={Activity} label="Active this week" value={formatNumber(m.active_users_7d)} sub={`${formatNumber(m.active_users_30d)} this month`} />
        <StatCard icon={DollarSign} label="MRR" value={formatUsd(m.mrr)} sub={`${formatUsd(m.arpu)} per user (ARPU)`} />
        <StatCard
          icon={TrendingUp}
          label="Paying users"
          value={formatNumber(m.paid_users)}
          sub={`${formatPct(m.free_to_paid_conversion)} of users convert`}
        />
      </StatGrid>
      <StatGrid>
        <StatCard
          icon={Wallet}
          label="Provider cost (est.)"
          value={formatUsd(m.estimated_cost_usd)}
          sub={`${formatNumber(m.total_prompt_tokens + m.total_completion_tokens)} tokens, all time`}
        />
        <StatCard
          icon={AlertTriangle}
          label="Errors, last 24h"
          value={h ? formatPct(h.error_rate) : "—"}
          tone={h ? rateTone(h.error_rate) : "default"}
          sub={h ? `${formatNumber(h.failed_requests)} of ${formatNumber(h.total_requests)} requests` : health.error || "…"}
        />
        <StatCard
          icon={Timer}
          label="Latency p95, last 24h"
          value={h ? formatMs(h.latency_p95_ms) : "—"}
          sub={h ? `TTFT p95 ${formatMs(h.ttft_p95_ms)}` : health.error || "…"}
          hint="95th percentile of total request time; TTFT is time to first token"
        />
        <StatCard
          icon={UserMinus}
          label="Lapsed"
          value={formatPct(m.churn_rate)}
          tone={m.churn_rate >= 0.5 ? "warn" : "default"}
          sub="active this month, not this week"
          hint="Share of 30-day active users with no request in the last 7 days (the API calls this churn_rate)"
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {usage.error ? (
            <ErrorBox message={usage.error} onRetry={usage.reload} />
          ) : (
            <AreaChartCard
              title="Requests per day"
              sub="last 30 days"
              data={chart}
              xKey="date"
              series={[{ key: "requests", label: "Requests" }]}
              valueFormatter={(v) => formatNumber(v)}
            />
          )}
        </div>
        <div className="rounded-2xl border border-line bg-paper-raised p-4">
          <h3 className="text-[13px] font-semibold text-ink">Top models</h3>
          <p className="mt-0.5 text-[12px] text-ink-muted">by requests, last 30 days</p>
          {models.error ? (
            <p className="mt-3 text-[12px] text-error">{models.error}</p>
          ) : topModels.length === 0 ? (
            <p className="mt-3 text-[12px] text-ink-faint">No requests yet.</p>
          ) : (
            <ul className="mt-3 space-y-2.5">
              {topModels.map((x) => (
                <li key={`${x.provider_name}/${x.model_id}`} className="text-[12px]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-[11.5px] text-ink">{x.model_id}</span>
                    <span className="shrink-0 tabular-nums text-ink-muted">{formatNumber(x.requests)}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-paper-sunken">
                    <div className="h-full rounded-full bg-accent/50" style={{ width: `${(x.requests / maxReq) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => onOpen("models")}
            className="ring-focus mt-3 rounded text-[12px] text-ink-muted hover:text-ink"
          >
            All models →
          </button>
        </div>
      </div>

      {h && h.error_rate >= 0.05 && (
        <div className="rounded-2xl border border-error/25 bg-error/10 px-4 py-3 text-[12.5px] text-error">
          {formatPct(h.error_rate)} of requests failed in the last 24 hours.{" "}
          <button type="button" onClick={() => onOpen("health")} className="ring-focus rounded font-medium underline">
            Open Health
          </button>
        </div>
      )}

      <p className="text-[11.5px] text-ink-faint">
        Costs are estimated from token counts and list prices. Active means at least one gateway request. Days are UTC.
      </p>
    </div>
  );
}
