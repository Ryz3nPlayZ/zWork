import { useEffect, useState } from "react";
import { Pause, Play, Users, Zap, Gauge, AlertTriangle } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button, SectionHeading } from "../page/Page";
import {
  DataTable,
  ErrorBox,
  StatCard,
  StatusBadge,
  TabToolbar,
  UserCell,
  rateTone,
  type ApiFetch,
} from "./shared";
import { formatMs, formatNumber, formatPct, formatRelative } from "./format";

interface RecentRequest {
  id: string;
  user_email: string | null;
  user_name: string | null;
  provider_name: string | null;
  model_id: string | null;
  upstream_status: number | null;
  total_duration_ms: number | null;
  total_tokens: number | null;
  created_at: string;
}
interface LiveOverview {
  active_users_5m: number;
  requests_5m: number;
  tokens_5m: number;
  requests_per_min: number;
  recent: RecentRequest[];
}

const POLL_MS = 10_000;
const HISTORY = 30;

function isFailure(r: RecentRequest) {
  return r.upstream_status === null || r.upstream_status >= 400;
}

export function LiveTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const [data, setData] = useState<LiveOverview | null>(null);
  const [rpm, setRpm] = useState<number[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // Two separate reasons to stop polling: the admin pressed Pause, or the
  // browser tab is hidden. Keeping them apart means coming back to the tab
  // doesn't silently undo a manual pause.
  const [userPaused, setUserPaused] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");
  const [failedOnly, setFailedOnly] = useState(false);
  const [err, setErr] = useState("");
  const polling = !userPaused && !hidden;

  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    async function tick() {
      try {
        const d = await apiFetch<LiveOverview>(`/api/admin/metrics/live?_=${Date.now()}`);
        if (cancelled) return;
        setData(d);
        setRpm((h) => [...h.slice(-(HISTORY - 1)), d.requests_per_min]);
        setUpdatedAt(Date.now());
        setErr("");
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    }
    void tick();
    const interval = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [polling, apiFetch, refreshKey]);

  const recent = data?.recent ?? [];
  const failures = recent.filter(isFailure).length;
  const failRate = recent.length ? failures / recent.length : 0;
  const maxRpm = Math.max(1, ...rpm);

  return (
    <div className="space-y-5">
      <TabToolbar
        right={
          <Button icon={userPaused ? <Play /> : <Pause />} onClick={() => setUserPaused((p) => !p)}>
            {userPaused ? "Resume" : "Pause"}
          </Button>
        }
      >
        <span className="flex items-center gap-2 text-[12px] text-ink-muted">
          <span
            className={cn("inline-block h-2 w-2 rounded-full", polling ? "animate-pulse bg-success" : "bg-ink-faint")}
          />
          {userPaused
            ? "Paused"
            : hidden
              ? "Paused while this tab is in the background"
              : `Refreshing every ${POLL_MS / 1000}s`}
          {updatedAt && <span className="text-ink-faint">· updated {formatRelative(new Date(updatedAt).toISOString())}</span>}
        </span>
      </TabToolbar>

      {err && <ErrorBox message={err} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Users} label="Active users" value={formatNumber(data?.active_users_5m ?? 0)} sub="last 5 minutes" />
        <StatCard
          icon={Zap}
          label="Requests"
          value={formatNumber(data?.requests_5m ?? 0)}
          sub={`${(data?.requests_per_min ?? 0).toFixed(1)} per minute`}
        />
        <StatCard icon={Gauge} label="Tokens" value={formatNumber(data?.tokens_5m ?? 0)} sub="last 5 minutes" />
        <StatCard
          icon={AlertTriangle}
          label="Failing"
          value={recent.length ? formatPct(failRate, 0) : "—"}
          tone={recent.length ? rateTone(failRate, 0.05, 0.15) : "default"}
          sub={`${failures} of the last ${recent.length} requests`}
        />
      </div>

      <div className="rounded-2xl border border-line bg-paper-raised p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-ink">Requests per minute</h3>
          <span className="text-[11.5px] text-ink-faint">
            {rpm.length ? `last ${rpm.length} samples · peak ${maxRpm.toFixed(1)}` : "waiting for the first sample"}
          </span>
        </div>
        <div className="flex h-12 items-end gap-0.5" aria-label="Requests per minute history">
          {/* Fixed slots, newest on the right, so bar width doesn't jump as samples arrive. */}
          {Array.from({ length: HISTORY - rpm.length }, (_, i) => (
            <div key={`empty-${i}`} className="flex-1" />
          ))}
          {rpm.map((v, i) => (
            <div
              key={i}
              className="flex-1 rounded-t bg-accent/50 transition-all"
              style={{ height: `${(v / maxRpm) * 100}%`, minHeight: "2px" }}
              title={`${v.toFixed(1)}/min`}
            />
          ))}
        </div>
      </div>

      <div>
        <SectionHeading
          title="Recent requests"
          count={recent.length}
          className="mt-2"
          action={
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-muted">
              <input
                type="checkbox"
                checked={failedOnly}
                onChange={(e) => setFailedOnly(e.target.checked)}
                className="accent-[rgb(var(--accent))]"
              />
              Failures only
            </label>
          }
        />
        <DataTable
          rows={failedOnly ? recent.filter(isFailure) : recent}
          rowKey={(r) => r.id}
          empty={failedOnly ? "No failures in the recent requests." : "No recent requests."}
          columns={[
            {
              key: "created_at",
              label: "When",
              value: (r) => Date.parse(r.created_at),
              render: (r) => <span className="whitespace-nowrap text-ink-muted">{formatRelative(r.created_at)}</span>,
            },
            { key: "user_email", label: "User", render: (r) => <UserCell name={r.user_name} email={r.user_email} /> },
            {
              key: "model_id",
              label: "Model",
              render: (r) => (
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11.5px] text-ink">{r.model_id ?? "—"}</div>
                  <div className="truncate text-ink-muted">{r.provider_name ?? "—"}</div>
                </div>
              ),
            },
            { key: "upstream_status", label: "Status", render: (r) => <StatusBadge code={r.upstream_status} /> },
            { key: "total_duration_ms", label: "Duration", numeric: true, render: (r) => formatMs(r.total_duration_ms) },
            { key: "total_tokens", label: "Tokens", numeric: true, render: (r) => formatNumber(r.total_tokens) },
          ]}
        />
      </div>
    </div>
  );
}
