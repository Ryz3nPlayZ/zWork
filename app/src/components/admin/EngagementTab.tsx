import { useState } from "react";
import { Activity, Users, Sparkles, UserPlus } from "lucide-react";
import {
  AreaChartCard,
  BarChartCard,
  DataTable,
  LineChartCard,
  StatCard,
  StatGrid,
  TabStatus,
  TabToolbar,
  TierBadge,
  TONE_COLOR,
  UserCell,
  WindowPicker,
  type ApiFetch,
  type SeriesPoint,
  useAdminData,
} from "./shared";
import { SectionHeading } from "../page/Page";
import { formatNumber, formatRelative, formatUsd, shortDate } from "./format";

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

export function EngagementTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useAdminData<EngagementOverview>(
    apiFetch,
    `/api/admin/metrics/engagement?days=${days}`,
    refreshKey,
  );

  const toolbar = (
    <TabToolbar>
      <WindowPicker value={days} options={[7, 30, 90]} onChange={setDays} />
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

  const daily: SeriesPoint[] = data.daily.map((d) => ({
    date: shortDate(d.date),
    dau: d.dau,
    new_users: d.new_users,
    returning: d.returning,
    requests: d.requests,
    tokens: d.tokens,
  }));

  return (
    <div className="space-y-5">
      {toolbar}

      <StatGrid>
        <StatCard icon={Activity} label="Active today" value={formatNumber(data.dau_today)} sub={`${formatNumber(data.wau)} this week`} />
        <StatCard icon={Users} label="Active this month" value={formatNumber(data.mau)} sub="last 30 days" />
        <StatCard
          icon={Sparkles}
          label="Stickiness"
          value={`${data.stickiness_pct.toFixed(1)}%`}
          sub="daily ÷ monthly active"
          hint="DAU / MAU. 20%+ is healthy for a work tool."
        />
        <StatCard icon={UserPlus} label="New users" value={formatNumber(data.new_users_in_window)} sub={`last ${data.window_days} days`} />
      </StatGrid>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Daily active users"
            sub="distinct users per day"
            data={daily}
            xKey="date"
            series={[{ key: "dau", label: "Active" }]}
          />
        </div>
        <BarChartCard
          title="New vs returning"
          sub="per day"
          data={daily}
          xKey="date"
          series={[
            { key: "new_users", label: "New", color: TONE_COLOR.success },
            { key: "returning", label: "Returning", color: TONE_COLOR.info },
          ]}
          stacked
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <LineChartCard
          title="Requests per day"
          data={daily}
          xKey="date"
          series={[{ key: "requests", label: "Requests" }]}
          valueFormatter={(v) => formatNumber(v)}
        />
        <LineChartCard
          title="Tokens per day"
          data={daily}
          xKey="date"
          series={[{ key: "tokens", label: "Tokens", color: TONE_COLOR.info }]}
          valueFormatter={(v) => formatNumber(v)}
        />
      </div>

      <div>
        <SectionHeading title="Most active users" count={data.top_active_users.length} className="mt-2" />
        <DataTable
          rows={data.top_active_users}
          rowKey={(u) => u.user_id}
          defaultSort={{ key: "total_requests", dir: "desc" }}
          empty="No activity in this window."
          exportName={`top-users-${days}d`}
          columns={[
            { key: "email", label: "User", render: (u) => <UserCell name={u.name} email={u.email} /> },
            { key: "tier", label: "Tier", render: (u) => <TierBadge tier={u.tier} /> },
            { key: "total_requests", label: "Requests", numeric: true, render: (u) => formatNumber(u.total_requests) },
            {
              key: "tokens",
              label: "Tokens",
              numeric: true,
              value: (u) => u.total_prompt_tokens + u.total_completion_tokens,
              render: (u) => formatNumber(u.total_prompt_tokens + u.total_completion_tokens),
            },
            { key: "estimated_cost_usd", label: "Est. cost", numeric: true, render: (u) => formatUsd(u.estimated_cost_usd) },
            {
              key: "last_activity",
              label: "Last active",
              numeric: true,
              value: (u) => (u.last_activity ? Date.parse(u.last_activity) : null),
              render: (u) => <span className="text-ink-muted">{formatRelative(u.last_activity)}</span>,
            },
          ]}
        />
      </div>
    </div>
  );
}
