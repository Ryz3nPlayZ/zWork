import { useEffect, useState } from "react";
import {
  TrendingUp,
  Loader2,
  Zap,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
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

export function AnalyticsPage() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chartDays, setChartDays] = useState<7 | 30>(7);
  const setView = useApp((s) => s.setView);

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

  const chartSource = chartDays === 7
    ? summary?.past_week ?? []
    : summary?.past_month ?? [];
  const chartData = summary ? buildSeries(chartDays, chartSource) : [];
  const maxValue = Math.max(1, ...chartData.map((d) => d.value));

  const tier = summary?.user?.tier ?? "free";
  const isPaid = tier !== "free";

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[720px] px-6 py-10">
        {/* Header */}
        <header className="mb-10">
          <div className="flex items-center gap-3">
            <h1 className="text-[32px] font-semibold tracking-tight text-ink">Analytics</h1>
            <span className={cn(
              "rounded-full px-2.5 py-0.5 text-[12px] font-medium",
              tier === "max" ? "bg-amber-500/10 text-amber-600" :
              tier === "pro" ? "bg-accent/10 text-ink" :
              "bg-ink/5 text-ink-soft"
            )}>
              {tier === "max" ? "Max" : tier === "pro" ? "Pro" : "Free"}
            </span>
          </div>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
            Track your usage and activity over time.
          </p>
        </header>

        {error && (
          <section className="mb-6 rounded-2xl border border-line bg-paper-raised p-5">
            <div className="text-[13px] font-semibold text-ink">Usage unavailable</div>
            <p className="mt-2 text-[13px] leading-5 text-ink-soft">
              {error.includes("401") ? "Sign in to view your usage." : error}
            </p>
          </section>
        )}

        {/* Usage limits */}
        <section className="mb-8 rounded-2xl border border-line bg-paper-raised p-6">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">Usage limits</h2>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">
                Your plan's limits determine how much you can use zWork over time.
              </p>
            </div>
            {!loading && summary && (
              <span className="text-[12px] text-ink-faint">Updated just now</span>
            )}
          </div>

          <div className="space-y-5">
            <UsageBar
              label="5-hour window"
              used={summary?.five_hour_used ?? 0}
              limit={summary?.five_hour_limit ?? 0}
              loading={loading}
            />
            <UsageBar
              label="Weekly limit"
              used={summary?.weekly_used ?? 0}
              limit={summary?.weekly_limit ?? 0}
              loading={loading}
            />
          </div>
        </section>

        {/* Upgrade prompt — free users only */}
        {!isPaid && !loading && (
          <section className="mb-8 flex items-center gap-4 rounded-2xl border border-line bg-paper-raised px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink/5">
              <Zap className="h-4 w-4 text-ink" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-ink">
                Need more capacity?
              </p>
              <p className="text-[12.5px] text-ink-muted">
                Upgrade to Pro for higher limits and hosted access.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setView("plan")}
              className="press ring-focus inline-flex items-center gap-1 rounded-xl bg-ink px-4 py-2 text-[12.5px] font-medium text-paper hover:bg-ink/90"
            >
              Upgrade
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </section>
        )}

        {/* Activity chart */}
        <section className="rounded-2xl border border-line bg-paper-raised p-6">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-ink-soft" />
              <h2 className="text-[15px] font-semibold text-ink">Activity</h2>
            </div>
            <div className="inline-flex rounded-full border border-line bg-paper p-0.5">
              <button
                type="button"
                onClick={() => setChartDays(7)}
                className={cn(
                  "press rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                  chartDays === 7 ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
                )}
              >
                7 days
              </button>
              <button
                type="button"
                onClick={() => setChartDays(30)}
                className={cn(
                  "press rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                  chartDays === 30 ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
                )}
              >
                30 days
              </button>
            </div>
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
                            "w-full rounded-md transition-colors",
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
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Gemini-style usage bar                                             */
/* ------------------------------------------------------------------ */
function UsageBar({
  label,
  used,
  limit,
  loading,
}: {
  label: string;
  used: number;
  limit: number;
  loading: boolean;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const isHigh = pct > 80;
  const isCritical = pct > 95;

  return (
    <div>
      <div className="mb-2 flex items-end justify-between">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        <div className="text-right">
          <span className={cn("text-[18px] font-semibold tracking-tight text-ink", loading && "opacity-40")}>
            {loading ? "—" : `${Math.round(pct)}%`}
          </span>
          <span className="ml-1 text-[11px] text-ink-faint">
            {loading ? "" : `used`}
          </span>
        </div>
      </div>
      <div
        className="h-2.5 overflow-hidden rounded-full bg-paper-sunken"
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
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-faint">
        <span>{loading ? "—" : `${formatNumber(used)} of ${formatNumber(limit)}`}</span>
      </div>
    </div>
  );
}
