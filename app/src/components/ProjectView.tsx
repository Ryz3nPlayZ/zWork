import { useEffect, useMemo, useState, useRef } from "react";
import {
  ArrowLeft,
  MoreHorizontal,
  Star,
  Plus,
  FileText,
  Trash2,
  X,
  FolderOpen,
  Clock,
  Loader2,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { ChatInput } from "./ChatInput";
import { IconButton } from "./IconButton";
import { api } from "../lib/api";

const EMOJI_OPTIONS = [
  "📁", "📊", "💡", "🚀", "🎯", "🔧", "💼", "📝", "🎨", "🏗️",
  "⚡", "🌟", "🔬", "📈", "🎮", "🤝", "🏆", "📱", "🌐", "✅",
];

/**
 * Detail view for a single project. Layout:
 *   left column — header + composer + past chats
 *   right column — Memory / Instructions / Files cards
 */
export function ProjectView() {
  const activeId = useApp((s) => s.activeProjectId);

  // If no project is selected, show the project list view
  if (!activeId) {
    return <ProjectListPage />;
  }

  return <ProjectDetail />;
}

// ---- Project List Page ----

function ProjectListPage() {
  const projects = useApp((s) => s.projects);
  const [modalOpen, setModalOpen] = useState(false);

  // Sort: starred first, then by updated_at descending
  const sorted = useMemo(() => {
    return [...projects].sort((a, b) => {
      if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
      return b.updated_at - a.updated_at;
    });
  }, [projects]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      {/* Header — consistent with Scheduled and Inbox */}
      <div className="shrink-0 border-b border-line bg-paper-soft px-6 py-4">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight text-ink">
              Projects
            </h1>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              {projects.length} project{projects.length === 1 ? "" : "s"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="press ring-focus inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink/90 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            New project
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1200px] px-6 py-6">
          {projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line p-16 text-center">
              <FolderOpen className="mx-auto h-8 w-8 text-ink-faint" />
              <h3 className="mt-3 text-[13.5px] font-semibold text-ink">
                No projects yet
              </h3>
              <p className="mx-auto mt-1 max-w-[320px] text-[12.5px] text-ink-muted">
                Create a project to organize chats, instructions, and files around a single goal.
              </p>
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="press ring-focus mt-4 inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink/90 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Create your first project
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sorted.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </div>
      </div>

      {modalOpen && <CreateProjectModal onClose={() => setModalOpen(false)} />}
    </div>
  );
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const createProject = useApp((s) => s.createProject);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 10);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCreate = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      await createProject(n, description.trim() || undefined, selectedIcon ?? undefined);
      const all = useApp.getState().projects;
      const latest = all[all.length - 1];
      if (latest) setActiveProject(latest.id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] rounded-2xl border border-line bg-paper-raised shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">Create Project</h2>
          <button
            type="button"
            onClick={onClose}
            className="press rounded-md p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Icon picker row */}
          <div>
            <label className="block text-[12.5px] font-medium text-ink-muted mb-1.5">
              Icon <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEmojiPickerOpen((v) => !v)}
                className="press flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-paper hover:border-line-strong text-[20px]"
              >
                {selectedIcon ?? <FolderOpen className="h-4 w-4 text-ink-muted" />}
              </button>
              {selectedIcon && (
                <button
                  type="button"
                  onClick={() => { setSelectedIcon(null); setEmojiPickerOpen(false); }}
                  className="press rounded-md px-2 py-1 text-[11.5px] text-ink-faint hover:bg-paper-sunken hover:text-ink"
                >
                  Clear
                </button>
              )}
            </div>
            {emojiPickerOpen && (
              <div className="mt-2 flex flex-wrap gap-1 rounded-xl border border-line bg-paper p-2 animate-fade-in">
                {EMOJI_OPTIONS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => { setSelectedIcon(e); setEmojiPickerOpen(false); }}
                    className={cn(
                      "press flex h-8 w-8 items-center justify-center rounded-lg text-[18px] hover:bg-paper-sunken",
                      selectedIcon === e && "bg-paper-sunken ring-1 ring-line-strong",
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-[12.5px] font-medium text-ink-muted mb-1.5">
              Name
            </label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) void handleCreate();
              }}
              placeholder="e.g. Website Redesign"
              className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-ink-muted mb-1.5">
              Description <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What is this project about?"
              className="block w-full resize-none rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="press rounded-md border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-paper-sunken"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={busy || !name.trim()}
            className="press rounded-md bg-ink px-4 py-1.5 text-[12.5px] font-medium text-paper hover:bg-ink-soft disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({ project }: { project: { id: string; name: string; description: string; updated_at: number; starred?: boolean; icon?: string } }) {
  const setActiveProject = useApp((s) => s.setActiveProject);
  const deleteProject = useApp((s) => s.deleteProject);
  const updateProject = useApp((s) => s.updateProject);
  const [menuOpen, setMenuOpen] = useState(false);

  // Task 3: fix date — backend returns Unix seconds, Date.now() is ms
  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts * 1000;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const handleStar = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await updateProject(project.id, { starred: !project.starred });
  };

  return (
    <div className="group relative rounded-2xl border border-line bg-paper-raised p-4 transition-shadow hover:shadow-chat">
      <button
        type="button"
        onClick={() => setActiveProject(project.id)}
        className="text-left w-full"
      >
        <div className="flex items-start justify-between gap-2">
          {/* Task 4: show emoji icon if set, otherwise FolderOpen */}
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-paper-sunken text-[20px]">
            {project.icon ? (
              <span>{project.icon}</span>
            ) : (
              <FolderOpen className="h-4 w-4 text-ink-muted" />
            )}
          </div>
          <div
            className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Task 2: star button */}
            <button
              type="button"
              onClick={(e) => void handleStar(e)}
              className="press rounded-md p-1 hover:bg-paper-sunken"
              aria-label={project.starred ? "Unstar" : "Star"}
            >
              <Star
                className={cn(
                  "h-3.5 w-3.5 transition-colors",
                  project.starred ? "fill-amber-400 text-amber-400" : "text-ink-faint",
                )}
              />
            </button>
            <IconButton
              icon={<MoreHorizontal />}
              label="More"
              size="sm"
              showTooltip={false}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
            />
          </div>
        </div>
        <h3 className="mt-3 truncate text-[14px] font-semibold text-ink">{project.name}</h3>
        {project.description && (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-5 text-ink-muted">{project.description}</p>
        )}
        <div className="mt-3 flex items-center gap-1 text-[10.5px] text-ink-faint">
          <Clock className="h-3 w-3" />
          <span>{timeAgo(project.updated_at)}</span>
          {project.starred && (
            <Star className="ml-auto h-3 w-3 fill-amber-400 text-amber-400" />
          )}
        </div>
      </button>

      {/* Context menu */}
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div
            className="absolute right-3 top-10 z-50 w-[160px] animate-fade-in rounded-xl border border-line-strong bg-paper-raised p-1 shadow-pop"
            role="menu"
          >
            <button
              type="button"
              onClick={async () => {
                await deleteProject(project.id);
                setMenuOpen(false);
              }}
              role="menuitem"
              className="press flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-red-600 hover:bg-red-500/10"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete project
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Project Detail Page ----

function ProjectDetail() {
  const activeId = useApp((s) => s.activeProjectId);
  const projects = useApp((s) => s.projects);
  const chatSummaries = useApp((s) => s.chatSummaries);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const updateProject = useApp((s) => s.updateProject);
  const openChat = useApp((s) => s.openChat);

  const project = useMemo(
    () => projects.find((p) => p.id === activeId) || null,
    [projects, activeId],
  );

  const [menuOpen, setMenuOpen] = useState(false);

  // Editable name/description inline
  const [editingField, setEditingField] = useState<"name" | "description" | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");

  useEffect(() => {
    if (!project) return;
    setNameDraft(project.name);
    setDescDraft(project.description || "");
  }, [project?.id, project?.name, project?.description]);

  // Instructions (project.md) Modal and State
  const [instructions, setInstructions] = useState<string>("");
  const [editModalType, setEditModalType] = useState<"instructions" | null>(null);
  const [projectFiles, setProjectFiles] = useState<Array<{ name: string; size: number; mime: string; path: string }>>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; filename: string }>({ open: false, filename: "" });

  // If we land here with no resolved project, reset the active id and render
  // nothing. Done in an effect (not during render) to avoid a render-phase
  // setState, and after all hooks so the hook order is stable across renders
  // (React error #300: "Rendered fewer hooks than expected").
  useEffect(() => {
    if (!project) setActiveProject(null);
  }, [project, setActiveProject]);

  if (!project) {
    // Shouldn't reach here since ProjectView routes to list when no activeId,
    // but handle gracefully.
    return null;
  }

  const loadProjectFiles = async () => {
    if (!activeId) return;
    setFilesLoading(true);
    try {
      const res = await api.getProjectFiles(activeId);
      setProjectFiles(res.files || []);
    } catch (err) {
      console.error("Failed to load project files:", err);
    } finally {
      setFilesLoading(false);
    }
  };

  const handleAddFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeId) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const result = evt.target?.result;
      if (typeof result !== "string") return;
      const payload = {
        files: [
          {
            name: file.name,
            mime: file.type || "application/octet-stream",
            kind: "file",
            data_url: result,
          }
        ]
      };
      try {
        await api.uploadProjectFiles(activeId, payload);
        void loadProjectFiles();
      } catch (err) {
        console.error("Failed to upload project file:", err);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDeleteFile = async (filename: string) => {
    if (!activeId) return;
    setDeleteModal({ open: true, filename });
  };

  const confirmDeleteFile = async () => {
    if (!activeId || !deleteModal.filename) return;
    try {
      await api.deleteProjectFile(activeId, deleteModal.filename);
      void loadProjectFiles();
    } catch (err) {
      console.error("Failed to delete project file:", err);
    } finally {
      setDeleteModal({ open: false, filename: "" });
    }
  };

  const triggerAddFile = () => {
    fileInputRef.current?.click();
  };

  useEffect(() => {
    if (!activeId) return;
    void api
      .getProjectContext(activeId)
      .then((r) => {
        setInstructions(r.content || "");
      })
      .catch(() => {});
    void loadProjectFiles();
  }, [activeId]);

  const projectChats = chatSummaries.filter((c) =>
    c.project_id === project.id,
  );

  const commitName = async () => {
    const next = nameDraft.trim();
    setEditingField(null);
    if (next && next !== project.name) {
      await updateProject(project.id, { name: next });
    } else {
      setNameDraft(project.name);
    }
  };

  const commitDesc = async () => {
    const next = descDraft.trim();
    setEditingField(null);
    if (next !== (project.description || "")) {
      await updateProject(project.id, { description: next });
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-paper">
      {/* Header: back to all projects */}
      <div className="flex h-12 shrink-0 items-center border-b border-line px-4">
        <div data-no-drag>
          <button
            type="button"
            onClick={() => {
              setActiveProject(null);
              // Stay on projects view — will render the list page
            }}
            className="press inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All projects
          </button>
        </div>
      </div>

      {/* Body: 2-column responsive grid */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1180px] grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8 lg:py-10">
          {/* LEFT: header + composer + chats */}
          <div className="flex min-w-0 flex-col gap-6">
            {/* Header row */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {editingField === "name" ? (
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitName();
                      if (e.key === "Escape") {
                        setNameDraft(project.name);
                        setEditingField(null);
                      }
                    }}
                    className="w-full bg-transparent text-[28px] font-semibold tracking-tight text-ink focus:outline-none"
                  />
                ) : (
                  <h1
                    onClick={() => setEditingField("name")}
                    className="cursor-text text-[28px] font-semibold tracking-tight text-ink"
                  >
                    {project.icon && <span className="mr-2 text-[36px]">{project.icon}</span>}
                    {project.name}
                  </h1>
                )}
                {editingField === "description" ? (
                  <input
                    autoFocus
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    onBlur={commitDesc}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitDesc();
                      if (e.key === "Escape") {
                        setDescDraft(project.description || "");
                        setEditingField(null);
                      }
                    }}
                    placeholder="goal"
                    className="mt-1 w-full bg-transparent text-[14px] text-ink-muted focus:outline-none"
                  />
                ) : (
                  <p
                    onClick={() => setEditingField("description")}
                    className="mt-1 cursor-text text-[14px] text-ink-muted"
                  >
                    {project.description?.trim() || (
                      <span className="text-ink-faint">goal</span>
                    )}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                <ProjectMenu
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  projectId={project.id}
                />
                {/* Task 2: star button wired to API */}
                <IconButton
                  icon={<Star className={cn(project.starred && "fill-amber-400 text-amber-400")} />}
                  label={project.starred ? "Unstar" : "Star"}
                  size="md"
                  onClick={() => void updateProject(project.id, { starred: !project.starred })}
                />
              </div>
            </div>

            {/* Composer — sends with project_id via store.send */}
            <ChatInput
              placeholder="How can I help you today?"
              autoFocus
            />

            {/* Past chats — flat list matching sidebar style */}
            {projectChats.length > 0 && (
              <div className="flex flex-col">
                <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Chats
                </h3>
                <ul className="flex flex-col">
                  {projectChats.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => void openChat(c.id)}
                        className={cn(
                          "press flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-muted",
                          "hover:bg-line/60 hover:text-ink",
                        )}
                      >
                        <span className="truncate">{c.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* RIGHT: instructions / files */}
          <aside className="flex flex-col gap-5">
            {/* Instructions card */}
            <section className="flex-grow flex-shrink-0 min-h-[200px] rounded-2xl border border-line bg-paper-raised p-5 flex flex-col">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] font-semibold text-ink">Instructions</h3>
                  <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
                    Add instructions to tailor zWork's responses
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditModalType("instructions")}
                  className="text-[12.5px] font-semibold text-accent hover:underline press shrink-0"
                >
                  edit
                </button>
              </div>
              {instructions.trim() ? (
                <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-paper-sunken p-3 font-mono text-[11.5px] leading-5 text-ink-muted overflow-y-auto max-h-[160px] flex-grow">
                  {instructions}
                </pre>
              ) : (
                <div className="mt-auto flex items-center justify-center py-6 text-[12px] text-ink-faint border border-dashed border-line rounded-lg flex-grow">
                  No instructions added yet.
                </div>
              )}
            </section>

            {/* Files card */}
            <section className="flex-grow flex-shrink-0 min-h-[200px] rounded-2xl border border-line bg-paper-raised p-5 flex flex-col">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] font-semibold text-ink">Files</h3>
                  <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
                    Add PDFs, documents, or other text to reference in this project.
                  </p>
                </div>
                <IconButton icon={<Plus />} label="Add file" size="sm" onClick={triggerAddFile} className="shrink-0" />
              </div>
              
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleAddFile}
                className="hidden"
              />

              {filesLoading ? (
                <div className="flex flex-grow items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-ink-muted" />
                </div>
              ) : projectFiles.length === 0 ? (
                <div className="mt-auto flex flex-col items-center justify-center gap-3 rounded-xl bg-paper-sunken px-4 py-6 flex-grow">
                  <div className="relative flex items-end gap-1 text-ink-faint">
                    <FileText className="h-7 w-7" />
                    <FileText className="h-9 w-9 -ml-2" />
                    <FileText className="h-7 w-7 -ml-2" />
                  </div>
                  <p className="max-w-[200px] text-center text-[11px] leading-4 text-ink-muted">
                    No files added yet.
                  </p>
                </div>
              ) : (
                <div className="flex-grow overflow-y-auto max-h-[200px] mt-2">
                  <ul className="flex flex-col gap-1.5">
                    {projectFiles.map((file) => (
                      <li key={file.name} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[11.5px] text-ink transition-colors">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                          <span className="truncate font-medium" title={file.name}>{file.name}</span>
                          <span className="text-[9.5px] text-ink-faint shrink-0">
                            ({(file.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleDeleteFile(file.name)}
                          className="press rounded p-0.5 text-ink-faint hover:bg-line hover:text-ink shrink-0"
                          aria-label={`Delete ${file.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>

      {editModalType === "instructions" && (
        <EditModal
          title="Edit Instructions"
          subtitle="Add instructions to tailor zWork's responses for this project."
          value={instructions}
          placeholder="e.g. Always respond in markdown. Prefer concise answers."
          onSave={async (val) => {
            await api.putProjectContext(project.id, val);
            setInstructions(val);
          }}
          onClose={() => setEditModalType(null)}
        />
      )}

      {/* Delete file confirmation modal */}
      {deleteModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-fade-in px-4"
          onClick={() => setDeleteModal({ open: false, filename: "" })}
        >
          <div
            className="w-full max-w-[360px] rounded-2xl border border-line bg-paper-raised shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <h2 className="text-[15px] font-semibold text-ink">Delete file</h2>
              <button
                type="button"
                onClick={() => setDeleteModal({ open: false, filename: "" })}
                className="press rounded-md p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-4">
              <p className="text-[13px] text-ink-muted leading-relaxed">
                Are you sure you want to delete{" "}
                <span className="font-medium text-ink">{deleteModal.filename}</span>?
                This action cannot be undone.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
              <button
                type="button"
                onClick={() => setDeleteModal({ open: false, filename: "" })}
                className="press rounded-md border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-paper-sunken"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteFile()}
                className="press rounded-md bg-red-600 px-4 py-1.5 text-[12.5px] font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectMenu({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  projectId: string;
}) {
  const deleteProject = useApp((s) => s.deleteProject);
  const setActiveProject = useApp((s) => s.setActiveProject);

  const remove = async () => {
    await deleteProject(projectId);
    setActiveProject(null);
  };

  return (
    <div className="relative">
      <IconButton
        icon={<MoreHorizontal />}
        label="More"
        size="md"
        onClick={() => onOpenChange(!open)}
      />
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-[180px] animate-fade-in rounded-xl border border-line-strong bg-paper-raised p-1 shadow-pop"
          role="menu"
          onMouseLeave={() => onOpenChange(false)}
        >
          <button
            type="button"
            onClick={() => void remove()}
            role="menuitem"
            className="press flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-red-600 hover:bg-red-500/10"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete project
          </button>
        </div>
      )}
    </div>
  );
}

function EditModal({
  title,
  subtitle,
  value,
  placeholder,
  onSave,
  onClose,
}: {
  title: string;
  subtitle: string;
  value: string;
  placeholder?: string;
  onSave: (val: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 10);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-fade-in px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[600px] rounded-2xl border border-line bg-paper-raised shadow-pop flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
            <p className="text-[11.5px] text-ink-muted mt-0.5">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press rounded-md p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 flex-grow overflow-y-auto">
          <textarea
            ref={textareaRef}
            rows={12}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="block w-full resize-y rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12.5px] leading-5 text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3 bg-paper-sunken/40">
          <button
            type="button"
            onClick={onClose}
            className="press rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink-muted hover:bg-paper-sunken hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="press rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-paper hover:bg-ink-soft disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

