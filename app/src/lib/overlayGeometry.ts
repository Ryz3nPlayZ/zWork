import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";

/**
 * Overlay window geometry.
 *
 * Design goals (the Ctrl+Alt+Space overlay used to fail all three):
 *  - No dark rectangle: the window is transparent + `shadow:false`; the chat
 *    UI paints its own background. Only placement/size lives here.
 *  - Draggable + position persists: we never force-recenter after the initial
 *    placement. The user drags via `startDragging()` (wired in ChatInput); this
 *    module saves the resulting position and restores it on relaunch.
 *  - Grows with what you're typing: idle height tracks the chatbar's content
 *    height (passed in as `contentHeight`), clamped to a sane range, so you can
 *    compose a multi-line message before sending.
 */

const IDLE_WIDTH = 720;
/** Idle window height when the bar is a single line. */
const IDLE_MIN_HEIGHT = 64;
/** Cap so an essay-length draft doesn't swallow the screen. */
const IDLE_MAX_HEIGHT = 380;
/** Tall conversation panel that opens above the bar. */
const CHAT_HEIGHT = 640;
/** Keep the window this far inside the work-area edges when clamping. */
const EDGE_MARGIN = 10;
/** Bottom margin for the default (first-run) placement. */
const BOTTOM_MARGIN = 24;

const STORAGE_KEY = "zwork.overlay.geometry.v1";

export type OverlayMode = "idle" | "chat";

/** Saved logical position, or null if never persisted. */
function loadSavedPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p.x === "number" && typeof p.y === "number") return p;
  } catch {
    /* ignore */
  }
  return null;
}

function savePos(x: number, y: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {
    /* ignore */
  }
}

/** Logical work-area rect for a monitor (or a sensible fallback). */
function workAreaOf(monitor: { workArea: { position: { x: number; y: number }; size: { width: number; height: number } }; scaleFactor?: number } | null) {
  if (!monitor) {
    return { workX: 0, workY: 0, workW: window.screen.availWidth, workH: window.screen.availHeight, scale: 1 };
  }
  const scale = monitor.scaleFactor || 1;
  return {
    workX: monitor.workArea.position.x / scale,
    workY: monitor.workArea.position.y / scale,
    workW: monitor.workArea.size.width / scale,
    workH: monitor.workArea.size.height / scale,
    scale,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Whether a saved top-left keeps the whole window on-screen at `width`×`height`.
 * Used to discard a position saved on a now-absent external display.
 */
function fitsOnScreen(x: number, y: number, width: number, height: number, wa: { workX: number; workY: number; workW: number; workH: number }): boolean {
  return (
    x >= wa.workX &&
    y >= wa.workY &&
    x + width <= wa.workX + wa.workW &&
    y + height <= wa.workY + wa.workH
  );
}

/** True after the first placement this session; subsequent calls preserve the window's current position. */
let placed = false;

/**
 * Size + position the overlay. Called on mount and whenever the mode or the
 * chatbar's content height changes.
 *
 * - First call: restore the saved position if it's still on-screen, else place
 *   at bottom-center. Either way, clamp into the work area.
 * - Later calls: keep the window's current position (so dragging sticks), only
 *   adjusting so a height change never pushes the bar off-screen.
 */
export async function fitOverlayWindow(
  mode: OverlayMode,
  opts?: { contentHeight?: number },
): Promise<void> {
  const win = getCurrentWindow();
  const monitor = (await currentMonitor()) ?? (await primaryMonitor());
  const wa = workAreaOf(monitor);
  const width = IDLE_WIDTH;
  const height =
    mode === "chat"
      ? CHAT_HEIGHT
      : clamp(opts?.contentHeight ?? IDLE_MIN_HEIGHT, IDLE_MIN_HEIGHT, IDLE_MAX_HEIGHT);

  let x: number;
  let y: number;

  if (!placed) {
    const saved = loadSavedPos();
    if (saved && fitsOnScreen(saved.x, saved.y, width, height, wa)) {
      x = saved.x;
      y = saved.y;
    } else {
      // Default: bottom-center on the current monitor.
      x = wa.workX + (wa.workW - width) / 2;
      y = wa.workY + wa.workH - height - BOTTOM_MARGIN;
    }
    placed = true;
  } else {
    // Preserve where the user put it (or where we last placed it).
    const pos = await win.outerPosition().catch(() => null);
    if (pos) {
      x = pos.x / wa.scale;
      y = pos.y / wa.scale;
    } else {
      x = wa.workX + (wa.workW - width) / 2;
      y = wa.workY + wa.workH - height - BOTTOM_MARGIN;
    }
  }

  // Clamp horizontally into the work area.
  x = clamp(x, wa.workX + EDGE_MARGIN, wa.workX + wa.workW - width - EDGE_MARGIN);
  // Vertically: if growing pushed the bottom past the work area, shift up; never above the top.
  if (y + height > wa.workY + wa.workH - EDGE_MARGIN) {
    y = wa.workY + wa.workH - height - EDGE_MARGIN;
  }
  if (y < wa.workY + EDGE_MARGIN) {
    y = wa.workY + EDGE_MARGIN;
  }

  await win.setSize(new LogicalSize(width, height));
  await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
}

/**
 * Persist the overlay's position whenever the user moves it. Attach once on
 * mount; the returned callback tears the listener down. Saves are debounced so
 * a drag writes one value, not dozens.
 */
export async function attachPositionPersistence(): Promise<() => void> {
  const win = getCurrentWindow();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unlisten = await win.onMoved(({ payload }) => {
    // payload is a PhysicalPosition; convert to logical using devicePixelRatio.
    // (Exact precision isn't required — restore clamps into the work area.)
    const scale = window.devicePixelRatio || 1;
    const x = payload.x / scale;
    const y = payload.y / scale;
    clearTimeout(timer);
    timer = setTimeout(() => savePos(x, y), 250);
  });
  return unlisten;
}
