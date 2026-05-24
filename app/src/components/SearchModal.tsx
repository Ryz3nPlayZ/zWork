import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  MessageCircle,
  CornerDownLeft,
  SquarePen,
  Settings,
  BarChart3,
  Plug,
  CreditCard,
  FolderOpen,
  Brain,
  Command,
} from "lucide-react";
import { useApp, bucketFor, type ChatBucket } from "../lib/store";
import { cn } from "../lib/cn";

// ---- Built-in action commands ----
interface ActionCmd {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
  keywords: string;
}

// ---- Result union ----
type Result =
  | { kind: "action"; action: ActionCmd }
  | { kind: "chat"; id: string; title: string; updatedAt: number };

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-accent/20 text-accent rounded-[2px] px-0">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

const bucketLabel = (ts: number): string => {
  const b: ChatBucket = bucketFor(ts);
  if (b === "Today") return "Today";
  if (b === "This week") return "This week";
  return "Earlier";
};

export function SearchModal() {
  const open = useApp((s) => s.searchOpen);
  const setOpen = useApp((s) => s.setSearchOpen);
  const summaries = useApp((s) => s.chatSummaries);
  const openChat = useApp((s) => s.openChat);
  const openLanding = useApp((s) => s.openLanding);
  const setView = useApp((s) => s.setView);
  const openSettings = useApp((s) => s.openSettings);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build the actions list (recreated per render so closures are fresh)
  const actions: ActionCmd[] = useMemo(() => [
    {
      id: "new-chat",
      label: "New Chat",
      hint: "⌘N",
      icon: <SquarePen className="h-4 w-4" />,
      run: () => { openLanding(); setOpen(false); },
      keywords: "new chat start fresh",
    },
    {
      id: "settings-general",
      label: "Open Settings",
      hint: "⌘,",
      icon: <Settings className="h-4 w-4" />,
      run: () => { openSettings("general"); setOpen(false); },
      keywords: "settings preferences config",
    },
    {
      id: "settings-models",
      label: "Manage Models & API Keys",
      icon: <Brain className="h-4 w-4" />,
      run: () => { openSettings("models"); setOpen(false); },
      keywords: "models api keys provider anthropic openai",
    },
    {
      id: "settings-memory",
      label: "Edit Memory (zwork.md)",
      icon: <Brain className="h-4 w-4" />,
      run: () => { openSettings("memory"); setOpen(false); },
      keywords: "memory personalization zwork.md",
    },
    {
      id: "view-analytics",
      label: "View Analytics",
      icon: <BarChart3 className="h-4 w-4" />,
      run: () => { setView("analytics"); setOpen(false); },
      keywords: "analytics usage stats",
    },
    {
      id: "view-connectors",
      label: "Connectors & Integrations",
      icon: <Plug className="h-4 w-4" />,
      run: () => { setView("connectors"); setOpen(false); },
      keywords: "connectors integrations mcp composio",
    },
    {
      id: "view-plan",
      label: "Upgrade Plan",
      icon: <CreditCard className="h-4 w-4" />,
      run: () => { setView("plan"); setOpen(false); },
      keywords: "plan upgrade billing",
    },
    {
      id: "view-projects",
      label: "Projects",
      icon: <FolderOpen className="h-4 w-4" />,
      run: () => { setView("projects"); setOpen(false); },
      keywords: "projects folders",
    },
  ], [openLanding, openSettings, setOpen, setView]);

  const results: Result[] = useMemo(() => {
    const q = query.trim().toLowerCase();

    const matchedActions: Result[] = actions
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.keywords.includes(q))
      .map((a) => ({ kind: "action" as const, action: a }));

    const matchedChats: Result[] = (q
      ? summaries.filter((c) => c.title.toLowerCase().includes(q))
      : summaries
    )
      .slice(0, 60)
      .map((c) => ({ kind: "chat" as const, id: c.id, title: c.title, updatedAt: c.updated_at }));

    // When there's a query, interleave actions first; when empty, show actions then chats.
    return [...matchedActions, ...matchedChats];
  }, [summaries, query, actions]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Clamp active index
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1));
  }, [results.length, activeIdx]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  const selectAt = (idx: number) => {
    const r = results[idx];
    if (!r) return;
    if (r.kind === "action") {
      r.action.run();
    } else {
      void openChat(r.id);
      setOpen(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); selectAt(activeIdx); }
  };

  // Separate actions from chats for section headers
  const firstChatIdx = results.findIndex((r) => r.kind === "chat");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[8vh] animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-[640px] overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <Command className="h-4.5 w-4.5 text-ink-faint shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKey}
            placeholder="Search chats or run a command…"
            className="flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(""); setActiveIdx(0); inputRef.current?.focus(); }}
              className="press rounded-md p-0.5 text-ink-faint hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <kbd className="hidden rounded-md border border-line bg-paper px-1.5 py-0.5 text-[10.5px] text-ink-faint sm:block">
            ESC
          </kbd>
        </div>

        {/* Results list */}
        <div ref={listRef} className="max-h-[58vh] overflow-y-auto py-1.5">
          {results.length === 0 && (
            <div className="px-6 py-10 text-center text-[13px] text-ink-faint">
              No results for "{query}"
            </div>
          )}

          {results.map((r, i) => {
            const active = i === activeIdx;
            const isFirstChat = r.kind === "chat" && i === firstChatIdx;
            const isFirstAction = r.kind === "action" && i === 0;

            return (
              <div key={r.kind === "action" ? r.action.id : r.id}>
                {/* Section header */}
                {isFirstAction && (
                  <p className="px-4 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-widest text-ink-faint">
                    Actions
                  </p>
                )}
                {isFirstChat && (
                  <p className={cn("px-4 pb-1 text-[10.5px] font-semibold uppercase tracking-widest text-ink-faint", firstChatIdx > 0 && "pt-3 border-t border-line mt-1.5")}>
                    Recent Chats
                  </p>
                )}

                <button
                  type="button"
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => selectAt(i)}
                  className={cn(
                    "press flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
                    active ? "bg-accent/8 text-ink" : "text-ink hover:bg-paper-sunken/60",
                  )}
                >
                  <span className={cn("shrink-0", active ? "text-accent" : "text-ink-muted")}>
                    {r.kind === "action" ? r.action.icon : <MessageCircle className="h-4 w-4" />}
                  </span>
                  <span className="flex-1 truncate text-[13.5px]">
                    {r.kind === "action"
                      ? r.action.label
                      : highlight(r.title || "Untitled conversation", query)}
                  </span>
                  {r.kind === "action" && r.action.hint && (
                    <kbd className="shrink-0 rounded border border-line bg-paper px-1.5 py-0.5 text-[10px] text-ink-faint">
                      {r.action.hint}
                    </kbd>
                  )}
                  {r.kind === "chat" && (
                    <span className="shrink-0 text-[11.5px] text-ink-faint">
                      {bucketLabel(r.updatedAt)}
                    </span>
                  )}
                  {active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-muted" />}
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 border-t border-line px-4 py-2">
          <span className="text-[11px] text-ink-faint">
            <kbd className="rounded border border-line bg-paper px-1 py-0.5 text-[10px]">↑↓</kbd>{" "}
            navigate
          </span>
          <span className="text-[11px] text-ink-faint">
            <kbd className="rounded border border-line bg-paper px-1 py-0.5 text-[10px]">↵</kbd>{" "}
            select
          </span>
          <div className="flex-1" />
          <span className="text-[11px] text-ink-faint">
            <kbd className="rounded border border-line bg-paper px-1 py-0.5 text-[10px]">⌘K</kbd>{" "}
            to open
          </span>
        </div>
      </div>
    </div>
  );
}
