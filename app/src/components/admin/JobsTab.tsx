import { useState } from "react";
import { AlertTriangle, CalendarClock, Coins, Info, ListChecks, Users } from "lucide-react";
import {
  BarChartCard,
  ChartCard,
  DataTable,
  Meter,
  Section,
  StatCard,
  StatGrid,
  TabStatus,
  TabToolbar,
  TierBadge,
  TONE_COLOR,
  SERIES_PALETTE,
  UserCell,
  WindowPicker,
  change,
  type ApiFetch,
  useAdminData,
} from "./shared";
import { formatDay, formatNumber, formatPct, formatRelative, formatUsd, shortDate } from "./format";

export type Trigger = "schedule" | "chat" | "background" | "untagged";

export interface TriggerRow {
  trigger: Trigger | string;
  requests: number;
  runs: number;
  users: number;
  cost_usd: number;
  calls_per_run: number;
}
export interface TelemetryQuality {
  requests_24h: number;
  missing_version_pct: number;
  missing_os_pct: number;
  missing_trigger_pct: number;
  continuation_pct: number;
  untagged_users_24h: number;
}
export interface Scheduler {
  user_id: string;
  email: string;
  name: string;
  tier: string;
  runs: number;
  requests: number;
  cost_usd: number;
  active_days: number;
  last_run_at: string | null;
}
export interface JobsOverview {
  window_days: number;
  tagged_since: string | null;
  by_trigger: TriggerRow[];
  daily: { date: string; schedule: number; chat: number; background: number; untagged: number }[];
  weekly_schedulers: { week_start: string; users: number; runs: number }[];
  top_schedulers: Scheduler[];
  quality: TelemetryQuality;
}

export const TRIGGER_META: Record<Trigger, { label: string; color: string; about: string }> = {
  schedule: { label: "Scheduled", color: SERIES_PALETTE[1], about: "Started by a schedule in the desktop app" },
  chat: { label: "Chat", color: SERIES_PALETTE[0], about: "Started by the user sending a message" },
  background: { label: "Background", color: TONE_COLOR.info, about: "Helper calls such as chat titles" },
  untagged: { label: "Untagged", color: TONE_COLOR.muted, about: "Older builds that don't send a run tag" },
};

export function triggerMeta(t: string) {
  return TRIGGER_META[t as Trigger] ?? TRIGGER_META.untagged;
}

/** Above this share of untagged traffic, the splits on this tab are unreliable. */
export const UNTAGGED_WARN_PCT = 5;

export function JobsTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useAdminData<JobsOverview>(apiFetch, `/api/admin/metrics/jobs?days=${days}`, refreshKey);

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

  const by = (t: Trigger) => data.by_trigger.find((r) => r.trigger === t);
  const sched = by("schedule");
  const chat = by("chat");
  const taggedRuns = (sched?.runs ?? 0) + (chat?.runs ?? 0);
  const schedShare = taggedRuns > 0 ? (sched?.runs ?? 0) / taggedRuns : null;
  const weeks = data.weekly_schedulers;
  const thisWeek = weeks[weeks.length - 1];
  const lastWeek = weeks[weeks.length - 2];
  const q = data.quality;
  const daily = data.daily.map((d) => ({ ...d, date: shortDate(d.date) }));
  const maxTriggerCost = Math.max(0.0001, ...data.by_trigger.map((r) => r.cost_usd));

  return (
    <div className="space-y-6">
      {toolbar}

      {!data.tagged_since ? (
        <Banner tone="info">
          No request has carried a run tag yet. Scheduled and chat runs split out once a desktop build with run tagging
          ships; until then everything is <b>untagged</b>.
        </Banner>
      ) : (
        q.missing_trigger_pct > UNTAGGED_WARN_PCT && (
          <Banner tone="warn">
            {formatPct(q.missing_trigger_pct / 100, 0)} of the last 24 hours' requests ({formatNumber(q.untagged_users_24h)}{" "}
            {q.untagged_users_24h === 1 ? "user" : "users"}) come from builds that don't tag runs. Every model call from those
            builds counts as a new message against the user's quota, and none of it can be split into scheduled vs chat.
            The share falls as users take the update.
          </Banner>
        )
      )}

      <StatGrid>
        <StatCard
          icon={CalendarClock}
          label={`Scheduled runs, ${days}d`}
          value={formatNumber(sched?.runs ?? 0)}
          sub={schedShare === null ? "no tagged runs yet" : `${formatPct(schedShare, 0)} of scheduled + chat runs`}
          hint="Distinct runs whose calls carried x-zwork-trigger: schedule"
        />
        <StatCard
          icon={Users}
          label="Users with schedules, this week"
          value={formatNumber(thisWeek?.users ?? 0)}
          delta={lastWeek ? { ratio: change(thisWeek?.users ?? 0, lastWeek.users), good: "up", label: `vs last week (${lastWeek.users})` } : undefined}
          sub={thisWeek ? `${formatNumber(thisWeek.runs)} runs since Monday` : "none yet"}
          hint="Distinct users with at least one scheduled run since Monday (UTC). The wedge metric."
        />
        <StatCard
          icon={ListChecks}
          label="Model calls per run"
          value={sched ? sched.calls_per_run.toFixed(1) : "—"}
          sub={chat ? `scheduled · ${chat.calls_per_run.toFixed(1)} for chat` : "scheduled"}
          hint="Requests ÷ runs. A run is billed against the quota once, however many calls it takes."
        />
        <StatCard
          icon={Coins}
          label={`Spend on schedules, ${days}d`}
          value={formatUsd(sched?.cost_usd ?? 0)}
          sub={sched && sched.runs > 0 ? `${formatUsd(sched.cost_usd / sched.runs)} per run · ${formatNumber(sched.users)} users` : "—"}
        />
      </StatGrid>

      <BarChartCard
        title="Runs per day"
        sub={`by what started them${data.tagged_since ? ` · tagged since ${formatDay(data.tagged_since)}` : ""}`}
        data={daily}
        xKey="date"
        stacked
        series={(["schedule", "chat", "background", "untagged"] as Trigger[]).map((t) => ({
          key: t,
          label: TRIGGER_META[t].label,
          color: TRIGGER_META[t].color,
        }))}
        valueFormatter={(v) => formatNumber(v)}
      />

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Section title="By trigger" sub={`last ${days} days · untagged calls each got their own run id, so their runs equal their calls`}>
            <DataTable
              rows={data.by_trigger}
              rowKey={(r) => r.trigger}
              defaultSort={{ key: "runs", dir: "desc" }}
              empty="No requests in this window."
              columns={[
                {
                  key: "trigger",
                  label: "Trigger",
                  render: (r) => (
                    <span className="inline-flex items-center gap-2" title={triggerMeta(r.trigger).about}>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: triggerMeta(r.trigger).color }} />
                      {triggerMeta(r.trigger).label}
                    </span>
                  ),
                },
                { key: "runs", label: "Runs", numeric: true, render: (r) => formatNumber(r.runs) },
                { key: "calls_per_run", label: "Calls / run", numeric: true, render: (r) => r.calls_per_run.toFixed(1) },
                { key: "users", label: "Users", numeric: true, render: (r) => formatNumber(r.users) },
                {
                  key: "cost_usd",
                  label: "Spend",
                  numeric: true,
                  render: (r) => (
                    <div className="ml-auto w-24">
                      <div className="tabular-nums">{formatUsd(r.cost_usd)}</div>
                      <Meter value={r.cost_usd / maxTriggerCost} color={triggerMeta(r.trigger).color} />
                    </div>
                  ),
                },
              ]}
            />
          </Section>
        </div>

        <ChartCard title="Telemetry, last 24h" sub={`${formatNumber(q.requests_24h)} requests`} className="lg:col-span-2 lg:mt-[34px]">
          <ul className="space-y-3 text-[12px]">
            <QualityRow label="Missing run tag" pct={q.missing_trigger_pct} bad />
            <QualityRow label="Missing app version" pct={q.missing_version_pct} bad />
            <QualityRow label="Missing OS" pct={q.missing_os_pct} bad />
            <QualityRow
              label="Stored as continuations"
              pct={q.continuation_pct}
              hint="Calls after the first in a run. Near zero while tasks take several calls means every step is billed as a message."
            />
          </ul>
        </ChartCard>
      </div>

      <Section
        title="Who runs work on a schedule"
        sub={`Top users by scheduled runs in the last ${days} days`}
      >
        <DataTable
          rows={data.top_schedulers}
          rowKey={(r) => r.user_id}
          defaultSort={{ key: "runs", dir: "desc" }}
          empty={data.tagged_since ? "Nobody ran a scheduled task in this window." : "Waiting for tagged builds."}
          exportName={`schedulers-${days}d`}
          columns={[
            { key: "user", label: "User", render: (r) => <UserCell name={r.name} email={r.email} />, value: (r) => r.email },
            { key: "tier", label: "Tier", render: (r) => <TierBadge tier={r.tier} /> },
            { key: "runs", label: "Runs", numeric: true, render: (r) => formatNumber(r.runs) },
            { key: "active_days", label: "Days", numeric: true, render: (r) => formatNumber(r.active_days) },
            { key: "requests", label: "Calls", numeric: true, render: (r) => formatNumber(r.requests) },
            { key: "cost_usd", label: "Spend", numeric: true, render: (r) => formatUsd(r.cost_usd) },
            {
              key: "last_run_at",
              label: "Last run",
              numeric: true,
              value: (r) => (r.last_run_at ? Date.parse(r.last_run_at) : null),
              render: (r) => <span className="text-ink-muted">{formatRelative(r.last_run_at)}</span>,
            },
          ]}
        />
      </Section>

      <p className="text-[11.5px] text-ink-faint">
        A run is one task: everything the agent does for one message or one scheduled firing. Triggers come from the
        desktop sidecar's <code className="font-mono">x-zwork-trigger</code> header. Days are UTC.
      </p>
    </div>
  );
}

function QualityRow({ label, pct, bad, hint }: { label: string; pct: number; bad?: boolean; hint?: string }) {
  const tone = !bad ? TONE_COLOR.info : pct > 20 ? TONE_COLOR.error : pct > UNTAGGED_WARN_PCT ? TONE_COLOR.warning : TONE_COLOR.success;
  return (
    <li title={hint}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-ink">{label}</span>
        <span className="tabular-nums text-ink-muted">{pct.toFixed(1)}%</span>
      </div>
      <Meter value={pct / 100} color={tone} />
    </li>
  );
}

function Banner({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  const Icon = tone === "warn" ? AlertTriangle : Info;
  return (
    <div
      className={
        tone === "warn"
          ? "flex items-start gap-2 rounded-2xl border border-warning/25 bg-warning/10 px-4 py-3 text-[12.5px] text-ink"
          : "flex items-start gap-2 rounded-2xl border border-info/25 bg-info/10 px-4 py-3 text-[12.5px] text-ink"
      }
    >
      <Icon className={tone === "warn" ? "mt-px h-4 w-4 shrink-0 text-warning" : "mt-px h-4 w-4 shrink-0 text-info"} />
      <span>{children}</span>
    </div>
  );
}
