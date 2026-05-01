import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowUpRight, ExternalLink, LogOut, Sparkles, TrendingUp, User, Zap, Calendar, Info } from "lucide-react";
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

function StatBar({
  label,
  value,
  used,
  limit,
  color = "emerald",
}: {
  label: string;
  value: string;
  used: number;
  limit: number;
  color?: "emerald" | "amber" | "rose";
}) {
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const remaining = Math.max(limit - used, 0);

  const colors = {
    emerald: { bar: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
    amber: { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
    rose: { bar: "bg-rose-500", text: "text-rose-600 dark:text-rose-400" },
  }[color];

  return (
    <div className="flex items-center gap-4 py-3">
      <div className="w-24 shrink-0 text-[13px] text-ink-muted">{label}</div>
      <div className="flex-1">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[26px] font-light tracking-tight text-ink">{value}</span>
          <span className={cn("text-[12px]", colors.text)}>{remaining} left</span>
        </div>
        <div className="h-1.5 rounded-full bg-paper-sunken">
          <div className={cn("h-full rounded-full transition-all duration-500", colors.bar)} style={{ width: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line/50 bg-paper px-4 py-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-paper-sunken text-ink-muted">
        {icon}
      </div>
      <div>
        <div className="text-[22px] font-light leading-none text-ink">{value}</div>
        <div className="mt-1 text-[11.5px] uppercase tracking-wide text-ink-faint">{label}</div>
      </div>
    </div>
  );
}

function ActionCard({
  icon,
  title,
  description,
  action,
  variant = "default",
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: ReactNode;
  variant?: "default" | "pro";
}) {
  return (
    <div className={cn(
      "flex items-start gap-4 rounded-2xl border p-5",
      variant === "pro"
        ? "border-line bg-paper-sunken"
        : "border-line bg-paper"
    )}>
      <div className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
        variant === "pro"
          ? "bg-emerald-100 dark:bg-emerald-500/20"
          : "bg-paper-sunken"
      )}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-[13px] text-ink-muted">{description}</p>
        <div className="mt-3">{action}</div>
      </div>
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

  const fiveHourUsed = summary?.five_hour_used || 0;
  const fiveHourLimit = summary?.five_hour_limit || 0;
  const weeklyUsed = summary?.weekly_used || 0;
  const weeklyLimit = summary?.weekly_limit || 0;

  const fiveHourColor = fiveHourLimit > 0
    ? ((fiveHourLimit - fiveHourUsed) / fiveHourLimit <= 0.1 ? "rose" : ((fiveHourLimit - fiveHourUsed) / fiveHourLimit <= 0.25 ? "amber" : "emerald"))
    : "emerald";
  const weeklyColor = weeklyLimit > 0
    ? ((weeklyLimit - weeklyUsed) / weeklyLimit <= 0.1 ? "rose" : ((weeklyLimit - weeklyUsed) / weeklyLimit <= 0.25 ? "amber" : "emerald"))
    : "emerald";

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[1000px] px-6 py-8">

        {/* Header */}
        <header className="mb-8 flex items-center justify-between border-b border-line/50 pb-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-[36px] font-light tracking-tight text-ink">
                Analytics
              </h1>
              {isPro && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                  <Sparkles className="h-3 w-3" />
                  Pro
                </span>
              )}
            </div>
            <p className="mt-2 text-[14px] text-ink-muted">
              Welcome back, {firstName}. Here's your activity overview.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={logoutBusy}
            className="press ring-focus inline-flex items-center gap-2 rounded-full border border-line/50 bg-paper px-4 py-2 text-[13px] text-ink-muted hover:border-line hover:bg-paper-sunken hover:text-ink disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </header>

        {/* Main Content Grid */}
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">

          {/* Left Column */}
          <div className="space-y-6">

            {/* Usage Section */}
            <section className="rounded-2xl border border-line bg-paper p-6">
              <div className="mb-4 flex items-center gap-2">
                <Zap className="h-5 w-5 text-ink-muted" />
                <h2 className="text-[16px] font-semibold text-ink">Usage Limits</h2>
              </div>
              <div className="space-y-1">
                <StatBar
                  label="5-hour window"
                  value={`${fiveHourUsed}/${fiveHourLimit}`}
                  used={fiveHourUsed}
                  limit={fiveHourLimit}
                  color={fiveHourColor}
                />
                <div className="my-2 border-t border-line/30" />
                <StatBar
                  label="Weekly budget"
                  value={`${weeklyUsed}/${weeklyLimit}`}
                  used={weeklyUsed}
                  limit={weeklyLimit}
                  color={weeklyColor}
                />
              </div>
            </section>

            {/* Activity Chart */}
            <section className="rounded-2xl border border-line bg-paper p-6">
              <div className="mb-5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-ink-muted" />
                  <h2 className="text-[16px] font-semibold text-ink">Activity</h2>
                </div>
                <div className="flex items-center gap-1 rounded-full border border-line/50 bg-paper p-0.5">
                  <button
                    type="button"
                    onClick={() => setTrendRange("7d")}
                    className={cn(
                      "ring-focus rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors",
                      trendRange === "7d" ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
                    )}
                  >
                    7 days
                  </button>
                  <button
                    type="button"
                    onClick={() => setTrendRange("1m")}
                    className={cn(
                      "ring-focus rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors",
                      trendRange === "1m" ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
                    )}
                  >
                    30 days
                  </button>
                </div>
              </div>
              <div
                className="flex items-end justify-between gap-1"
                style={{ height: "140px" }}
              >
                {trendData.map((day) => {
                  const height = Math.max(8, (day.roots / maxDay) * 120);
                  const hasActivity = day.roots > 0;
                  return (
                    <div key={day.day} className="flex flex-1 flex-col items-center gap-1.5">
                      <div
                        className={cn(
                          "w-full rounded-t-md transition-all duration-300",
                          hasActivity ? "bg-ink/80 dark:bg-white/15" : "bg-paper-sunken"
                        )}
                        style={{ height: `${height}px` }}
                      />
                      <div className={cn("text-[9.5px]", hasActivity ? "text-ink-faint" : "text-ink-faint/50")}>
                        {day.day.slice(5).replace("-", "")}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Quick Stats */}
            <section className="grid gap-3 sm:grid-cols-3">
              <MiniStat
                label="Active tasks"
                value={loading ? "—" : (summary?.active_runs || 0)}
                icon={<Activity className="h-4 w-4" />}
              />
              <MiniStat
                label="Today's chats"
                value={loading ? "—" : (summary?.continuation_requests_today || 0)}
                icon={<Calendar className="h-4 w-4" />}
              />
              <MiniStat
                label="Plan"
                value={isPro ? "Pro" : "Free"}
                icon={<User className="h-4 w-4" />}
              />
            </section>

            {/* Help Section */}
            <section className="rounded-2xl border border-line/50 bg-paper px-5 py-4">
              <div className="flex items-start gap-3">
                <Info className="h-4 w-4 mt-0.5 text-ink-faint" />
                <div className="text-[12.5px] text-ink-muted">
                  <span className="font-medium text-ink">How limits work:</span> Only your main requests count. Background tasks don't use quota. Limits reset gradually over time.
                </div>
              </div>
            </section>
          </div>

          {/* Right Column - Actions */}
          <div className="space-y-4">

            {/* Hosted Access */}
            <ActionCard
              icon={<Sparkles className={cn("h-5 w-5", isPro ? "text-emerald-600 dark:text-emerald-400" : "text-ink-muted")} />}
              title="Hosted Access"
              description={managedActive
                ? "Using zWork's hosted AI gateway"
                : isPro
                  ? "Activate hosted AI access"
                  : "Pro feature — upgrade to enable"}
              variant={isPro ? "pro" : "default"}
              action={
                managedActive ? (
                  <button
                    type="button"
                    disabled={routeBusy}
                    onClick={() => void restorePersonalMode()}
                    className="press ring-focus w-full rounded-full border border-line/50 bg-paper px-4 py-2 text-[13px] font-medium text-ink hover:bg-paper-sunken disabled:opacity-50"
                  >
                    Use personal setup
                  </button>
                ) : isPro ? (
                  <button
                    type="button"
                    disabled={routeBusy || !managedReady}
                    onClick={() => void activateManagedMode()}
                    className="press ring-focus w-full rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
                  >
                    {routeBusy ? "Activating…" : "Turn on"}
                  </button>
                ) : (
                  <div className="text-[12px] text-ink-muted">Upgrade to Pro required</div>
                )
              }
            />
            {routeError && (
              <div className="rounded-xl border border-line-strong bg-paper-sunken px-3 py-2 text-[12px] text-ink">
                {routeError}
              </div>
            )}

            {/* Access Code */}
            {!isPro && (
              <ActionCard
                icon={<Sparkles className="h-5 w-5 text-amber-600 dark:text-amber-400" />}
                title="Try Pro Free"
                description="Use an access code to test Pro features"
                action={
                  <div className="flex gap-2">
                    <input
                      value={accessCode}
                      onChange={(e) => setAccessCode(e.target.value)}
                      className="ring-focus flex-1 rounded-full border border-line/50 bg-paper px-3 py-2 text-[12.5px] text-ink focus:border-line focus:outline-none"
                      placeholder="Access code"
                    />
                    <button
                      type="button"
                      disabled={accessCodeBusy}
                      onClick={() => void redeemAccess()}
                      className="press ring-focus shrink-0 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
                    >
                      {accessCodeBusy ? "…" : "Go"}
                    </button>
                  </div>
                }
              />
            )}
            {accessCodeError && (
              <div className="rounded-xl border border-line-strong bg-paper-sunken px-3 py-2 text-[12px] text-ink">
                {accessCodeError}
              </div>
            )}

            {/* Quick Links */}
            {summary?.owner_provider_overview && summary.owner_provider_overview.length > 0 && (
              <div className="rounded-2xl border border-line/50 bg-paper p-5">
                <div className="mb-3 flex items-center gap-2">
                  <ExternalLink className="h-4 w-4 text-ink-muted" />
                  <h3 className="text-[14px] font-semibold text-ink">Quick Links</h3>
                </div>
                <div className="space-y-2">
                  <a
                    href={summary?.api_url || "https://api.tryzwork.app/health"}
                    target="_blank"
                    rel="noreferrer"
                    className="press ring-focus flex items-center justify-between rounded-lg border border-line/50 px-3 py-2 text-[13px] text-ink hover:bg-paper-sunken"
                  >
                    <span>API Status</span>
                    <ArrowUpRight className="h-3.5 w-3.5 text-ink-faint" />
                  </a>
                  <a
                    href={summary?.analytics_url || "https://us.posthog.com/project/397748"}
                    target="_blank"
                    rel="noreferrer"
                    className="press ring-focus flex items-center justify-between rounded-lg border border-line/50 px-3 py-2 text-[13px] text-ink hover:bg-paper-sunken"
                  >
                    <span>Analytics Dashboard</span>
                    <ArrowUpRight className="h-3.5 w-3.5 text-ink-faint" />
                  </a>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
