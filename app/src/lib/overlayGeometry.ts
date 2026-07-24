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
/** Idle window height when the bar is a single line. Generous enough that the
 * pill (48px content + focus ring) is never clipped at the top. */
const IDLE_MIN_HEIGHT = 76;
/** Cap so an essay-length draft doesn't swallow the screen. Generous enough
 * that opening the + tools menu or the Share Window picker (which need vertical
 * room above the pill) isn't clipped — the textarea itself is internally capped
 * at 200px, so this ceiling only matters for those overlay UI elements. */
const IDLE_MAX_HEIGHT = 600;
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

/** Whether the user has explicitly dragged the overlay this session. Until
 * they do, every show defaults to bottom-center. Set true by the onMoved
 * listener in attachPositionPersistence. */
let userDragged = false;

/** Mark that the user has dragged — called from the position-persistence
 * listener. Once true, fitOverlayWindow preserves the user's position. */
export function markUserDragged(): void {
  userDragged = true;
}

/** Reset the drag flag — call when the overlay is hidden so the next show
 * defaults to bottom-center again (unless the user drags). */
export function resetOverlayPlacement(): void {
  userDragged = false;
}

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

  if (!userDragged) {
    // The user hasn't explicitly moved the overlay this session. Default to
    // bottom-center on the current monitor — the expected position for a
    // global chat overlay. (A saved position is only honored if the user
    // dragged in a prior session AND it still fits.)
    const saved = loadSavedPos();
    if (saved && fitsOnScreen(saved.x, saved.y, width, height, wa)) {
      x = saved.x;
      y = saved.y;
    } else {
      x = wa.workX + (wa.workW - width) / 2;
      y = wa.workY + wa.workH - height - BOTTOM_MARGIN;
    }
  } else {
    // The user dragged — preserve where they put it.
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
  // Vertically: keep the bottom pinned. If growing pushed the bottom past the
  // work area, shift up; never above the top.
  if (y + height > wa.workY + wa.workH - EDGE_MARGIN) {
    y = wa.workY + wa.workH - height - EDGE_MARGIN;
  }
  if (y < wa.workY + EDGE_MARGIN) {
    y = wa.workY + EDGE_MARGIN;
  }

  // Smoothly animate the size/position transition instead of snapping. The
  // bottom is pinned (y shifts up as height grows) so the pill appears to
  // stay put while the panel expands above it.
  await animateOverlayTo(win, width, height, x, y, wa.scale);
}

/**
 * Tween the overlay window from its current size/position to the target over
 * ~180ms using requestAnimationFrame. The bottom edge stays pinned (y moves
 * up as height grows). Tauri v2 setSize/setPosition are instant, so we step
 * through intermediate values to fake an animation. Coarse steps (~10) keep
 * IPC overhead low; the CSS opacity fade on the conversation panel masks any
 * stair-stepping.
 */
async function animateOverlayTo(
  win: ReturnType<typeof getCurrentWindow>,
  targetW: number,
  targetH: number,
  targetX: number,
  targetY: number,
  scale: number,
): Promise<void> {
  const startPos = await win.outerPosition().catch(() => null);
  const startSize = await win.outerSize().catch(() => null);
  if (!startPos || !startSize) {
    // Can't read current geometry — just snap.
    await win.setSize(new LogicalSize(targetW, targetH));
    await win.setPosition(new LogicalPosition(Math.round(targetX), Math.round(targetY)));
    return;
  }

  const startW = startSize.width / scale;
  const startH = startSize.height / scale;
  const start_X = startPos.x / scale;
  const start_Y = startPos.y / scale;

  // If we're already at the target (within 1px), skip the animation.
  if (Math.abs(startH - targetH) < 2 && Math.abs(startW - targetW) < 2) {
    await win.setSize(new LogicalSize(targetW, targetH));
    await win.setPosition(new LogicalPosition(Math.round(targetX), Math.round(targetY)));
    return;
  }

  const STEPS = 10;
  const STEP_MS = 18; // ~180ms total
  const ease = (t: number) => 1 - Math.pow(1 - t, 3); // ease-out-cubic

  for (let i = 1; i <= STEPS; i++) {
    const t = ease(i / STEPS);
    const w = Math.round(startW + (targetW - startW) * t);
    const h = Math.round(startH + (targetH - startH) * t);
    const px = Math.round(start_X + (targetX - start_X) * t);
    const py = Math.round(start_Y + (targetY - start_Y) * t);
    await win.setSize(new LogicalSize(w, h));
    await win.setPosition(new LogicalPosition(px, py));
    if (i < STEPS) await new Promise((r) => setTimeout(r, STEP_MS));
  }
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
    // The user explicitly moved the overlay — stop defaulting to bottom-center.
    markUserDragged();
    clearTimeout(timer);
    timer = setTimeout(() => savePos(x, y), 250);
  });
  return unlisten;
}
