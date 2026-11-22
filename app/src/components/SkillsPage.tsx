import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Calculator,
  ChevronLeft,
  ExternalLink,
  FileText,
  GraduationCap,
  Languages,
  Loader2,
  Mail,
  MonitorSmartphone,
  Palette,
  Plus,
  Presentation,
  Receipt,
  RefreshCw,
  Search,
  Sheet,
  Users,
} from "lucide-react";
import { useApp } from "../lib/store";
import { api, type SkillMeta, type StoreSkill, type StoreSkillDetail } from "../lib/api";
import { IconButton } from "./IconButton";
import {
  Badge,
  Button,
  Card,
  CardGrid,
  EmptyState,
  IconTile,
  ListGroup,
  ListRow,
  PageShell,
  SearchField,
  SectionHeading,
  useConfirm,
} from "./page/Page";

/**
 * Skills that come with zWork and matter for everyday paperwork, in plain
 * words. The rest of the bundled skills (building software, brand kits,
 * testing tools) are counted, not listed.
 */
const INCLUDED: Record<string, { title: string; blurb: string }> = {
  pdf: { title: "PDF files", blurb: "Read, fill in, merge and split PDFs." },
  docx: { title: "Word documents", blurb: "Write and edit Word documents, tracked changes included." },
  xlsx: { title: "Spreadsheets", blurb: "Build and fix Excel sheets with formulas and charts." },
  pptx: { title: "Slide decks", blurb: "Make and edit PowerPoint presentations." },
  "doc-coauthoring": { title: "Writing documents together", blurb: "Plan and draft longer documents with you, section by section." },
  "internal-comms": { title: "Team updates", blurb: "Status reports, newsletters and announcements for your team." },
  "academic-research": { title: "Academic research", blurb: "Find papers and help with literature reviews and citations." },
  "theme-factory": { title: "Document themes", blurb: "Give slides, documents and reports one consistent look." },
  "canvas-design": { title: "Posters and visuals", blurb: "Design posters and simple visuals as images or PDFs." },
  "computer-use": { title: "Apps on your Mac", blurb: "Work in apps like Notes, Mail and Finder for you." },
  "zbctl-browser": { title: "Your web browser", blurb: "Work in your own Chrome, on sites you're signed in to." },
};

const OTHER_APPS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  agents: "other AI apps",
  pi: "Pi",
  opencode: "OpenCode",
};

/** "meeting-notes" → "Meeting notes". */
function humanize(name: string): string {
  const words = name.replace(/^[a-z0-9]+:/, "").split(/[-_]+/).filter(Boolean);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function iconFor(name: string) {
  const n = name.toLowerCase();
  if (/invoice|receipt|expense|budget|tax/.test(n)) return <Receipt />;
  if (/meeting|minutes|interview|team/.test(n)) return <Users />;
  if (/excel|xlsx|sheet|spreadsheet/.test(n)) return <Sheet />;
  if (/pptx|slide|deck|presentation/.test(n)) return <Presentation />;
  if (/letter|email|mail|comms|outreach/.test(n)) return <Mail />;
  if (/lesson|teach|research|grant|academic|study|paper/.test(n)) return <GraduationCap />;
  if (/translat|language/.test(n)) return <Languages />;
  if (/account|finance|payroll|calcul/.test(n)) return <Calculator />;
  if (/design|theme|poster|canvas|brand/.test(n)) return <Palette />;
  if (/computer|browser/.test(n)) return <MonitorSmartphone />;
  if (/pdf|docx|doc|resume|cv|proposal|report|notes|writ/.test(n)) return <FileText />;
  return <BookOpen />;
}

function SkillTile({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  return <IconTile size={size}>{iconFor(name)}</IconTile>;
}

function friendlyStoreError(raw: string, name?: string): string {
  const code = raw.match(/"error":"([a-z_0-9]+)"/)?.[1] ?? "";
  if (code === "skill_name_taken") return `You already have a skill called ${name ?? "this"}, so this one wasn't added.`;
  if (code === "skills_unreachable" || /Failed to fetch|NetworkError/i.test(raw)) return "Couldn't reach skills.sh. Check your internet connection and try again.";
  if (code === "skill_not_found") return "This skill isn't on skills.sh any more.";
  if (code === "skill_too_large") return "This skill is too big to add.";
  if (code.startsWith("skill_md") || code === "skill_files_invalid" || code === "skill_name_invalid") return "This skill isn't set up in a way zWork can use.";
  if (code === "skill_write_failed") return "Couldn't save the skill on this computer. Try again.";
  if (code === "skill_not_removable") return "zWork didn't add this skill, so it can't remove it.";
  return "Something went wrong. Try again.";
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

let shelfCache: StoreSkill[] | null = null;

/** An added skill as the store knows it, so its page can open. */
function storeSkillOf(s: SkillMeta): StoreSkill {
  const id = s.store_id ?? "";
  return shelfCache?.find((x) => x.id === id) ?? { id, name: s.name, source: id.split("/").slice(0, 2).join("/") };
}

export function SkillsPage() {
  const openLanding = useApp((s) => s.openLanding);
  const [installed, setInstalled] = useState<SkillMeta[] | null>(null);
  const [shelf, setShelf] = useState<StoreSkill[] | null>(shelfCache);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StoreSkill[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<StoreSkill | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirm();
  const topRef = useRef<HTMLDivElement>(null);

  async function loadInstalled() {
    try {
      setInstalled((await api.skills()).skills);
    } catch {
      setInstalled([]);
    }
  }

  async function loadShelf() {
    try {
      const { skills } = await api.skillStoreShelf();
      shelfCache = skills;
      setShelf(skills);
    } catch {
      setShelf([]);
    }
  }

  useEffect(() => {
    void loadInstalled();
    if (!shelfCache) void loadShelf();
  }, []);

  // Search skills.sh as you type, after a short pause.
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) {
      setResults(null);
      setSearchError(null);
      return;
    }
    let live = true;
    setSearching(true);
    const t = window.setTimeout(() => {
      api
        .skillStoreSearch(q)
        .then(({ skills }) => {
          if (!live) return;
          setResults(skills);
          setSearchError(null);
        })
        .catch((e) => live && setSearchError(friendlyStoreError(String(e?.message ?? e))))
        .finally(() => live && setSearching(false));
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    topRef.current?.closest(".overflow-y-auto")?.scrollTo({ top: 0 });
  }, [openId]);

  const byName = useMemo(() => new Map((installed ?? []).map((s) => [s.name, s])), [installed]);
  const added = (installed ?? []).filter((s) => s.source === "user");
  const includedOrder = Object.keys(INCLUDED);
  const included = (installed ?? [])
    .filter((s) => s.source === "bundled" && INCLUDED[s.name])
    .sort((a, b) => includedOrder.indexOf(a.name) - includedOrder.indexOf(b.name));
  const behindTheScenes = (installed ?? []).filter((s) => s.source === "bundled" && !INCLUDED[s.name]).length;
  const fromOthers = (installed ?? []).filter((s) => s.source !== "user" && s.source !== "bundled");

  async function remove(skill: SkillMeta) {
    const ok = await confirm({
      title: `Remove ${humanize(skill.name)}?`,
      body: "zWork will stop using this skill. You can add it again from the store any time.",
      confirmLabel: "Remove",
    });
    if (!ok) return false;
    try {
      await api.skillStoreRemove(skill.name);
      await loadInstalled();
      return true;
    } catch (e: any) {
      setError(friendlyStoreError(String(e?.message ?? e)));
      return false;
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([loadInstalled(), loadShelf()]);
    } finally {
      setRefreshing(false);
    }
  }

  const ask = (prompt: string) => {
    openLanding();
    useApp.setState({ draftInject: { chatId: "", text: prompt, nonce: Date.now() } });
  };

  if (openId) {
    return (
      <>
        <SkillDetail
          skill={openId}
          backLabel={q.length >= 2 ? "Search results" : "Skills"}
          onBack={() => setOpenId(null)}
          onChanged={loadInstalled}
          onRemove={async (name) => {
            const s = byName.get(name);
            return s ? remove(s) : false;
          }}
          onAsk={ask}
        />
        {confirmDialog}
      </>
    );
  }

  const storeCard = (s: StoreSkill) => {
    const have = byName.get(s.name);
    return (
      <Card
        key={s.id}
        icon={<SkillTile name={s.name} />}
        title={s.title ?? humanize(s.name)}
        description={s.description ?? `From ${s.source}`}
        footer={s.installs ? <span>{plural(s.installs, "install")}</span> : undefined}
        corner={have ? <Badge tone="success">{have.source === "user" ? "Added" : "Already here"}</Badge> : undefined}
        onClick={() => setOpenId(s)}
      />
    );
  };

  // The sidecar already keeps the results named for what you typed.
  const shown = results ?? [];

  let body: React.ReactNode;
  if (q.length >= 2) {
    const mine = (installed ?? []).filter((s) => `${s.name} ${INCLUDED[s.name]?.title ?? ""} ${s.description}`.toLowerCase().includes(q.toLowerCase()));
    body = (
      <>
        {mine.length > 0 && (
          <section className="mb-8">
            <SectionHeading title="Already in zWork" count={mine.length} />
            <ListGroup>
              {mine.slice(0, 8).map((s) => (
                <ListRow
                  key={`${s.source}:${s.name}`}
                  icon={<SkillTile name={s.name} />}
                  title={INCLUDED[s.name]?.title ?? humanize(s.name)}
                  meta={INCLUDED[s.name]?.blurb ?? s.description}
                  onClick={s.store_id ? () => setOpenId(storeSkillOf(s)) : undefined}
                />
              ))}
            </ListGroup>
          </section>
        )}
        {searchError ? (
          <EmptyState compact icon={<Search />} title="Couldn't search skills.sh" body={searchError} />
        ) : results === null || (searching && !results.length) ? (
          <div className="flex h-24 items-center justify-center text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : shown.length ? (
          <section className="mb-8">
            <SectionHeading title="On skills.sh" count={shown.length} description="Skills shared by other people. Open one to see exactly what it tells zWork to do before you add it." />
            <CardGrid>{shown.map(storeCard)}</CardGrid>
          </section>
        ) : (
          <EmptyState compact icon={<Search />} title={`No skills match “${q}”`} body="Try a word for the task, like invoices, minutes or lesson plan." />
        )}
      </>
    );
  } else {
    body = (
      <>
        {added.length > 0 && (
          <section className="mb-8">
            <SectionHeading title="Added by you" count={added.length} />
            <ListGroup>
              {added.map((s) => (
                <ListRow
                  key={s.name}
                  icon={<SkillTile name={s.name} />}
                  title={humanize(s.name)}
                  meta={s.description}
                  onClick={s.store_id ? () => setOpenId(storeSkillOf(s)) : undefined}
                  trailing={
                    s.store_id ? (
                      <Button onClick={() => void remove(s)}>Remove</Button>
                    ) : (
                      <span>In your skills folder</span>
                    )
                  }
                />
              ))}
            </ListGroup>
          </section>
        )}

        <section className="mb-8">
          <SectionHeading
            title="Popular for office work"
            description="Picked from skills.sh. Each one teaches zWork a task it does the same way every time."
          />
          {shelf === null ? (
            <div className="flex h-24 items-center justify-center text-ink-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <CardGrid>{shelf.map(storeCard)}</CardGrid>
          )}
        </section>

        {included.length > 0 && (
          <section className="mb-8">
            <SectionHeading
              title="Included with zWork"
              count={included.length}
              description={behindTheScenes > 0 ? `zWork also has ${plural(behindTheScenes, "more skill")} it uses behind the scenes.` : undefined}
            />
            <ListGroup>
              {included.map((s) => (
                <ListRow
                  key={s.name}
                  icon={<SkillTile name={s.name} />}
                  title={INCLUDED[s.name].title}
                  meta={INCLUDED[s.name].blurb}
                />
              ))}
            </ListGroup>
          </section>
        )}

        {fromOthers.length > 0 && (
          <section className="mb-8">
            <SectionHeading
              title="From other apps on this computer"
              count={fromOthers.length}
              description="zWork can also use skills you set up for other AI apps. Manage them in those apps."
              action={<Button onClick={() => setShowOthers((v) => !v)}>{showOthers ? "Hide" : "Show"}</Button>}
            />
            {showOthers && (
              <ListGroup>
                {fromOthers.map((s) => (
                  <ListRow
                    key={`${s.source}:${s.name}`}
                    icon={<SkillTile name={s.name} />}
                    title={humanize(s.name)}
                    meta={s.description}
                    trailing={<span>{s.source === "project" ? "This folder" : `From ${OTHER_APPS[s.source ?? ""] ?? s.source}`}</span>}
                  />
                ))}
              </ListGroup>
            )}
          </section>
        )}
      </>
    );
  }

  return (
    <PageShell
      title="Skills"
      subtitle="Skills teach zWork how to do a kind of task your way, like chasing invoices or writing minutes."
      actions={
        <IconButton
          icon={refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          label="Refresh"
          variant="outline"
          onClick={() => void refresh()}
        />
      }
      toolbar={<SearchField value={query} onChange={setQuery} placeholder="Search skills" />}
    >
      <div ref={topRef} />
      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-error/20 bg-error/10 px-3.5 py-2.5 text-[12.5px] text-error">{error}</p>
      )}
      {body}
      {confirmDialog}
    </PageShell>
  );
}

/** One skill's page: what it does, exactly what it tells zWork, and Add or Remove. */
function SkillDetail({
  skill,
  backLabel,
  onBack,
  onChanged,
  onRemove,
  onAsk,
}: {
  skill: StoreSkill;
  backLabel: string;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onRemove: (name: string) => Promise<boolean>;
  onAsk: (prompt: string) => void;
}) {
  const [detail, setDetail] = useState<StoreSkillDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      setDetail(await api.skillStoreDetail(skill.id));
    } catch (e: any) {
      setLoadError(friendlyStoreError(String(e?.message ?? e)));
    }
  }

  useEffect(() => {
    void load();
  }, [skill.id]);

  const title = skill.title ?? humanize(detail?.name ?? skill.name);
  const installed = detail?.installed;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.skillStoreInstall(skill.id);
      await Promise.all([onChanged(), load()]);
    } catch (e: any) {
      setError(friendlyStoreError(String(e?.message ?? e), title));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!detail) return;
    setBusy(true);
    try {
      if (await onRemove(detail.name)) await load();
    } finally {
      setBusy(false);
    }
  }

  let action: React.ReactNode = null;
  if (detail) {
    if (installed?.from_store) {
      action = <Button disabled={busy} onClick={() => void remove()}>Remove</Button>;
    } else if (installed) {
      action = <Badge tone="success">Already in zWork</Badge>;
    } else {
      action = (
        <Button variant="primary" disabled={busy} onClick={() => void add()} icon={busy ? <Loader2 className="animate-spin" /> : <Plus />}>
          {busy ? "Adding" : "Add to zWork"}
        </Button>
      );
    }
  }

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
            <IconTile size="lg" className="h-14 w-14 rounded-2xl [&_svg]:h-6 [&_svg]:w-6">{iconFor(skill.name)}</IconTile>
            <div className="min-w-0 flex-1">
              <h1 className="text-[24px] font-semibold tracking-tight text-ink">{title}</h1>
              <p className="flex flex-wrap items-center gap-3 text-[13px] text-ink-muted">
                Shared by {skill.source.split("/")[0]} on skills.sh
                {installed?.from_store && <Badge tone="success">Added</Badge>}
              </p>
            </div>
            {action}
          </header>

          {loadError ? (
            <div className="mt-8">
              <EmptyState compact icon={<BookOpen />} title="Couldn't load this skill" body={loadError} action={<Button onClick={() => void load()}>Try again</Button>} />
            </div>
          ) : !detail ? (
            <div className="flex h-32 items-center justify-center text-ink-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <>
              <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">{skill.description ?? detail.description}</p>
              {skill.description && skill.description !== detail.description && (
                <p className="mt-2 max-w-[60ch] text-[12.5px] leading-relaxed text-ink-muted">In its own words: {detail.description}</p>
              )}
              {error && (
                <p role="alert" className="mt-4 rounded-xl border border-error/20 bg-error/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-error">{error}</p>
              )}

              {installed?.from_store && (
                <div className="mt-5">
                  <Button onClick={() => onAsk(`Use the ${detail.name} skill to help me with `)}>Try it in a chat</Button>
                </div>
              )}

              {detail.scripts > 0 && (
                <div className="mt-6 flex gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-[13px] leading-relaxed text-ink-soft">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                  <p>
                    This skill comes with {plural(detail.scripts, "small program")} zWork may run on your computer. Only add it if you trust who shared it.
                  </p>
                </div>
              )}

              <section className="mt-7">
                <h2 className="text-[15px] font-semibold text-ink">What it tells zWork</h2>
                <p className="mt-1 text-[12.5px] text-ink-muted">zWork reads these instructions whenever a task calls for this skill.</p>
                <div className="mt-3 max-h-[360px] overflow-y-auto whitespace-pre-wrap rounded-2xl border border-line bg-paper-raised p-4 text-[12.5px] leading-relaxed text-ink-soft">
                  {detail.instructions.trim()}
                  {detail.truncated && "\n\n…"}
                </div>
              </section>

              <section className="mt-7">
                <h2 className="text-[15px] font-semibold text-ink">Details</h2>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
                  <dt className="text-ink-muted">Licence</dt>
                  <dd className="text-ink-soft">{detail.license ?? "Not stated"}</dd>
                  <dt className="text-ink-muted">Files</dt>
                  <dd className="text-ink-soft">{plural(detail.files.length, "file")}</dd>
                  {skill.installs ? (
                    <>
                      <dt className="text-ink-muted">Installs</dt>
                      <dd className="text-ink-soft">{skill.installs.toLocaleString()}</dd>
                    </>
                  ) : null}
                  <dt className="text-ink-muted">Source</dt>
                  <dd>
                    <a href={detail.url} target="_blank" rel="noreferrer" className="ring-focus inline-flex items-center gap-1 rounded text-ink-soft underline-offset-2 hover:text-ink hover:underline">
                      {detail.source}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  </dd>
                </dl>
                <p className="mt-4 text-[12.5px] leading-relaxed text-ink-muted">
                  A skill is mostly written instructions. It doesn't connect zWork to any new apps or accounts, and you can remove it any time.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
