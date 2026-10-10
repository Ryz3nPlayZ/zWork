import { useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { RowIconButton } from "../page/Page";
import { AreaChartCard, ErrorBox, Meter, WindowPicker, type ApiFetch, useAdminData } from "./shared";
import { formatDate, formatNumber, formatRelative, formatUsd, shortDate } from "./format";
import { triggerMeta } from "./JobsTab";
import type { AdminUser } from "./UsersTab";

export interface UserActivity {
  window_days: number;
  requests: number;
  runs: number;
  cost_usd: number;
  failed: number;
  daily: { date: string; requests: number; runs: number; cost_usd: number }[];
  models: { model: string; requests: number; tokens: number; cost_usd: number }[];
  triggers: { trigger: string; runs: number; requests: number }[];
  clients: { app_version: string; os: string; requests: number; last_seen: string }[];
  recent_runs: {
    run_id: string;
    trigger: string;
    started_at: string;
    requests: number;
    tokens: number;
    cost_usd: number;
    failed: number;
    model: string | null;
  }[];
}

/** Expanded row in the Users table: ids, then what this user ran and what it cost. */
export function UserActivityPanel({ u, apiFetch, refreshKey }: { u: AdminUser; apiFetch: ApiFetch; refreshKey: number }) {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useAdminData<UserActivity>(
    apiFetch,
    `/api/admin/users/${encodeURIComponent(u.user_id)}/activity?days=${days}`,
    refreshKey,
  );

  return (
    // Clicks inside shouldn't collapse the row.
    <div className="space-y-3 pt-1" onClick={(e) => e.stopPropagation()}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[11.5px] sm:grid-cols-2 lg:grid-cols-3">
        <Field label="User id" value={u.user_id} copy />
        <Field label="Stripe customer" value={u.stripe_customer_id} copy />
        <Field label="Joined" value={formatDate(u.created_at)} />
        <Field label="Last active" value={formatDate(u.last_activity)} />
        <Field label="Prompt tokens" value={u.total_prompt_tokens.toLocaleString()} />
        <Field label="Completion tokens" value={u.total_completion_tokens.toLocaleString()} />
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <WindowPicker value={days} options={[7, 30, 90]} onChange={setDays} />
        {data && (
          <p className="text-[12px] text-ink-muted">
            <b className="font-semibold text-ink">{formatNumber(data.runs)}</b> runs ·{" "}
            <b className="font-semibold text-ink">{formatNumber(data.requests)}</b> calls ·{" "}
            <b className="font-semibold text-ink">{formatUsd(data.cost_usd)}</b> spend
            {data.failed > 0 && (
              <>
                {" "}
                · <span className="text-error">{formatNumber(data.failed)} failed</span>
              </>
            )}
          </p>
        )}
      </div>

      {error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : !data ? (
        <div className="flex items-center gap-2 py-6 text-[12px] text-ink-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading activity…
        </div>
      ) : data.requests === 0 ? (
        <p className="py-4 text-[12px] text-ink-faint">No requests in the last {days} days.</p>
      ) : (
        <div className={loading ? "space-y-3 opacity-60 transition-opacity" : "space-y-3"}>
          <AreaChartCard
            title="Calls per day"
            data={data.daily.map((d) => ({ date: shortDate(d.date), requests: d.requests, runs: d.runs }))}
            xKey="date"
            height={130}
            series={[
              { key: "requests", label: "Calls" },
              { key: "runs", label: "Runs" },
            ]}
            valueFormatter={(v) => formatNumber(v)}
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <MiniCard title="Started by">
              {data.triggers.map((t) => {
                const m = triggerMeta(t.trigger);
                return (
                  <Bar
                    key={t.trigger}
                    label={
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                        {m.label}
                      </span>
                    }
                    value={`${formatNumber(t.runs)} runs`}
                    ratio={t.runs / Math.max(1, ...data.triggers.map((x) => x.runs))}
                    color={m.color}
                  />
                );
              })}
            </MiniCard>
            <MiniCard title="Models">
              {data.models.map((m) => (
                <Bar
                  key={m.model}
                  label={<span className="font-mono text-[11px]">{m.model}</span>}
                  value={`${formatNumber(m.requests)} · ${formatUsd(m.cost_usd)}`}
                  ratio={m.requests / Math.max(1, ...data.models.map((x) => x.requests))}
                />
              ))}
            </MiniCard>
            <MiniCard title="Builds">
              {data.clients.map((c) => (
                <li key={`${c.app_version}/${c.os}`} className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className={c.app_version === "unknown" ? "text-ink-faint" : "font-mono text-[11.5px] text-ink"}>
                    {c.app_version === "unknown" ? "untagged" : `v${c.app_version}`}{" "}
                    <span className="font-sans text-ink-muted">{c.os === "unknown" ? "" : c.os}</span>
                  </span>
                  <span className="shrink-0 text-ink-faint">{formatRelative(c.last_seen)}</span>
                </li>
              ))}
            </MiniCard>
          </div>
          <RecentRuns runs={data.recent_runs} />
        </div>
      )}
    </div>
  );
}

function RecentRuns({ runs }: { runs: UserActivity["recent_runs"] }) {
  if (runs.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-paper-raised">
      <table className="w-full text-left text-[11.5px]">
        <thead className="border-b border-line text-ink-muted">
          <tr>
            <th className="px-3 py-1.5 font-medium">Recent runs</th>
            <th className="px-3 py-1.5 font-medium">Started by</th>
            <th className="px-3 py-1.5 font-medium">Model</th>
            <th className="px-3 py-1.5 text-right font-medium">Calls</th>
            <th className="px-3 py-1.5 text-right font-medium">Tokens</th>
            <th className="px-3 py-1.5 text-right font-medium">Spend</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.run_id} className="border-b border-line/60 last:border-0">
              <td className="whitespace-nowrap px-3 py-1.5 text-ink" title={r.run_id}>
                {formatRelative(r.started_at)}
                {r.failed > 0 && <span className="ml-1.5 text-error">{r.failed} failed</span>}
              </td>
              <td className="px-3 py-1.5">
                <span className="inline-flex items-center gap-1.5 text-ink-muted">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: triggerMeta(r.trigger).color }} />
                  {triggerMeta(r.trigger).label}
                </span>
              </td>
              <td className="max-w-[220px] truncate px-3 py-1.5 font-mono text-[11px] text-ink-muted">{r.model ?? "—"}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(r.requests)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(r.tokens)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatUsd(r.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MiniCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-paper-raised p-3">
      <h4 className="mb-2 text-[12px] font-semibold text-ink">{title}</h4>
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}

function Bar({ label, value, ratio, color }: { label: React.ReactNode; value: string; ratio: number; color?: string }) {
  return (
    <li className="text-[12px]">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-ink">{label}</span>
        <span className="shrink-0 tabular-nums text-ink-muted">{value}</span>
      </div>
      <Meter value={ratio} color={color} />
    </li>
  );
}

function Field({ label, value, copy }: { label: string; value: string | null; copy?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className={copy ? "truncate font-mono text-ink" : "truncate text-ink"}>{value ?? "—"}</dd>
      {copy && value && (
        <RowIconButton
          label={`Copy ${label.toLowerCase()}`}
          className="h-5 w-5"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard?.writeText(value);
          }}
        >
          <Copy />
        </RowIconButton>
      )}
    </div>
  );
}
