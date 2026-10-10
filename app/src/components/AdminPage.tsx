import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  Boxes,
  CalendarClock,
  DollarSign,
  Globe,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  Moon,
  Radio,
  RefreshCw,
  Rocket,
  ScrollText,
  Shield,
  Sun,
  Users,
  Wallet,
} from "lucide-react";
import { cn } from "../lib/cn";
import { HealthTab } from "./admin/HealthTab";
import { RevenueTab } from "./admin/RevenueTab";
import { EngagementTab } from "./admin/EngagementTab";
import { LiveTab } from "./admin/LiveTab";
import { AuditTab } from "./admin/AuditTab";
import { UsersTab } from "./admin/UsersTab";
import { ModelsTab, UsageTab } from "./admin/UsageTab";
import { OverviewTab } from "./admin/OverviewTab";
import { FinanceTab } from "./admin/FinanceTab";
import { GrowthTab } from "./admin/GrowthTab";
import { StatusTab } from "./admin/StatusTab";
import { JobsTab } from "./admin/JobsTab";
import type { AdminTabId } from "./admin/shared";
import { formatRelative } from "./admin/format";

// API base: in the admin-web SPA (admin.tryzwork.app) requests go through
// Caddy's /api/* proxy, so an empty base (relative URLs) is correct. In the
// desktop app, the absolute API origin is required. `VITE_ADMIN_API_BASE` lets
// the admin-web build override without changing this shared source.
const API_BASE = import.meta.env.VITE_ADMIN_API_BASE ?? "https://api.tryzwork.app";
const TOKEN_KEY = "zwork:admin-token";
const THEME_KEY = "zwork:admin-theme";

interface LiveSummary {
  active_users_5m: number;
  requests_per_min: number;
}

interface TabDef {
  id: AdminTabId;
  label: string;
  icon: React.ElementType;
  /** One line under the page title. */
  blurb: string;
}

// Sidebar order is also the 1–9 shortcut order.
const GROUPS: { label: string | null; tabs: TabDef[] }[] = [
  {
    label: null,
    tabs: [{ id: "overview", label: "Overview", icon: LayoutDashboard, blurb: "The headline numbers and anything that needs a look today." }],
  },
  {
    label: "Business",
    tabs: [
      { id: "finance", label: "Finance", icon: Wallet, blurb: "What hosted models cost us, who spends it, and what's left after revenue." },
      { id: "revenue", label: "Revenue", icon: DollarSign, blurb: "MRR, subscriptions and churn from Stripe." },
      { id: "growth", label: "Growth", icon: Rocket, blurb: "Downloads, versions in use, and how sign-ups activate and stay." },
    ],
  },
  {
    label: "Product",
    tabs: [
      { id: "jobs", label: "Jobs", icon: CalendarClock, blurb: "Scheduled work, the product's wedge: who runs tasks on a schedule, how often, and what it costs." },
      { id: "users", label: "Users", icon: Users, blurb: "Every account, its tier and its usage. Click a row for that user's activity." },
      { id: "usage", label: "Usage", icon: BarChart3, blurb: "Requests and tokens over time." },
      { id: "models", label: "Models", icon: Boxes, blurb: "Traffic, latency and failures by model." },
      { id: "engagement", label: "Engagement", icon: Activity, blurb: "How often people come back and what they do." },
    ],
  },
  {
    label: "Ops",
    tabs: [
      { id: "health", label: "Health", icon: HeartPulse, blurb: "Gateway errors, latency and provider saturation." },
      { id: "live", label: "Live", icon: Radio, blurb: "What's happening right now." },
      { id: "status", label: "Status", icon: Globe, blurb: "Every public surface, the database and server integrations." },
      { id: "audit", label: "Audit", icon: ScrollText, blurb: "Admin sign-ins and changes." },
    ],
  },
];

const TABS: TabDef[] = GROUPS.flatMap((g) => g.tabs);

type Tab = AdminTabId;

function tabFromHash(): Tab {
  const h = window.location.hash.replace(/^#\/?/, "");
  return TABS.find((t) => t.id === h)?.id ?? "overview";
}

/**
 * Owner dashboard. Shared by the desktop app (`/admin`) and the admin-web SPA.
 * `standalone` is set by admin-web, where this page owns the whole window and
 * can offer its own light/dark toggle.
 */
export function AdminPage({ standalone = false }: { standalone?: boolean }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || "");
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const [, setClock] = useState(0);
  const [liveSummary, setLiveSummary] = useState<LiveSummary | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  const signOutLocal = useCallback(() => {
    setToken("");
    sessionStorage.removeItem(TOKEN_KEY);
  }, []);

  const apiFetch = useCallback(
    async function apiFetch<T>(path: string): Promise<T> {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 401) {
        signOutLocal();
        throw new Error("Session expired. Sign in again.");
      }
      if (!res.ok) throw new Error(await errorText(res));
      return res.json();
    },
    [token, signOutLocal],
  );

  const setTier = useCallback(
    async (userId: string, tier: string) => {
      const res = await fetch(`${API_BASE}/api/admin/users/${encodeURIComponent(userId)}/tier`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      if (res.status === 401) signOutLocal();
      if (!res.ok) throw new Error(await errorText(res));
    },
    [token, signOutLocal],
  );

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    // replaceState so tab switches don't pile up in history, but a reload or
    // a shared link lands on the same tab.
    window.history.replaceState(null, "", `#${t}`);
  }, []);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setRefreshedAt(Date.now());
  }, []);

  // Each tab starts at the top, not where the last one was scrolled to.
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
    document
      .querySelector("#admin-tabs-narrow [aria-current=page]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Keep "updated 3m ago" honest without a refetch.
  useEffect(() => {
    const i = setInterval(() => setClock((c) => c + 1), 30_000);
    return () => clearInterval(i);
  }, []);

  // Keyboard: 1–9 jump to a tab, j/k step through them, r refreshes.
  // Ignored while typing.
  useEffect(() => {
    if (!token) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const n = Number(e.key);
      const i = TABS.findIndex((t) => t.id === tab);
      if (n >= 1 && n <= Math.min(9, TABS.length)) setTab(TABS[n - 1].id);
      else if (e.key === "j") setTab(TABS[(i + 1) % TABS.length].id);
      else if (e.key === "k") setTab(TABS[(i - 1 + TABS.length) % TABS.length].id);
      else if (e.key === "r") refresh();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token, tab, setTab, refresh]);

  // Header badge: light polling that stops while the window is hidden and
  // starts again when it comes back.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    async function tick() {
      try {
        const d = await apiFetch<LiveSummary>(`/api/admin/metrics/live?_=${Date.now()}`);
        if (!cancelled) setLiveSummary(d);
      } catch {
        if (!cancelled) setLiveSummary(null);
      }
    }
    function start() {
      if (interval) return;
      void tick();
      interval = setInterval(tick, 30_000);
    }
    function stop() {
      clearInterval(interval);
      interval = undefined;
    }
    const onVis = () => (document.visibilityState === "hidden" ? stop() : start());
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [token, apiFetch, refreshKey]);

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  if (!token) {
    return (
      <LoginScreen
        onToken={(t) => {
          setToken(t);
          setRefreshedAt(Date.now());
          sessionStorage.setItem(TOKEN_KEY, t);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-paper">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Shield className="h-4 w-4 shrink-0 text-ink-muted" />
          <h1 className="truncate text-[15px] font-semibold text-ink">zWork Admin</h1>
          {liveSummary && (
            <button
              type="button"
              onClick={() => setTab("live")}
              title="Open Live"
              className="ring-focus ml-1 flex shrink-0 items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success hover:bg-success/15"
            >
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
              {liveSummary.active_users_5m} active · {liveSummary.requests_per_min.toFixed(0)}/min
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden text-[11.5px] text-ink-faint sm:inline">
            updated {formatRelative(new Date(refreshedAt).toISOString())}
          </span>
          <HeaderButton label="Refresh (r)" onClick={refresh}>
            <RefreshCw className="h-4 w-4" />
          </HeaderButton>
          {standalone && <ThemeToggle />}
          <HeaderButton
            label="Sign out"
            onClick={() => {
              void fetch(`${API_BASE}/api/admin/logout`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
              }).catch(() => {});
              signOutLocal();
            }}
          >
            <LogOut className="h-4 w-4" />
          </HeaderButton>
        </div>
      </header>

      {/* Narrow windows: one scrolling row instead of the sidebar. */}
      <nav
        id="admin-tabs-narrow"
        className="flex gap-0.5 overflow-x-auto border-b border-line px-3 md:hidden"
        aria-label="Admin sections"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "ring-focus -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] font-medium",
              tab === t.id ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[208px] shrink-0 flex-col border-r border-line md:flex" aria-label="Admin sections">
          <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 py-3">
            {GROUPS.map((g) => (
              <div key={g.label ?? "top"}>
                {g.label && (
                  <div className="mb-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
                    {g.label}
                  </div>
                )}
                <ul className="space-y-px">
                  {g.tabs.map((t) => {
                    const n = TABS.indexOf(t) + 1;
                    const active = tab === t.id;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => setTab(t.id)}
                          title={n <= 9 ? `${t.label} (${n})` : t.label}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "ring-focus group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
                            active ? "bg-paper-sunken text-ink" : "text-ink-muted hover:bg-paper-sunken/60 hover:text-ink",
                          )}
                        >
                          <t.icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="flex-1 truncate text-left">{t.label}</span>
                          {t.id === "live" && liveSummary && (
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                          )}
                          {n <= 9 && (
                            <kbd className="hidden font-mono text-[10px] text-ink-faint group-hover:inline">{n}</kbd>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <p className="border-t border-line px-5 py-2.5 text-[10.5px] leading-relaxed text-ink-faint">
            <kbd className="font-mono">1</kbd>–<kbd className="font-mono">9</kbd> jump · <kbd className="font-mono">j</kbd>/
            <kbd className="font-mono">k</kbd> step · <kbd className="font-mono">r</kbd> refresh
          </p>
        </aside>

        <main ref={mainRef} className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[1240px] px-5 py-5 md:px-7 md:py-6">
            <div className="mb-5">
              <h2 className="text-[22px] font-semibold tracking-tight text-ink">{current.label}</h2>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">{current.blurb}</p>
            </div>
            {tab === "overview" && <OverviewTab apiFetch={apiFetch} refreshKey={refreshKey} onOpen={setTab} />}
            {tab === "finance" && <FinanceTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "revenue" && <RevenueTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "growth" && <GrowthTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "jobs" && <JobsTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "users" && <UsersTab apiFetch={apiFetch} refreshKey={refreshKey} setTier={setTier} />}
            {tab === "usage" && <UsageTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "models" && <ModelsTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "engagement" && <EngagementTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "health" && <HealthTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "live" && <LiveTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "status" && <StatusTab apiFetch={apiFetch} refreshKey={refreshKey} />}
            {tab === "audit" && <AuditTab apiFetch={apiFetch} refreshKey={refreshKey} />}
          </div>
        </main>
      </div>
    </div>
  );
}

/** Server error bodies are usually short text or `{error}` JSON; show them. */
async function errorText(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.text()).trim();
    try {
      const j = JSON.parse(body) as { error?: unknown; message?: unknown };
      detail = String(j.error ?? j.message ?? "");
    } catch {
      detail = body.slice(0, 200);
    }
  } catch {
    /* no body */
  }
  return `${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`;
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="press ring-focus rounded-lg p-1.5 text-ink-muted hover:bg-paper-sunken hover:text-ink"
    >
      {children}
    </button>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  return (
    <HeaderButton
      label={dark ? "Light theme" : "Dark theme"}
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle("dark", next);
        document.documentElement.classList.toggle("light", !next);
        try {
          localStorage.setItem(THEME_KEY, next ? "dark" : "light");
        } catch {
          /* private mode: theme just won't persist */
        }
      }}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </HeaderButton>
  );
}

function LoginScreen({ onToken }: { onToken: (t: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function login() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/verify-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 401 || res.status === 403) {
        setError("Wrong password.");
        return;
      }
      if (res.status === 429) {
        setError("Too many attempts. Wait a minute and try again.");
        return;
      }
      if (!res.ok) {
        setError(`Sign-in failed: ${await errorText(res)}`);
        return;
      }
      const { token } = (await res.json()) as { token: string };
      onToken(token);
    } catch {
      setError(`Couldn't reach ${API_BASE || window.location.origin}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-paper-raised p-7">
        <div className="flex items-center gap-2.5">
          <Shield className="h-5 w-5 text-ink-muted" />
          <h2 className="text-[17px] font-semibold text-ink">zWork Admin</h2>
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
            aria-label="Admin password"
            autoComplete="current-password"
            className="ring-focus w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint"
            autoFocus
          />
          {error && <p className="text-[12px] text-error">{error}</p>}
          <button
            type="submit"
            disabled={busy || !password}
            className="press ring-focus w-full rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
