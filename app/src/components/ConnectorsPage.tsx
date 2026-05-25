import { useState, useEffect } from "react";
import {
  Loader2,
  RefreshCw,
  ExternalLink,
  Plug,
  X,
  Check,
} from "lucide-react";
import { useApp } from "../lib/store";
import { AppBrandLogo, hasBrandLogo } from "./BrandLogos";

const APP_DESCRIPTIONS: Record<string, string> = {
  gmail: "Send, read, and search your emails",
  googlecalendar: "Create events, check your schedule, and manage calendars",
  slack: "Send messages, read channels, and manage your workspace",
  notion: "Create pages, search your workspace, and query databases",
  googledrive: "Browse, upload, and share your files",
  github: "Create issues, manage pull requests, and browse repos",
  jira: "Track issues, manage projects, and search your board",
  trello: "Create cards, manage boards, and organize your work",
  todoist: "Create tasks, manage projects, and stay organized",
  linear: "Create issues, track progress, and manage your team",
  asana: "Manage tasks, track projects, and organize work",
  hubspot: "Manage contacts, deals, and your CRM pipeline",
};

const APP_DETAILED_DESCRIPTIONS: Record<string, string> = {
  gmail: "Connect Gmail to let zWork read, send, and search your emails on your behalf.",
  googlecalendar: "Connect Google Calendar to create events, check availability, and manage your schedule.",
  slack: "Connect Slack to send messages, read channels, and manage your workspace.",
  notion: "Connect Notion to create pages, search your workspace, and query databases.",
  googledrive: "Connect Google Drive to browse, upload, and share your files.",
  github: "Connect GitHub to create issues, manage pull requests, and browse repositories.",
  jira: "Connect Jira to track issues, manage projects, and search your board.",
  trello: "Connect Trello to create cards, manage boards, and organize your work.",
  todoist: "Connect Todoist to create tasks, manage projects, and stay organized.",
  linear: "Connect Linear to create issues, track progress, and manage your team.",
  asana: "Connect Asana to manage tasks, track projects, and organize work.",
  hubspot: "Connect HubSpot to manage contacts, deals, and your CRM pipeline.",
};

const ALLOWED_APPS = new Set([
  "gmail",
  "googlecalendar",
  "notion",
  "googledrive",
  "github",
  "linear"
]);

export function ConnectorsPage() {
  const composioAccounts = useApp((s) => s.composioAccounts);
  const composioApps = useApp((s) => s.composioApps);
  const refreshComposio = useApp((s) => s.refreshComposio);
  const connectComposioApp = useApp((s) => s.connectComposioApp);
  const disconnectComposioApp = useApp((s) => s.disconnectComposioApp);

  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [expandedApp, setExpandedApp] = useState<string | null>(null);

  useEffect(() => {
    void refreshComposio();
  }, [refreshComposio]);

  const connectedApps = new Set(
    composioAccounts
      .filter((a) => a.status === "ACTIVE")
      .map((a) => a.app),
  );

  async function handleConnect(appId: string) {
    setConnecting(appId);
    setConnectError(null);
    try {
      await connectComposioApp(appId);
    } catch (e: any) {
      setConnectError(e?.message || String(e));
    } finally {
      setConnecting(null);
    }
  }

  const allowedComposioApps = composioApps.filter((app) => ALLOWED_APPS.has(app.id));
  const expandedAppData = allowedComposioApps.find((a) => a.id === expandedApp);
  const isExpandedConnected = expandedApp ? connectedApps.has(expandedApp) : false;
  const expandedAppColor = expandedAppData?.id === "notion" ? "rgb(var(--ink))" : expandedAppData?.color;

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[860px] px-6 py-20">
        {/* Header */}
        <div className="mb-14 text-center flex flex-col items-center gap-4 relative">
          <div className="absolute right-0 top-0">
            <button
              onClick={() => void refreshComposio()}
              className="press ring-focus rounded-xl border border-line bg-paper-raised p-2.5 text-ink-soft hover:text-ink transition-colors"
              aria-label="Refresh connectors"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          <div className="mx-auto text-center flex flex-col items-center">
            <h1 className="font-serif text-[42px] font-bold tracking-tight text-ink">
              Connectors
            </h1>
            <p className="mt-4 text-[14px] leading-relaxed text-ink-soft max-w-[520px] text-center">
              Connect your apps and zWork can act on your behalf — send emails,
              manage your calendar, update tasks, and more.
            </p>
          </div>
        </div>

        {/* App grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {allowedComposioApps.map((app) => {
            const isConnected = connectedApps.has(app.id);
            const isConnecting = connecting === app.id;
            const desc = APP_DESCRIPTIONS[app.id] ?? `Use ${app.name} from zWork`;
            const hasLogo = hasBrandLogo(app.id);
            const appColor = app.id === "notion" ? "rgb(var(--ink))" : app.color;

            return (
              <button
                key={app.id}
                type="button"
                onClick={() => setExpandedApp(app.id)}
                className="group text-left flex flex-col gap-3 rounded-2xl border border-line bg-paper-raised p-4 transition-colors hover:border-line-strong"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl overflow-hidden"
                    style={{
                      backgroundColor: app.id === "notion" ? "rgba(var(--ink), 0.08)" : hasLogo ? `${appColor}14` : "rgb(var(--paper-sunken))",
                      color: hasLogo ? appColor : "rgb(var(--ink-muted))",
                    }}
                  >
                    {hasLogo ? (
                      <AppBrandLogo appId={app.id} size={20} />
                    ) : app.icon ? (
                      <img src={app.icon} alt="" className="h-6 w-6 object-contain" />
                    ) : (
                      <Plug size={18} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[14px] font-semibold text-ink truncate">
                        {app.name}
                      </h3>
                      {isConnected && (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          Connected
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <p className="text-[12.5px] leading-[18px] text-ink-soft line-clamp-2">
                  {desc}
                </p>

                <div className="mt-auto pt-1">
                  {isConnecting ? (
                    <div className="flex h-7 items-center gap-1.5 text-[12px] text-ink-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Connecting…
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-muted group-hover:text-ink transition-colors">
                      {isConnected ? "Manage" : "Connect"}
                      <ExternalLink className="h-3 w-3 opacity-60" />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Expanded overlay */}
      {expandedAppData && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-paper/80 backdrop-blur-sm p-4"
          onClick={() => setExpandedApp(null)}
        >
          <div
            className="w-full max-w-[420px] rounded-2xl border border-line bg-paper-raised p-6 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl overflow-hidden"
                  style={{
                    backgroundColor: expandedAppData.id === "notion" ? "rgba(var(--ink), 0.08)" : hasBrandLogo(expandedAppData.id)
                      ? `${expandedAppColor}14`
                      : "rgb(var(--paper-sunken))",
                    color: hasBrandLogo(expandedAppData.id)
                      ? expandedAppColor
                      : "rgb(var(--ink-muted))",
                  }}
                >
                  {hasBrandLogo(expandedAppData.id) ? (
                    <AppBrandLogo appId={expandedAppData.id} size={26} />
                  ) : expandedAppData.icon ? (
                    <img src={expandedAppData.icon} alt="" className="h-7 w-7 object-contain" />
                  ) : (
                    <Plug size={22} />
                  )}
                </div>
                <div>
                  <h3 className="text-[18px] font-semibold text-ink">{expandedAppData.name}</h3>
                  {isExpandedConnected && (
                    <span className="inline-flex items-center gap-1 text-[12px] font-medium text-emerald-600">
                      <Check className="h-3 w-3" /> Connected
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setExpandedApp(null)}
                className="press rounded-lg p-1.5 text-ink-muted hover:text-ink hover:bg-line/40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Description */}
            <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
              {APP_DETAILED_DESCRIPTIONS[expandedAppData.id] ?? APP_DESCRIPTIONS[expandedAppData.id] ?? `Use ${expandedAppData.name} from zWork`}
            </p>

            {/* Error */}
            {connectError && (
              <div className="mt-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-[12.5px] leading-relaxed text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-400">
                {connectError}
              </div>
            )}

            {/* Actions */}
            <div className="mt-4 flex gap-2">
              {isExpandedConnected ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void disconnectComposioApp(expandedAppData.id);
                      setExpandedApp(null);
                    }}
                    className="press ring-focus flex-1 rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-[13px] font-medium text-red-600 hover:bg-red-100 transition-colors dark:bg-red-500/10 dark:hover:bg-red-500/20"
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void handleConnect(expandedAppData.id);
                      setExpandedApp(null);
                    }}
                    disabled={connecting === expandedAppData.id}
                    className="press ring-focus flex-1 rounded-xl border border-line bg-paper px-4 py-2.5 text-[13px] font-medium text-ink hover:bg-paper-sunken disabled:opacity-40 transition-colors"
                  >
                    {connecting === expandedAppData.id ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Connecting…
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        Connect
                        <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                      </span>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
