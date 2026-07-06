import { PanelLeft, Search } from "lucide-react";
import { cn } from "../lib/cn";
import { dragRegionAttrs, onDragMouseDown } from "../lib/drag";
import { isMacOS } from "../lib/platform";
import { nativeVibrancySupported, useTranslucencyPref } from "../lib/translucency";
import { useApp } from "../lib/store";
import { IconButton } from "./IconButton";

/**
 * Full-width top strip — the single owner of window dragging.
 *
 * Two segments, each matching the column below it so translucency stays
 * sidebar-only:
 *   1. Sidebar strip (left) — transparent when native glass is on, mirrors
 *      the sidebar's `bg-paper-sidebar` fill otherwise. Carries the sidebar
 *      collapse button + the search button, both fixed next to the traffic
 *      lights so they don't jump when the sidebar toggles.
 *   2. Content strip (right) — always opaque (bg-paper), so the main content
 *      pane never goes translucent even when window vibrancy is on.
 *
 * Spacing (macOS): traffic lights sit ~8px from the left edge and occupy
 * ~52px. The collapse button lands at pl-[88px] — a touch past the lights
 * with comfortable breathing room on all sides. Search follows immediately
 * after a small gap.
 *
 * Dragging uses startDragging() (see lib/drag.ts); IconButtons carry
 * `data-no-drag` so clicks never start a drag.
 */
export function TopStrip() {
  const isMac = isMacOS();
  const open = useApp((s) => s.sidebarOpen);
  const toggle = useApp((s) => s.toggleSidebar);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const translucency = useTranslucencyPref();
  const useNativeGlass = translucency === "on" && nativeVibrancySupported();

  return (
    <div
      {...dragRegionAttrs()}
      onMouseDown={onDragMouseDown}
      className="flex h-[28px] shrink-0 items-stretch"
    >
      {/* Sidebar segment — matches the sidebar's translucency. Width tracks
          the sidebar so the seam lines up exactly. */}
      <div
        className={cn(
          "flex items-center",
          open ? "w-[248px]" : "w-[64px]",
          useNativeGlass
            ? "bg-transparent"
            : "bg-paper-sidebar",
          isMac ? "pl-[88px] pr-1" : "pl-2 pr-1",
        )}
      >
        <div data-no-drag className="flex items-center gap-0.5">
          <IconButton
            icon={<PanelLeft />}
            label={open ? "Collapse sidebar" : "Expand sidebar"}
            shortcut="⌘\\"
            tooltipSide="bottom"
            showTooltip={false}
            onClick={toggle}
            size="sm"
          />
          <IconButton
            icon={<Search />}
            label="Search"
            shortcut="⌘K"
            tooltipSide="bottom"
            showTooltip={false}
            onClick={() => setSearchOpen(true)}
            size="sm"
          />
        </div>
      </div>

      {/* Content segment — always opaque so the reading pane never bleeds
          desktop wallpaper through window vibrancy. Also a drag region. */}
      <div className="flex flex-1 items-center bg-paper" />
    </div>
  );
}
