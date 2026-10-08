import { useState } from "react";
import {
  PanelLeft,
  SquarePen,
  Search,
  Settings,
  FolderOpen,
  BarChart3,
  ChevronDown,
} from "lucide-react";
import { Logo } from "../Logo";

export function DemoShell({
  children,
  sidebarOpen = true,
  title = "New conversation",
  msgCount = 1,
}: {
  children: React.ReactNode;
  sidebarOpen?: boolean;
  title?: string;
  msgCount?: number;
}) {
  const [open, setOpen] = useState(sidebarOpen);

  return (
    <div className="flex h-full w-full overflow-hidden rounded-2xl border border-line bg-paper shadow-lg">
      {/* Sidebar */}
      <aside
        className={`relative flex h-full shrink-0 flex-col overflow-x-hidden border-r border-line bg-paper-sidebar transition-[width] duration-200 ease-out ${
          open ? "w-[200px]" : "w-[56px]"
        }`}
      >
        {/* Top row: logo + toggle */}
        <div
          className={`flex shrink-0 items-center px-2 pt-2 pb-1 ${
            open ? "justify-between" : "justify-center"
          }`}
        >
          <div className="flex items-center gap-2.5 rounded-lg p-1.5 pl-2">
            <span className="inline-flex">
              <Logo size={28} />
            </span>
            {open && (
              <span className="text-[14px] font-semibold tracking-tight text-ink">
                <span className="lowercase">z</span>
                <span>Work</span>
              </span>
            )}
          </div>
          {open && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-line/40 hover:text-ink"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Expand toggle in collapsed state */}
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mx-auto mb-1 mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-line/40 hover:text-ink"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}

        {/* Actions row */}
        <div
          className={`flex items-center gap-1 px-2 pb-2 ${
            open ? "justify-between" : "flex-col justify-center gap-2"
          }`}
        >
          <button
            type="button"
            className={`inline-flex items-center gap-2 rounded-md border border-line bg-paper px-2 py-1.5 text-[12.5px] font-medium text-ink hover:bg-paper-sunken ${
              open ? "" : "w-8 justify-center px-0"
            }`}
          >
            <SquarePen className="h-3.5 w-3.5" />
            {open && "New chat"}
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-line/40 hover:text-ink"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {open && (
            <>
              <div className="mb-1 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
                Today
              </div>
              <div className="mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-ink bg-line/30">
                <span className="truncate">{title}</span>
              </div>
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-ink-muted hover:bg-line/20">
                <span className="truncate">Weekly planning</span>
              </div>
              <div className="mb-1 px-2 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
                This week
              </div>
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-ink-muted hover:bg-line/20">
                <span className="truncate">Invoice cleanup</span>
              </div>
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-ink-muted hover:bg-line/20">
                <span className="truncate">Blog post draft</span>
              </div>
            </>
          )}
        </div>

        {/* Bottom actions */}
        <div
          className={`flex items-center border-t border-line px-2 py-2 ${
            open ? "justify-between" : "flex-col gap-2"
          }`}
        >
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-line/40 hover:text-ink"
          >
            <FolderOpen className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-line/40 hover:text-ink"
          >
            <BarChart3 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-line/40 hover:text-ink"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* Main chat area */}
      <div className="flex h-full min-w-0 flex-1 flex-col bg-paper">
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{title}</span>
            <ChevronDown className="h-3.5 w-3.5 text-ink-faint" />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10.5px] text-ink-faint font-mono">
              {msgCount} msgs
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
