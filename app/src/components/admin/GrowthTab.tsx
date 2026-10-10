import { useState } from "react";
import { AlertTriangle, Download, GitFork, RefreshCcw, Star, Timer, Tag } from "lucide-react";
import { Badge } from "../page/Page";
import {
  BarChartCard,
  DataTable,
  DonutCard,
  ErrorBox,
  Meter,
  Section,
  SERIES_PALETTE,
  StatCard,
  StatGrid,
  TabStatus,
  TabToolbar,
  TONE_COLOR,
  WindowPicker,
  type ApiFetch,
  useAdminData,
} from "./shared";
import { formatDay, formatNumber, formatPct, formatRelative, shortDate } from "./format";

interface ReleaseAsset {
  name: string;
  platform: string;
  kind: string;
  downloads: number;
}
interface Release {
  tag: string;
  name: string | null;
  published_at: string | null;
  prerelease: boolean;
  installers: number;
  updates: number;
  update_checks: number;
  assets: ReleaseAsset[];
}
export interface DownloadsOverview {
  repo: string;
  stars: number;
  forks: number;
  open_issues: number;
  watchers: number;
  total_installers: number;
  total_updates: number;
  total_update_checks: number;
  by_platform: { platform: string; downloads: number }[];
  releases: Release[];
  fetched_at: string | null;
  source_error: string | null;
  daily: { date: string; installers: number; updates: number; update_checks: number }[];
  versions_in_use: { version: string; users: number; requests: number }[];
  os_split: { os: string; users: number }[];
}
interface Funnel {
  window_days: number;
  steps: { step: string; users: number }[];
  median_hours_to_first_request: number | null;
  cohorts: { week_start: string; users: number; retention: number[] }[];
}

const PLATFORM_COLOR: Record<string, string> = {
  macOS: SERIES_PALETTE[0],
  Windows: SERIES_PALETTE[1],
  Linux: SERIES_PALETTE[2],
};

function hours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

export function GrowthTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const [days, setDays] = useState(90);
  const dl = useAdminData<DownloadsOverview>(apiFetch, "/api/admin/metrics/downloads", refreshKey);
  const funnel = useAdminData<Funnel>(apiFetch, `/api/admin/metrics/funnel?days=${days}`, refreshKey);

  const d = dl.data;
  const latest = d?.releases.find((r) => !r.prerelease);
  const latestVersion = latest?.tag.replace(/^v/, "");
  const versionUsers = d?.versions_in_use.reduce((s, v) => s + v.users, 0) ?? 0;
  const onLatest = d?.versions_in_use.find((v) => v.version === latestVersion)?.users ?? 0;

  return (
    <div className="space-y-6">
      <Section
        title="Downloads"
        sub={
          d ? (
            <>
              GitHub releases of{" "}
              <a className="underline hover:text-ink" href={`https://github.com/${d.repo}`} target="_blank" rel="noreferrer">
                {d.repo}
              </a>
              {d.fetched_at && <> · fetched {formatRelative(d.fetched_at)}</>}
            </>
          ) : (
            "GitHub releases"
          )
        }
      >
        {!d ? (
          <TabStatus loading={dl.loading} error={dl.error} onRetry={dl.reload} />
        ) : (
          <div className="space-y-3">
            {d.source_error && (
              <div className="flex items-start gap-2 rounded-2xl border border-warning/25 bg-warning/10 px-4 py-3 text-[12.5px] text-warning">
                <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
                <span>GitHub fetch failed, showing the last good copy: {d.source_error}</span>
              </div>
            )}
            <StatGrid>
              <StatCard
                icon={Download}
                label="Installer downloads"
                value={formatNumber(d.total_installers)}
                sub={latest ? `${formatNumber(latest.installers)} for ${latest.tag}` : "all releases"}
                hint="dmg, exe, msi, AppImage, deb and rpm downloads across every release"
              />
              <StatCard
                icon={RefreshCcw}
                label="Auto-updates"
                value={formatNumber(d.total_updates)}
                sub={`${formatNumber(d.total_update_checks)} update checks`}
                hint="Update bundles fetched by the in-app updater; checks are latest.json fetches, a rough count of app launches"
              />
              <StatCard
                icon={Tag}
                label="On latest version"
                value={versionUsers ? formatPct(onLatest / versionUsers, 0) : "—"}
                tone={versionUsers && onLatest / versionUsers < 0.5 ? "warn" : "default"}
                sub={latestVersion ? `v${latestVersion}, of users active in 7d` : "no release yet"}
              />
              <StatCard
                icon={Star}
                label="GitHub stars"
                value={formatNumber(d.stars)}
                sub={
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-flex items-center gap-0.5">
                      <GitFork className="h-3 w-3" /> {d.forks}
                    </span>
                    · {d.open_issues} open issues
                  </span>
                }
              />
            </StatGrid>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className="lg:col-span-2">
                {d.daily.length > 1 ? (
                  <BarChartCard
                    title="Downloads per day"
                    sub="from daily snapshots of the release counters"
                    data={d.daily.map((x) => ({ date: shortDate(x.date), installers: x.installers, updates: x.updates }))}
                    xKey="date"
                    stacked
                    series={[
                      { key: "installers", label: "Installers", color: TONE_COLOR.info },
                      { key: "updates", label: "Updates", color: TONE_COLOR.muted },
                    ]}
                    valueFormatter={(v) => formatNumber(v)}
                  />
                ) : (
                  <div className="flex h-full min-h-[200px] items-center justify-center rounded-2xl border border-line bg-paper-raised p-6 text-center text-[12px] text-ink-muted">
                    The API snapshots GitHub's download counters once an hour. The per-day chart fills in after two days of
                    snapshots.
                  </div>
                )}
              </div>
              <DonutCard
                title="Installers by platform"
                sub="all releases"
                data={d.by_platform.map((p) => ({ name: p.platform, value: p.downloads, color: PLATFORM_COLOR[p.platform] }))}
                valueFormatter={(v) => formatNumber(v)}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <DataTable
                  rows={d.releases}
                  rowKey={(r) => r.tag}
                  limit={8}
                  exportName="releases"
                  expand={(r) => (
                    <ul className="grid grid-cols-1 gap-x-6 gap-y-1 pt-2 sm:grid-cols-2">
                      {r.assets.map((a) => (
                        <li key={a.name} className="flex items-baseline justify-between gap-3 text-[11.5px]">
                          <span className="truncate font-mono text-ink-muted">{a.name}</span>
                          <span className="shrink-0 tabular-nums text-ink">{formatNumber(a.downloads)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  columns={[
                    {
                      key: "tag",
                      label: "Release",
                      render: (r) => (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="font-mono text-[11.5px]">{r.tag}</span>
                          {r.prerelease && <Badge tone="warning">pre</Badge>}
                          {r === latest && <Badge tone="success">latest</Badge>}
                        </span>
                      ),
                    },
                    { key: "published_at", label: "Published", render: (r) => formatDay(r.published_at) },
                    { key: "installers", label: "Installers", numeric: true, render: (r) => formatNumber(r.installers) },
                    { key: "updates", label: "Updates", numeric: true, render: (r) => formatNumber(r.updates) },
                    { key: "update_checks", label: "Checks", numeric: true, render: (r) => formatNumber(r.update_checks) },
                  ]}
                />
              </div>
              <div className="space-y-3 rounded-2xl border border-line bg-paper-raised p-4">
                <div>
                  <h3 className="text-[13px] font-semibold text-ink">Versions in use</h3>
                  <p className="mt-0.5 text-[12px] text-ink-muted">users with a request in the last 7 days</p>
                </div>
                {d.versions_in_use.length === 0 ? (
                  <p className="text-[12px] text-ink-faint">No version data yet.</p>
                ) : (
                  <ul className="space-y-2.5">
                    {d.versions_in_use.slice(0, 8).map((v) => (
                      <li key={v.version} className="space-y-1 text-[12px]">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[11.5px] text-ink">
                            {v.version}
                            {v.version === latestVersion && <span className="ml-1.5 text-success">latest</span>}
                          </span>
                          <span className="tabular-nums text-ink-muted">{formatNumber(v.users)}</span>
                        </div>
                        <Meter
                          value={v.users / Math.max(1, versionUsers)}
                          color={v.version === latestVersion ? TONE_COLOR.success : undefined}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {d.os_split.length > 0 && (
                  <p className="border-t border-line pt-2.5 text-[11.5px] text-ink-muted">
                    {/* "desktop" is what builds before run tagging sent as their OS. */}
                    {d.os_split
                      .map((o) => `${["desktop", "unknown", ""].includes(o.os) ? "untagged" : o.os} ${formatNumber(o.users)}`)
                      .join(" · ")}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Activation"
        sub="How sign-ups turn into usage and subscriptions"
        right={
          <TabToolbar>
            <WindowPicker value={days} options={[30, 90, 180, 365]} onChange={setDays} />
          </TabToolbar>
        }
      >
        {!funnel.data ? (
          funnel.error ? (
            <ErrorBox message={funnel.error} onRetry={funnel.reload} />
          ) : (
            <TabStatus loading={funnel.loading} error="" />
          )
        ) : (
          <FunnelView f={funnel.data} />
        )}
      </Section>
    </div>
  );
}

function FunnelView({ f }: { f: Funnel }) {
  const top = Math.max(1, f.steps[0]?.users ?? 1);
  const weeks = Math.max(0, ...f.cohorts.map((c) => c.retention.length));
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
      <div className="space-y-3 rounded-2xl border border-line bg-paper-raised p-4 lg:col-span-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-ink">Funnel</h3>
          <span className="text-[12px] text-ink-muted">users who signed up in the last {f.window_days} days</span>
        </div>
        <ol className="space-y-3">
          {f.steps.map((s, i) => {
            const prev = i > 0 ? f.steps[i - 1].users : null;
            return (
              <li key={s.step} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="text-ink">{s.step}</span>
                  <span className="tabular-nums text-ink-muted">
                    <span className="font-medium text-ink">{formatNumber(s.users)}</span>
                    {prev !== null && <> · {prev ? formatPct(s.users / prev, 0) : "—"} of previous</>}
                  </span>
                </div>
                <div className="h-6 overflow-hidden rounded-md bg-paper-sunken">
                  <div
                    className="flex h-full items-center rounded-md px-2 text-[10.5px] font-medium text-white"
                    style={{ width: `${Math.max(2, (s.users / top) * 100)}%`, background: `rgb(var(--info) / ${Math.max(0.45, 1 - i * 0.17)})` }}
                  >
                    {s.users / top >= 0.12 && formatPct(s.users / top, 0)}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="flex items-center gap-1.5 border-t border-line pt-2.5 text-[12px] text-ink-muted">
          <Timer className="h-3.5 w-3.5" />
          Median time from sign-up to first request: <span className="font-medium text-ink">{hours(f.median_hours_to_first_request)}</span>
        </p>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-paper-raised p-4 lg:col-span-3">
        <h3 className="text-[13px] font-semibold text-ink">Weekly retention</h3>
        <p className="mt-0.5 text-[12px] text-ink-muted">share of each sign-up week with a request N weeks later</p>
        {f.cohorts.length === 0 ? (
          <p className="mt-3 text-[12px] text-ink-faint">No cohorts yet.</p>
        ) : (
          <table className="mt-3 w-full text-[11.5px]">
            <thead>
              <tr className="text-ink-muted">
                <th className="py-1 pr-2 text-left font-medium">Week of</th>
                <th className="py-1 pr-2 text-right font-medium">Users</th>
                {Array.from({ length: weeks }, (_, i) => (
                  <th key={i} className="px-0.5 py-1 text-center font-medium">
                    W{i}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {f.cohorts.map((c) => (
                <tr key={c.week_start}>
                  <td className="whitespace-nowrap py-0.5 pr-2 text-ink">{formatDay(c.week_start)}</td>
                  <td className="py-0.5 pr-2 text-right tabular-nums text-ink-muted">{c.users}</td>
                  {Array.from({ length: weeks }, (_, i) => {
                    const v = c.retention[i];
                    return (
                      <td key={i} className="px-0.5 py-0.5">
                        {v === undefined ? (
                          <div className="h-6" />
                        ) : (
                          <div
                            className="flex h-6 items-center justify-center rounded tabular-nums"
                            style={{
                              background: `rgb(var(--info) / ${0.08 + (v / 100) * 0.7})`,
                              color: v >= 45 ? "white" : "rgb(var(--ink))",
                            }}
                            title={`${v.toFixed(1)}% of the ${formatDay(c.week_start)} cohort active in week ${i}`}
                          >
                            {Math.round(v)}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
