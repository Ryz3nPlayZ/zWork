import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  FileText,
  FolderOpen,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "../lib/cn";
import { GlideGroup } from "./Glide";
import { useApp } from "../lib/store";
import { ChatInput } from "./ChatInput";
import { AssistantMarkdown } from "./Message";
import { api, type Project } from "../lib/api";
import {
  Button,
  Card,
  CardGrid,
  Dialog,
  EmptyState,
  Field,
  IconTile,
  ListGroup,
  ListRow,
  OverflowMenu,
  PageShell,
  RowIconButton,
  SearchField,
  SectionHeading,
  inputClass,
  useConfirm,
} from "./page/Page";

/** The Projects page: the list, or one project when one is open. */
export function ProjectView() {
  const activeId = useApp((s) => s.activeProjectId);
  return activeId ? <ProjectDetail /> : <ProjectListPage />;
}

/** Backend writes timestamps as milliseconds. */
function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Project list ----

function ProjectListPage() {
  const projects = useApp((s) => s.projects);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmDialog, confirm] = useConfirm();

  const q = query.trim().toLowerCase();
  const { starred, rest } = useMemo(() => {
    const byRecent = [...projects]
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
      .sort((a, b) => b.updated_at - a.updated_at);
    return {
      starred: byRecent.filter((p) => p.starred),
      rest: byRecent.filter((p) => !p.starred),
    };
  }, [projects, q]);

  const grid = (list: Project[]) => (
    <CardGrid>
      {list.map((p) => (
        <ProjectCard key={p.id} project={p} confirm={confirm} />
      ))}
    </CardGrid>
  );

  const newProject = (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      New project
    </Button>
  );

  return (
    <PageShell
      title="Projects"
      subtitle="Keep the chats, instructions and files for one piece of work together."
      actions={projects.length > 0 ? newProject : undefined}
      toolbar={
        projects.length >= 5 ? (
          <SearchField value={query} onChange={setQuery} placeholder="Search projects" />
        ) : undefined
      }
    >
      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderOpen />}
          title="No projects yet"
          body="A project keeps related chats together, with instructions and files zWork uses in every one of them."
          action={newProject}
        />
      ) : starred.length + rest.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-ink-muted">No projects match &ldquo;{query}&rdquo;.</p>
      ) : starred.length > 0 ? (
        <>
          <SectionHeading title="Starred" count={starred.length} className="mt-0" />
          {grid(starred)}
          {rest.length > 0 && (
            <>
              <SectionHeading title="Other projects" count={rest.length} />
              {grid(rest)}
            </>
          )}
        </>
      ) : (
        grid(rest)
      )}

      {creating && <CreateProjectDialog onClose={() => setCreating(false)} />}
      {confirmDialog}
    </PageShell>
  );
}

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const createProject = useApp((s) => s.createProject);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createProject(n, description.trim() || undefined);
      if (id) setActiveProject(id);
      onClose();
    } catch {
      setError("The project wasn't created. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New project"
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            {busy ? "Creating…" : "Create project"}
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="project-name">
        <input
          id="project-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          placeholder="2026 tax return"
          className={inputClass}
        />
      </Field>
      <Field label="What's it for?" htmlFor="project-goal" optional>
        <textarea
          id="project-goal"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Collect receipts and fill in the forms before April 15"
          className={cn(inputClass, "resize-none leading-relaxed")}
        />
      </Field>
      {error && (
        <p role="alert" className="text-[12.5px] text-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function ProjectCard({
  project,
  confirm,
}: {
  project: Project;
  confirm: (o: { title: string; body?: string; confirmLabel: string }) => Promise<boolean>;
}) {
  const setActiveProject = useApp((s) => s.setActiveProject);
  const deleteProject = useApp((s) => s.deleteProject);
  const updateProject = useApp((s) => s.updateProject);
  const chats = project.chat_ids?.length ?? 0;

  return (
    <Card
      icon={
        <IconTile size="lg">
          <FolderOpen />
        </IconTile>
      }
      title={project.name}
      description={project.description || undefined}
      onClick={() => setActiveProject(project.id)}
      footer={
        <>
          <span>{chats === 0 ? "No chats yet" : `${chats} chat${chats === 1 ? "" : "s"}`}</span>
          <span>Updated {timeAgo(project.updated_at)}</span>
        </>
      }
      corner={
        project.starred ? <Star aria-label="Starred" className="h-3.5 w-3.5 fill-warning text-warning" /> : undefined
      }
      menu={
        <OverflowMenu
          items={[
            {
              label: project.starred ? "Unstar" : "Star",
              icon: <Star />,
              onSelect: () => void updateProject(project.id, { starred: !project.starred }),
            },
            {
              label: "Delete",
              icon: <Trash2 />,
              danger: true,
              onSelect: async () => {
                const ok = await confirm({
                  title: `Delete "${project.name}"?`,
                  body: "Its instructions and files are removed. Its chats stay in your history.",
                  confirmLabel: "Delete project",
                });
                if (ok) void deleteProject(project.id);
              },
            },
          ]}
        />
      }
    />
  );
}

// ---- One project ----

function ProjectDetail() {
  const activeId = useApp((s) => s.activeProjectId);
  const project = useApp((s) => s.projects.find((p) => p.id === activeId) ?? null);
  const setActiveProject = useApp((s) => s.setActiveProject);

  // A project that no longer exists (deleted elsewhere) sends you back to the list.
  useEffect(() => {
    if (!project) setActiveProject(null);
  }, [project, setActiveProject]);

  if (!project) return null;
  // Keyed so drafts and loaded files reset when you switch projects.
  return <ProjectDetailBody key={project.id} project={project} />;
}

/** `name` is how it's stored (used to remove it), `display_name` how the user named it. */
type ProjectFile = {
  name: string;
  display_name?: string;
  size: number;
  path: string;
};

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === "string" ? resolve(r.result) : reject(new Error("unreadable")));
    r.onerror = () => reject(r.error ?? new Error("unreadable"));
    r.readAsDataURL(file);
  });
}

function ProjectDetailBody({ project }: { project: Project }) {
  const chatSummaries = useApp((s) => s.chatSummaries);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const updateProject = useApp((s) => s.updateProject);
  const deleteProject = useApp((s) => s.deleteProject);
  const openChat = useApp((s) => s.openChat);
  const [confirmDialog, confirm] = useConfirm();

  const [editing, setEditing] = useState<"name" | "description" | null>(null);
  const [nameDraft, setNameDraft] = useState(project.name);
  const [descDraft, setDescDraft] = useState(project.description || "");
  const [instructions, setInstructions] = useState("");
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [memory, setMemory] = useState("");
  const [timeline, setTimeline] = useState("");
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNameDraft(project.name);
    setDescDraft(project.description || "");
  }, [project.name, project.description]);

  const loadFiles = useCallback(async () => {
    try {
      const res = await api.getProjectFiles(project.id);
      setFiles(res.files || []);
    } catch {
      setFiles([]);
    }
  }, [project.id]);

  useEffect(() => {
    void api
      .getProjectContext(project.id)
      .then((r) => setInstructions(r.content || ""))
      .catch(() => {});
    void api
      .getProjectMemory(project.id)
      .then((r) => setMemory(r.content || ""))
      .catch(() => {});
    void api
      .getProjectTimeline(project.id)
      .then((r) => setTimeline(r.content || ""))
      .catch(() => {});
    void loadFiles();
  }, [project.id, loadFiles]);

  const chats = useMemo(
    () => chatSummaries.filter((c) => c.project_id === project.id).sort((a, b) => b.updated_at - a.updated_at),
    [chatSummaries, project.id],
  );

  const commitName = async () => {
    const next = nameDraft.trim();
    setEditing(null);
    if (next && next !== project.name) await updateProject(project.id, { name: next });
    else setNameDraft(project.name);
  };

  const commitDesc = async () => {
    const next = descDraft.trim();
    setEditing(null);
    if (next !== (project.description || "")) await updateProject(project.id, { description: next });
  };

  const upload = async (list: FileList | File[]) => {
    const picked = Array.from(list);
    if (picked.length === 0) return;
    setUploading(true);
    setFileError(null);
    try {
      const payload = await Promise.all(
        picked.map(async (f) => ({
          name: f.name,
          mime: f.type || "application/octet-stream",
          kind: "file",
          data_url: await readAsDataUrl(f),
        })),
      );
      const res = await api.uploadProjectFiles(project.id, { files: payload });
      await loadFiles();
      if (res.failed?.length) {
        setFileError(
          res.failed.length === 1
            ? `"${res.failed[0]}" didn't upload. Try again.`
            : `${res.failed.length} files didn't upload. Try again.`,
        );
      }
    } catch {
      setFileError(
        picked.length === 1 ? "That file didn't upload. Try again." : "Those files didn't upload. Try again.",
      );
    } finally {
      setUploading(false);
    }
  };

  const removeFile = async (f: ProjectFile) => {
    const ok = await confirm({
      title: `Remove "${f.display_name ?? f.name}"?`,
      body: "zWork won't use it in this project anymore. The copy on your computer isn't touched.",
      confirmLabel: "Remove file",
    });
    if (!ok) return;
    try {
      await api.deleteProjectFile(project.id, f.name);
    } finally {
      void loadFiles();
    }
  };

  const removeProject = async () => {
    const ok = await confirm({
      title: `Delete "${project.name}"?`,
      body: "Its instructions and files are removed. Its chats stay in your history.",
      confirmLabel: "Delete project",
    });
    if (!ok) return;
    await deleteProject(project.id);
    setActiveProject(null);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-paper">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] px-6 pb-16 pt-6">
          <button
            type="button"
            onClick={() => setActiveProject(null)}
            className="press ring-focus -ml-2 mb-4 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] text-ink-muted transition-colors hover:bg-ink/5 hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Projects
          </button>

          <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_300px]">
            {/* Main column: name, composer, chats */}
            <div className="min-w-0">
              <header className="mb-5 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {editing === "name" ? (
                    <input
                      autoFocus
                      aria-label="Project name"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={() => void commitName()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitName();
                        if (e.key === "Escape") {
                          setNameDraft(project.name);
                          setEditing(null);
                        }
                      }}
                      className="-mx-1.5 w-full rounded-md bg-line/25 px-1.5 text-[22px] font-semibold tracking-tight text-ink focus:outline-none"
                    />
                  ) : (
                    <h1>
                      <button
                        type="button"
                        title="Rename"
                        onClick={() => setEditing("name")}
                        className="ring-focus -mx-1.5 max-w-full truncate rounded-md px-1.5 text-left text-[22px] font-semibold tracking-tight text-ink transition-colors hover:bg-ink/5"
                      >
                        {project.name}
                      </button>
                    </h1>
                  )}
                  {editing === "description" ? (
                    <input
                      autoFocus
                      aria-label="What this project is for"
                      value={descDraft}
                      onChange={(e) => setDescDraft(e.target.value)}
                      onBlur={() => void commitDesc()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitDesc();
                        if (e.key === "Escape") {
                          setDescDraft(project.description || "");
                          setEditing(null);
                        }
                      }}
                      placeholder="What's this project for?"
                      className="-mx-1.5 mt-0.5 w-full rounded-md bg-line/25 px-1.5 py-0.5 text-[13px] text-ink-muted placeholder:text-ink-faint focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditing("description")}
                      className="ring-focus -mx-1.5 mt-0.5 block max-w-full rounded-md px-1.5 py-0.5 text-left text-[13px] text-ink-muted transition-colors hover:bg-ink/5"
                    >
                      {project.description?.trim() || (
                        <span className="text-ink-faint">Add what this project is for</span>
                      )}
                    </button>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5 pt-1">
                  <RowIconButton
                    label={project.starred ? "Unstar" : "Star"}
                    aria-pressed={!!project.starred}
                    onClick={() =>
                      void updateProject(project.id, {
                        starred: !project.starred,
                      })
                    }
                  >
                    <Star className={cn(project.starred && "fill-warning text-warning")} />
                  </RowIconButton>
                  <OverflowMenu
                    items={[
                      {
                        label: "Rename",
                        icon: <Pencil />,
                        onSelect: () => setEditing("name"),
                      },
                      {
                        label: "Edit instructions",
                        icon: <FileText />,
                        onSelect: () => setEditingInstructions(true),
                      },
                      {
                        label: "Delete project",
                        icon: <Trash2 />,
                        danger: true,
                        onSelect: () => void removeProject(),
                      },
                    ]}
                  />
                </div>
              </header>

              <ChatInput placeholder={`Ask anything about ${project.name}`} autoFocus />

              <SectionHeading title="Chats" count={chats.length || undefined} />
              {chats.length === 0 ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-line-strong px-4 py-4">
                  <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
                  <p className="text-[12.5px] leading-relaxed text-ink-muted">
                    No chats yet. Ask something above to start one. Chats here are kept with this project and use its instructions and files.
                  </p>
                </div>
              ) : (
                <ListGroup>
                  {chats.map((c) => (
                    <ListRow
                      key={c.id}
                      icon={
                        <IconTile>
                          <MessageSquare />
                        </IconTile>
                      }
                      title={c.title || "Untitled chat"}
                      meta={c.preview || undefined}
                      onClick={() => void openChat(c.id)}
                      trailing={<span>{timeAgo(c.updated_at)}</span>}
                    />
                  ))}
                </ListGroup>
              )}
            </div>

            {/* Side column: what zWork uses in every chat here */}
            <aside className="flex flex-col divide-y divide-line self-start border-line xl:sticky xl:top-0 xl:border-l xl:pl-8 [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
              <SidePanel
                title="Instructions"
                action={
                  instructions.trim() ? (
                    <RowIconButton label="Edit instructions" onClick={() => setEditingInstructions(true)}>
                      <Pencil />
                    </RowIconButton>
                  ) : undefined
                }
              >
                {instructions.trim() ? (
                  <ClampedText text={instructions} />
                ) : (
                  <>
                    <p className="text-[12.5px] leading-relaxed text-ink-muted">
                      Tell zWork how to work on this project: who it's for, what to include, the tone to use.
                    </p>
                    <Button className="mt-3" icon={<Plus />} onClick={() => setEditingInstructions(true)}>
                      Add instructions
                    </Button>
                  </>
                )}
              </SidePanel>

              <div
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void upload(e.dataTransfer.files);
                }}
              >
                <SidePanel
                  title="Files"
                  count={files?.length || undefined}
                  highlighted={dragging}
                  action={
                    <RowIconButton label="Add files" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                      {uploading ? <Loader2 className="animate-spin" /> : <Plus />}
                    </RowIconButton>
                  }
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files) void upload(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  {files === null ? (
                    <div className="flex justify-center py-3">
                      <Loader2 className="h-4 w-4 animate-spin text-ink-faint" />
                    </div>
                  ) : files.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="ring-focus -mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-ink/5"
                    >
                      <Upload className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                      <span className="text-[12.5px] leading-relaxed text-ink-muted">
                        <span className="font-medium text-ink">Add files</span> zWork should use here, like PDFs, spreadsheets or documents. You can also drop them here.
                      </span>
                    </button>
                  ) : (
                    <GlideGroup className="-mx-1.5 flex max-h-[240px] flex-col overflow-y-auto">
                      {files.map((f) => {
                        const label = f.display_name ?? f.name;
                        return (
                          <div
                            key={f.name}
                            data-glide=""
                            className="group flex items-center gap-2 rounded-lg px-1.5 py-1"
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                            <button
                              type="button"
                              onClick={() => void api.openFile(f.path)}
                              title={`Open ${label}`}
                              className="ring-focus min-w-0 flex-1 truncate rounded text-left text-[12.5px] text-ink"
                            >
                              {label}
                            </button>
                            <span className="shrink-0 text-[11px] text-ink-faint group-hover:hidden">
                              {fileSize(f.size)}
                            </span>
                            <RowIconButton
                              label={`Remove ${label}`}
                              onClick={() => void removeFile(f)}
                              className="hidden h-6 w-6 group-hover:inline-flex focus-visible:inline-flex"
                            >
                              <Trash2 />
                            </RowIconButton>
                          </div>
                        );
                      })}
                    </GlideGroup>
                  )}
                  {fileError && (
                    <p role="alert" className="mt-2 text-[12px] text-error">
                      {fileError}
                    </p>
                  )}
                </SidePanel>
              </div>

              {/* Only shown when there are notes; zWork reads them in every chat here. */}
              {(memory.trim() || timeline.trim()) && (
                <SidePanel title="What zWork remembers">
                  {memory.trim() && (
                    <div className="max-h-[220px] overflow-y-auto text-[12.5px] text-ink-soft">
                      <AssistantMarkdown content={memory} />
                    </div>
                  )}
                  {timeline.trim() && <History text={timeline} />}
                </SidePanel>
              )}
            </aside>
          </div>
        </div>
      </div>

      {editingInstructions && (
        <InstructionsDialog
          value={instructions}
          onSave={async (val) => {
            await api.putProjectContext(project.id, val);
            setInstructions(val);
          }}
          onClose={() => setEditingInstructions(false)}
        />
      )}
      {confirmDialog}
    </div>
  );
}

function SidePanel({
  title,
  count,
  action,
  highlighted,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  highlighted?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "-mx-3 rounded-xl px-3 py-1 transition-colors",
        highlighted && "bg-ink/5 outline-dashed outline-1 outline-line-strong",
      )}
    >
      <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">
          {title}
          {count !== undefined && <span className="ml-1.5 font-normal text-ink-faint">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Long text shown a few lines at a time, with a toggle when it overflows. */
function ClampedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 6;
  return (
    <div>
      <p
        className={cn(
          "whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-soft",
          long && !open && "line-clamp-6",
        )}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ring-focus mt-1 rounded text-[12px] font-medium text-ink-muted hover:text-ink"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/** The agent's log of what happened in this project, folded away by default. */
function History({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t border-line pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="ring-focus -mx-1 flex w-[calc(100%+0.5rem)] items-center justify-between rounded-md px-1 py-1 text-[12px] font-medium text-ink-muted transition-colors hover:text-ink"
      >
        History
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-1 max-h-[240px] overflow-y-auto text-[12px] text-ink-soft">
          <AssistantMarkdown content={text} />
        </div>
      )}
    </div>
  );
}

function InstructionsDialog({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave: (val: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch {
      setError("That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Project instructions"
      description="zWork follows these in every chat in this project."
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <textarea
        autoFocus
        aria-label="Project instructions"
        rows={12}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          "This is for my small bakery's bookkeeping.\nKeep answers short and use plain words.\nPut totals in a table."
        }
        className={cn(inputClass, "resize-y leading-relaxed")}
      />
      {error && (
        <p role="alert" className="text-[12.5px] text-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
