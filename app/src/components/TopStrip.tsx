import { PanelLeft } from "lucide-react";
import { cn } from "../lib/cn";
import { dragRegionAttrs, onDragMouseDown } from "../lib/drag";
import { isMacOS } from "../lib/platform";
import { useApp } from "../lib/store";
import { IconButton } from "./IconButton";

/**
 * Full-width top strip — the single owner of window dragging.
 *
 * This replaces the previous "overlay" pattern where the sidebar header and
 * each view's header each carried drag regions. Concentrating drag handling
 * here means:
 *  - One consistent draggable edge across the whole window (no hit-and-miss
 *    per-view behavior).
 *  - The sidebar collapse button lives in a FIXED position (next to the
 *    traffic lights on macOS) so it never jumps when the sidebar toggles —
 *    exactly the Vellum/Hermes layout the user referenced.
 *
 * Visual approach: the strip is ALWAYS transparent and only ~22px tall, so it
 * vanishes — the collapse button floats over whatever column is below it
 * (sidebar bg on the left, paper bg on the right) with no visible band. The
 * previous opaque `bg-paper-sidebar` version read as "a separate section."
 *
 * Spacing (macOS): traffic lights sit ~8px from the left edge and occupy
 * ~52px, so the collapse button is placed at `pl-[80px]` to land just past
 * them with matching visual rhythm: [8px : lights : ~20px : button].
 * On non-macOS the button sits at the natural `px-2` left edge (no lights).
 *
 * Dragging uses the same startDragging() IPC as before (see lib/drag.ts);
 * the IconButton carries `data-no-drag` so clicking it never starts a drag.
 */
export function TopStrip() {
  const isMac = isMacOS();
  const open = useApp((s) => s.sidebarOpen);
  const toggle = useApp((s) => s.toggleSidebar);

  return (
    <div
      {...dragRegionAttrs()}
      onMouseDown={onDragMouseDown}
      className={cn(
        "flex h-[22px] shrink-0 items-center bg-transparent",
        isMac ? "pl-[80px] pr-2" : "pl-2 pr-2",
      )}
    >
      <div data-no-drag>
        <IconButton
          icon={<PanelLeft />}
          label={open ? "Collapse sidebar" : "Expand sidebar"}
          shortcut="⌘\\"
          tooltipSide="bottom"
          showTooltip={false}
          onClick={toggle}
          size="sm"
          active={!open}
        />
      </div>
    </div>
  );
}
