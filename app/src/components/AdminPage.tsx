import { useEffect, useState } from "react";
import { Activity, DollarSign, Key, LogOut, RefreshCw, Shield, TrendingUp, Users } from "lucide-react";
import { cn } from "../lib/cn";

const API_BASE = "https://api.tryzwork.app";

interface Metrics {
  total_users: number;
  active_users_30d: number;
  active_users_7d: number;
  new_users_this_week: number;
  new_users_this_month: number;
  churn_rate: number;
  paid_users: number;
  mrr: number;
  arpu: number;
  free_to_paid_conversion: number;
}

interface AdminUser {
  user_id: string;
  email: string;
  name: string;
  tier: string;
  created_at: string;
  last_activity: string | null;
  total_requests: number;
  total_tokens: number;
  stripe_customer_id: string | null;
  subscription_status: string | null;
}

interface UsageRow {
  date: string;
  requests: number;
  roots: number;
  continuations: number;
  prompt_tokens: number;
  completion_tokens: number;
}

interface ModelUsage {
  provider_name: string;
  model_id: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
}

type Tab = "overview" | "users" | "usage" | "models";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatNumber(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function MetricCard({ label, value, sub, icon: Icon }: { label: string; value: string; sub?: string; icon: React.ElementType }) {
  return (
    <div className="rounded-xl border border-line bg-paper-raised p-4">
      <div className="flex items-center gap-2 text-ink-muted">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

export function AdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem("zwork:admin-token") || "");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [models, setModels] = useState<ModelUsage[]>([]);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  async function apiFetch<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    if (res.status === 401) {
      setToken("");
      sessionStorage.removeItem("zwork:admin-token");
      throw new Error("Session expired");
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function login() {
    setLoading(true);
    setAuthError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/verify-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setAuthError("Invalid password");
        return;
      }
      const { token: t } = await res.json();
      setToken(t);
      sessionStorage.setItem("zwork:admin-token", t);
    } catch {
      setAuthError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  async function loadData() {
    setLoading(true);
    try {
      const [m, u, us, mo] = await Promise.all([
        apiFetch<Metrics>("/api/admin/metrics/overview"),
        apiFetch<AdminUser[]>("/api/admin/users"),
        apiFetch<UsageRow[]>("/api/admin/usage/by-time?days=30"),
        apiFetch<ModelUsage[]>("/api/admin/usage/by-model?days=30"),
      ]);
      setMetrics(m);
      setUsers(u);
      setUsage(us);
      setModels(mo);
    } catch (e) {
      console.error("Failed to load admin data", e);
    } finally {
      setLoading(false);
    }
  }

  async function updateTier(userId: string, tier: string) {
    await fetch(`${API_BASE}/api/admin/users/${userId}/tier`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    });
    await loadData();
  }

  useEffect(() => {
    if (token) loadData();
  }, [token]);

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center bg-paper">
        <div className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-paper-raised p-8">
          <div className="flex items-center gap-3">
            <Shield className="h-6 w-6 text-ink-muted" />
            <h2 className="text-lg font-semibold text-ink">zWork Admin</h2>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
            className="space-y-3"
          >
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Admin password"
              className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent"
              autoFocus
            />
            {authError && <p className="text-xs text-red-500">{authError}</p>}
            <button
              type="submit"
              disabled={loading || !password}
              className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "overview", label: "Overview", icon: TrendingUp },
    { id: "users", label: "Users", icon: Users },
    { id: "usage", label: "Usage", icon: Activity },
    { id: "models", label: "Models", icon: Key },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-paper">
      <div className="flex items-center justify-between border-b border-line px-6 py-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-ink-muted" />
          <h1 className="text-base font-semibold text-ink">zWork Admin</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void loadData()}
            className="rounded-lg p-1.5 text-ink-muted hover:bg-paper-sunken hover:text-ink"
            title="Refresh"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
          <button
            onClick={() => {
              setToken("");
              sessionStorage.removeItem("zwork:admin-token");
            }}
            className="rounded-lg p-1.5 text-ink-muted hover:bg-paper-sunken hover:text-ink"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-line px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium transition-colors",
              tab === t.id
                ? "border-b-2 border-accent text-accent"
                : "text-ink-muted hover:text-ink",
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-6">
        {tab === "overview" && metrics && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <MetricCard icon={Users} label="Total Users" value={metrics.total_users.toString()} sub={`${metrics.new_users_this_week} this week`} />
              <MetricCard icon={Activity} label="Active (7d)" value={metrics.active_users_7d.toString()} sub={`${metrics.active_users_30d} (30d)`} />
              <MetricCard icon={DollarSign} label="MRR" value={`$${metrics.mrr.toFixed(2)}`} sub={`$${metrics.arpu.toFixed(2)} ARPU`} />
              <MetricCard icon={TrendingUp} label="Paid Users" value={metrics.paid_users.toString()} sub={`${(metrics.free_to_paid_conversion * 100).toFixed(1)}% conversion`} />
            </div>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <MetricCard icon={Users} label="New (Week)" value={metrics.new_users_this_week.toString()} />
              <MetricCard icon={Users} label="New (Month)" value={metrics.new_users_this_month.toString()} />
              <MetricCard icon={Activity} label="Churn Rate" value={`${(metrics.churn_rate * 100).toFixed(1)}%`} />
              <MetricCard icon={DollarSign} label="ARPU" value={`$${metrics.arpu.toFixed(2)}`} />
            </div>
          </div>
        )}

        {tab === "users" && (
          <div className="overflow-auto rounded-xl border border-line">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-paper-sunken">
                <tr>
                  <th className="px-3 py-2 font-medium text-ink-muted">User</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Tier</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Requests</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Tokens</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Sub Status</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Last Active</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Joined</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.user_id} className="border-b border-line/50 hover:bg-paper-sunken/50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{u.name}</div>
                      <div className="text-ink-muted">{u.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn(
                        "inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                        u.tier === "max" ? "bg-purple-100 text-purple-700" :
                        u.tier === "pro" ? "bg-blue-100 text-blue-700" :
                        "bg-gray-100 text-gray-600",
                      )}>
                        {u.tier}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink">{formatNumber(u.total_requests)}</td>
                    <td className="px-3 py-2 text-ink">{formatNumber(u.total_tokens)}</td>
                    <td className="px-3 py-2 text-ink-muted">{u.subscription_status || "—"}</td>
                    <td className="px-3 py-2 text-ink-muted whitespace-nowrap">{formatDate(u.last_activity)}</td>
                    <td className="px-3 py-2 text-ink-muted whitespace-nowrap">{formatDate(u.created_at)}</td>
                    <td className="px-3 py-2">
                      <select
                        value={u.tier}
                        onChange={(e) => void updateTier(u.user_id, e.target.value)}
                        className="rounded border border-line bg-paper px-1.5 py-0.5 text-[11px] text-ink"
                      >
                        <option value="free">free</option>
                        <option value="pro">pro</option>
                        <option value="max">max</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "usage" && (
          <div className="overflow-auto rounded-xl border border-line">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-paper-sunken">
                <tr>
                  <th className="px-3 py-2 font-medium text-ink-muted">Date</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Requests</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Roots</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Continuations</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Prompt Tokens</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Completion Tokens</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((r) => (
                  <tr key={r.date} className="border-b border-line/50 hover:bg-paper-sunken/50">
                    <td className="px-3 py-2 text-ink whitespace-nowrap">{r.date}</td>
                    <td className="px-3 py-2 text-ink">{formatNumber(r.requests)}</td>
                    <td className="px-3 py-2 text-ink">{formatNumber(r.roots)}</td>
                    <td className="px-3 py-2 text-ink">{formatNumber(r.continuations)}</td>
                    <td className="px-3 py-2 text-ink">{formatNumber(r.prompt_tokens)}</td>
                    <td className="px-3 py-2 text-ink">{formatNumber(r.completion_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "models" && (
          <div className="overflow-auto rounded-xl border border-line">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-paper-sunken">
                <tr>
                  <th className="px-3 py-2 font-medium text-ink-muted">Provider</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Model</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Requests</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Prompt Tokens</th>
                  <th className="px-3 py-2 font-medium text-ink-muted">Completion Tokens</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m, i) => (
                  <tr key={`${m.provider_name}-${m.model_id}-${i}`} className="border-b border-line/50 hover:bg-paper-sunken/50">
                    <td className="px-3 py-2 text-ink">{m.provider_name}</td>
                    <td className="px-3 py-2 font-mono text-ink">{m.model_id}</td>
                    <td className="px-3 py-2 text-ink">{formatNumber(m.requests)}</td>
                    <td className="px-3 py-2 text-ink">{formatNumber(m.prompt_tokens)}</td>
                    <td className="px-3 py-2 text-ink">{formatNumber(m.completion_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!metrics && tab === "overview" && (
          <div className="flex items-center justify-center py-20 text-sm text-ink-muted">
            {loading ? "Loading…" : "No data"}
          </div>
        )}
      </div>
    </div>
  );
}
