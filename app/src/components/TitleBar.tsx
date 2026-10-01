/**
 * Integrated Windows title bar.
 *
 * On Windows the main window ships without native decorations (see
 * tauri.windows.conf.json), so this component owns the top chrome. It renders
 * a full-width strip in the base layer's surface color (the sidebar/"surface"
 * fill — never a separate bar color), and uses that space as app space:
 *
 *   [search] [sidebar toggle] │ [←] [chat title ✏] [•] [n msgs] [Export] ─ [–] [□] [×]
 *
 * The empty strip area is a window drag region (double-click toggles
 * maximize via Tauri's declarative data-tauri-drag-region handling), and the
 * right edge carries Windows-style caption buttons. macOS keeps its native
 * traffic-light overlay, Linux its native title bar, and the web build has no
 * window chrome — none of them render this bar (usesIntegratedTitleBar()).
 *
 * The main pane is offset below the strip (App.tsx, top-[45px]) and ChatView
 * hides its own floating header on Windows, so the strip IS the chat header —
 * one continuous bar instead of a native strip stacked on an app header.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, Download, Pencil, PanelLeft, Search, X } from "lucide-react";
import { cn } from "../lib/cn";
import { IS_TAURI, isMacOS, usesIntegratedTitleBar } from "../lib/platform";
import { dragRegionAttrs, onDragMouseDown } from "../lib/drag";
import { useApp, type Chat, type View } from "../lib/store";
import { downloadChatJson, downloadChatMarkdown } from "../lib/chatExport";
import { IconButton } from "./IconButton";

/** Strip height in px. Mirrored by the pane offset (top-[45px]) in App.tsx
 *  and the sidebar's top clearance (pt-[46px]) in Sidebar.tsx. */
const TITLEBAR_H = 40;

const VIEW_LABELS: Partial<Record<View, string>> = {
  settings: "Settings",
  projects: "Projects",
  analytics: "Analytics",
  plan: "Plan",
  connectors: "Connectors",
  admin: "Admin",
  tasks: "Tasks",
  inbox: "Inbox",
  scheduled: "Scheduled",
};

/* ------------------------------------------------------------------ *
 *  Caption buttons (– □ ×)
 * ------------------------------------------------------------------ */

/** Windows 10/11 caption glyphs — 10×10, 1px strokes, no fill. */
function CaptionGlyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 10 10"
      className="h-[10px] w-[10px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const GlyphMin = () => <CaptionGlyph><path d="M0.5 5h9" /></CaptionGlyph>;
const GlyphMax = () => <CaptionGlyph><rect x="0.5" y="0.5" width="9" height="9" /></CaptionGlyph>;
const GlyphRestore = () => (
  <CaptionGlyph>
    <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
    <rect x="0.5" y="2.5" width="7" height="7" />
  </CaptionGlyph>
);
const GlyphClose = () => <CaptionGlyph><path d="M0.7 0.7 9.3 9.3M9.3 0.7 0.7 9.3" /></CaptionGlyph>;

function captionAction(method: "minimize" | "toggleMaximize" | "close") {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      if (method === "minimize") return win.minimize();
      if (method === "toggleMaximize") return win.toggleMaximize();
      return win.close();
    })
    .catch((err) => console.warn(`[titlebar] ${method} failed:`, err));
}

function CaptionButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex w-[46px] items-center justify-center outline-none transition-colors duration-100",
        danger
          ? "hover:bg-[#c42b1c] hover:text-white"
          // ink at low alpha adapts to the theme: light overlay on dark
          // surfaces, dark overlay on light ones.
          : "hover:bg-ink/[0.06] hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** Tracks maximized state so the middle button can swap □ / restore. */
function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!IS_TAURI) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (disposed) return;
      const win = getCurrentWindow();
      const sync = () => {
        win
          .isMaximized()
          .then((m) => {
            if (!disposed) setMaximized(m);
          })
          .catch(() => {});
      };
      sync();
      win
        .onResized(sync)
        .then((u) => {
          unlisten = u;
        })
        .catch(() => {});
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return maximized;
}

/** Min / max-restore / close cluster. Full-height, flush to the window's
 *  top-right corner — the parent supplies the height (h-full). */
export function WindowControls() {
  const maximized = useWindowMaximized();
  return (
    <div data-no-drag className="flex h-full items-stretch text-ink-faint">
      <CaptionButton label="Minimize" onClick={() => captionAction("minimize")}>
        <GlyphMin />
      </CaptionButton>
      <CaptionButton
        label={maximized ? "Restore" : "Maximize"}
        onClick={() => captionAction("toggleMaximize")}
      >
        {maximized ? <GlyphRestore /> : <GlyphMax />}
      </CaptionButton>
      <CaptionButton label="Close" danger onClick={() => captionAction("close")}>
        <GlyphClose />
      </CaptionButton>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Chat header cluster — the active chat's title + metadata, lifted
 *  from ChatView's in-pane header into the title bar on Windows.
 * ------------------------------------------------------------------ */

function ChatCluster({ chat }: { chat: Chat }) {
  const rename = useApp((s) => s.renameChat);
  const setView = useApp((s) => s.setView);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [exportOpen]);

  const commitRename = () => {
    const t = titleDraft.trim();
    if (!t) return;
    void rename(chat.id, t);
    setEditing(false);
  };

  return (
    <div data-no-drag className="flex min-w-0 items-center gap-1.5 pl-2">
      <span className="mx-1 h-4 w-px shrink-0 bg-line/70" aria-hidden="true" />
      {chat.projectId && (
        <button
          type="button"
          onClick={() => {
            setActiveProject(chat.projectId!);
            setView("projects");
          }}
          className="press inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title="Back to project"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
      )}
      {editing ? (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            className="rounded border border-line bg-paper px-2 py-0.5 text-[13px] text-ink focus:outline-none"
            autoFocus
          />
          <button
            type="button"
            onClick={commitRename}
            className="rounded p-0.5 text-ink-muted hover:bg-paper-sunken hover:text-ink"
            aria-label="Save title"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded p-0.5 text-ink-muted hover:bg-paper-sunken hover:text-ink"
            aria-label="Cancel rename"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setTitleDraft(chat.title);
            setEditing(true);
          }}
          className="press group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-paper-sunken"
          title="Rename chat"
        >
          <span className="truncate text-[13px] font-medium text-ink">{chat.title}</span>
          <Pencil className="h-3 w-3 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}
      {chat.working && (
        <span
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
          title={chat.status || "Working"}
          aria-hidden="true"
        />
      )}
      <span className="shrink-0 font-mono text-[11px] text-ink-faint">
        {chat.messages.length} msgs
      </span>
      <div ref={exportRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setExportOpen((v) => !v)}
          className="press inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-[11px] font-medium text-ink hover:bg-paper-sunken"
          title="Export chat history"
        >
          <Download className="h-3 w-3" />
          <span>Export</span>
          <ChevronDown className="h-3 w-3 text-ink-muted" />
        </button>
        {exportOpen && (
          <div className="absolute top-[calc(100%+4px)] right-0 z-[80] w-[170px] animate-fade-in rounded-lg border border-line bg-paper p-1 shadow-pop">
            <button
              type="button"
              onClick={() => {
                downloadChatMarkdown(chat);
                setExportOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] font-medium text-ink transition-colors hover:bg-paper-sunken"
            >
              Export as Markdown (.md)
            </button>
            <button
              type="button"
              onClick={() => {
                downloadChatJson(chat);
                setExportOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] font-medium text-ink transition-colors hover:bg-paper-sunken"
            >
              Export as JSON (.json)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  The bar itself
 * ------------------------------------------------------------------ */

/** Rendered only when usesIntegratedTitleBar() is true — App gates the mount,
 *  so on macOS/Linux/web this component never runs. */
export function TitleBar() {
  const view = useApp((s) => s.view);
  const active = useApp((s) => s.activeChatId);
  const chat = useApp((s) => (active ? s.chats[active] : undefined));
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const viewLabel = view === "chat" ? null : VIEW_LABELS[view];

  return (
    // Transparent over the base layer's surface fill — the bar IS the surface,
    // so the window edge and the sidebar/pane frame are one continuous color.
    // dragRegionAttrs keeps Tauri's native double-click-to-maximize working on
    // the empty areas; mousedowns also bubble to the base layer's JS drag path.
    <div
      {...dragRegionAttrs()}
      style={{ height: TITLEBAR_H }}
      className="absolute inset-x-0 top-0 z-40 flex select-none items-stretch"
    >
      <div data-no-drag className="flex items-center gap-0.5 pl-[10px]">
        <IconButton
          icon={<Search />}
          label="Search"
          shortcut="⌘K"
          tooltipSide="bottom"
          showTooltip={false}
          onClick={() => setSearchOpen(true)}
          size="sm"
        />
        <IconButton
          icon={<PanelLeft />}
          label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          shortcut="⌘\\"
          tooltipSide="bottom"
          showTooltip={false}
          onClick={toggleSidebar}
          size="sm"
        />
      </div>
      {chat ? (
        <ChatCluster chat={chat} />
      ) : viewLabel ? (
        <div {...dragRegionAttrs()} className="flex min-w-0 items-center pl-2">
          <span className="mx-1 h-4 w-px shrink-0 bg-line/70" aria-hidden="true" />
          <span className="truncate px-1.5 text-[13px] font-medium text-ink">{viewLabel}</span>
        </div>
      ) : null}
      <div className="ml-auto flex h-full">
        <WindowControls />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Early screens (boot / login / onboarding) render without the main
 *  layout's base layer, so they carry their own minimal chrome: a drag
 *  strip everywhere Tauri runs, plus caption buttons where the TitleBar
 *  owns the window (Windows).
 * ------------------------------------------------------------------ */

export function EarlyScreenChrome() {
  if (!IS_TAURI) return null;
  if (usesIntegratedTitleBar()) {
    return (
      <>
        <div
          {...dragRegionAttrs()}
          onMouseDown={onDragMouseDown}
          className="absolute inset-x-0 top-0 z-30"
          style={{ height: TITLEBAR_H }}
          aria-hidden="true"
        />
        <div className="absolute right-0 top-0 z-30 flex" style={{ height: TITLEBAR_H }}>
          <WindowControls />
        </div>
      </>
    );
  }
  if (isMacOS()) {
    return (
      <div
        {...dragRegionAttrs()}
        onMouseDown={onDragMouseDown}
        className="absolute inset-x-0 top-0 z-10 h-10"
        aria-hidden="true"
      />
    );
  }
  return null;
}
