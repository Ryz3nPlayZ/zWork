import { useState, useEffect } from "react";
import { Loader2, RefreshCw, ExternalLink, Plug, X } from "lucide-react";
import { useApp } from "../lib/store";
import type { ComposioApp } from "../lib/api";
import { AppBrandLogo, hasBrandLogo } from "./BrandLogos";
import { IconButton } from "./IconButton";
import { McpConnectors } from "./McpConnectors";
import { Badge, Button, Card, CardGrid, PageShell, SectionHeading, useConfirm } from "./page/Page";

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
  "googledrive",
  "notion",
  "github",
  "linear"
]);

/** Near-black brand marks (Notion, GitHub) are drawn in ink so they show in dark mode. */
const INK_LOGOS = new Set(["notion", "github"]);

/** Brand mark on a tinted tile. Near-black marks (Notion, GitHub) use ink so they show in dark mode. */
function AppLogoTile({ app, size = "md" }: { app: ComposioApp; size?: "md" | "lg" }) {
  const ink = INK_LOGOS.has(app.id);
  const hasLogo = hasBrandLogo(app.id);
  const color = ink ? "rgb(var(--ink))" : app.color;
  const box = size === "md" ? "h-9 w-9 rounded-[10px]" : "h-11 w-11 rounded-xl";
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden ${box}`}
      style={{
        backgroundColor: ink ? "rgb(var(--ink) / 0.08)" : hasLogo ? `${color}14` : "rgb(var(--paper-sunken))",
        color: hasLogo ? color : "rgb(var(--ink-muted))",
      }}
    >
      {hasLogo ? (
        <AppBrandLogo appId={app.id} size={size === "md" ? 18 : 22} />
      ) : app.icon ? (
        <img src={app.icon} alt="" className="h-5 w-5 object-contain" />
      ) : (
        <Plug size={16} />
      )}
    </div>
  );
}

export function ConnectorsPage() {
  const composioAccounts = useApp((s) => s.composioAccounts);
  const composioApps = useApp((s) => s.composioApps);
  const refreshComposio = useApp((s) => s.refreshComposio);
  const connectComposioApp = useApp((s) => s.connectComposioApp);
  const disconnectComposioApp = useApp((s) => s.disconnectComposioApp);

  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [expandedApp, setExpandedApp] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDialog, confirm] = useConfirm();

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
      setExpandedApp(null);
    } catch (e: any) {
      setConnectError(e?.message || String(e));
    } finally {
      setConnecting(null);
    }
  }

  async function handleDisconnect(app: ComposioApp) {
    const ok = await confirm({
      title: `Disconnect ${app.name}?`,
      body: `zWork will stop using ${app.name}. You can connect it again any time.`,
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    setExpandedApp(null);
    void disconnectComposioApp(app.id);
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshComposio();
    } finally {
      setRefreshing(false);
    }
  }

  const allowedComposioApps = composioApps.filter((app) => ALLOWED_APPS.has(app.id));
  const connectedCount = allowedComposioApps.filter((a) => connectedApps.has(a.id)).length;
  const expandedAppData = allowedComposioApps.find((a) => a.id === expandedApp);
  const isExpandedConnected = expandedApp ? connectedApps.has(expandedApp) : false;

  return (
    <PageShell
      title="Connectors"
      subtitle={
        allowedComposioApps.length > 0
          ? `${connectedCount} of ${allowedComposioApps.length} apps connected. zWork can act in the apps you connect.`
          : "Connect your apps and zWork can act in them for you."
      }
      actions={
        <IconButton
          icon={refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          label="Refresh"
          variant="outline"
          onClick={() => void refresh()}
        />
      }
    >
      <SectionHeading title="Apps" className="mt-0" />
      {allowedComposioApps.length === 0 ? (
        <div className="flex h-24 items-center justify-center text-ink-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        <CardGrid>
          {allowedComposioApps.map((app) => {
            const isConnected = connectedApps.has(app.id);
            const isConnecting = connecting === app.id;
            return (
              <Card
                key={app.id}
                icon={<AppLogoTile app={app} />}
                title={app.name}
                description={APP_DESCRIPTIONS[app.id] ?? `Use ${app.name} from zWork`}
                corner={isConnected ? <Badge tone="success">Connected</Badge> : undefined}
                onClick={() => {
                  setConnectError(null);
                  setExpandedApp(app.id);
                }}
                footer={
                  isConnecting ? (
                    <span className="inline-flex items-center gap-1.5 text-ink-muted">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Connecting
                    </span>
                  ) : (
                    <span className="font-medium text-ink-muted transition-colors group-hover:text-ink">
                      {isConnected ? "Manage" : "Connect"}
                    </span>
                  )
                }
              />
            );
          })}
        </CardGrid>
      )}

      <McpConnectors confirm={confirm} />

      {expandedAppData && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm animate-fade-in"
          onClick={() => setExpandedApp(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={expandedAppData.name}
            className="w-full max-w-[400px] rounded-2xl border border-line bg-paper-raised p-5 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <AppLogoTile app={expandedAppData} size="lg" />
                <div>
                  <h2 className="text-[15px] font-semibold text-ink">{expandedAppData.name}</h2>
                  <div className="mt-0.5">
                    {isExpandedConnected ? (
                      <Badge tone="success">Connected</Badge>
                    ) : (
                      <span className="text-[12px] text-ink-muted">Not connected</span>
                    )}
                  </div>
                </div>
              </div>
              <IconButton icon={<X />} label="Close" size="sm" showTooltip={false} onClick={() => setExpandedApp(null)} />
            </div>

            <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
              {APP_DETAILED_DESCRIPTIONS[expandedAppData.id] ?? APP_DESCRIPTIONS[expandedAppData.id] ?? `Use ${expandedAppData.name} from zWork`}
            </p>

            {connectError && (
              <div className="mt-4 rounded-xl border border-error/20 bg-error/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-error">
                {connectError}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setExpandedApp(null)}>Close</Button>
              {isExpandedConnected ? (
                <Button variant="danger" onClick={() => void handleDisconnect(expandedAppData)}>
                  Disconnect
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={connecting === expandedAppData.id}
                  onClick={() => void handleConnect(expandedAppData.id)}
                  icon={connecting === expandedAppData.id ? <Loader2 className="animate-spin" /> : <ExternalLink />}
                >
                  {connecting === expandedAppData.id ? "Connecting" : `Connect ${expandedAppData.name}`}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </PageShell>
  );
}
