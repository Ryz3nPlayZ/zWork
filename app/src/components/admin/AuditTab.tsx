import { useMemo, useState } from "react";
import { Badge, SearchField, Segmented, type Tone } from "../page/Page";
import { DataTable, TabStatus, TabToolbar, type ApiFetch, useAdminData } from "./shared";
import { formatDate, formatRelative } from "./format";

interface AuditRow {
  id: string;
  actor_email: string | null;
  action: string;
  target_user_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const ACTION_TONE: Record<string, Tone> = {
  admin_login: "info",
  admin_logout: "neutral",
  tier_change: "warning",
};

const ACTION_LABEL: Record<string, string> = {
  admin_login: "Signed in",
  admin_logout: "Signed out",
  tier_change: "Changed tier",
};

const LIMIT = 200;

/** One readable line for the metadata we know; raw JSON is in the expanded row. */
function describe(r: AuditRow): string {
  const m = r.metadata;
  if (!m) return "—";
  if (r.action === "tier_change") return `${String(m.from ?? "?")} → ${String(m.to ?? "?")}`;
  const keys = Object.keys(m);
  if (keys.length === 0) return "—";
  return keys
    .slice(0, 3)
    .map((k) => `${k}: ${typeof m[k] === "object" ? "…" : String(m[k])}`)
    .join(" · ");
}

export function AuditTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const { data, loading, error, reload } = useAdminData<AuditRow[]>(apiFetch, `/api/admin/audit?limit=${LIMIT}`, refreshKey);
  const [action, setAction] = useState("all");
  const [q, setQ] = useState("");

  const rows = data ?? [];
  const actions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (action !== "all" && r.action !== action) return false;
      if (!needle) return true;
      return [r.actor_email, r.target_user_id, r.action, describe(r)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [rows, action, q]);

  if (!data) return <TabStatus loading={loading} error={error} onRetry={reload} />;

  return (
    <div className="space-y-4">
      <TabToolbar right={rows.length >= 5 && <SearchField value={q} onChange={setQ} placeholder="Search actor, target, details" />}>
        {actions.length > 1 && (
          <Segmented
            label="Action"
            value={action}
            onChange={setAction}
            options={[
              { value: "all", label: "All", count: rows.length },
              ...actions.map(([a, n]) => ({ value: a, label: ACTION_LABEL[a] ?? a, count: n })),
            ]}
          />
        )}
      </TabToolbar>
      <DataTable
        rows={filtered}
        rowKey={(r) => r.id}
        defaultSort={{ key: "created_at", dir: "desc" }}
        empty={rows.length === 0 ? "No admin actions logged yet." : "No actions match."}
        exportName="admin-audit"
        expand={(r) => (
          <div className="grid gap-1 pt-1 text-[11.5px] text-ink-muted">
            <div>
              {formatDate(r.created_at)} · target <span className="font-mono">{r.target_user_id ?? "—"}</span>
            </div>
            {r.metadata && (
              <pre className="overflow-x-auto rounded-lg border border-line bg-paper p-2 font-mono text-[11px] text-ink">
                {JSON.stringify(r.metadata, null, 2)}
              </pre>
            )}
          </div>
        )}
        columns={[
          {
            key: "created_at",
            label: "When",
            value: (r) => Date.parse(r.created_at),
            render: (r) => (
              <span className="whitespace-nowrap text-ink-muted" title={formatDate(r.created_at)}>
                {formatRelative(r.created_at)}
              </span>
            ),
          },
          { key: "actor_email", label: "Who" },
          {
            key: "action",
            label: "Action",
            render: (r) => <Badge tone={ACTION_TONE[r.action] ?? "neutral"}>{ACTION_LABEL[r.action] ?? r.action}</Badge>,
          },
          {
            key: "target_user_id",
            label: "Target",
            mono: true,
            render: (r) => (r.target_user_id ? `${r.target_user_id.slice(0, 12)}…` : "—"),
          },
          { key: "details", label: "Details", value: describe, render: (r) => <span className="text-ink-muted">{describe(r)}</span> },
        ]}
      />
      {rows.length >= LIMIT && <p className="text-[11.5px] text-ink-faint">Showing the most recent {LIMIT} actions.</p>}
    </div>
  );
}
