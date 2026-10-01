import { CheckCircle2, CircleDashed, Database, ExternalLink, Globe, Plug, Server, XCircle } from "lucide-react";
import { Badge } from "../page/Page";
import { DataTable, Section, StatCard, StatGrid, TabStatus, type ApiFetch, useAdminData } from "./shared";
import { formatDate, formatMs, formatNumber } from "./format";

export interface Surface {
  name: string;
  url: string;
  host: string;
  role: string;
  expect: string;
  status: number | null;
  ok: boolean;
  latency_ms: number | null;
  detail: string | null;
}
export interface StatusOverview {
  api_version: string;
  started_at: string | null;
  uptime_secs: number | null;
  surfaces: Surface[];
  database: {
    ok: boolean;
    latency_ms: number | null;
    size_bytes: number | null;
    tables: { name: string; rows: number; bytes: number }[];
  };
  integrations: { name: string; configured: boolean; detail: string | null }[];
}

function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function uptime(secs: number | null): string {
  if (secs === null) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function StatusTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const { data, loading, error, reload } = useAdminData<StatusOverview>(apiFetch, "/api/admin/metrics/status", refreshKey);
  if (!data) return <TabStatus loading={loading} error={error} onRetry={reload} />;

  const down = data.surfaces.filter((s) => !s.ok);
  const configured = data.integrations.filter((i) => i.configured).length;

  return (
    <div className="space-y-6">
      <StatGrid>
        <StatCard
          icon={Globe}
          label="Surfaces up"
          value={`${data.surfaces.length - down.length}/${data.surfaces.length}`}
          tone={down.length ? "error" : "ok"}
          sub={down.length ? `down: ${down.map((s) => s.name).join(", ")}` : "every public host answered as expected"}
        />
        <StatCard
          icon={Database}
          label="Database"
          value={data.database.ok ? formatMs(data.database.latency_ms) : "down"}
          tone={data.database.ok ? "ok" : "error"}
          sub={`${bytes(data.database.size_bytes)} on disk`}
          hint="Round trip of a trivial query from the API"
        />
        <StatCard
          icon={Server}
          label="API uptime"
          value={uptime(data.uptime_secs)}
          sub={`v${data.api_version} · since ${formatDate(data.started_at)}`}
        />
        <StatCard
          icon={Plug}
          label="Integrations"
          value={`${configured}/${data.integrations.length}`}
          tone={configured < data.integrations.length ? "warn" : "ok"}
          sub="configured on the server"
        />
      </StatGrid>

      <Section title="Public surfaces" sub="Probed from the API server on every load. Expected codes differ by host.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.surfaces.map((s) => (
            <div
              key={s.name}
              className={`rounded-2xl border bg-paper-raised p-4 ${s.ok ? "border-line" : "border-error/40"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {s.ok ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                    ) : (
                      <XCircle className="h-4 w-4 shrink-0 text-error" />
                    )}
                    <span className="truncate text-[13px] font-semibold text-ink">{s.name}</span>
                  </div>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ring-focus mt-1 inline-flex max-w-full items-center gap-1 rounded font-mono text-[11.5px] text-ink-muted hover:text-ink"
                  >
                    <span className="truncate">{s.url.replace(/^https?:\/\//, "")}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
                <Badge tone={s.ok ? "success" : "error"}>{s.status ?? "no answer"}</Badge>
              </div>
              <p className="mt-2 text-[12px] text-ink-muted">{s.role}</p>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
                <span>{s.host}</span>
                <span>expects {s.expect}</span>
                <span className="tabular-nums">{formatMs(s.latency_ms)}</span>
              </div>
              {s.detail && (
                <p className={`mt-2 truncate text-[11.5px] ${s.ok ? "text-ink-faint" : "text-error"}`} title={s.detail}>
                  {s.detail}
                </p>
              )}
            </div>
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Section title="Largest tables">
            <DataTable
              rows={data.database.tables}
              rowKey={(r) => r.name}
              defaultSort={{ key: "bytes", dir: "desc" }}
              limit={10}
              columns={[
                { key: "name", label: "Table", mono: true },
                { key: "rows", label: "Rows (est.)", numeric: true, render: (r) => formatNumber(r.rows) },
                { key: "bytes", label: "Size", numeric: true, render: (r) => bytes(r.bytes) },
              ]}
            />
          </Section>
        </div>
        <div className="lg:col-span-2">
          <Section title="Integrations" sub="Whether the server has the keys for each service.">
            <ul className="divide-y divide-line/60 rounded-2xl border border-line bg-paper-raised">
              {data.integrations.map((i) => (
                <li key={i.name} className="flex items-start gap-2.5 px-4 py-2.5">
                  {i.configured ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  ) : (
                    <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  )}
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium text-ink">{i.name}</div>
                    {i.detail && <div className="truncate text-[11.5px] text-ink-muted">{i.detail}</div>}
                  </div>
                  {!i.configured && (
                    <span className="ml-auto shrink-0 text-[11px] text-ink-faint">not set</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
