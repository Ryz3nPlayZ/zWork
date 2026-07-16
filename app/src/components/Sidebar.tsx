import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SquarePen,
  Settings,
  Trash2,
  MoreHorizontal,
  ChevronDown,
  FolderOpen,
  BarChart3,
  CreditCard,
  Plug,
  Inbox,
  Clock,
} from "lucide-react";
import { cn } from "../lib/cn";
import { isMacOS } from "../lib/platform";
import { nativeVibrancySupported, useTranslucencyPref } from "../lib/translucency";
import { Logo } from "./Logo";
import { IconButton } from "./IconButton";
import { useApp, bucketFor, type ChatBucket, type View } from "../lib/store";

export function Sidebar() {
  const isMac = isMacOS();
  const translucency = useTranslucencyPref();
  const translucentOn = translucency === "on";
  // Native macOS vibrancy shows real desktop behind a fully transparent aside;
  // everywhere else, use a translucent tint + blur as a CSS-only fallback.
  const useNativeGlass = translucentOn && nativeVibrancySupported();
  const open = useApp((s) => s.sidebarOpen);
  const summaries = useApp((s) => s.chatSummaries);
  const active = useApp((s) => s.activeChatId);
  const openChat = useApp((s) => s.openChat);
  const deleteChat = useApp((s) => s.deleteChat);
  const openLanding = useApp((s) => s.openLanding);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Exclude chats that belong to any project from the sidebar
  const projectChatIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of summaries) {
      if (s.project_id) ids.add(s.id);
    }
    return ids;
  }, [summaries]);

  const sidebarSummaries = useMemo(() => summaries.filter((c) => !projectChatIds.has(c.id)), [summaries, projectChatIds]);

  const grouped = useMemo(() => {
    const buckets: Record<ChatBucket, typeof sidebarSummaries> = {
      Today: [],
      "This week": [],
      Earlier: [],
    };
    for (const c of sidebarSummaries) {
      buckets[bucketFor(c.updated_at)].push(c);
    }
    return buckets;
  }, [sidebarSummaries]);

  return (
    // Collapse is now purely visual: the outer <aside> animates its width from
    // 248px → 0 and clips. Content always renders in a fixed-width inner div so
    // nothing reflows during the animation. The toggle lives in App.tsx's
    // floating controls, not here. No border-r — the 5px gap to the floating
    // main pane (and its rounded edge + shadow) provide the visual separation.
    <aside
      className={cn(
        "relative h-full shrink-0 overflow-hidden",
        // Translucency: native macOS vibrancy → fully transparent so the
        // desktop shows through. CSS fallback (Win/Linux/web) → translucent
        // tint + blur over the page. Off → the standard opaque sidebar fill.
        useNativeGlass
          ? "bg-transparent native-glass"
          : translucentOn
            ? "bg-paper-sidebar/85 backdrop-blur-xl"
            : "bg-paper-sidebar",
        "transition-[width] duration-200 ease-out",
        open ? "w-[248px]" : "w-0",
      )}
    >
      {/* Fixed-width inner wrapper: holds the actual sidebar content at its
          natural 248px while the outer aside collapses. Prevents reflow. */}
      <div className="flex h-full w-[248px] flex-col">
        {/*
          Logo header — brand row only. Search + sidebar toggle are
          window-level controls (see App.tsx) pinned at the top-left so
          they don't slide with the pane. On macOS this row is pushed
          below the traffic lights (≈28px) and the floating control row
          (≈35px) so the logo clears both.
        */}
        <div className={cn("flex shrink-0 items-center px-2 pb-1", isMac ? "pt-[40px]" : "pt-3")}>
          <button
            type="button"
            onClick={() => openLanding()}
            data-no-drag
            className="logo-hover-trigger press group flex items-center gap-2.5 rounded-lg p-1.5 pl-2"
            aria-label="Home"
            title="Home (new chat)"
          >
            <span className="logo-spin-target inline-flex">
              <Logo size={28} />
            </span>
            <span className="text-[14px] font-semibold tracking-tight text-ink">
              <span className="lowercase">z</span>
              <span>Work</span>
            </span>
          </button>
        </div>

        {/* Primary actions */}
        <nav className="flex flex-col gap-0.5 px-2 pt-4 pb-2">
          <SidebarButton
            icon={<SquarePen />}
            label="New chat"
            shortcut="⌘N"
            onClick={() => openLanding()}
            active={view === "chat" && active === null}
          />
          <SidebarButton
            icon={<Clock />}
            label="Scheduled"
            onClick={() => setView("scheduled")}
            active={view === "scheduled"}
          />
          <SidebarButton
            icon={<Inbox />}
            label="Inbox"
            onClick={() => setView("inbox")}
            active={view === "inbox"}
          />
          {/* Tasks (kanban) deferred — TasksPage exists but is backlog.
          <SidebarButton
            icon={<LayoutDashboard />}
            label="Tasks"
            onClick={() => setView("tasks")}
            active={view === "tasks"}
          />
          */}
          <SidebarButton
            icon={<FolderOpen />}
            label="Projects"
            onClick={() => {
              setActiveProject(null);
              setView("projects");
            }}
            active={view === "projects"}
          />
        </nav>

        {/* Chat history */}
        <div className="mt-3 flex-1 overflow-x-hidden overflow-y-auto pb-3">
          <div className="px-2">
            {(["Today", "This week", "Earlier"] as ChatBucket[]).map((bucket) => {
              const items = grouped[bucket];
              if (items.length === 0) return null;
              return (
                <div key={bucket} className="mt-3 first:mt-1">
                  <SectionLabel title={bucket} />
                  <ul className="mt-1 flex flex-col">
                    {items.map((c) => {
                      const isActive = view === "chat" && c.id === active;
                      const rowMenuOpen = openMenuId === c.id;
                      return (
                        <li
                          key={c.id}
                          className={cn(
                            "group/item relative",
                            rowMenuOpen ? "z-50" : "z-0 hover:z-20 focus-within:z-20",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuId(null);
                              void openChat(c.id);
                            }}
                            className={cn(
                              "press flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-muted",
                              "hover:bg-line/60 hover:text-ink",
                              isActive &&
                              "bg-line/50 font-semibold text-ink",
                            )}
                          >
                            <span className="truncate pr-6">{c.title}</span>
                          </button>
                          <div
                            className={cn(
                              "absolute right-1 top-1/2 -translate-y-1/2 transition-opacity",
                              rowMenuOpen
                                ? "pointer-events-auto opacity-100"
                                : "pointer-events-none opacity-0 group-hover/item:pointer-events-auto group-hover/item:opacity-100 group-focus-within/item:pointer-events-auto group-focus-within/item:opacity-100",
                            )}
                          >
                            <RowMenu
                              open={rowMenuOpen}
                              onOpenChange={(next) => {
                                setOpenMenuId((current) => {
                                  if (next) return c.id;
                                  return current === c.id ? null : current;
                                });
                              }}
                              onDelete={() => {
                                setOpenMenuId(null);
                                void deleteChat(c.id);
                              }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {sidebarSummaries.length === 0 && (
              <div className="mt-6 px-2 text-[12px] text-ink-faint">
                No chats yet. Press{" "}
                <kbd className="rounded border border-line bg-paper-raised px-1 py-[1px] font-mono text-[10.5px] text-ink-muted">
                  ⌘N
                </kbd>{" "}
                to start.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-edge-muted px-2 py-3">
          <div className="flex flex-col gap-0.5">
            <SidebarButton
              icon={<Settings />}
              label="Settings"
              shortcut="⌘,"
              active={view === "settings"}
              onClick={() => setView("settings")}
            />
            <MoreMenuButton view={view} setView={setView} />
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * "More" — a persistent toggle that expands Analytics / Plan / Connectors
 * INLINE within the sidebar footer. Previously this floated out to the right
 * (clipped by overflow-x-hidden) and auto-collapsed on selection. Now it stays
 * open after picking an item so the user doesn't have to re-expand it every
 * time — the chevron indicates state, and clicking the toggle row collapses it.
 */
function MoreMenuButton({
  view,
  setView,
}: {
  view: View;
  setView: (view: View) => void;
}) {
  const [open, setOpen] = useState(false);

  const items: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: "analytics", label: "Analytics", icon: <BarChart3 className="h-4 w-4" /> },
    { id: "plan", label: "Plan", icon: <CreditCard className="h-4 w-4" /> },
    { id: "connectors", label: "Connectors", icon: <Plug className="h-4 w-4" /> },
  ];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "press group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-muted",
          "hover:bg-line/60 hover:text-ink",
          open && "bg-line/50 text-ink",
        )}
      >
        <span className="flex h-5 w-5 items-center justify-center text-ink-muted group-hover:text-ink">
          <MoreHorizontal className="h-4 w-4" />
        </span>
        <span className="flex-1 text-left">More</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-ink-faint transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5 pl-2" role="group" aria-label="More navigation">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                // Intentionally do NOT collapse — keep the panel open so the
                // user can switch between these views without re-expanding.
                setView(item.id);
              }}
              className={cn(
                "press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]",
                view === item.id
                  ? "bg-line/50 font-semibold text-ink"
                  : "text-ink-muted hover:bg-line/50 hover:text-ink",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between px-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
        {title}
      </span>
    </div>
  );
}

function SidebarButton({
  icon,
  label,
  shortcut,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "press group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-muted",
        "hover:bg-line/60 hover:text-ink",
        active && "bg-line/50 font-semibold text-ink",
      )}
    >
      <span className="flex h-5 w-5 items-center justify-center text-ink-muted group-hover:text-ink [&_svg]:h-[16px] [&_svg]:w-[16px]">
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {shortcut && (
        <span className="font-mono text-[10.5px] text-ink-faint">{shortcut}</span>
      )}
    </button>
  );
}

function RowMenu({
  open,
  onOpenChange,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onDelete: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onDocMouseDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };

    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open, onOpenChange]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onClick={(e) => e.stopPropagation()}
    >
      <IconButton
        icon={<MoreHorizontal />}
        label="More actions"
        size="sm"
        showTooltip={false}
        onClick={(e) => {
          e.stopPropagation();
          onOpenChange(!open);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      />
      {open && (
        <div
          className="absolute right-0 top-full z-[300] mt-1 w-[150px] animate-fade-in rounded-xl hairline bg-paper-raised p-1 shadow-lift"
          role="menu"
          aria-label="Chat actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onDelete();
              onOpenChange(false);
            }}
            role="menuitem"
            className="press flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-red-600 hover:bg-red-500/10"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete chat
          </button>
        </div>
      )}
    </div>
  );
}
