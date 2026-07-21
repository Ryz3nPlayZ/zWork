import { useEffect, useState } from "react";
import { DollarSign, TrendingUp, TrendingDown, Users, Percent } from "lucide-react";
import {
  AreaChartCard,
  BarChartCard,
  DonutCard,
  SERIES_PALETTE,
  type SeriesPoint,
} from "./shared";
import { cn } from "../../lib/cn";

interface RevenueDayPoint {
  date: string;
  mrr: number;
  new_subs: number;
  cancellations: number;
  est_cost_usd: number;
  margin: number;
}
interface TierSplit {
  tier: string;
  users: number;
  mrr: number;
}
interface RevenueOverview {
  window_days: number;
  current_mrr: number;
  arpu: number;
  paid_users: number;
  churned_in_window: number;
  new_subs_in_window: number;
  est_cost_usd: number;
  gross_margin_pct: number;
  daily: RevenueDayPoint[];
  tier_split: TierSplit[];
}

const TIER_COLORS: Record<string, string> = {
  free: "#9ca3af",
  pro: "#3b82f6",
  max: "#a855f7",
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

export function RevenueTab({ apiFetch }: { apiFetch: <T>(path: string) => Promise<T> }) {
  const [data, setData] = useState<RevenueOverview | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr("");
    apiFetch<RevenueOverview>(`/api/admin/metrics/revenue?days=${days}`)
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

  const marginTone = data.gross_margin_pct >= 50 ? "ok" : data.gross_margin_pct >= 0 ? "warn" : "error";

  const dailyNet: SeriesPoint[] = data.daily.map((d) => ({
    date: d.date.slice(5),
    new_subs: d.new_subs,
    cancellations: -d.cancellations,
  }));
  const dailyCost: SeriesPoint[] = data.daily.map((d) => ({
    date: d.date.slice(5),
    cost: d.est_cost_usd,
    margin: data.current_mrr - d.est_cost_usd,
  }));
  const tierDonut = data.tier_split.map((t) => ({
    name: t.tier,
    value: t.users,
    color: TIER_COLORS[t.tier] ?? SERIES_PALETTE[5],
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-muted">Window:</span>
        {[7, 30, 90, 365].map((d) => (
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
        <StatCard icon={DollarSign} label="Current MRR" value={`$${data.current_mrr.toFixed(2)}`} sub={`$${data.arpu.toFixed(2)} ARPU`} />
        <StatCard icon={Users} label="Paid Users" value={data.paid_users.toLocaleString()} />
        <StatCard
          icon={TrendingUp}
          label="New Subs"
          value={`+${data.new_subs_in_window}`}
          tone={data.new_subs_in_window > 0 ? "ok" : "default"}
          sub={`${data.window_days}d`}
        />
        <StatCard
          icon={TrendingDown}
          label="Churned"
          value={`-${data.churned_in_window}`}
          tone={data.churned_in_window > 0 ? "error" : "default"}
          sub={`${data.window_days}d`}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={DollarSign} label="Est. Cost" value={`$${data.est_cost_usd.toFixed(2)}`} sub={`${data.window_days}d`} />
        <StatCard
          icon={Percent}
          label="Gross Margin"
          value={`${data.gross_margin_pct.toFixed(1)}%`}
          tone={marginTone as "ok" | "warn" | "error"}
          sub="MRR − cost"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <BarChartCard
            title="Net subscription changes"
            sub="new vs cancelled per day"
            data={dailyNet}
            xKey="date"
            series={[
              { key: "new_subs", label: "New subs", color: "#10b981" },
              { key: "cancellations", label: "Cancellations", color: "#ef4444" },
            ]}
            stacked
          />
        </div>
        <DonutCard title="Users by tier" data={tierDonut} valueFormatter={(v) => v.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AreaChartCard
          title="Estimated provider cost"
          sub="daily, USD"
          data={dailyCost}
          xKey="date"
          series={[{ key: "cost", label: "Cost", color: "#f59e0b" }]}
          valueFormatter={(v) => `$${v.toFixed(2)}`}
        />
        <AreaChartCard
          title="Margin (MRR − cost)"
          sub={`current MRR $${data.current_mrr.toFixed(2)}`}
          data={dailyCost}
          xKey="date"
          series={[{ key: "margin", label: "Margin", color: "#10b981" }]}
          valueFormatter={(v) => `$${v.toFixed(2)}`}
        />
      </div>
    </div>
  );
}
