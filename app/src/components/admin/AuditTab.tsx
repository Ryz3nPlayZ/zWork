import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { formatRelative } from "./format";

interface AuditRow {
  id: string;
  actor_email: string | null;
  action: string;
  target_user_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const ACTION_BADGE: Record<string, string> = {
  admin_login: "bg-blue-100 text-blue-700",
  admin_logout: "bg-gray-100 text-gray-600",
  tier_change: "bg-purple-100 text-purple-700",
};

export function AuditTab({ apiFetch }: { apiFetch: <T>(path: string) => Promise<T> }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr("");
    apiFetch<AuditRow[]>(`/api/admin/audit?limit=200`)
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  if (loading && rows.length === 0) {
    return <div className="flex items-center justify-center py-20 text-sm text-ink-muted">Loading…</div>;
  }
  if (err) {
    return <div className="flex items-center justify-center py-20 text-sm text-red-500">{err}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">Most recent 200 admin actions.</p>
      </div>
      <div className="overflow-auto rounded-xl border border-line">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line bg-paper-sunken">
            <tr>
              <th className="px-3 py-2 font-medium text-ink-muted">When</th>
              <th className="px-3 py-2 font-medium text-ink-muted">Actor</th>
              <th className="px-3 py-2 font-medium text-ink-muted">Action</th>
              <th className="px-3 py-2 font-medium text-ink-muted">Target</th>
              <th className="px-3 py-2 font-medium text-ink-muted">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-ink-muted">
                  No admin actions logged yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-b border-line/50 hover:bg-paper-sunken/50">
                  <td className="px-3 py-2 text-ink-muted whitespace-nowrap">{formatRelative(r.created_at)}</td>
                  <td className="px-3 py-2 text-ink">{r.actor_email ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                        ACTION_BADGE[r.action] ?? "bg-gray-100 text-gray-600",
                      )}
                    >
                      {r.action}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-ink-muted">
                    {r.target_user_id ? r.target_user_id.slice(0, 12) + "…" : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-ink-muted">
                    {r.metadata ? JSON.stringify(r.metadata) : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
