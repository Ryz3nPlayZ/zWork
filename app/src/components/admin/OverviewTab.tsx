import { Activity, AlertTriangle, CheckCircle2, ChevronRight, DollarSign, Percent, Timer, TrendingUp, Users, Wallet } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  AreaChartCard,
  ErrorBox,
  StatCard,
  StatGrid,
  TabStatus,
  change,
  rateTone,
  type AdminTabId,
  type ApiFetch,
  useAdminData,
} from "./shared";
import { formatMs, formatNumber, formatPct, formatUsd, shortDate } from "./format";
import type { ModelUsage, UsageRow } from "./UsageTab";
import type { FinanceOverview } from "./FinanceTab";
import type { StatusOverview } from "./StatusTab";
import type { DownloadsOverview } from "./GrowthTab";

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
  onOpen: (tab: AdminTabId) => void;
}) {
  const metrics = useAdminData<Metrics>(apiFetch, "/api/admin/metrics/overview", refreshKey);
  const usage = useAdminData<UsageRow[]>(apiFetch, "/api/admin/usage/by-time?days=30", refreshKey);
  const models = useAdminData<ModelUsage[]>(apiFetch, "/api/admin/usage/by-model?days=30", refreshKey);
  const health = useAdminData<HealthHeadline>(apiFetch, "/api/admin/metrics/health?days=1", refreshKey);
  const finance = useAdminData<FinanceOverview>(apiFetch, "/api/admin/metrics/finance?days=30", refreshKey);
  const status = useAdminData<StatusOverview>(apiFetch, "/api/admin/metrics/status", refreshKey);
  const downloads = useAdminData<DownloadsOverview>(apiFetch, "/api/admin/metrics/downloads", refreshKey);

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
  const f = finance.data;
  const attention = attentionItems(m, h, f, status.data, downloads.data);

  return (
    <div className="space-y-5">
      <AttentionPanel items={attention} onOpen={onOpen} loading={finance.loading || status.loading} />
      <StatGrid>
        <StatCard
          icon={Users}
          label="Users"
          value={formatNumber(m.total_users)}
          sub={`+${m.new_users_this_week} this week · +${m.new_users_this_month} this month`}
        />
        <StatCard
          icon={Activity}
          label="Active this week"
          value={formatNumber(m.active_users_7d)}
          sub={`${formatNumber(m.active_users_30d)} this month · ${formatPct(m.churn_rate, 0)} lapsed`}
          hint="Lapsed: share of 30-day active users with no request in the last 7 days"
        />
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
          label="Upstream spend, 30d"
          value={f ? formatUsd(f.spend_usd) : formatUsd(m.estimated_cost_usd)}
          delta={f ? { ratio: change(f.spend_usd, f.prev_spend_usd), good: "down", label: "vs the 30 days before" } : undefined}
          sub={f ? `${formatUsd(f.free_spend_usd)} on free users` : "all time"}
          hint="Estimated provider cost of hosted-model requests"
        />
        <StatCard
          icon={Percent}
          label="Gross margin, 30d"
          value={f ? `${f.margin_usd < 0 ? "−" : ""}${formatUsd(Math.abs(f.margin_usd))}` : "—"}
          tone={!f || f.margin_pct === null ? "default" : f.margin_pct >= 50 ? "ok" : f.margin_pct >= 0 ? "warn" : "error"}
          sub={f ? (f.margin_pct === null ? "no revenue yet" : `${f.margin_pct.toFixed(0)}% · ${formatUsd(f.projected_month_spend_usd)} spend projected this month`) : finance.error || "…"}
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


      <p className="text-[11.5px] text-ink-faint">
        Costs are estimated from token counts and list prices. Active means at least one gateway request. Days are UTC.
      </p>
    </div>
  );
}

interface Attention {
  tone: "error" | "warn" | "ok";
  text: string;
  tab: AdminTabId;
}

/** Everything on the other tabs that someone should look at today. */
function attentionItems(
  m: Metrics,
  h: HealthHeadline | null,
  f: FinanceOverview | null,
  st: StatusOverview | null,
  dl: DownloadsOverview | null,
): Attention[] {
  const out: Attention[] = [];
  for (const s of st?.surfaces ?? []) {
    if (!s.ok) out.push({ tone: "error", text: `${s.name} (${s.url.replace(/^https?:\/\//, "")}) answered ${s.status ?? "nothing"}, expected ${s.expect}`, tab: "status" });
  }
  if (st && !st.database.ok) out.push({ tone: "error", text: "The database probe failed", tab: "status" });
  if (h && h.error_rate >= 0.02) {
    out.push({
      tone: h.error_rate >= 0.05 ? "error" : "warn",
      text: `${formatPct(h.error_rate)} of requests failed in the last 24 hours`,
      tab: "health",
    });
  }
  if (f && f.unprofitable_users > 0) {
    out.push({
      tone: "error",
      text: `${f.unprofitable_users} paying ${f.unprofitable_users === 1 ? "user costs" : "users cost"} more than their plan`,
      tab: "finance",
    });
  }
  if (f && f.margin_pct !== null && f.margin_pct < 30) {
    out.push({ tone: "warn", text: `Gross margin is ${f.margin_pct.toFixed(0)}% over 30 days`, tab: "finance" });
  }
  if (f && f.spend_usd > 0 && f.free_spend_usd / f.spend_usd > 0.5) {
    out.push({ tone: "warn", text: `Free users are ${formatPct(f.free_spend_usd / f.spend_usd, 0)} of upstream spend`, tab: "finance" });
  }
  if (f && f.unpriced_requests > 0) {
    const models = f.by_model.filter((x) => x.unpriced_requests > 0).map((x) => x.model);
    out.push({
      tone: "warn",
      text: `${formatNumber(f.unpriced_requests)} requests have no price${models.length ? ` (${models.slice(0, 2).join(", ")})` : ""}, so spend is understated`,
      tab: "finance",
    });
  }
  if (f && f.last_month_spend_usd > 0 && f.projected_month_spend_usd > f.last_month_spend_usd * 1.5) {
    out.push({
      tone: "warn",
      text: `Spend is on track for ${formatUsd(f.projected_month_spend_usd)} this month, vs ${formatUsd(f.last_month_spend_usd)} last month`,
      tab: "finance",
    });
  }
  if (dl?.source_error) out.push({ tone: "warn", text: "GitHub download stats are stale", tab: "growth" });
  if (dl) {
    const rel = dl.releases.find((r) => !r.prerelease);
    const latest = rel?.tag.replace(/^v/, "");
    const total = dl.versions_in_use.reduce((s, v) => s + v.users, 0);
    const on = dl.versions_in_use.find((v) => v.version === latest)?.users ?? 0;
    // Give a release a week to roll out through the auto-updater first.
    const ageDays = rel?.published_at ? (Date.now() - new Date(rel.published_at).getTime()) / 86_400_000 : 0;
    if (latest && ageDays >= 7 && total >= 10 && on / total < 0.5) {
      out.push({ tone: "warn", text: `Only ${formatPct(on / total, 0)} of active users run v${latest}`, tab: "growth" });
    }
  }
  if (m.churn_rate >= 0.5) {
    out.push({ tone: "warn", text: `${formatPct(m.churn_rate, 0)} of this month's active users went quiet this week`, tab: "engagement" });
  }
  const rank = { error: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

function AttentionPanel({ items, onOpen, loading }: { items: Attention[]; onOpen: (t: AdminTabId) => void; loading: boolean }) {
  if (items.length === 0) {
    if (loading) return null;
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-success/25 bg-success/10 px-4 py-2.5 text-[12.5px] text-success">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        Nothing needs attention: every surface is up, errors are low and every paying user is profitable.
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-line bg-paper-raised">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
        <h3 className="text-[13px] font-semibold text-ink">Needs attention</h3>
        <span className="text-[12px] text-ink-muted">{items.length}</span>
      </div>
      <ul className="divide-y divide-line/60">
        {items.map((it, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onOpen(it.tab)}
              className="ring-focus group flex w-full items-center gap-2.5 px-4 py-2 text-left text-[12.5px] hover:bg-line/25"
            >
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", it.tone === "error" ? "bg-error" : "bg-warning")} />
              <span className="min-w-0 flex-1 text-ink">{it.text}</span>
              <span className="flex shrink-0 items-center gap-0.5 text-[11.5px] capitalize text-ink-faint group-hover:text-ink-muted">
                {it.tab}
                <ChevronRight className="h-3.5 w-3.5" />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
