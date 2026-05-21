import { useState, useEffect } from "react";
import {
  Loader2,
  RefreshCw,
  ExternalLink,
  Plug,
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

export function ConnectorsPage() {
  const composioStatus = useApp((s) => s.composioStatus);
  const composioAccounts = useApp((s) => s.composioAccounts);
  const composioApps = useApp((s) => s.composioApps);
  const refreshComposio = useApp((s) => s.refreshComposio);
  const connectComposioApp = useApp((s) => s.connectComposioApp);
  const disconnectComposioApp = useApp((s) => s.disconnectComposioApp);

  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    void refreshComposio();
  }, [refreshComposio]);

  const connectedApps = new Set(
    composioAccounts
      .filter((a) => a.status === "ACTIVE")
      .map((a) => a.app),
  );
  const toolCount = composioStatus?.tool_count ?? 0;
  const connectedCount = connectedApps.size;

  async function handleConnect(appId: string) {
    setConnecting(appId);
    try {
      await connectComposioApp(appId);
    } finally {
      setConnecting(null);
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[860px] px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight text-ink">
              Connectors
            </h1>
            <p className="mt-1.5 text-[14px] leading-relaxed text-ink-muted max-w-[480px]">
              Connect your apps and zWork can act on your behalf — send emails,
              manage your calendar, update tasks, and more.
            </p>
          </div>
          <button
            onClick={() => void refreshComposio()}
            className="press mt-1 shrink-0 rounded-xl border border-line bg-paper-raised p-2.5 text-ink-muted hover:text-ink transition-colors"
            aria-label="Refresh connectors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {/* Status summary */}
        {connectedCount > 0 ? (
          <div className="mb-6 flex items-center gap-3 rounded-2xl border border-line bg-paper-raised px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10">
              <Plug className="h-4 w-4 text-emerald-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-ink">
                {connectedCount} app{connectedCount !== 1 ? "s" : ""} connected
                {toolCount > 0 && (
                  <span className="text-ink-muted font-normal">
                    {" "}&middot; {toolCount} action{toolCount !== 1 ? "s" : ""} available
                  </span>
                )}
              </p>
            </div>
          </div>
        ) : composioApps.length > 0 ? (
          <div className="mb-6 rounded-2xl border border-dashed border-line bg-paper-raised/50 px-5 py-4">
            <p className="text-[13px] text-ink-muted text-center">
              No apps connected yet. Connect an app below to let zWork use it for you.
            </p>
          </div>
        ) : null}

        {/* App grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {composioApps.map((app) => {
            const isConnected = connectedApps.has(app.id);
            const isConnecting = connecting === app.id;
            const desc = APP_DESCRIPTIONS[app.id] ?? `Use ${app.name} from zWork`;
            const hasLogo = hasBrandLogo(app.id);

            return (
              <div
                key={app.id}
                className="group flex items-center gap-4 rounded-2xl border border-line bg-paper-raised px-4 py-3.5 transition-colors hover:border-line-strong"
              >
                {/* Logo */}
                <div
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                  style={{
                    backgroundColor: hasLogo ? `${app.color}14` : "rgb(var(--paper-sunken))",
                    color: hasLogo ? app.color : "rgb(var(--ink-muted))",
                  }}
                >
                  {hasLogo ? (
                    <AppBrandLogo appId={app.id} size={22} />
                  ) : (
                    <Plug size={20} />
                  )}
                </div>

                {/* Info */}
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
                  <p className="text-[12.5px] leading-[18px] text-ink-muted truncate">
                    {desc}
                  </p>
                </div>

                {/* Action */}
                <div className="shrink-0">
                  {isConnecting ? (
                    <div className="flex h-8 w-8 items-center justify-center">
                      <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
                    </div>
                  ) : isConnected ? (
                    <button
                      onClick={() => disconnectComposioApp(app.id)}
                      className="press rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink-muted hover:text-red-500 hover:border-red-300 transition-colors"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => handleConnect(app.id)}
                      className="press inline-flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-paper hover:bg-ink/90 transition-colors"
                    >
                      Connect
                      <ExternalLink className="h-3 w-3 opacity-60" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
