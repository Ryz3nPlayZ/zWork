// Shared look and placement for the composer's menus (security, crew, model).

/** A ghost trigger: no border, same height and radius as the icon buttons beside it. */
export const MENU_TRIGGER =
  "press ring-focus inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

/** The menu panel. Items inside use rounded-lg. */
export const MENU_PANEL =
  "absolute z-50 overflow-y-auto overscroll-contain animate-menu-in rounded-xl border border-line bg-paper-raised p-1 shadow-pop";

export type MenuPlacement = { dropDown: boolean; maxHeight: number };

/** Open toward the side of `el` with more room, and no taller than that room. */
export function menuPlacement(el: Element | null): MenuPlacement {
  const r = el?.getBoundingClientRect();
  if (!r) return { dropDown: false, maxHeight: 400 };
  const below = window.innerHeight - r.bottom;
  const dropDown = below > r.top;
  // 8px gap to the trigger, 12px to the window edge.
  return { dropDown, maxHeight: Math.max(160, (dropDown ? below : r.top) - 20) };
}
