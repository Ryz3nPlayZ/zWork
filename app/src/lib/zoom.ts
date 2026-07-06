/**
 * App zoom — selection-safe across Tauri (macOS/Win/Linux) and web.
 *
 * WHY THIS EXISTS:
 * Previously zoom was implemented as `body { zoom: var(--zoom-level) }` in
 * index.css. CSS `zoom` is non-standard and breaks selection-rectangle
 * hit-testing in WebKit: the paint coordinates and the selection coordinates
 * diverge after a zoom transform, so highlighting lands on weird chunk
 * boundaries. (Visually: dragging to select text would jump and snap to
 * unexpected regions — the "weird sectioning" symptom.)
 *
 * THE FIX:
 * On Tauri we use the native `getCurrentWebview().setZoom()` IPC, which scales
 * the webview at the compositor level — paint and hit-testing stay aligned.
 * In a browser (dev/preview) there is no webview zoom API, so we fall back to
 * `transform: scale()` on #root, which is also selection-safe (transforms do
 * not desync hit-testing the way `zoom` does in WebKit).
 *
 * The preference is persisted as `localStorage["zwork.zoom"]` (a float). The
 * CSS variable `--zoom-level` is kept in sync for any consumers that read it
 * (e.g. sizing webview-external overlays), but it is no longer the mechanism
 * that scales the page.
 */

import { IS_TAURI } from "./platform";

const STORAGE_KEY = "zwork.zoom";
const MIN = 0.5;
const MAX = 1.5;

export function loadZoom(): number {
  try {
    const v = parseFloat(localStorage.getItem(STORAGE_KEY) || "1");
    if (Number.isFinite(v) && v >= MIN && v <= MAX) return v;
  } catch {}
  return 1;
}

function clamp(v: number): number {
  return Math.max(MIN, Math.min(MAX, Math.round(v * 10) / 10));
}

/**
 * Apply a zoom level to the app. Safe to call at boot and on every change.
 * No-op outside the supported range. Returns the clamped value actually
 * applied (so callers can persist it).
 */
export async function applyZoom(level: number): Promise<number> {
  const v = clamp(level);
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {}

  // Keep the CSS var in sync for any external consumers, but it no longer
  // drives a CSS `zoom` transform.
  document.documentElement.style.setProperty("--zoom-level", String(v));

  if (IS_TAURI) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(v);
      return v;
    } catch (err) {
      // Permission missing or webview API unavailable — fall through to the
      // CSS transform so zoom still works in some form. Log for diagnosis.
      console.warn("[zoom] native setZoom failed, using CSS fallback:", err);
    }
  }

  // Browser / fallback: transform the root. transform-origin must be top-left
  // so the layout pins to the window corner instead of centering.
  document.documentElement.style.setProperty("--zoom-scale", String(v));
  return v;
}

/** Bump zoom up by one step. Returns the new level. */
export async function zoomIn(): Promise<number> {
  return applyZoom(loadZoom() + 0.1);
}

/** Bump zoom down by one step. Returns the new level. */
export async function zoomOut(): Promise<number> {
  return applyZoom(loadZoom() - 0.1);
}

/** Reset to 100%. */
export async function zoomReset(): Promise<number> {
  return applyZoom(1);
}
