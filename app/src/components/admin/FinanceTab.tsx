import { useState } from "react";
import { AlertTriangle, CalendarClock, Coins, Gift, Percent, Receipt, UserX, Wallet } from "lucide-react";
import {
  AreaChartCard,
  DataTable,
  DonutCard,
  Meter,
  Section,
  StatCard,
  StatGrid,
  TabStatus,
  TabToolbar,
  TierBadge,
  TONE_COLOR,
  UserCell,
  WindowPicker,
  change,
  type ApiFetch,
  type Column,
  type StatTone,
  useAdminData,
} from "./shared";
import { formatNumber, formatUsd, shortDate } from "./format";

export interface FinanceTier {
  tier: string;
  users: number;
  paying_users: number;
  active_users: number;
  requests: number;
  tokens: number;
  cost_usd: number;
  revenue_usd: number;
  margin_usd: number;
  cost_per_active_user: number;
}
export interface FinanceModel {
  provider: string;
  model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  unpriced_requests: number;
}
export interface FinanceSpender {
  user_id: string;
  email: string | null;
  name: string | null;
  tier: string;
  paying: boolean;
  requests: number;
  tokens: number;
  cost_usd: number;
  cost_30d_usd: number;
  monthly_price_usd: number;
  margin_30d_usd: number;
}
export interface FinanceOverview {
  window_days: number;
  spend_usd: number;
  prev_spend_usd: number;
  revenue_usd: number;
  margin_usd: number;
  margin_pct: number | null;
  mrr: number;
  paid_users: number;
  mtd_spend_usd: number;
  projected_month_spend_usd: number;
  last_month_spend_usd: number;
  projected_month_margin_usd: number;
  free_spend_usd: number;
  paid_spend_usd: number;
  cost_per_request_usd: number | null;
  cost_per_1k_tokens_usd: number | null;
  requests: number;
  unpriced_requests: number;
  unpriced_tokens: number;
  priced_coverage_pct: number | null;
  unprofitable_users: number;
  by_tier: FinanceTier[];
  daily: { date: string; free: number; pro: number; max: number; total: number }[];
  by_model: FinanceModel[];
  top_spenders: FinanceSpender[];
  unprofitable: FinanceSpender[];
}

const TIER_COLOR: Record<string, string> = {
  free: TONE_COLOR.muted,
  pro: TONE_COLOR.info,
  max: TONE_COLOR.warning,
};

/** Sub-cent costs need more digits than formatUsd gives. */
function usdFine(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(5)}`;
  return formatUsd(n);
}

function signedUsd(n: number): string {
  return n < 0 ? `−${formatUsd(-n)}` : formatUsd(n);
}

const spenderColumns: Column<FinanceSpender>[] = [
  { key: "user", label: "User", render: (r) => <UserCell name={r.name} email={r.email} />, value: (r) => r.email ?? r.user_id },
  {
    key: "tier",
    label: "Tier",
    render: (r) => (
      <span className="inline-flex items-center gap-1.5">
        <TierBadge tier={r.tier} />
        {r.tier !== "free" && !r.paying && <span className="text-[11px] text-ink-faint">comped</span>}
      </span>
    ),
  },
  { key: "requests", label: "Requests", numeric: true, render: (r) => formatNumber(r.requests) },
  { key: "tokens", label: "Tokens", numeric: true, render: (r) => formatNumber(r.tokens) },
  { key: "cost_usd", label: "Cost (window)", numeric: true, render: (r) => formatUsd(r.cost_usd) },
  { key: "cost_30d_usd", label: "Cost (30d)", numeric: true, render: (r) => formatUsd(r.cost_30d_usd) },
  {
    key: "monthly_price_usd",
    label: "Pays / mo",
    numeric: true,
    value: (r) => (r.paying ? r.monthly_price_usd : 0),
    render: (r) => (r.paying ? formatUsd(r.monthly_price_usd) : <span className="text-ink-faint">$0.00</span>),
  },
  {
    key: "margin_30d_usd",
    label: "Margin (30d)",
    numeric: true,
    render: (r) => (
      <span className={r.margin_30d_usd < 0 ? "font-medium text-error" : "text-success"}>{signedUsd(r.margin_30d_usd)}</span>
    ),
  },
];

export function FinanceTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useAdminData<FinanceOverview>(
    apiFetch,
    `/api/admin/metrics/finance?days=${days}`,
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

  const marginTone: StatTone =
    data.margin_pct === null ? "default" : data.margin_pct >= 50 ? "ok" : data.margin_pct >= 0 ? "warn" : "error";
  const freeShare = data.spend_usd > 0 ? data.free_spend_usd / data.spend_usd : 0;
  const daily = data.daily.map((d) => ({ date: shortDate(d.date), free: d.free, pro: d.pro, max: d.max }));
  const tierDonut = data.by_tier
    .filter((t) => t.cost_usd > 0)
    .map((t) => ({ name: t.tier, value: t.cost_usd, color: TIER_COLOR[t.tier] }));
  const maxModelCost = Math.max(0.0001, ...data.by_model.map((m) => m.cost_usd));
  const now = new Date();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  return (
    <div className="space-y-6">
      {toolbar}

      {data.unprofitable_users > 0 && (
        <div className="flex items-start gap-2 rounded-2xl border border-error/25 bg-error/10 px-4 py-3 text-[12.5px] text-error">
          <UserX className="mt-px h-4 w-4 shrink-0" />
          <span>
            {data.unprofitable_users} paying {data.unprofitable_users === 1 ? "user costs" : "users cost"} more in
            upstream spend over the last 30 days than their plan brings in. They're listed below.
          </span>
        </div>
      )}

      <StatGrid>
        <StatCard
          icon={Wallet}
          label={`Upstream spend, ${days}d`}
          value={formatUsd(data.spend_usd)}
          delta={{ ratio: change(data.spend_usd, data.prev_spend_usd), good: "down", label: `vs the ${days} days before (${formatUsd(data.prev_spend_usd)})` }}
          sub={`${formatNumber(data.requests)} requests`}
          hint="Estimated provider cost of every hosted-model request in the window"
        />
        <StatCard
          icon={Coins}
          label={`Revenue, ${days}d`}
          value={formatUsd(data.revenue_usd)}
          sub={`${formatUsd(data.mrr)} MRR · ${formatNumber(data.paid_users)} paying`}
          hint="Current MRR from Stripe × days ÷ 30"
        />
        <StatCard
          icon={Percent}
          label="Gross margin"
          value={signedUsd(data.margin_usd)}
          tone={marginTone}
          sub={data.margin_pct === null ? "no revenue yet" : `${data.margin_pct.toFixed(1)}% of revenue`}
          hint="Revenue minus upstream spend for the window"
        />
        <StatCard
          icon={CalendarClock}
          label="This month, projected"
          value={formatUsd(data.projected_month_spend_usd)}
          delta={{
            ratio: change(data.projected_month_spend_usd, data.last_month_spend_usd),
            good: "down",
            label: `vs last month (${formatUsd(data.last_month_spend_usd)})`,
          }}
          sub={`${formatUsd(data.mtd_spend_usd)} so far · day ${now.getUTCDate()}/${daysInMonth}`}
          hint="Month-to-date spend extrapolated to the end of the UTC month"
        />
      </StatGrid>

      <StatGrid>
        <StatCard
          icon={Gift}
          label="Free-tier spend"
          value={formatUsd(data.free_spend_usd)}
          tone={freeShare > 0.5 ? "warn" : "default"}
          sub={`${(freeShare * 100).toFixed(0)}% of spend, earns nothing`}
          hint="Spend by users without an active subscription (free tier and comped Pro/Max)"
        />
        <StatCard
          icon={Coins}
          label="Paying-user spend"
          value={formatUsd(data.paid_spend_usd)}
          sub={`${(100 - freeShare * 100).toFixed(0)}% of spend`}
        />
        <StatCard
          icon={Receipt}
          label="Cost per request"
          value={usdFine(data.cost_per_request_usd)}
          sub={`${usdFine(data.cost_per_1k_tokens_usd)} per 1K tokens`}
          hint="Priced requests only"
        />
        <StatCard
          icon={UserX}
          label="Unprofitable payers"
          value={formatNumber(data.unprofitable_users)}
          tone={data.unprofitable_users > 0 ? "error" : "ok"}
          sub="30-day cost above plan price"
        />
      </StatGrid>

      {data.unpriced_requests > 0 && (
        <div className="flex items-start gap-2 rounded-2xl border border-warning/25 bg-warning/10 px-4 py-3 text-[12.5px] text-warning">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
          <span>
            {formatNumber(data.unpriced_requests)} requests ({formatNumber(data.unpriced_tokens)} tokens) used models with
            no price, so spend is understated
            {data.priced_coverage_pct !== null && <> ({data.priced_coverage_pct.toFixed(1)}% of requests priced)</>}. Add
            them to <code className="font-mono text-[11.5px]">estimate_cost</code> in the API.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Daily upstream spend"
            sub="by the user's current tier"
            data={daily}
            xKey="date"
            stacked
            series={[
              { key: "free", label: "Free", color: TIER_COLOR.free },
              { key: "pro", label: "Pro", color: TIER_COLOR.pro },
              { key: "max", label: "Max", color: TIER_COLOR.max },
            ]}
            valueFormatter={(v) => formatUsd(v)}
          />
        </div>
        <DonutCard title="Spend by tier" sub={`last ${days} days`} data={tierDonut} valueFormatter={(v) => formatUsd(v)} />
      </div>

      <Section title="Tiers" sub="Revenue is list price × paying users for the window. Comped users count as users but not revenue.">
        <DataTable
          rows={data.by_tier}
          rowKey={(r) => r.tier}
          exportName="finance-tiers"
          columns={[
            { key: "tier", label: "Tier", render: (r) => <TierBadge tier={r.tier} /> },
            { key: "users", label: "Users", numeric: true, render: (r) => formatNumber(r.users) },
            { key: "paying_users", label: "Paying", numeric: true, render: (r) => formatNumber(r.paying_users) },
            { key: "active_users", label: "Active", numeric: true, render: (r) => formatNumber(r.active_users) },
            { key: "requests", label: "Requests", numeric: true, render: (r) => formatNumber(r.requests) },
            { key: "tokens", label: "Tokens", numeric: true, render: (r) => formatNumber(r.tokens) },
            { key: "cost_usd", label: "Spend", numeric: true, render: (r) => formatUsd(r.cost_usd) },
            { key: "revenue_usd", label: "Revenue", numeric: true, render: (r) => formatUsd(r.revenue_usd) },
            {
              key: "margin_usd",
              label: "Margin",
              numeric: true,
              render: (r) => <span className={r.margin_usd < 0 ? "text-error" : "text-success"}>{signedUsd(r.margin_usd)}</span>,
            },
            { key: "cost_per_active_user", label: "Spend / active user", numeric: true, render: (r) => usdFine(r.cost_per_active_user) },
          ]}
        />
      </Section>

      {data.unprofitable.length > 0 && (
        <Section title="Unprofitable paying users" sub="Paying users whose last-30-day spend is above their monthly plan price.">
          <DataTable
            rows={data.unprofitable}
            rowKey={(r) => r.user_id}
            columns={spenderColumns}
            defaultSort={{ key: "margin_30d_usd", dir: "asc" }}
            exportName="unprofitable-users"
          />
        </Section>
      )}

      <Section title="Top spenders" sub={`Who costs the most in the last ${days} days, free or paid.`}>
        <DataTable
          rows={data.top_spenders}
          rowKey={(r) => r.user_id}
          columns={spenderColumns}
          defaultSort={{ key: "cost_usd", dir: "desc" }}
          exportName="top-spenders"
          limit={10}
        />
      </Section>

      <Section title="Spend by model">
        <DataTable
          rows={data.by_model}
          rowKey={(r) => `${r.provider}/${r.model}`}
          defaultSort={{ key: "cost_usd", dir: "desc" }}
          exportName="spend-by-model"
          columns={[
            {
              key: "model",
              label: "Model",
              render: (r) => (
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11.5px] text-ink">{r.model}</div>
                  <div className="text-ink-muted">{r.provider}</div>
                </div>
              ),
            },
            { key: "requests", label: "Requests", numeric: true, render: (r) => formatNumber(r.requests) },
            { key: "prompt_tokens", label: "Input tokens", numeric: true, render: (r) => formatNumber(r.prompt_tokens) },
            { key: "completion_tokens", label: "Output tokens", numeric: true, render: (r) => formatNumber(r.completion_tokens) },
            {
              key: "cost_usd",
              label: "Spend",
              numeric: true,
              render: (r) =>
                r.unpriced_requests > 0 && r.cost_usd === 0 ? (
                  <span className="text-warning">no price</span>
                ) : (
                  <div className="ml-auto w-28 space-y-1">
                    <div>{formatUsd(r.cost_usd)}</div>
                    <Meter value={r.cost_usd / maxModelCost} />
                  </div>
                ),
            },
            {
              key: "per_req",
              label: "Per request",
              numeric: true,
              value: (r) => (r.requests ? r.cost_usd / r.requests : null),
              render: (r) => usdFine(r.requests && r.cost_usd ? r.cost_usd / r.requests : null),
            },
          ]}
        />
      </Section>

      <p className="flex items-center gap-1.5 text-[11.5px] text-ink-faint">
        <Receipt className="h-3.5 w-3.5" />
        Spend is estimated per request from token counts and list prices, not provider invoices. Ollama Cloud is a flat
        subscription and counts as $0.
      </p>
    </div>
  );
}
