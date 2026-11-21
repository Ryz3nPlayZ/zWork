import { useState, useEffect } from "react";
import { Check, ChevronLeft, ExternalLink, Loader2, Plug, Plus, RefreshCw } from "lucide-react";
import { useApp } from "../lib/store";
import type { ComposioApp } from "../lib/api";
import { AppBrandLogo, hasBrandLogo } from "./BrandLogos";
import { IconButton } from "./IconButton";
import { McpConnectors } from "./McpConnectors";
import { Button, PageShell, RowIconButton, SearchField, useConfirm } from "./page/Page";

interface CatalogEntry {
  maker: string;
  /** One line for the list. */
  short: string;
  long: string;
  /** Things to ask once it's connected; each opens a new chat with the request typed in. */
  prompts: string[];
  can: string[];
}

const CATALOG: Record<string, CatalogEntry> = {
  gmail: {
    maker: "Google",
    short: "Read, sort, draft and send your email",
    long: "Let zWork read your inbox, find the messages that matter, and draft or send replies in your voice.",
    prompts: ["Find every invoice email from last month and list the totals", "Draft polite replies to anything still unanswered from this week", "Summarise the newsletters I got today in five bullets"],
    can: ["Search and read your email and attachments", "Draft, reply to and send messages", "Label, archive and tidy threads"],
  },
  outlook: {
    maker: "Microsoft",
    short: "Read and send email, and manage your calendar",
    long: "Let zWork work through your Outlook inbox and calendar: answer email, find attachments and book time.",
    prompts: ["List the emails from my manager I haven't answered", "Find a free hour with Sam next week and send an invite", "Save every PDF attachment from this week to a folder"],
    can: ["Search, read and send email", "Read and create calendar events", "Find and save attachments"],
  },
  googlecalendar: {
    maker: "Google",
    short: "Check your schedule and book events",
    long: "Let zWork see when you're free, set up meetings and keep your week in order.",
    prompts: ["What does my week look like, and where are the gaps?", "Block two hours of focus time every morning next week", "Move tomorrow's 3pm to Thursday and let everyone know"],
    can: ["Read your calendars and free time", "Create, move and cancel events", "Invite people and set reminders"],
  },
  googledrive: {
    maker: "Google",
    short: "Find, read and share your files",
    long: "Let zWork search your Drive, read docs and sheets, and file new work where it belongs.",
    prompts: ["Find the latest version of our pricing sheet", "Put this month's receipts into one folder", "Summarise the three newest docs in my team folder"],
    can: ["Search and read files and folders", "Upload and organise files", "Share files with people you name"],
  },
  one_drive: {
    maker: "Microsoft",
    short: "Find, read and save your files",
    long: "Let zWork find and read files in your OneDrive and save what it makes for you.",
    prompts: ["Find the contract I edited last Tuesday", "Save this report to my Reports folder", "List the files I haven't opened in a year"],
    can: ["Search and read files", "Save and move files", "Organise folders"],
  },
  excel: {
    maker: "Microsoft",
    short: "Read and update workbooks stored online",
    long: "Let zWork read and update Excel workbooks in OneDrive or SharePoint, so totals and trackers stay current.",
    prompts: ["Add this week's sales to the tracker and update the totals", "Which clients are more than 30 days overdue?", "Make a summary sheet of spending by category"],
    can: ["Read sheets, tables and ranges", "Add and update rows", "Build summary sheets"],
  },
  slack: {
    maker: "Slack",
    short: "Read channels and send messages",
    long: "Let zWork catch you up on channels, find what was decided and post updates for you.",
    prompts: ["Catch me up on #general since Friday", "What did the team decide about the launch date?", "Post this week's report in #updates"],
    can: ["Read channels and threads", "Search messages", "Send messages and replies"],
  },
  microsoft_teams: {
    maker: "Microsoft",
    short: "Read and send messages in your teams",
    long: "Let zWork read your Teams chats and channels and send messages for you.",
    prompts: ["Summarise what I missed in the Finance channel", "Find the file Priya shared in chat yesterday", "Tell the team the report is ready"],
    can: ["Read chats and channels", "Search messages", "Send messages"],
  },
  notion: {
    maker: "Notion",
    short: "Create pages and search your workspace",
    long: "Let zWork search your Notion workspace, update databases and write new pages.",
    prompts: ["Turn these meeting notes into a page in Team Notes", "Which tasks in the Projects database are overdue?", "Write this week's update from the Roadmap page"],
    can: ["Search pages and databases", "Create and edit pages", "Add and update database rows"],
  },
  quickbooks: {
    maker: "Intuit",
    short: "Look up invoices, customers and reports",
    long: "Let zWork look up invoices, customers and reports in QuickBooks, so month-end takes minutes.",
    prompts: ["Which invoices are overdue, and by how much?", "How did this month's expenses compare with last month?", "List the customers who paid late twice this year"],
    can: ["Read invoices, bills and customers", "Run profit and loss and other reports", "Draft new invoices"],
  },
  xero: {
    maker: "Xero",
    short: "Look up invoices, contacts and bills",
    long: "Let zWork look up invoices, contacts and bills in Xero and keep your books up to date.",
    prompts: ["Which bills are due this week?", "Total what each client paid us this quarter", "Find invoices still in draft"],
    can: ["Read invoices, bills and contacts", "Run reports", "Draft invoices and bills"],
  },
};

const SECTIONS: { title: string; apps: string[] }[] = [
  { title: "Email and calendar", apps: ["gmail", "outlook", "googlecalendar"] },
  { title: "Files and spreadsheets", apps: ["googledrive", "one_drive", "excel"] },
  { title: "Team chat and notes", apps: ["slack", "microsoft_teams", "notion"] },
  { title: "Accounting", apps: ["quickbooks", "xero"] },
];
const ALLOWED_APPS = new Set(SECTIONS.flatMap((section) => section.apps));
const short = (app: ComposioApp) => CATALOG[app.id]?.short ?? `Use ${app.name} from zWork`;

/** Near-black brand marks (Notion, GitHub) are drawn in ink so they show in dark mode. */
const INK_LOGOS = new Set(["notion", "github"]);

/** Brand mark on a tinted tile. Near-black marks (Notion, GitHub) use ink so they show in dark mode. */
function AppLogoTile({ app, size = "md" }: { app: ComposioApp; size?: "md" | "xl" }) {
  const ink = INK_LOGOS.has(app.id);
  const hasLogo = hasBrandLogo(app.id);
  const color = ink ? "rgb(var(--ink))" : app.color;
  const box = size === "md" ? "h-10 w-10 rounded-xl" : "h-16 w-16 rounded-2xl";
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden ${box}`}
      style={{
        backgroundColor: ink ? "rgb(var(--ink) / 0.08)" : hasLogo ? `${color}14` : "rgb(var(--paper-sunken))",
        color: hasLogo ? color : "rgb(var(--ink-muted))",
      }}
    >
      {hasLogo ? (
        <AppBrandLogo appId={app.id} size={size === "md" ? 18 : 30} />
      ) : app.icon ? (
        <img src={app.icon} alt="" className={size === "md" ? "h-5 w-5 object-contain" : "h-8 w-8 object-contain"} />
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
  const openLanding = useApp((s) => s.openLanding);
  const [query, setQuery] = useState("");

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
      const message = e?.message || String(e);
      setConnectError(
        message.includes("composio_auth_config_not_found")
          ? "This app isn't ready to connect yet. Please try again later."
          : message,
      );
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

  const allowedComposioApps = composioApps.filter((app) => ALLOWED_APPS.has(app.id) || connectedApps.has(app.id));
  const connectedCount = allowedComposioApps.filter((a) => connectedApps.has(a.id)).length;
  const expandedAppData = allowedComposioApps.find((a) => a.id === expandedApp);
  const byId = new Map(allowedComposioApps.map((app) => [app.id, app]));
  const q = query.trim().toLowerCase();
  const sections = q
    ? [{ title: "Results", apps: allowedComposioApps.filter((app) => `${app.name} ${short(app)} ${CATALOG[app.id]?.maker ?? ""}`.toLowerCase().includes(q)) }]
    : [
        { title: "Connected", apps: allowedComposioApps.filter((app) => connectedApps.has(app.id)) },
        ...SECTIONS.map((section) => ({
          title: section.title,
          apps: section.apps.map((id) => byId.get(id)).filter((app): app is ComposioApp => !!app && !connectedApps.has(app.id)),
        })),
      ];

  const ask = (prompt: string) => {
    openLanding();
    useApp.setState({ draftInject: { chatId: "", text: prompt, nonce: Date.now() } });
  };

  if (expandedAppData) {
    return (
      <>
        <AppDetail
          app={expandedAppData}
          connected={connectedApps.has(expandedAppData.id)}
          connecting={connecting === expandedAppData.id}
          error={connectError}
          onBack={() => setExpandedApp(null)}
          onConnect={() => void handleConnect(expandedAppData.id)}
          onDisconnect={() => void handleDisconnect(expandedAppData)}
          onAsk={ask}
        />
        {confirmDialog}
      </>
    );
  }

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
      toolbar={<SearchField value={query} onChange={setQuery} placeholder="Search apps" />}
    >
      {connectError && (
        <p role="alert" className="mb-4 rounded-xl border border-error/20 bg-error/10 px-3.5 py-2.5 text-[12.5px] text-error">{connectError}</p>
      )}
      {allowedComposioApps.length === 0 ? (
        <div className="flex h-24 items-center justify-center text-ink-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        sections.map(
          (section) =>
            (section.apps.length > 0 || section.title === "Results") && (
              <section key={section.title} className="mb-7">
                <h2 className="mb-2 px-1 text-[14px] font-semibold text-ink">{section.title}</h2>
                {section.apps.length === 0 && <p className="px-1 text-[13px] text-ink-muted">No apps match “{query.trim()}”.</p>}
                <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                  {section.apps.map((app) => {
                    const isConnected = connectedApps.has(app.id);
                    return (
                      <div key={app.id} className="group relative flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-state-hover">
                        <button
                          type="button"
                          onClick={() => {
                            setConnectError(null);
                            setExpandedApp(app.id);
                          }}
                          className="ring-focus absolute inset-0 rounded-xl"
                          aria-label={`${app.name} details`}
                        />
                        <AppLogoTile app={app} />
                        <div className="pointer-events-none min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-medium text-ink">{app.name}</p>
                          <p className="truncate text-[12.5px] text-ink-muted">{short(app)}</p>
                        </div>
                        {isConnected ? (
                          <span className="pointer-events-none flex items-center gap-1 text-[12px] text-ink-muted">
                            <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                            Connected
                          </span>
                        ) : (
                          <RowIconButton
                            label={`Connect ${app.name}`}
                            onClick={() => void handleConnect(app.id)}
                            className="relative"
                          >
                            {connecting === app.id ? <Loader2 className="animate-spin" /> : <Plus />}
                          </RowIconButton>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ),
        )
      )}

      <McpConnectors confirm={confirm} />
      {confirmDialog}
    </PageShell>
  );
}

/** One app's page: what it is, what you can ask once it's connected, and what zWork can do in it. */
function AppDetail({
  app,
  connected,
  connecting,
  error,
  onBack,
  onConnect,
  onDisconnect,
  onAsk,
}: {
  app: ComposioApp;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onAsk: (prompt: string) => void;
}) {
  const entry = CATALOG[app.id];
  const tint = INK_LOGOS.has(app.id) ? "rgb(var(--ink))" : app.color;
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 pb-16 pt-6 animate-fade-in">
          <button
            type="button"
            onClick={onBack}
            className="press ring-focus -ml-2 flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] text-ink-muted hover:bg-state-hover hover:text-ink"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Connectors
          </button>

          <header className="mt-5 flex flex-wrap items-center gap-4">
            <AppLogoTile app={app} size="xl" />
            <div className="min-w-0 flex-1">
              <h1 className="text-[24px] font-semibold tracking-tight text-ink">{app.name}</h1>
              <p className="flex items-center gap-3 text-[13px] text-ink-muted">
                {entry ? `By ${entry.maker}` : "App"}
                {connected && (
                  <span className="flex items-center gap-1">
                    <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                    Connected
                  </span>
                )}
              </p>
            </div>
            {connected ? (
              <Button onClick={onDisconnect}>Disconnect</Button>
            ) : (
              <Button variant="primary" disabled={connecting} onClick={onConnect} icon={connecting ? <Loader2 className="animate-spin" /> : <ExternalLink />}>
                {connecting ? "Connecting" : `Connect ${app.name}`}
              </Button>
            )}
          </header>

          <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">{entry?.long ?? `Use ${app.name} from zWork.`}</p>
          {error && (
            <p role="alert" className="mt-4 rounded-xl border border-error/20 bg-error/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-error">{error}</p>
          )}

          {entry && (
            <>
              <section
                className="relative mt-7 overflow-hidden rounded-3xl p-5 sm:p-7"
                style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${tint} 30%, rgb(var(--paper))) 0%, color-mix(in srgb, ${tint} 8%, rgb(var(--paper))) 100%)` }}
              >
                <h2 className="text-[15px] font-semibold text-ink">{connected ? "Ask zWork" : `Once ${app.name} is connected, ask`}</h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {entry.prompts.map((prompt) => {
                    const card = "flex min-h-[112px] flex-col justify-between gap-3 rounded-2xl bg-paper/75 p-4 text-left text-[13px] leading-snug text-ink shadow-sm backdrop-blur";
                    return connected ? (
                      <button key={prompt} type="button" onClick={() => onAsk(prompt)} className={`press ring-focus transition-colors hover:bg-paper ${card}`}>
                        {prompt}
                        <span className="text-[12px] text-ink-muted">Start a chat</span>
                      </button>
                    ) : (
                      <div key={prompt} className={card}>
                        {prompt}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="mt-7">
                <h2 className="text-[15px] font-semibold text-ink">What zWork can do in {app.name}</h2>
                <ul className="mt-3 space-y-2">
                  {entry.can.map((line) => (
                    <li key={line} className="flex items-start gap-2.5 text-[13.5px] text-ink-soft">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
                      {line}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-[12.5px] leading-relaxed text-ink-muted">
                  With Ask before changes on, zWork checks with you before it sends, deletes or changes anything in {app.name}. You can disconnect any time.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
