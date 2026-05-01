import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowRight, BarChart3, Calendar, CheckCircle, ExternalLink, LogOut, Sparkles, TrendingUp, User, Zap } from "lucide-react";
import { api } from "../lib/api";
import {
  clearManagedBackup,
  fetchAnalyticsSummary,
  logoutCloudSession,
  redeemAccessCode,
  saveManagedBackup,
  type AnalyticsSummary,
  type CloudUser,
  getManagedBackup,
} from "../lib/cloud";
import { recordTelemetry } from "../lib/telemetry";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

const MANAGED_MODEL_ID = "zwork-router";
const MANAGED_BASE_URL = "https://api.tryzwork.app/api/v1";
const MANAGED_MODEL_NAME = "zWork Router";

function StatCard({
  label,
  value,
  hint,
  icon,
  trend,
}: {
  label: string;
  value: string;
  hint: string;
  icon: ReactNode;
  trend?: "up" | "down" | "neutral";
}) {
  return (
    <div className="rounded-2xl border border-line bg-paper-raised p-5 shadow-[0_8px_32px_rgba(17,17,17,0.06)] transition-shadow hover:shadow-[0_12px_40px_rgba(17,17,17,0.1)]">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">{label}</div>
        <div className="text-ink-muted">{icon}</div>
      </div>
      <div className="mt-3 text-[32px] font-light tracking-tight text-ink">{value}</div>
      <div className="mt-1 text-[12.5px] leading-5 text-ink-muted">{hint}</div>
    </div>
  );
}

function ProgressQuotaCard({
  label,
  icon,
  used,
  limit,
  hint,
  period,
}: {
  label: string;
  icon: ReactNode;
  used: number;
  limit: number;
  hint: string;
  period: string;
}) {
  const remaining = Math.max(limit - used, 0);
  const percentRemaining = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
  const percentUsed = limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;

  const getColor = () => {
    if (percentRemaining <= 10) return { bar: "bg-rose-500", text: "text-rose-600", sub: "text-rose-500/20" };
    if (percentRemaining <= 25) return { bar: "bg-amber-500", text: "text-amber-600", sub: "text-amber-500/20" };
    return { bar: "bg-emerald-500", text: "text-emerald-600", sub: "text-emerald-500/20" };
  };

  const colors = getColor();

  return (
    <div className="rounded-2xl border border-line bg-paper-raised p-5 shadow-[0_8px_32px_rgba(17,17,17,0.06)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", colors.sub)}>
            {icon}
          </div>
          <div>
            <div className="text-[13px] font-semibold text-ink">{label}</div>
            <div className="text-[11.5px] text-ink-muted">{period}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[28px] font-light tracking-tight text-ink">
            {remaining}
            <span className="ml-1 text-[14px] text-ink-muted">left</span>
          </div>
          <div className="text-[12px] text-ink-muted">{used} of {limit} used</div>
        </div>
      </div>
      <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-paper-sunken">
        <div
          className={cn("h-full rounded-full transition-all duration-500", colors.bar)}
          style={{ width: `${percentUsed}%` }}
        />
      </div>
      <div className="mt-2 text-[12px] text-ink-muted">{hint}</div>
    </div>
  );
}

export function AnalyticsPage({
  cloudUser,
  onCloudUserChange,
}: {
  cloudUser: CloudUser;
  onCloudUserChange: (user: CloudUser | null) => void;
}) {
  const settings = useApp((s) => s.settings);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const saveSettings = useApp((s) => s.saveSettings);
  const upsertCustomModel = useApp((s) => s.upsertCustomModel);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessCode, setAccessCode] = useState("zwork-dev-pro");
  const [accessCodeBusy, setAccessCodeBusy] = useState(false);
  const [accessCodeError, setAccessCodeError] = useState<string | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [trendRange, setTrendRange] = useState<"7d" | "1m">("7d");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void fetchAnalyticsSummary()
      .then((data) => {
        if (!alive) return;
        setSummary(data);
        onCloudUserChange(data.user);
      })
      .catch(() => {
        if (!alive) return;
        setSummary(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [onCloudUserChange]);

  const managedActive = useMemo(() => {
    const currentBase = settings?.provider_config?.openai?.base_url || "";
    const currentDefault = settings?.default_model || "";
    return currentBase === MANAGED_BASE_URL && currentDefault === MANAGED_MODEL_ID;
  }, [settings]);
  const managedReady = summary?.managed_gateway_ready ?? false;
  const managedStatus = summary?.managed_gateway_status || "Checking hosted gateway status…";

  const activateManagedMode = async () => {
    if (!settings) return;
    setRouteBusy(true);
    setRouteError(null);
    try {
      if (!getManagedBackup()) {
        saveManagedBackup({
          apiKey: settings.api_keys?.openai || "",
          baseUrl: settings.provider_config?.openai?.base_url || "",
          defaultModel: settings.default_model || "",
        });
      }
      await saveSettings({
        api_keys: { openai: window.localStorage.getItem("zwork:cloud-token") || "" },
        provider_config: { openai: { base_url: MANAGED_BASE_URL } },
      });
      await upsertCustomModel({
        id: MANAGED_MODEL_ID,
        name: MANAGED_MODEL_NAME,
        shape: "openai",
        credential: "openai",
        model_id: MANAGED_MODEL_ID,
        base_url_override: MANAGED_BASE_URL,
      });
      await api.putSettings({ default_model: MANAGED_MODEL_ID });
      await Promise.all([refreshSettings(), refreshProviders()]);
      recordTelemetry("managed_mode_activated", {
        tier: cloudUser.tier,
      });
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Failed to activate managed mode.");
    } finally {
      setRouteBusy(false);
    }
  };

  const restorePersonalMode = async () => {
    const backup = getManagedBackup();
    setRouteBusy(true);
    setRouteError(null);
    try {
      await saveSettings({
        api_keys: { openai: backup?.apiKey || "" },
        provider_config: { openai: { base_url: backup?.baseUrl || "" } },
      });
      await api.putSettings({ default_model: backup?.defaultModel || "" });
      clearManagedBackup();
      await Promise.all([refreshSettings(), refreshProviders()]);
      recordTelemetry("managed_mode_restored_personal", {});
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Failed to restore your previous setup.");
    } finally {
      setRouteBusy(false);
    }
  };

  const redeemAccess = async () => {
    setAccessCodeBusy(true);
    setAccessCodeError(null);
    try {
      const user = await redeemAccessCode(accessCode);
      onCloudUserChange(user);
      setSummary((current) => (current ? { ...current, user } : current));
      recordTelemetry("access_code_applied", {
        code: accessCode,
        tier: user.tier,
      });
    } catch (error) {
      setAccessCodeError(error instanceof Error ? error.message : "Failed to redeem access code.");
      recordTelemetry("access_code_failed", {
        code: accessCode,
        message: error instanceof Error ? error.message : "Failed to redeem access code.",
      });
    } finally {
      setAccessCodeBusy(false);
    }
  };

  const signOut = async () => {
    setLogoutBusy(true);
    try {
      await logoutCloudSession();
      onCloudUserChange(null);
    } finally {
      setLogoutBusy(false);
    }
  };

  const trendData = trendRange === "1m" ? (summary?.past_month || []) : (summary?.past_week || []);
  const maxDay = Math.max(1, ...(trendData.map((day) => day.roots) || [1]));
  const user = summary?.user || cloudUser;
  const isPro = user.tier === "pro";
  const firstName = user.name.split(/\s+/)[0] || "there";

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5 px-6 py-8">
        {/* Welcome Header */}
        <section className="overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-paper-raised to-paper p-6 shadow-[0_16px_60px_rgba(17,17,17,0.08)] md:p-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex items-center gap-2">
                {isPro ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                    <Sparkles className="h-3 w-3" />
                    Pro
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-paper-sunken px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                    Free
                  </span>
                )}
              </div>
              <h1 className="mt-3 text-[32px] font-light leading-tight tracking-tight text-ink md:text-[40px]">
                Welcome back, {firstName}!
              </h1>
              <p className="mt-2 max-w-[50ch] text-[14px] leading-6 text-ink-muted">
                Here's your activity overview and usage. {isPro ? "You have full access to all features." : "Upgrade to Pro for extended limits and hosted access."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={logoutBusy}
              className="press inline-flex items-center gap-2 rounded-full border border-line bg-paper px-4 py-2 text-[13px] font-medium text-ink-muted hover:border-line-strong hover:bg-paper-sunken hover:text-ink disabled:opacity-50"
            >
              <LogOut className="h-4 w-4" />
              {logoutBusy ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </section>

        {/* Usage Limits */}
        <section className="grid gap-4 xl:grid-cols-2">
          <ProgressQuotaCard
            label="Requests remaining"
            icon={<Zap className="h-5 w-5 text-ink-muted" />}
            used={loading ? 0 : (summary?.five_hour_used || 0)}
            limit={loading ? 0 : (summary?.five_hour_limit || 0)}
            hint="Based on your last 5 hours of activity"
            period="Rolling window"
          />
          <ProgressQuotaCard
            label="Weekly budget"
            icon={<Calendar className="h-5 w-5 text-ink-muted" />}
            used={loading ? 0 : (summary?.weekly_used || 0)}
            limit={loading ? 0 : (summary?.weekly_limit || 0)}
            hint="Resets gradually over 7 days"
            period="Rolling week"
          />
        </section>

        {/* Quick Stats */}
        <section className="grid gap-4 md:grid-cols-3">
          <StatCard
            label="Active tasks"
            value={loading ? "…" : String(summary?.active_runs || 0)}
            hint="Running right now"
            icon={<Activity className="h-4 w-4" />}
          />
          <StatCard
            label="Today's conversations"
            value={loading ? "…" : String(summary?.continuation_requests_today || 0)}
            hint="Started today"
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <StatCard
            label="Plan"
            value={isPro ? "Pro" : "Free"}
            hint={isPro ? "Full access enabled" : "Upgrade anytime"}
            icon={<User className="h-4 w-4" />}
          />
        </section>

        {/* Usage Chart and Quick Actions */}
        <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          {/* Usage Trend Chart */}
          <div className="rounded-2xl border border-line bg-paper-raised p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[17px] font-semibold tracking-tight text-ink">Your activity</h2>
                <p className="mt-1 text-[13px] text-ink-muted">See how much you've been using zWork</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="rounded-full border border-line bg-paper-sunken p-1">
                  <button
                    type="button"
                    onClick={() => setTrendRange("7d")}
                    className={cn(
                      "rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
                      trendRange === "7d" ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
                    )}
                  >
                    7 days
                  </button>
                  <button
                    type="button"
                    onClick={() => setTrendRange("1m")}
                    className={cn(
                      "rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
                      trendRange === "1m" ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
                    )}
                  >
                    30 days
                  </button>
                </div>
                <BarChart3 className="h-5 w-5 text-ink-faint" />
              </div>
            </div>
            <div
              className="mt-6 grid gap-2"
              style={{ gridTemplateColumns: `repeat(${Math.max(trendData.length, 1)}, minmax(0, 1fr))` }}
            >
              {trendData.map((day) => {
                const height = `${Math.max(8, (day.roots / maxDay) * 160)}px`;
                const hasActivity = day.roots > 0;
                return (
                  <div key={day.day} className="flex flex-col items-center gap-2">
                    <div className="flex h-[160px] w-full items-end justify-center rounded-xl bg-paper-sunken px-1.5 pb-1.5">
                      <div
                        className={cn(
                          "flex w-full flex-col overflow-hidden rounded-lg border transition-all duration-300",
                          hasActivity
                            ? "border-line/60 bg-white/80 dark:bg-white/10"
                            : "border-transparent bg-transparent"
                        )}
                        style={{ height }}
                      >
                        {hasActivity && <div className="flex-1 bg-emerald-500/80 dark:bg-emerald-400/70" />}
                      </div>
                    </div>
                    <div className={cn("text-center text-[10.5px]", hasActivity ? "text-ink" : "text-ink-faint")}>
                      {day.day.slice(5).replace("-", "/")}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quick Actions Panel */}
          <div className="flex flex-col gap-4">
            {/* Hosted Mode Toggle */}
            <div className="rounded-2xl border border-line bg-paper-raised p-5">
              <div className="flex items-start gap-3">
                <div className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                  isPro ? "bg-emerald-100 dark:bg-emerald-500/20" : "bg-paper-sunken"
                )}>
                  <Sparkles className={cn("h-5 w-5", isPro ? "text-emerald-600 dark:text-emerald-400" : "text-ink-muted")} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-semibold text-ink">Hosted access</h3>
                  <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
                    {managedActive
                      ? "Using zWork's hosted AI gateway"
                      : isPro
                        ? "Activate hosted AI access"
                        : "Upgrade to Pro to use hosted access"}
                  </p>
                </div>
              </div>
              <div className="mt-4">
                {managedActive ? (
                  <button
                    type="button"
                    disabled={routeBusy}
                    onClick={() => void restorePersonalMode()}
                    className="press w-full rounded-full border border-line bg-paper px-4 py-2.5 text-[13px] font-medium text-ink hover:border-line-strong hover:bg-paper-sunken disabled:opacity-50"
                  >
                    {routeBusy ? "Switching…" : "Use personal setup"}
                  </button>
                ) : isPro ? (
                  <button
                    type="button"
                    disabled={routeBusy || !managedReady}
                    onClick={() => void activateManagedMode()}
                    className="press w-full rounded-full bg-ink px-4 py-2.5 text-[13px] font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
                  >
                    {routeBusy ? "Activating…" : "Turn on hosted access"}
                  </button>
                ) : (
                  <div className="rounded-xl bg-paper-sunken px-4 py-3 text-[12px] text-ink-muted">
                    Upgrade to Pro to enable hosted access
                  </div>
                )}
              </div>
              {managedStatus && !managedActive && (
                <div className="mt-3 text-[11.5px] text-ink-faint">
                  {managedStatus}
                </div>
              )}
              {routeError && (
                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                  {routeError}
                </div>
              )}
            </div>

            {/* Access Code (Pro testing) */}
            {!isPro && (
              <div className="rounded-2xl border border-line bg-paper-raised p-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-500/20">
                    <Sparkles className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[15px] font-semibold text-ink">Try Pro free</h3>
                    <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
                      Use an access code to test Pro features
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <input
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    className="min-w-0 flex-1 rounded-full border border-line bg-paper px-4 py-2.5 text-[12.5px] text-ink focus:border-line-strong focus:outline-none"
                    placeholder="Enter access code"
                  />
                  <button
                    type="button"
                    disabled={accessCodeBusy}
                    onClick={() => void redeemAccess()}
                    className="press shrink-0 rounded-full bg-ink px-4 py-2.5 text-[13px] font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
                  >
                    {accessCodeBusy ? "Applying…" : "Apply"}
                  </button>
                </div>
                {accessCodeError && (
                  <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                    {accessCodeError}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Quick Links - Only for admins/owners */}
        {summary?.owner_provider_overview && summary.owner_provider_overview.length > 0 && (
          <section className="rounded-2xl border border-line bg-paper-raised p-5">
            <div className="flex items-center gap-3">
              <ExternalLink className="h-5 w-5 text-ink-muted" />
              <h2 className="text-[15px] font-semibold text-ink">Quick links</h2>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {[
                { label: "API status", href: summary?.api_url || "https://api.tryzwork.app/health" },
                { label: "Analytics", href: summary?.analytics_url || "https://us.posthog.com/project/397748" },
              ].map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="press group flex items-center justify-between rounded-xl border border-line bg-paper px-4 py-3 hover:border-line-strong hover:bg-paper-sunken"
                >
                  <span className="text-[13px] font-medium text-ink">{link.label}</span>
                  <ExternalLink className="h-4 w-4 text-ink-faint transition-transform group-hover:translate-x-0.5" />
                </a>
              ))}
            </div>
          </section>
        )}

        {/* How limits work - helpful explanation */}
        <section className="rounded-2xl border border-line bg-paper-raised p-5">
          <h2 className="text-[15px] font-semibold text-ink">Understanding your limits</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/20">
                <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <div className="text-[13px] font-medium text-ink">What counts</div>
                <div className="mt-1 text-[12px] text-ink-muted">
                  Only your main requests count toward your limit. Background work doesn't use up your quota.
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-500/20">
                <TrendingUp className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <div className="text-[13px] font-medium text-ink">Rolling limits</div>
                <div className="mt-1 text-[12px] text-ink-muted">
                  Your limits reset gradually over time, not all at once. Older usage drops off automatically.
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
