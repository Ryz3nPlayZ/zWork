import { useEffect, useRef, useState } from "react";
import { Radio, Users, Zap, Gauge } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatMs, formatNumber, formatRelative } from "./format";

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

function BigStat({
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
  tone?: "default" | "live";
}) {
  return (
    <div className="rounded-xl border border-line bg-paper-raised p-5">
      <div className="flex items-center gap-2 text-ink-muted">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
        {tone === "live" && (
          <span className="ml-auto flex items-center gap-1 text-[10px] font-bold uppercase text-emerald-500">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            live
          </span>
        )}
      </div>
      <div className="mt-2 text-3xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

export function LiveTab({ apiFetch }: { apiFetch: <T>(path: string) => Promise<T> }) {
  const [data, setData] = useState<LiveOverview | null>(null);
  const [paused, setPaused] = useState(false);
  const [err, setErr] = useState("");
  const rpmHistory = useRef<number[]>([]);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;

    async function tick() {
      try {
        const d = await apiFetch<LiveOverview>(`/api/admin/metrics/live?_=${Date.now()}`);
        if (cancelled) return;
        setData(d);
        rpmHistory.current = [...rpmHistory.current.slice(-29), d.requests_per_min];
        setErr("");
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    }

    tick();
    const interval = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [paused, apiFetch]);

  // Pause polling when the whole tab is hidden (saves DB load).
  useEffect(() => {
    const onVis = () => setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const rpm = rpmHistory.current;
  const maxRpm = Math.max(1, ...rpm);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <Radio className={cn("h-4 w-4", !paused && "animate-pulse text-emerald-500")} />
          {paused ? "Paused (tab hidden)" : "Auto-refreshing every 10s"}
        </div>
        <button
          onClick={() => setPaused((p) => !p)}
          className="rounded-md bg-paper-sunken px-3 py-1 text-xs font-medium text-ink-muted hover:text-ink"
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>

      {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{err}</div>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <BigStat icon={Users} label="Active (5m)" value={(data?.active_users_5m ?? 0).toLocaleString()} sub="distinct users" tone="live" />
        <BigStat icon={Zap} label="Requests (5m)" value={(data?.requests_5m ?? 0).toLocaleString()} sub={`${(data?.requests_per_min ?? 0).toFixed(1)}/min`} />
        <BigStat icon={Gauge} label="Tokens (5m)" value={formatNumber(data?.tokens_5m ?? 0)} />
      </div>

      {/* RPM sparkline */}
      <div className="rounded-xl border border-line bg-paper-raised p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Requests / min</h3>
          <span className="text-xs text-ink-muted">last {rpm.length} samples</span>
        </div>
        {rpm.length === 0 ? (
          <div className="h-12" />
        ) : (
          <div className="flex h-12 items-end gap-0.5">
            {rpm.map((v, i) => (
              <div
                key={i}
                className="flex-1 rounded-t bg-indigo-500/70 transition-all"
                style={{ height: `${(v / maxRpm) * 100}%`, minHeight: "2px" }}
                title={`${v.toFixed(1)}/min`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Recent activity feed */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">Recent requests</h3>
        <div className="overflow-auto rounded-xl border border-line">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line bg-paper-sunken">
              <tr>
                <th className="px-3 py-2 font-medium text-ink-muted">User</th>
                <th className="px-3 py-2 font-medium text-ink-muted">Provider / Model</th>
                <th className="px-3 py-2 font-medium text-ink-muted">Status</th>
                <th className="px-3 py-2 font-medium text-ink-muted">Duration</th>
                <th className="px-3 py-2 font-medium text-ink-muted">Tokens</th>
                <th className="px-3 py-2 font-medium text-ink-muted">When</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recent ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-ink-muted">
                    No recent requests.
                  </td>
                </tr>
              ) : (
                (data?.recent ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-line/50 hover:bg-paper-sunken/50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{r.user_name ?? "—"}</div>
                      <div className="text-ink-muted">{r.user_email ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-ink">{r.provider_name ?? "—"}</div>
                      <div className="font-mono text-ink-muted">{r.model_id ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2">
                      {r.upstream_status === null ? (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600">—</span>
                      ) : (
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-bold",
                            r.upstream_status < 300
                              ? "bg-emerald-100 text-emerald-700"
                              : r.upstream_status < 400
                                ? "bg-blue-100 text-blue-700"
                                : r.upstream_status < 500
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-red-100 text-red-700",
                          )}
                        >
                          {r.upstream_status}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink">{formatMs(r.total_duration_ms)}</td>
                    <td className="px-3 py-2 text-ink">{r.total_tokens !== null ? formatNumber(r.total_tokens) : "—"}</td>
                    <td className="px-3 py-2 text-ink-muted whitespace-nowrap">{formatRelative(r.created_at)}</td>
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
