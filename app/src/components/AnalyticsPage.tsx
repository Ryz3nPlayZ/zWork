import { useEffect, useState } from "react";
import {
  Clock,
  TrendingUp,
  Loader2,
  Zap,
  Activity,
  ChevronRight,
  Server,
} from "lucide-react";
import { cn } from "../lib/cn";
import { fetchAnalyticsSummary, type AnalyticsDay, type AnalyticsSummary } from "../lib/cloud";

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatDayLabel(day: string) {
  const date = new Date(`${day}T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function buildSeries(days: number, rows: AnalyticsDay[]) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const today = new Date();
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - index - 1));
    const key = dateKey(date);
    const row = byDay.get(key);
    return {
      date: formatDayLabel(key),
      value: (row?.roots || 0) + (row?.continuations || 0),
    };
  });
}

const CHART_DAYS = 14;

export function AnalyticsPage() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    void fetchAnalyticsSummary()
      .then((data) => {
        if (!alive) return;
        setSummary(data);
      })
      .catch((err) => {
        if (!alive) return;
        setSummary(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const chartData = summary
    ? buildSeries(CHART_DAYS, summary.past_week.length > 0 ? summary.past_week : [])
    : [];
  const maxValue = Math.max(1, ...chartData.map((d) => d.value));

  const totalRequests = summary
    ? (summary.root_requests_today ?? 0) + (summary.continuation_requests_today ?? 0)
    : 0;

  const tier = summary?.user?.tier ?? "free";
  const tierLabel = tier === "max" ? "Max" : tier === "pro" ? "Pro" : "Free";
  const tierColor =
    tier === "max" ? "bg-amber-500/10 text-amber-600" :
    tier === "pro" ? "bg-accent/10 text-ink" :
    "bg-ink/5 text-ink-soft";

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-8">
        {/* Header */}
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-[28px] font-semibold tracking-tight text-ink">Analytics</h1>
              <span className={cn("rounded-full px-2.5 py-0.5 text-[12px] font-medium", tierColor)}>
                {tierLabel}
              </span>
            </div>
            <p className="mt-1.5 text-[14px] leading-relaxed text-ink-soft">
              Track your usage and activity over time.
            </p>
          </div>
        </header>

        {error && (
          <section className="mb-6 rounded-2xl border border-line bg-paper-raised p-5">
            <div className="text-[13px] font-semibold text-ink">Usage unavailable</div>
            <p className="mt-2 text-[13px] leading-5 text-ink-soft">
              {error.includes("401") ? "Sign in to view your usage." : error}
            </p>
          </section>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <LimitCard
            icon={<Clock className="h-4 w-4" />}
            label="5-hour window"
            used={summary?.five_hour_used ?? 0}
            limit={summary?.five_hour_limit ?? 0}
            loading={loading}
          />
          <LimitCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Weekly"
            used={summary?.weekly_used ?? 0}
            limit={summary?.weekly_limit ?? 0}
            loading={loading}
          />
          <StatCard
            icon={<Activity className="h-4 w-4" />}
            label="Today"
            value={totalRequests}
            sublabel="root + continuation"
            loading={loading}
          />
          <StatCard
            icon={<Zap className="h-4 w-4" />}
            label="All time"
            value={summary?.root_requests_total ?? 0}
            sublabel="root requests"
            loading={loading}
          />
        </div>

        {/* Activity chart */}
        <section className="rounded-2xl border border-line bg-paper-raised p-6 mb-6">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-ink-soft" />
              <h2 className="text-[15px] font-semibold text-ink">Activity</h2>
              <span className="text-[12px] text-ink-faint">last {CHART_DAYS} days</span>
            </div>
            {summary?.active_runs ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-0.5 text-[12px] font-medium text-ink">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
                </span>
                {summary.active_runs} active
              </span>
            ) : null}
          </div>

          {loading && !summary ? (
            <div className="flex h-[240px] items-center justify-center text-[13px] text-ink-soft">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading activity…
            </div>
          ) : chartData.length === 0 || chartData.every((d) => d.value === 0) ? (
            <div className="flex h-[240px] items-center justify-center">
              <p className="text-[13px] text-ink-soft">No activity yet.</p>
            </div>
          ) : (
            <div className="relative" role="img" aria-label="Activity chart">
              {/* Y-axis */}
              <div className="absolute inset-y-0 left-0 flex w-10 flex-col justify-between text-[11px] text-ink-faint py-2">
                <span>{formatNumber(maxValue)}</span>
                <span>{formatNumber(Math.round(maxValue / 2))}</span>
                <span>0</span>
              </div>

              {/* Chart */}
              <div className="relative ml-10" style={{ height: "240px" }}>
                {/* Grid lines */}
                <div className="pointer-events-none absolute inset-0 py-2">
                  {[0, 0.5].map((pos) => (
                    <div
                      key={pos}
                      className="absolute left-0 right-0 border-t border-line/40"
                      style={{ top: `${pos * 100}%` }}
                    />
                  ))}
                </div>

                {/* Bars */}
                <div className="relative flex h-full items-end gap-[3px] py-2">
                  {chartData.map((day, i) => {
                    const h = day.value > 0 ? Math.max(4, (day.value / maxValue) * 232) : 0;
                    return (
                      <div
                        key={`${day.date}-${i}`}
                        className="group flex-1 flex flex-col justify-end"
                        style={{ minWidth: 1 }}
                      >
                        <div
                          className={cn(
                            "w-full rounded-t-sm transition-colors",
                            day.value > 0 ? "bg-accent/50 hover:bg-accent/70" : "bg-line/30"
                          )}
                          style={{ height: `${h}px` }}
                          title={`${day.date}: ${formatNumber(day.value)} requests`}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* X-axis */}
              <div className="ml-10 mt-3 flex text-[11px] text-ink-faint">
                <span>{chartData[0]?.date}</span>
                <span className="flex-1 text-center">{chartData[Math.floor(chartData.length / 2)]?.date}</span>
                <span>{chartData[chartData.length - 1]?.date}</span>
              </div>
            </div>
          )}
        </section>

        {/* Gateway status */}
        {summary && (
          <section className="rounded-2xl border border-line bg-paper-raised p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-lg",
                  summary.managed_gateway_ready ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-500"
                )}>
                  <Server className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-ink">{summary.router_label}</div>
                  <div className="text-[12px] text-ink-soft">{summary.managed_gateway_status}</div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-[12px] text-ink-faint">
                {summary.managed_gateway_ready ? "Online" : "Offline"}
                <ChevronRight className="h-3.5 w-3.5" />
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Limit card — used / limit with progress bar                        */
/* ------------------------------------------------------------------ */
function LimitCard({
  icon,
  label,
  used,
  limit,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  used: number;
  limit: number;
  loading: boolean;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const isHigh = pct > 80;
  const isCritical = pct > 95;

  return (
    <section className="rounded-2xl border border-line bg-paper-raised p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-sunken text-ink-soft">
            {icon}
          </div>
          <span className="text-[13px] font-semibold text-ink">{label}</span>
        </div>
        <div className="text-right">
          <div className={cn("text-[22px] font-semibold tracking-tight text-ink", loading && "opacity-40")}>
            {loading ? "…" : formatNumber(used)}
          </div>
          <div className="text-[11px] text-ink-faint">
            {loading ? "…" : `of ${formatNumber(limit)}`}
          </div>
        </div>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-paper-sunken"
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={`${label}: ${used} of ${limit}`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            isCritical ? "bg-red-500" : isHigh ? "bg-amber-500" : "bg-accent/60"
          )}
          style={{ width: `${Math.max(pct, 0.5)}%` }}
        />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Simple stat card — just a number                                   */
/* ------------------------------------------------------------------ */
function StatCard({
  icon,
  label,
  value,
  sublabel,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sublabel: string;
  loading: boolean;
}) {
  return (
    <section className="rounded-2xl border border-line bg-paper-raised p-5">
      <div className="flex items-center gap-2.5 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-sunken text-ink-soft">
          {icon}
        </div>
        <span className="text-[13px] font-semibold text-ink">{label}</span>
      </div>
      <div className={cn("text-[28px] font-semibold tracking-tight text-ink", loading && "opacity-40")}>
        {loading ? "…" : formatNumber(value)}
      </div>
      <div className="text-[11px] text-ink-faint mt-0.5">{sublabel}</div>
    </section>
  );
}
