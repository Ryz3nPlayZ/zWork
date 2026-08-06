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

/** True while we're driving setSize/setPosition programmatically. The onMoved
 * listener checks this and skips markUserDragged() so our own geometry writes
 * don't get mistaken for a user drag (which would flip the overlay into
 * "preserve position" mode and make the + menu open move the pill). */
let programmaticMove = false;

/** How long programmaticMove stays true after a geometry write — long enough
 * to absorb the IPC round-trip of the onMoved event our setSize/setPosition
 * triggers, so the persistence listener reliably skips it. */
const PROGRAMMATIC_MOVE_HOLD_MS = 80;

/** Monotonically increasing token used to coalesce rapid fitOverlayWindow
 * calls. Each call captures the current value; if a newer call has started by
 * the time this one is ready to write geometry, this one bails. That stops
 * fast barHeight changes (typing, menu toggles) from stacking overlapping
 * writes that fought each other and made the overlay visibly jitter. */
let applyToken = 0;

/** The overlay's pinned edges (logical work-area coords): the X of the
 * window's left edge, and the Y of its bottom edge. Idle/chat height changes
 * keep these pinned and grow the window along the other axis only, so the
 * pill never shifts when the draft grows or the + menu opens. Updated on
 * genuine user drags; seeded on first placement. Modal mode doesn't touch
 * them, so closing a modal restores the pre-modal position. */
let pinnedX: number | null = null;
let pinnedBottom: number | null = null;

/** Mark that the user has dragged — called from the position-persistence
 * listener. Once true, fitOverlayWindow preserves the user's position. */
export function markUserDragged(): void {
  if (programmaticMove) return; // ignore geometry changes WE caused
  userDragged = true;
}

/** Reset the drag/pinned state — call when the overlay is hidden so the next
 * show defaults to bottom-center again (unless the user drags). */
export function resetOverlayPlacement(): void {
  userDragged = false;
  pinnedX = null;
  pinnedBottom = null;
}

/**
 * Size + position the overlay. Called on mount and whenever the mode or the
 * chatbar's content height changes.
 *
 * Modes:
 *  - "idle": the chatbar only. Grows upward with the draft / + menu, bottom
 *    edge pinned so the pill never shifts vertically.
 *  - "chat": the expanded conversation panel + chatbar, bottom pinned.
 *
 * (The Share Window picker is now its own OS window and never drives the
 * overlay's geometry — there is no "modal" mode anymore.)
 *
 * The bottom edge is tracked across height changes so opening the + menu,
 * typing a multi-line draft, or growing the panel never moves the pill. Only
 * a genuine user drag updates the pinned bottom.
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

  // Seed the pinned edges on first placement (or after a hide → reset). After
  // this, every height change keeps these edges and grows along the other
  // axis, so the pill never moves. We do NOT read live window geometry here:
  // post-modal it points at the work-area origin (meaningless), and reading
  // it was the source of "snap back" jitter when barHeight fired repeatedly.
  if (pinnedBottom === null) {
    const defaultY = wa.workY + wa.workH - height - BOTTOM_MARGIN;
    pinnedBottom = defaultY + height; // i.e. work-area bottom − margin
  }
  if (pinnedX === null) {
    if (!userDragged) {
      const saved = loadSavedPos();
      pinnedX =
        saved && fitsOnScreen(saved.x, saved.y, width, height, wa)
          ? saved.x
          : wa.workX + (wa.workW - width) / 2;
    } else {
      // User dragged this session but we have no pinned X yet — fall back to
      // horizontal center; the next genuine-drag onMoved will refresh it.
      pinnedX = wa.workX + (wa.workW - width) / 2;
    }
  }

  // Derive the window's top-left from the pinned edges. This is the crux of
  // the jitter fix: the target is a pure function of (pinnedX, pinnedBottom,
  // width, height) — independent of any live read — so rapid height changes
  // never read a half-written intermediate position and fight each other.
  let x = pinnedX;
  let y = pinnedBottom - height;

  // Clamp into the work area so the overlay never escapes the screen.
  x = clamp(x, wa.workX + EDGE_MARGIN, wa.workX + wa.workW - width - EDGE_MARGIN);
  if (y < wa.workY + EDGE_MARGIN) y = wa.workY + EDGE_MARGIN;
  if (y + height > wa.workY + wa.workH - EDGE_MARGIN) {
    y = wa.workY + wa.workH - height - EDGE_MARGIN;
  }

  // Coalesced snap. Each call bumps applyToken; before writing we re-check
  // it — if a newer call has started, this one bails (its target is stale).
  // This is what stops overlapping writes from fighting: only the newest
  // target's writes ever land. Snapping (no tween) means no intermediate
  // frames to jitter; the CSS opacity fade on the conversation panel covers
  // the instant size jump.
  const token = ++applyToken;
  programmaticMove = true;
  try {
    // If a newer call superseded us while we were waiting on the monitor
    // query above, drop this write entirely — its target is already stale.
    if (token !== applyToken) return;
    await win.setSize(new LogicalSize(width, height));
    if (token !== applyToken) return; // re-check after the first IPC
    await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
  } finally {
    setTimeout(() => { programmaticMove = false; }, PROGRAMMATIC_MOVE_HOLD_MS);
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
  const unlisten = await win.onMoved(async ({ payload }) => {
    if (programmaticMove) return; // ignore geometry changes WE caused
    // payload is a PhysicalPosition; convert to logical using devicePixelRatio.
    // (Exact precision isn't required — restore clamps into the work area.)
    const scale = window.devicePixelRatio || 1;
    const x = payload.x / scale;
    const y = payload.y / scale;
    // The user explicitly moved the overlay — stop defaulting to bottom-center.
    markUserDragged();
    // Refresh BOTH pinned edges from this drag so the next idle height change
    // keeps the pill at this X and this bottom. Reading the live size here is
    // safe: this listener only fires for user moves, which are always settled.
    const size = await win.outerSize().catch(() => null);
    const curH = size ? size.height / scale : 0;
    pinnedX = x;
    pinnedBottom = y + curH;
    clearTimeout(timer);
    timer = setTimeout(() => savePos(x, y), 250);
  });
  return unlisten;
}
