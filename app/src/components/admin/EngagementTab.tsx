import { useEffect, useState } from "react";
import { Activity, Users, Repeat, Sparkles } from "lucide-react";
import {
  AreaChartCard,
  BarChartCard,
  LineChartCard,
  type SeriesPoint,
} from "./shared";
import { cn } from "../../lib/cn";
import { formatDate, formatNumber } from "./format";

interface EngagementDayPoint {
  date: string;
  dau: number;
  new_users: number;
  returning: number;
  requests: number;
  tokens: number;
}
interface AdminUserLite {
  user_id: string;
  email: string;
  name: string;
  tier: string;
  last_activity: string | null;
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  estimated_cost_usd: number;
}
interface EngagementOverview {
  window_days: number;
  dau_today: number;
  wau: number;
  mau: number;
  stickiness_pct: number;
  new_users_in_window: number;
  daily: EngagementDayPoint[];
  top_active_users: AdminUserLite[];
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-xl border border-line bg-paper-raised p-4">
      <div className="flex items-center gap-2 text-ink-muted">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

export function EngagementTab({ apiFetch }: { apiFetch: <T>(path: string) => Promise<T> }) {
  const [data, setData] = useState<EngagementOverview | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr("");
    apiFetch<EngagementOverview>(`/api/admin/metrics/engagement?days=${days}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days, apiFetch]);

  if (loading && !data) {
    return <div className="flex items-center justify-center py-20 text-sm text-ink-muted">Loading…</div>;
  }
  if (err || !data) {
    return <div className="flex items-center justify-center py-20 text-sm text-red-500">{err || "No data"}</div>;
  }

  const dailyNewReturn: SeriesPoint[] = data.daily.map((d) => ({
    date: d.date.slice(5),
    new_users: d.new_users,
    returning: d.returning,
  }));
  const dailyRequests: SeriesPoint[] = data.daily.map((d) => ({
    date: d.date.slice(5),
    requests: d.requests,
    tokens: d.tokens,
  }));
  // Build DAU/WAU/MAU comparison lines (DAU series is our daily; WAU/MAU are
  // point-in-time so we plot them as flat reference lines).
  const dailyEngagement: SeriesPoint[] = data.daily.map((d) => ({
    date: d.date.slice(5),
    dau: d.dau,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-muted">Window:</span>
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              days === d ? "bg-accent text-white" : "bg-paper-sunken text-ink-muted hover:text-ink",
            )}
          >
            {d}d
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Activity} label="DAU (today)" value={data.dau_today.toLocaleString()} />
        <StatCard icon={Users} label="WAU" value={data.wau.toLocaleString()} sub="7-day active" />
        <StatCard icon={Users} label="MAU" value={data.mau.toLocaleString()} sub="30-day active" />
        <StatCard
          icon={Sparkles}
          label="Stickiness"
          value={`${data.stickiness_pct.toFixed(1)}%`}
          sub="DAU / MAU"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Daily active users"
            sub="distinct users per day"
            data={dailyEngagement}
            xKey="date"
            series={[{ key: "dau", label: "DAU", color: "#6366f1" }]}
          />
        </div>
        <BarChartCard
          title="New vs returning"
          sub="per day"
          data={dailyNewReturn}
          xKey="date"
          series={[
            { key: "new_users", label: "New", color: "#10b981" },
            { key: "returning", label: "Returning", color: "#3b82f6" },
          ]}
          stacked
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LineChartCard
          title="Requests per day"
          data={dailyRequests}
          xKey="date"
          series={[{ key: "requests", label: "Requests", color: "#f59e0b" }]}
          valueFormatter={(v) => formatNumber(v)}
        />
        <LineChartCard
          title="Tokens per day"
          data={dailyRequests}
          xKey="date"
          series={[{ key: "tokens", label: "Tokens", color: "#14b8a6" }]}
          valueFormatter={(v) => formatNumber(v)}
        />
      </div>

      {/* Top active users */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <Repeat className="h-4 w-4 text-ink-muted" />
          <h3 className="text-sm font-semibold text-ink">Top active users</h3>
          <span className="text-xs text-ink-muted">last {data.window_days} days</span>
        </div>
        <div className="overflow-auto rounded-xl border border-line">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line bg-paper-sunken">
              <tr>
                <th className="px-3 py-2 font-medium text-ink-muted">User</th>
                <th className="px-3 py-2 font-medium text-ink-muted">Tier</th>
                <th className="px-3 py-2 font-medium text-ink-muted">Requests</th>
                <th className="px-3 py-2 font-medium text-ink-muted">Tokens</th>
                <th className="px-3 py-2 font-medium text-ink-muted">Est. Cost</th>
                <th className="px-3 py-2 font-medium text-ink-muted">Last Active</th>
              </tr>
            </thead>
            <tbody>
              {data.top_active_users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-ink-muted">
                    No activity in this window.
                  </td>
                </tr>
              ) : (
                data.top_active_users.map((u) => (
                  <tr key={u.user_id} className="border-b border-line/50 hover:bg-paper-sunken/50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{u.name}</div>
                      <div className="text-ink-muted">{u.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                          u.tier === "max"
                            ? "bg-purple-100 text-purple-700"
                            : u.tier === "pro"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-600",
                        )}
                      >
                        {u.tier}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink">{formatNumber(u.total_requests)}</td>
                    <td className="px-3 py-2 text-ink">
                      {formatNumber(u.total_prompt_tokens + u.total_completion_tokens)}
                    </td>
                    <td className="px-3 py-2 text-ink font-medium">${u.estimated_cost_usd.toFixed(2)}</td>
                    <td className="px-3 py-2 text-ink-muted whitespace-nowrap">
                      {formatDate(u.last_activity)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
