import type { ReactNode } from "react";
import { ChevronDown, Clock, FolderOpen, Inbox, MoreHorizontal, PanelLeft, Plug, Search, Settings, SquarePen } from "lucide-react";
import { cn } from "../lib/cn";
import { Logo } from "./Logo";
import type { CloneState } from "./types";

function SidebarButton({
  icon,
  label,
  active,
  shortcut,
  badge,
  target,
  pressed,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  shortcut?: string;
  badge?: number;
  target?: string;
  pressed?: boolean;
}) {
  return (
    <div
      data-target={target}
      data-pressed={pressed}
      className={cn(
        "press group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-muted",
        active && "bg-line font-semibold text-ink",
        pressed && !active && "bg-line/40 text-ink",
      )}
    >
      <span className="flex h-5 w-5 items-center justify-center [&_svg]:h-[16px] [&_svg]:w-[16px]">{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
      {badge ? (
        <span className="min-w-[18px] rounded-full bg-accent/15 px-1.5 text-center text-[10px] font-semibold leading-[18px] text-accent">
          {badge}
        </span>
      ) : shortcut ? (
        <span className="font-mono text-[10.5px] text-ink-faint">{shortcut}</span>
      ) : null}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">{children}</div>;
}

export function Sidebar({ s }: { s: CloneState }) {
  const unread = s.inbox.filter((i) => !i.read).length;
  const buckets = (["Today", "This week", "Earlier"] as const)
    .map((b) => [b, s.history.filter((h) => h.bucket === b)] as const)
    .filter(([, items]) => items.length > 0);

  return (
    <aside className="absolute inset-y-0 left-0 flex w-[248px] flex-col bg-paper-sidebar">
      {/* macOS window controls share the row with search + collapse */}
      <div className="absolute left-[14px] top-[14px] flex items-center gap-2">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57] ring-[0.5px] ring-black/10" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e] ring-[0.5px] ring-black/10" />
        <span className="h-3 w-3 rounded-full bg-[#28c840] ring-[0.5px] ring-black/10" />
      </div>
      <div className="absolute left-[86px] top-[10px] flex items-center gap-1 text-ink-muted">
        <span className="flex h-6 w-6 items-center justify-center">
          <Search className="h-[15px] w-[15px]" />
        </span>
        <span className="flex h-6 w-6 items-center justify-center">
          <PanelLeft className="h-[15px] w-[15px]" />
        </span>
      </div>

      <div className="flex items-center px-2 pb-1 pt-[40px]">
        <div className="flex items-center gap-2.5 rounded-lg p-1.5 pl-2">
          <Logo size={28} className="text-ink" />
          <span className="text-[14px] font-semibold tracking-tight text-ink">zWork</span>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-2 pb-2 pt-4">
        <SidebarButton
          icon={<SquarePen />}
          label="New chat"
          shortcut="⌘N"
          active={s.view === "welcome"}
          target="nav-new"
          pressed={s.pressed === "nav-new"}
        />
        <SidebarButton
          icon={<Clock />}
          label="Scheduled"
          active={s.view === "scheduled"}
          target="nav-scheduled"
          pressed={s.pressed === "nav-scheduled"}
        />
        <SidebarButton
          icon={<Inbox />}
          label="Inbox"
          badge={unread}
          active={s.view === "inbox"}
          target="nav-inbox"
          pressed={s.pressed === "nav-inbox"}
        />
        <SidebarButton icon={<FolderOpen />} label="Projects" />
        <SidebarButton icon={<Plug />} label="Connectors" />
      </nav>

      <div className="clone-scroll min-h-0 flex-1 overflow-hidden px-2">
        {buckets.map(([bucket, items]) => (
          <div key={bucket}>
            <SectionLabel>{bucket}</SectionLabel>
            <div className="flex flex-col gap-px">
              {items.map((h) => (
                <div
                  key={h.id}
                  className={cn(
                    "press flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-muted",
                    s.view === "chat" && s.activeChat === h.id && "bg-line font-semibold text-ink",
                  )}
                >
                  <span className="truncate">{h.title}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-0.5 border-t border-edge-muted px-2 py-3">
        <SidebarButton icon={<Settings />} label="Settings" shortcut="⌘," />
        <div className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-muted">
          <span className="flex h-5 w-5 items-center justify-center [&_svg]:h-[16px] [&_svg]:w-[16px]">
            <MoreHorizontal />
          </span>
          <span className="flex-1">More</span>
          <ChevronDown className="h-3.5 w-3.5 text-ink-faint" />
        </div>
      </div>
    </aside>
  );
}
