import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { RowIconButton, SearchField, Segmented, useConfirm } from "../page/Page";
import {
  DataTable,
  ErrorBox,
  TabStatus,
  TabToolbar,
  TierBadge,
  UserCell,
  type ApiFetch,
  useAdminData,
} from "./shared";
import { formatDate, formatDay, formatNumber, formatRelative, formatUsd } from "./format";

export interface AdminUser {
  user_id: string;
  email: string;
  name: string;
  tier: string;
  created_at: string;
  last_activity: string | null;
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  estimated_cost_usd: number;
  stripe_customer_id: string | null;
  subscription_status: string | null;
}

const TIERS = ["free", "pro", "max"] as const;

export function UsersTab({
  apiFetch,
  refreshKey,
  setTier,
}: {
  apiFetch: ApiFetch;
  refreshKey: number;
  /** PUTs the new tier; throws on failure. */
  setTier: (userId: string, tier: string) => Promise<void>;
}) {
  const { data, loading, error, reload, setData } = useAdminData<AdminUser[]>(apiFetch, "/api/admin/users", refreshKey);
  const [q, setQ] = useState("");
  const [tier, setTierFilter] = useState("all");
  const [saveError, setSaveError] = useState("");
  const [confirmDialog, confirm] = useConfirm();

  const users = data ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const u of users) c[u.tier] = (c[u.tier] ?? 0) + 1;
    return c;
  }, [users]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return users.filter((u) => {
      if (tier !== "all" && u.tier !== tier) return false;
      if (!needle) return true;
      return (
        u.email.toLowerCase().includes(needle) ||
        u.name.toLowerCase().includes(needle) ||
        u.user_id.toLowerCase().includes(needle) ||
        (u.stripe_customer_id ?? "").toLowerCase().includes(needle)
      );
    });
  }, [users, q, tier]);

  async function changeTier(u: AdminUser, next: string) {
    if (next === u.tier) return;
    const ok = await confirm({
      title: `Move ${u.email} to ${next}?`,
      body:
        u.subscription_status && u.subscription_status !== "canceled"
          ? `They have a Stripe subscription (${u.subscription_status}). This only changes their tier in zWork, not their billing.`
          : "This changes their limits right away. It is recorded in the audit log.",
      confirmLabel: `Move to ${next}`,
      variant: "primary",
    });
    if (!ok) return;
    setSaveError("");
    const prev = u.tier;
    setData((rows) => rows && rows.map((r) => (r.user_id === u.user_id ? { ...r, tier: next } : r)));
    try {
      await setTier(u.user_id, next);
    } catch (e) {
      setData((rows) => rows && rows.map((r) => (r.user_id === u.user_id ? { ...r, tier: prev } : r)));
      setSaveError(`Couldn't change ${u.email}'s tier: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!data) return <TabStatus loading={loading} error={error} onRetry={reload} />;

  return (
    <div className="space-y-4">
      <TabToolbar right={<SearchField value={q} onChange={setQ} placeholder="Search name, email, user or Stripe id" />}>
        <Segmented
          label="Tier"
          value={tier}
          onChange={setTierFilter}
          options={[
            { value: "all", label: "All", count: users.length },
            ...TIERS.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1), count: counts[t] ?? 0 })),
          ]}
        />
      </TabToolbar>

      {saveError && <ErrorBox message={saveError} />}

      <DataTable
        rows={filtered}
        rowKey={(u) => u.user_id}
        defaultSort={{ key: "created_at", dir: "desc" }}
        empty={users.length === 0 ? "No users yet." : "No users match."}
        exportName="users"
        limit={100}
        expand={(u) => <UserDetails u={u} />}
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
            key: "subscription_status",
            label: "Billing",
            render: (u) => <span className="text-ink-muted">{u.subscription_status ?? "—"}</span>,
          },
          {
            key: "last_activity",
            label: "Last active",
            numeric: true,
            value: (u) => (u.last_activity ? Date.parse(u.last_activity) : null),
            render: (u) => <span className="text-ink-muted">{formatRelative(u.last_activity)}</span>,
          },
          {
            key: "created_at",
            label: "Joined",
            numeric: true,
            value: (u) => Date.parse(u.created_at),
            render: (u) => <span className="text-ink-muted">{formatDay(u.created_at)}</span>,
          },
          {
            key: "set_tier",
            label: "Set tier",
            noSort: true,
            noExport: true,
            render: (u) => (
              <select
                value={u.tier}
                aria-label={`Tier for ${u.email}`}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => void changeTier(u, e.target.value)}
                className="ring-focus h-7 rounded-md border border-line bg-paper px-1.5 text-[12px] text-ink"
              >
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ),
          },
        ]}
      />
      {confirmDialog}
    </div>
  );
}

function UserDetails({ u }: { u: AdminUser }) {
  const fields: [string, string | null, boolean?][] = [
    ["User id", u.user_id, true],
    ["Stripe customer", u.stripe_customer_id, true],
    ["Joined", formatDate(u.created_at)],
    ["Last active", formatDate(u.last_activity)],
    ["Prompt tokens", u.total_prompt_tokens.toLocaleString()],
    ["Completion tokens", u.total_completion_tokens.toLocaleString()],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 pt-1 text-[11.5px] sm:grid-cols-2 lg:grid-cols-3">
      {fields.map(([label, value, copyable]) => (
        <div key={label} className="flex min-w-0 items-center gap-1.5">
          <dt className="shrink-0 text-ink-faint">{label}</dt>
          <dd className={copyable ? "truncate font-mono text-ink" : "truncate text-ink"}>{value ?? "—"}</dd>
          {copyable && value && (
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
      ))}
    </dl>
  );
}
