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
  Plug,
  Keyboard,
  Inbox,
  Clock,
} from "lucide-react";
import { cn } from "../lib/cn";
import { nativeVibrancySupported, useTranslucencyPref } from "../lib/translucency";
import { Logo } from "./Logo";
import { IconButton } from "./IconButton";
import { useApp, bucketFor, type ChatBucket, type View } from "../lib/store";
import { IS_TAURI, isMacOS } from "../lib/platform";

export function Sidebar() {
  const translucency = useTranslucencyPref();
  const translucentOn = translucency === "on";
  // Native macOS vibrancy shows real desktop behind a fully transparent aside;
  // everywhere else, use a translucent tint + blur as a CSS-only fallback.
  const useNativeGlass = translucentOn && nativeVibrancySupported();
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
  const setKeybindingsOpen = useApp((s) => s.setKeybindingsOpen);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const isMac = isMacOS();

  const onDragMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!IS_TAURI || e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, textarea, [data-no-drag]")) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().startDragging().catch(() => {});
    });
  };

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
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-x-hidden border-r border-line",
        // Translucency: native macOS vibrancy → fully transparent so the
        // desktop shows through. CSS fallback (Win/Linux/web) → translucent
        // tint + blur over the page. Off → the standard opaque sidebar fill.
        useNativeGlass
          ? "bg-transparent"
          : translucentOn
            ? "bg-paper-sidebar/70 backdrop-blur-xl"
            : "bg-paper-sidebar",
        "transition-[width] duration-200 ease-out",
        open ? "w-[248px]" : "w-[64px]",
      )}
    >
      {/* macOS drag strip. With titleBarStyle: Overlay the traffic lights are
          painted at the top-left of the window (~80 x 38 px). We reserve that
          space and use the JS startDragging() API, which is reliable in Tauri v2
          unlike the CSS -webkit-app-region class. */}
      <div
        onMouseDown={onDragMouseDown}
        className={cn(
          "shrink-0 w-full",
          isMac ? "h-[38px]" : "h-2",
          isMac && open && "pl-[80px]",
          isMac && "border-b border-line/60",
        )}
        aria-hidden="true"
      />

      {/* Logo + wordmark + collapse toggle — positioned below the drag strip so
          it can never overlap the macOS traffic lights. */}
      {open ? (
        <div className="flex shrink-0 items-center justify-between px-2 pt-2 pb-1">
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
            <span className="text-[14px] font-semibold tracking-tight text-ink">
              <span className="lowercase">z</span>
              <span>Work</span>
            </span>
          </button>
          <IconButton
            icon={<PanelLeft />}
            label="Collapse sidebar"
            shortcut="⌘\\"
            tooltipSide="bottom"
            showTooltip={false}
            onClick={toggle}
            size="sm"
          />
        </div>
      ) : (
        <div className={cn("flex shrink-0 justify-center", isMac ? "pt-1 pb-1" : "py-1")}>
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
        <SidebarButton
          icon={<Clock />}
          label="Scheduled"
          collapsed={!open}
          onClick={() => setView("scheduled")}
          active={view === "scheduled"}
        />
        <SidebarButton
          icon={<Inbox />}
          label="Inbox"
          collapsed={!open}
          onClick={() => setView("inbox")}
          active={view === "inbox"}
        />
        {/* Tasks (kanban) deferred — TasksPage exists but is backlog.
        <SidebarButton
          icon={<LayoutDashboard />}
          label="Tasks"
          collapsed={!open}
          onClick={() => setView("tasks")}
          active={view === "tasks"}
        />
        */}
        <SidebarButton
          icon={<FolderOpen />}
          label="Projects"
          collapsed={!open}
          onClick={() => {
            setActiveProject(null);
            setView("projects");
          }}
          active={view === "projects"}
        />
      </nav>

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
        ) : null}
      </div>

      {/* Footer */}
      <div className="border-t border-line/80 p-3">
        {open ? (
          <div className="flex flex-col gap-0.5">
            <SidebarButton
              icon={<Keyboard />}
              label="Shortcuts"
              shortcut="⌘/"
              collapsed={false}
              onClick={() => setKeybindingsOpen(true)}
            />
            <SidebarButton
              icon={<Settings />}
              label="Settings"
              shortcut="⌘,"
              collapsed={false}
              active={view === "settings"}
              onClick={() => setView("settings")}
            />
            <MoreMenuButton view={view} setView={setView} />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <IconButton
              icon={<Keyboard />}
              label="Shortcuts"
              shortcut="⌘/"
              tooltipSide="right"
              showTooltip={false}
              onClick={() => setKeybindingsOpen(true)}
              size="md"
            />
            <IconButton
              icon={<Settings />}
              label="Settings"
              shortcut="⌘,"
              tooltipSide="right"
              showTooltip={false}
              active={view === "settings"}
              onClick={() => setView("settings")}
              size="md"
            />
            <IconButton
              icon={<BarChart3 />}
              label="Analytics"
              tooltipSide="right"
              showTooltip={false}
              active={view === "analytics"}
              onClick={() => setView("analytics")}
              size="md"
            />
            <IconButton
              icon={<CreditCard />}
              label="Plan"
              tooltipSide="right"
              showTooltip={false}
              active={view === "plan"}
              onClick={() => setView("plan")}
              size="md"
            />
            <IconButton
              icon={<Plug />}
              label="Connectors"
              tooltipSide="right"
              showTooltip={false}
              active={view === "connectors"}
              onClick={() => setView("connectors")}
              size="md"
            />
          </div>
        )}
      </div>
    </aside>
  );
}

function MoreMenuButton({
  view,
  setView,
}: {
  view: View;
  setView: (view: View) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const items: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: "analytics", label: "Analytics", icon: <BarChart3 className="h-4 w-4" /> },
    { id: "plan", label: "Plan", icon: <CreditCard className="h-4 w-4" /> },
    { id: "connectors", label: "Connectors", icon: <Plug className="h-4 w-4" /> },
  ];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
      </button>
      {open && (
        <div
          className="absolute left-full bottom-0 z-[300] ml-2 w-[160px] animate-fade-in rounded-xl hairline bg-paper-raised p-1 shadow-lift"
          role="menu"
          aria-label="More navigation"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setView(item.id);
              }}
              className={cn(
                "press flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px]",
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
