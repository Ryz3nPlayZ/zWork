import { useEffect, useState } from "react";
import { Clock, TrendingUp, Loader2 } from "lucide-react";
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

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[760px] px-6 py-8">
        <header className="mb-8">
          <h1 className="text-[36px] font-light tracking-tight text-ink">Analytics</h1>
        </header>

        {error && (
          <section className="mb-6 rounded-2xl border border-line bg-paper-raised p-5">
            <div className="text-[13px] font-semibold text-ink">Usage unavailable</div>
            <p className="mt-2 text-[13px] leading-5 text-ink-muted">
              {error.includes("401") ? "Sign in to view your usage." : error}
            </p>
          </section>
        )}

        {/* Usage bars */}
        <div className="flex flex-col gap-4 mb-8">
          <UsageBar
            icon={<Clock className="h-4 w-4" />}
            label="5-hour limit"
            sublabel="Rolling window"
            used={summary?.five_hour_used ?? 0}
            limit={summary?.five_hour_limit ?? 0}
            loading={loading}
          />
          <UsageBar
            icon={<Clock className="h-4 w-4" />}
            label="Today"
            sublabel="Requests in the last 24 hours"
            used={(summary?.root_requests_today ?? 0) + (summary?.continuation_requests_today ?? 0)}
            limit={Math.max((summary?.weekly_limit ?? 100) / 7 | 0, 1)}
            loading={loading}
          />
        </div>

        {/* Activity chart */}
        <section className="rounded-2xl border border-line bg-paper-raised p-6">
          <div className="mb-5 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-ink-muted" />
            <h2 className="text-[15px] font-semibold text-ink">Activity</h2>
            <span className="text-[12px] text-ink-faint">last {CHART_DAYS} days</span>
          </div>

          {loading && !summary ? (
            <div className="flex h-[160px] items-center justify-center text-[13px] text-ink-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading
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
              <div className="relative ml-10" style={{ height: "160px" }}>
                {/* Grid */}
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
                    const h = day.value > 0 ? Math.max(3, (day.value / maxValue) * 156) : 0;
                    return (
                      <div
                        key={`${day.date}-${i}`}
                        className="flex-1 rounded-t bg-ink/60 hover:bg-ink/80 transition-colors"
                        style={{ height: `${h}px`, minWidth: 1 }}
                        title={`${day.date}: ${formatNumber(day.value)} requests`}
                      />
                    );
                  })}
                </div>
              </div>

              {/* X-axis */}
              <div className="ml-10 mt-2 flex text-[11px] text-ink-faint">
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

function UsageBar({
  icon,
  label,
  sublabel,
  used,
  limit,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  used: number;
  limit: number;
  loading: boolean;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <section className="rounded-2xl border border-line bg-paper-raised p-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-sunken text-ink-muted">
            {icon}
          </div>
          <div>
            <div className="text-[13px] font-semibold text-ink">{label}</div>
            <div className="text-[11.5px] text-ink-muted">{sublabel}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[24px] font-light tracking-tight text-ink">
            {loading ? "…" : formatNumber(used)}
          </div>
          <div className="text-[11.5px] text-ink-muted">
            of {loading ? "…" : formatNumber(limit)}
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
            pct > 85 ? "bg-red-500/70" : "bg-ink/70",
          )}
          style={{ width: `${Math.max(pct, 0.5)}%` }}
        />
      </div>
    </section>
  );
}
