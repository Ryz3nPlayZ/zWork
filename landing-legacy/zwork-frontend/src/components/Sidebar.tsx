import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PanelLeft,
  SquarePen,
  Search,
  Settings,
  Trash2,
  MoreHorizontal,
  FolderOpen,
  BarChart3,
  CreditCard,
} from "lucide-react";
import { cn } from "../lib/cn";
import { isMacOS } from "../lib/platform";
import { Logo } from "./Logo";
import { IconButton } from "./IconButton";
import { useApp, bucketFor, type ChatBucket } from "../lib/store";

export function Sidebar() {
  const SHOW_PROJECTS = false;
  const macOS = isMacOS();
  const open = useApp((s) => s.sidebarOpen);
  const toggle = useApp((s) => s.toggleSidebar);
  const summaries = useApp((s) => s.chatSummaries);
  const active = useApp((s) => s.activeChatId);
  const openChat = useApp((s) => s.openChat);
  const deleteChat = useApp((s) => s.deleteChat);
  const openLanding = useApp((s) => s.openLanding);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const buckets: Record<ChatBucket, typeof summaries> = {
      Today: [],
      "This week": [],
      Earlier: [],
    };
    for (const c of summaries) {
      buckets[bucketFor(c.updated_at)].push(c);
    }
    return buckets;
  }, [summaries]);

  return (
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-x-hidden border-r border-line bg-paper-sidebar",
        "transition-[width] duration-200 ease-out",
        open ? "w-[248px]" : "w-[64px]",
      )}
    >
      {/* Titlebar drag area — reserve space for the macOS traffic lights.
           On Linux, a smaller spacer keeps the logo from touching the window edge. */}
      {macOS ? (
        <div className="titlebar-drag relative h-8 shrink-0" />
      ) : (
        <div className="titlebar-drag relative h-3 shrink-0" />
      )}

      {/* Top row: logo (top-left, icon only) + optional "zWork" wordmark + collapse toggle */}
      <div
        className={cn(
          "flex shrink-0 items-center px-2 pt-2 pb-1",
          open ? "justify-between" : "justify-center",
        )}
      >
        <button
          type="button"
          onClick={() => openLanding()}
          className="logo-hover-trigger press group flex items-center gap-2.5 rounded-lg p-1.5 pl-2 hover:bg-line/40"
          aria-label="Home"
          title="Home (new chat)"
        >
          <span className="logo-spin-target inline-flex">
            <Logo size={28} />
          </span>
          {open && (
            <span className="text-[14px] font-semibold tracking-tight text-ink">
              <span className="lowercase">z</span>
              <span>Work</span>
            </span>
          )}
        </button>
        {open && (
          <IconButton
            icon={<PanelLeft />}
            label="Collapse sidebar"
            shortcut="⌘\\"
            tooltipSide="bottom"
            showTooltip={false}
            onClick={toggle}
            size="sm"
          />
        )}
      </div>

      {/* Expand toggle in collapsed state */}
      {!open && (
        <div className="flex justify-center pb-1">
          <IconButton
            icon={<PanelLeft />}
            label="Expand sidebar"
            shortcut="⌘\\"
            tooltipSide="right"
            showTooltip={false}
            onClick={toggle}
            size="sm"
          />
        </div>
      )}

      {/* Primary actions */}
      <nav className="flex flex-col gap-0.5 px-2 pt-4 pb-2">
        <SidebarButton
          icon={<SquarePen />}
          label="New chat"
          shortcut="⌘N"
          collapsed={!open}
          onClick={() => openLanding()}
          active={view === "chat" && active === null}
        />
        <SidebarButton
          icon={<Search />}
          label="Search"
          shortcut="⌘K"
          collapsed={!open}
          onClick={() => setSearchOpen(true)}
        />
      </nav>

      {/* Projects */}
      {SHOW_PROJECTS && open && (
        <div className="px-2 mt-3">
          <SectionLabel title="Projects" />
          <ul className="mt-1 flex flex-col">
            <li>
              <button
                type="button"
                onClick={() => {
                  setActiveProject(null);
                  setView("projects");
                }}
                className={cn(
                  "press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-muted",
                  "hover:bg-line/60 hover:text-ink",
                  view === "projects" && !useApp.getState().activeProjectId &&
                    "bg-paper-raised text-ink shadow-[0_0_0_1px_rgba(17,17,17,0.06)]",
                )}
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                <span>My Projects</span>
              </button>
            </li>
          </ul>
        </div>
      )}

      {/* Chat history */}
      <div className="mt-3 flex-1 overflow-x-hidden overflow-y-auto pb-3">
        {open ? (
          <div className="px-2">
            {(["Today", "This week", "Earlier"] as ChatBucket[]).map((bucket) => {
              const items = grouped[bucket];
              if (items.length === 0) return null;
              return (
                <div key={bucket} className="mt-3 first:mt-1">
                  <SectionLabel title={bucket} />
                  <ul className="mt-1 flex flex-col">
                    {items.map((c) => {
                      const isActive = c.id === active;
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
                              "bg-paper-raised text-ink shadow-[0_0_0_1px_rgba(17,17,17,0.06)]",
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
            {summaries.length === 0 && (
              <div className="mt-6 px-2 text-[12px] text-ink-faint">
                No chats yet. Press{" "}
                <kbd className="rounded border border-line bg-paper-raised px-1 py-[1px] font-mono text-[10.5px] text-ink-muted">
                  ⌘N
                </kbd>{" "}
                to start.
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Footer */}
      <div className="border-t border-line/80 p-3">
        <SidebarButton
          icon={<BarChart3 />}
          label="Analytics"
          collapsed={!open}
          active={view === "analytics"}
          onClick={() => setView("analytics")}
        />
        <SidebarButton
          icon={<CreditCard />}
          label="Plan"
          collapsed={!open}
          active={view === "plan"}
          onClick={() => setView("plan")}
        />
        <SidebarButton
          icon={<Settings />}
          label="Settings"
          shortcut="⌘,"
          collapsed={!open}
          active={view === "settings"}
          onClick={() => setView("settings")}
        />
      </div>
    </aside>
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
  collapsed,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  collapsed: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  if (collapsed) {
    return (
      <div className="flex justify-center">
        <IconButton
          icon={icon}
          label={label}
          shortcut={shortcut}
          tooltipSide="right"
          showTooltip={false}
          onClick={onClick}
          active={active}
          size="md"
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "press group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-muted",
        "hover:bg-line/60 hover:text-ink",
        active && "bg-line/70 text-ink",
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
          className="absolute right-0 top-full z-[300] mt-1 w-[150px] animate-fade-in rounded-xl border border-line-strong bg-paper-raised p-1 shadow-pop"
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
