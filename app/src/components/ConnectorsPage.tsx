import { useState, useEffect } from "react";
import {
  Loader2,
  RefreshCw,
  ExternalLink,
  Plug,
  Mail,
  Calendar,
  Hash,
  BookOpen,
  Folder,
  GitBranch,
  Layers,
  Zap,
  CheckSquare,
  LayoutGrid,
  Target,
  CircleDot,
} from "lucide-react";
import { useApp } from "../lib/store";

const APP_ICONS: Record<string, React.ReactNode> = {
  mail: <Mail className="h-6 w-6" />,
  calendar: <Calendar className="h-6 w-6" />,
  hash: <Hash className="h-6 w-6" />,
  "book-open": <BookOpen className="h-6 w-6" />,
  folder: <Folder className="h-6 w-6" />,
  "git-branch": <GitBranch className="h-6 w-6" />,
  layers: <Layers className="h-6 w-6" />,
  zap: <Zap className="h-6 w-6" />,
  "check-square": <CheckSquare className="h-6 w-6" />,
  "layout-grid": <LayoutGrid className="h-6 w-6" />,
  target: <Target className="h-6 w-6" />,
  "circle-dot": <CircleDot className="h-6 w-6" />,
};

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
      <div className="mx-auto w-full max-w-[820px] px-6 py-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-2">
          <div>
            <h1 className="text-[36px] font-light tracking-tight text-ink">
              Connectors
            </h1>
            <p className="mt-2 text-[14px] leading-6 text-ink-muted">
              Connect your apps and zWork can act on your behalf — send emails,
              manage your calendar, update tasks, and more.
            </p>
          </div>
          <button
            onClick={() => void refreshComposio()}
            className="press mt-2 shrink-0 rounded-lg border border-line p-2 text-ink-muted hover:text-ink transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {/* Status bar */}
        {connectedCount > 0 && (
          <div className="mt-4 mb-6 flex items-center gap-3 rounded-xl border border-line bg-paper-raised px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/10">
              <Plug className="h-4 w-4 text-emerald-600" />
            </div>
            <div className="flex-1">
              <span className="text-[13px] font-medium text-ink">
                {connectedCount} app{connectedCount !== 1 ? "s" : ""} connected
              </span>
              {toolCount > 0 && (
                <span className="text-[12px] text-ink-muted ml-2">
                  &middot; {toolCount} actions available
                </span>
              )}
            </div>
          </div>
        )}

        {connectedCount === 0 && composioApps.length > 0 && (
          <div className="mt-4 mb-6 rounded-xl border border-dashed border-line bg-paper-raised/50 px-4 py-4">
            <p className="text-[13px] text-ink-muted text-center">
              No apps connected yet. Connect an app below to let zWork use it for you.
            </p>
          </div>
        )}

        {/* App grid */}
        <div className="mt-4 grid grid-cols-2 gap-4">
          {composioApps.map((app) => {
            const isConnected = connectedApps.has(app.id);
            const isConnecting = connecting === app.id;
            const icon = APP_ICONS[app.icon] ?? <Plug className="h-6 w-6" />;
            const desc = APP_DESCRIPTIONS[app.id] ?? `Use ${app.name} from zWork`;

            return (
              <div
                key={app.id}
                className="group relative flex flex-col gap-3 rounded-2xl border border-line bg-paper-raised p-5 transition-colors hover:border-ink/20"
              >
                <div className="flex items-start justify-between">
                  <div
                    className="flex h-11 w-11 items-center justify-center rounded-xl"
                    style={{ backgroundColor: `${app.color}12` }}
                  >
                    <span style={{ color: app.color }}>{icon}</span>
                  </div>
                  {isConnected && (
                    <span className="shrink-0 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-600">
                      Connected
                    </span>
                  )}
                </div>

                <div>
                  <h3 className="text-[15px] font-semibold text-ink">
                    {app.name}
                  </h3>
                  <p className="mt-1 text-[12.5px] leading-[18px] text-ink-muted">
                    {desc}
                  </p>
                </div>

                <div className="mt-auto pt-1">
                  {isConnecting ? (
                    <div className="flex items-center gap-2 text-[13px] text-ink-muted">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Connecting...</span>
                    </div>
                  ) : isConnected ? (
                    <button
                      onClick={() => disconnectComposioApp(app.id)}
                      className="press rounded-lg border border-line px-3.5 py-1.5 text-[12.5px] font-medium text-ink-muted hover:text-red-500 hover:border-red-300 transition-colors"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => handleConnect(app.id)}
                      className="press rounded-lg bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:bg-ink/90 transition-colors"
                    >
                      <span className="flex items-center gap-1.5">
                        Connect
                        <ExternalLink className="h-3 w-3 opacity-60" />
                      </span>
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
