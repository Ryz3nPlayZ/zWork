import { useState } from "react";
import { DollarSign, TrendingUp, TrendingDown, Users, Percent, Receipt } from "lucide-react";
import {
  AreaChartCard,
  BarChartCard,
  DonutCard,
  StatCard,
  StatGrid,
  TabStatus,
  TabToolbar,
  TONE_COLOR,
  WindowPicker,
  type ApiFetch,
  type SeriesPoint,
  type StatTone,
  useAdminData,
} from "./shared";
import { formatNumber, formatUsd, shortDate } from "./format";

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
  free: TONE_COLOR.muted,
  pro: TONE_COLOR.info,
  max: TONE_COLOR.warning,
};

export function RevenueTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useAdminData<RevenueOverview>(
    apiFetch,
    `/api/admin/metrics/revenue?days=${days}`,
    refreshKey,
  );

  const toolbar = (
    <TabToolbar>
      <WindowPicker value={days} options={[7, 30, 90, 365]} onChange={setDays} />
    </TabToolbar>
  );
  if (!data) {
    return (
      <div className="space-y-5">
        {toolbar}
        <TabStatus loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  const marginTone: StatTone = data.gross_margin_pct >= 50 ? "ok" : data.gross_margin_pct >= 0 ? "warn" : "error";
  const net = data.new_subs_in_window - data.churned_in_window;

  const dailyNet: SeriesPoint[] = data.daily.map((d) => ({
    date: shortDate(d.date),
    new_subs: d.new_subs,
    cancellations: -d.cancellations,
  }));
  const dailyCost: SeriesPoint[] = data.daily.map((d) => ({
    date: shortDate(d.date),
    cost: d.est_cost_usd,
    // Computed here rather than read from d.margin: older API builds subtracted
    // a day's cost from the whole month's MRR.
    margin: Number((data.current_mrr / 30 - d.est_cost_usd).toFixed(2)),
  }));
  const tierDonut = data.tier_split.map((t) => ({
    name: t.tier,
    value: t.users,
    color: TIER_COLORS[t.tier] ?? TONE_COLOR.muted,
  }));

  return (
    <div className="space-y-5">
      {toolbar}

      <StatGrid>
        <StatCard icon={DollarSign} label="MRR" value={formatUsd(data.current_mrr)} sub={`${formatUsd(data.arpu)} per user (ARPU)`} />
        <StatCard icon={Users} label="Paying users" value={formatNumber(data.paid_users)} />
        <StatCard
          icon={net >= 0 ? TrendingUp : TrendingDown}
          label="Net subscriptions"
          value={`${net >= 0 ? "+" : ""}${net}`}
          tone={net > 0 ? "ok" : net < 0 ? "error" : "default"}
          sub={`+${data.new_subs_in_window} new · −${data.churned_in_window} churned`}
        />
        <StatCard
          icon={Percent}
          label="Gross margin"
          value={`${data.gross_margin_pct.toFixed(1)}%`}
          tone={marginTone}
          sub={`${formatUsd(data.est_cost_usd)} est. cost`}
          hint="Revenue for the window (MRR × days ÷ 30) minus estimated provider cost, as a share of that revenue"
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <BarChartCard
            title="Subscriptions"
            sub="new vs cancelled per day"
            data={dailyNet}
            xKey="date"
            series={[
              { key: "new_subs", label: "New", color: TONE_COLOR.success },
              { key: "cancellations", label: "Cancelled", color: TONE_COLOR.error },
            ]}
            stacked
          />
        </div>
        <DonutCard title="Users by tier" data={tierDonut} valueFormatter={(v) => v.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <AreaChartCard
          title="Estimated provider cost"
          sub="per day"
          data={dailyCost}
          xKey="date"
          series={[{ key: "cost", label: "Cost", color: TONE_COLOR.warning }]}
          valueFormatter={(v) => formatUsd(v)}
        />
        <AreaChartCard
          title="Daily margin"
          sub="MRR ÷ 30, minus that day's cost"
          data={dailyCost}
          xKey="date"
          series={[{ key: "margin", label: "Margin", color: TONE_COLOR.success }]}
          valueFormatter={(v) => formatUsd(v)}
        />
      </div>

      <p className="flex items-center gap-1.5 text-[11.5px] text-ink-faint">
        <Receipt className="h-3.5 w-3.5" />
        Costs are estimates from token counts and list prices, not provider invoices.
      </p>
    </div>
  );
}
