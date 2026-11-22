import { useState, useEffect, useMemo, useRef } from "react";
import { Check, ChevronLeft, ExternalLink, Loader2, Plug, RefreshCw, Search } from "lucide-react";
import { useApp } from "../lib/store";
import { api, type ComposioAccount, type ComposioToolkit } from "../lib/api";
import { AppBrandLogo, hasBrandLogo } from "./BrandLogos";
import { IconButton } from "./IconButton";
import { McpConnectors } from "./McpConnectors";
import {
  Badge,
  Button,
  Card,
  CardGrid,
  EmptyState,
  ListGroup,
  ListRow,
  PageShell,
  SearchField,
  SectionHeading,
  useConfirm,
} from "./page/Page";

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

/** The apps most people doing office work reach for first, in this order. */
const POPULAR = ["gmail", "outlook", "googlecalendar", "googledrive", "one_drive", "excel", "slack", "microsoft_teams", "notion", "quickbooks", "xero"];

/**
 * Shelves on the storefront, in plain words. Composio's own categories map
 * onto them; an app sits on the shelf of its first category that has one.
 */
const SHELVES: { id: string; title: string; categories: string[] }[] = [
  { id: "email", title: "Email and calendar", categories: ["email", "calendar", "scheduling & booking", "email newsletters", "event management"] },
  { id: "files", title: "Files and documents", categories: ["documents", "file management & storage", "spreadsheets", "notes", "signatures", "forms & surveys", "images & design"] },
  { id: "chat", title: "Chat and meetings", categories: ["team chat", "video conferencing", "communication", "phone & sms", "ai meeting assistants", "transcription", "notifications"] },
  { id: "tasks", title: "Tasks and projects", categories: ["project management", "task management", "team collaboration", "productivity", "time tracking software", "product management"] },
  { id: "money", title: "Money and accounting", categories: ["accounting", "proposal & invoice management", "payment processing", "fundraising"] },
  { id: "customers", title: "Customers and sales", categories: ["crm", "contact management", "customer support", "ecommerce", "ai sales tools", "call tracking"] },
  { id: "marketing", title: "Marketing and social", categories: ["marketing automation", "marketing", "social media accounts", "social media marketing", "ads & conversion", "website builders"] },
];
const MORE = { id: "more", title: "More apps" };

/** Apps built for software teams. They stay findable by search but aren't shelved. */
const BUILDER_CATEGORIES = new Set(["developer tools", "databases", "server monitoring", "ai models", "artificial intelligence", "model context protocol"]);

/** Where curated apps belong regardless of how Composio files them. */
const SHELF_OVERRIDES: Record<string, string> = {
  gmail: "email", outlook: "email", googlecalendar: "email",
  googledrive: "files", one_drive: "files", excel: "files", notion: "files",
  slack: "chat", microsoft_teams: "chat",
  quickbooks: "money", xero: "money",
};

function shelfOf(app: ComposioToolkit): string | null {
  if (SHELF_OVERRIDES[app.slug]) return SHELF_OVERRIDES[app.slug];
  for (const c of app.categories) {
    const shelf = SHELVES.find((s) => s.categories.includes(c.toLowerCase()));
    if (shelf) return shelf.id;
  }
  if (app.categories.some((c) => BUILDER_CATEGORIES.has(c.toLowerCase()))) return null;
  return MORE.id;
}

const shelfTitle = (id: string) => SHELVES.find((s) => s.id === id)?.title ?? MORE.title;

/** First sentence of Composio's description, so a card reads as one line of plain text. */
function blurb(app: ComposioToolkit): string {
  if (CATALOG[app.slug]) return CATALOG[app.slug].short;
  const first = app.description.split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
  return first || `Use ${app.name} from zWork`;
}

/** How connecting works, in words a person who's never heard of OAuth can follow. */
function howItConnects(app: ComposioToolkit): string {
  const oauth = app.auth.some((a) => a.includes("OAUTH"));
  return oauth
    ? `You sign in to ${app.name} in your browser and choose what to allow. zWork never sees your password.`
    : `Your browser opens a page where you paste a key from your ${app.name} account. zWork never sees your password.`;
}

/** Near-black brand marks (Notion, GitHub) are drawn in ink so they show in dark mode. */
const INK_LOGOS = new Set(["notion", "github"]);
/** Brand colours for the marks drawn in-app, keyed by app. */
const BRAND_COLORS: Record<string, string> = {
  gmail: "#EA4335", googlecalendar: "#4285F4", outlook: "#0078D4", googledrive: "#34A853", one_drive: "#0078D4",
  excel: "#217346", slack: "#4A154B", microsoft_teams: "#6264A7", quickbooks: "#2CA01C", xero: "#13B5EA", linear: "#5E6AD2",
};

/**
 * An app's logo on a light tile. Apps with a mark drawn in-app use it (no
 * network); the rest load Composio's logo, and fall back to the app's initial.
 */
function AppLogoTile({ app, size = "md" }: { app: Pick<ComposioToolkit, "slug" | "name" | "logo">; size?: "sm" | "md" | "xl" }) {
  const [broken, setBroken] = useState(false);
  const box = { sm: "h-8 w-8 rounded-lg", md: "h-10 w-10 rounded-xl", xl: "h-16 w-16 rounded-2xl" }[size];
  const px = { sm: 16, md: 20, xl: 32 }[size];
  const ink = INK_LOGOS.has(app.slug);
  return (
    <div className={`flex shrink-0 items-center justify-center overflow-hidden border border-line bg-white ${box}`}>
      {hasBrandLogo(app.slug) ? (
        <span style={{ color: ink ? "#111" : BRAND_COLORS[app.slug] ?? "#111" }}>
          <AppBrandLogo appId={app.slug} size={px} />
        </span>
      ) : app.logo && !broken ? (
        <img src={app.logo} alt="" width={px} height={px} loading="lazy" onError={() => setBroken(true)} className="object-contain" style={{ width: px, height: px }} />
      ) : (
        <span className="text-[13px] font-semibold text-neutral-600">{app.name.slice(0, 1).toUpperCase() || <Plug size={14} />}</span>
      )}
    </div>
  );
}

/** A connect failure in words a person can act on, not a status line and JSON. */
function friendlyConnectError(raw: string): string {
  if (raw.includes("composio_auth_config_not_found")) return "This app isn't ready to connect yet. Please try again later.";
  if (/sign in|401|access_denied/i.test(raw)) return "Sign in to zWork first, then connect your apps.";
  if (/composio_unreachable|Failed to fetch|NetworkError/i.test(raw)) return "Couldn't reach zWork. Check your internet connection and try again.";
  const inner = raw.match(/"error"\s*:\s*"([^"]+)"/)?.[1];
  return inner && !inner.includes("_") ? inner : "Something went wrong connecting this app. Please try again.";
}

/** One fetch per app session; the page reopens instantly after the first. */
let catalogCache: ComposioToolkit[] | null = null;

export function ConnectorsPage() {
  const composioAccounts = useApp((s) => s.composioAccounts);
  const refreshComposio = useApp((s) => s.refreshComposio);
  const connectComposioApp = useApp((s) => s.connectComposioApp);
  const disconnectComposioApp = useApp((s) => s.disconnectComposioApp);
  const openLanding = useApp((s) => s.openLanding);
  const [catalog, setCatalog] = useState<ComposioToolkit[] | null>(catalogCache);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [shelf, setShelf] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDialog, confirm] = useConfirm();
  const topRef = useRef<HTMLDivElement>(null);

  // Opening a shelf or going back starts at the top, not where the last view was scrolled.
  useEffect(() => {
    topRef.current?.closest(".overflow-y-auto")?.scrollTo({ top: 0 });
  }, [shelf]);

  async function loadCatalog() {
    try {
      const { toolkits } = await api.composioCatalog();
      catalogCache = toolkits;
      setCatalog(toolkits);
      setCatalogFailed(false);
    } catch {
      setCatalogFailed(true);
    }
  }

  useEffect(() => {
    void refreshComposio();
    if (!catalogCache) void loadCatalog();
  }, [refreshComposio]);

  const bySlug = useMemo(() => new Map((catalog ?? []).map((a) => [a.slug, a])), [catalog]);

  /** A connected account as an app, even when the catalogue doesn't list it. */
  const appFor = (account: ComposioAccount): ComposioToolkit =>
    bySlug.get(account.app) ?? {
      slug: account.app,
      name: account.app_name || account.app,
      description: "",
      logo: account.icon || `https://logos.composio.dev/api/${account.app}`,
      categories: [],
      auth: ["OAUTH2"],
      tools: 0,
    };

  const activeApps = new Set(composioAccounts.filter((a) => a.status === "ACTIVE").map((a) => a.app));
  // One row per app: an active account wins over a stale one.
  const accounts = [...new Map(
    // A sign-in that was started but never finished isn't a connection.
    composioAccounts.filter((a) => !["INITIATED", "INITIALIZING"].includes(a.status)).sort((a, b) => Number(a.status === "ACTIVE") - Number(b.status === "ACTIVE")).map((a) => [a.app, a]),
  ).values()].sort((a, b) => appFor(a).name.localeCompare(appFor(b).name));

  async function handleConnect(slug: string) {
    setConnecting(slug);
    setConnectError(null);
    try {
      await connectComposioApp(slug);
    } catch (e: any) {
      setConnectError(friendlyConnectError(e?.message || String(e)));
    } finally {
      setConnecting(null);
    }
  }

  async function handleDisconnect(app: ComposioToolkit) {
    const ok = await confirm({
      title: `Disconnect ${app.name}?`,
      body: `zWork will stop using ${app.name}. You can connect it again any time.`,
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    void disconnectComposioApp(app.slug);
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([refreshComposio(), loadCatalog()]);
    } finally {
      setRefreshing(false);
    }
  }

  const ask = (prompt: string) => {
    openLanding();
    useApp.setState({ draftInject: { chatId: "", text: prompt, nonce: Date.now() } });
  };

  const opened = openApp ? bySlug.get(openApp) ?? (() => {
    const account = composioAccounts.find((a) => a.app === openApp);
    return account ? appFor(account) : undefined;
  })() : undefined;

  if (opened) {
    const account = accounts.find((a) => a.app === opened.slug);
    return (
      <>
        <AppDetail
          app={opened}
          connected={activeApps.has(opened.slug)}
          needsReconnect={!!account && !activeApps.has(opened.slug)}
          connecting={connecting === opened.slug}
          error={connectError}
          backLabel={shelf ? shelfTitle(shelf) : "Connectors"}
          onBack={() => {
            setOpenApp(null);
            setConnectError(null);
          }}
          onConnect={() => void handleConnect(opened.slug)}
          onDisconnect={() => void handleDisconnect(opened)}
          onAsk={ask}
        />
        {confirmDialog}
      </>
    );
  }

  const open = (slug: string) => {
    setConnectError(null);
    setOpenApp(slug);
  };

  const card = (app: ComposioToolkit) => (
    <Card
      key={app.slug}
      icon={<AppLogoTile app={app} />}
      title={app.name}
      description={blurb(app)}
      corner={activeApps.has(app.slug) ? <Badge tone="success">Connected</Badge> : undefined}
      onClick={() => open(app.slug)}
    />
  );

  const q = query.trim().toLowerCase();
  const apps = catalog ?? [];
  const shelved = new Map<string, ComposioToolkit[]>();
  for (const app of apps) {
    const id = shelfOf(app);
    if (id) shelved.set(id, [...(shelved.get(id) ?? []), app]);
  }
  const popular = POPULAR.map((slug) => bySlug.get(slug)).filter((a): a is ComposioToolkit => !!a);
  const results = q
    ? apps.filter((a) => `${a.name} ${a.slug} ${blurb(a)} ${a.categories.join(" ")} ${CATALOG[a.slug]?.maker ?? ""}`.toLowerCase().includes(q))
    : [];

  let body: React.ReactNode;
  if (!catalog) {
    body = catalogFailed ? (
      <EmptyState
        icon={<Plug />}
        title="Couldn't load apps"
        body="Check your internet connection and try again."
        action={<Button onClick={() => void loadCatalog()}>Try again</Button>}
      />
    ) : (
      <div className="flex h-24 items-center justify-center text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  } else if (q) {
    body = results.length ? (
      <section className="mb-8">
        <SectionHeading title="Results" count={results.length} />
        <CardGrid>{results.map(card)}</CardGrid>
      </section>
    ) : (
      <EmptyState compact icon={<Search />} title={`No apps match “${query.trim()}”`} body="Try the app's name, or a word for what it does, like invoices or calendar." />
    );
  } else if (shelf) {
    const list = shelved.get(shelf) ?? [];
    body = (
      <section className="mb-8">
        <button
          type="button"
          onClick={() => setShelf(null)}
          className="press ring-focus -ml-2 mb-3 flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] text-ink-muted hover:bg-state-hover hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          All apps
        </button>
        <SectionHeading title={shelfTitle(shelf)} count={list.length} />
        <CardGrid>{list.map(card)}</CardGrid>
      </section>
    );
  } else {
    body = (
      <>
        <section className="mb-8">
          <SectionHeading title="Popular for office work" />
          <CardGrid>{popular.map(card)}</CardGrid>
        </section>
        {[...SHELVES, MORE].map(({ id, title }) => {
          const list = (shelved.get(id) ?? []).filter((a) => !POPULAR.includes(a.slug));
          if (!list.length) return null;
          return (
            <section key={id} className="mb-8">
              <SectionHeading
                title={title}
                count={list.length}
                action={list.length > 6 ? <Button onClick={() => setShelf(id)}>See all</Button> : undefined}
              />
              <CardGrid>{list.slice(0, 6).map(card)}</CardGrid>
            </section>
          );
        })}
      </>
    );
  }

  return (
    <PageShell
      title="Connectors"
      subtitle="Connect the apps you use and zWork can work in them for you."
      actions={
        <IconButton
          icon={refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          label="Refresh"
          variant="outline"
          onClick={() => void refresh()}
        />
      }
      toolbar={<SearchField value={query} onChange={setQuery} placeholder={catalog ? `Search ${catalog.length} apps` : "Search apps"} />}
    >
      <div ref={topRef} />
      {connectError && (
        <p role="alert" className="mb-4 rounded-xl border border-error/20 bg-error/10 px-3.5 py-2.5 text-[12.5px] text-error">{connectError}</p>
      )}

      {accounts.length > 0 && !q && !shelf && (
        <section className="mb-8">
          <SectionHeading title="What zWork can use" count={accounts.length} description="zWork can read and act in these apps for you. Disconnect one and it stops straight away." />
          <ListGroup>
            {accounts.map((account) => {
              const app = appFor(account);
              const active = account.status === "ACTIVE";
              return (
                <ListRow
                  key={account.app}
                  icon={<AppLogoTile app={app} size="sm" />}
                  title={app.name}
                  meta={blurb(app)}
                  onClick={() => open(app.slug)}
                  trailing={
                    <>
                      {active ? <Badge tone="success">Connected</Badge> : <Badge tone="warning">Needs reconnecting</Badge>}
                      {active ? (
                        <Button onClick={() => void handleDisconnect(app)}>Disconnect</Button>
                      ) : (
                        <Button
                          disabled={connecting === app.slug}
                          icon={connecting === app.slug ? <Loader2 className="animate-spin" /> : undefined}
                          onClick={() => void handleConnect(app.slug)}
                        >
                          Reconnect
                        </Button>
                      )}
                    </>
                  }
                />
              );
            })}
          </ListGroup>
        </section>
      )}

      {body}

      {!q && !shelf && <McpConnectors confirm={confirm} />}
      {confirmDialog}
    </PageShell>
  );
}

/** One app's page: what it is, what you can ask once it's connected, and what zWork can do in it. */
function AppDetail({
  app,
  connected,
  needsReconnect,
  connecting,
  error,
  backLabel,
  onBack,
  onConnect,
  onDisconnect,
  onAsk,
}: {
  app: ComposioToolkit;
  connected: boolean;
  needsReconnect: boolean;
  connecting: boolean;
  error: string | null;
  backLabel: string;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onAsk: (prompt: string) => void;
}) {
  const entry = CATALOG[app.slug];
  const tint = INK_LOGOS.has(app.slug) ? "rgb(var(--ink))" : BRAND_COLORS[app.slug] ?? "rgb(var(--ink-muted))";
  const shelfId = shelfOf(app);
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
            {backLabel}
          </button>

          <header className="mt-5 flex flex-wrap items-center gap-4">
            <AppLogoTile app={app} size="xl" />
            <div className="min-w-0 flex-1">
              <h1 className="text-[24px] font-semibold tracking-tight text-ink">{app.name}</h1>
              <p className="flex items-center gap-3 text-[13px] text-ink-muted">
                {entry ? `By ${entry.maker}` : shelfId ? shelfTitle(shelfId) : "App"}
                {connected && <Badge tone="success">Connected</Badge>}
                {needsReconnect && <Badge tone="warning">Needs reconnecting</Badge>}
              </p>
            </div>
            {connected ? (
              <Button onClick={onDisconnect}>Disconnect</Button>
            ) : (
              <Button variant="primary" disabled={connecting} onClick={onConnect} icon={connecting ? <Loader2 className="animate-spin" /> : <ExternalLink />}>
                {connecting ? "Connecting" : needsReconnect ? "Reconnect" : `Connect ${app.name}`}
              </Button>
            )}
          </header>

          <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">{entry?.long ?? (app.description || `Use ${app.name} from zWork.`)}</p>
          {!connected && <p className="mt-2 max-w-[60ch] text-[12.5px] leading-relaxed text-ink-muted">{howItConnects(app)}</p>}
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

          {!entry && (
            <section className="mt-7">
              <h2 className="text-[15px] font-semibold text-ink">What zWork can do in {app.name}</h2>
              <p className="mt-2 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-soft">
                Once it's connected, zWork can look things up and make the changes you ask for in {app.name}.
              </p>
              <p className="mt-4 text-[12.5px] leading-relaxed text-ink-muted">
                With Ask before changes on, zWork checks with you before it sends, deletes or changes anything in {app.name}. You can disconnect any time.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
