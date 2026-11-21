/**
 * Geometry for the desktop companion (the "overlay" Tauri window).
 *
 * The window is always the tight bounding box of what's showing: the pet on
 * its own, or the pet plus a card (chat or a finished-task note). The pet's
 * screen position is the anchor the user drags and we persist; cards are
 * placed around it and clamped to the monitor's work area so they're never
 * cut off at a screen edge.
 */
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";

export const PET_W = 136;
export const PET_H = 124;
/** Room for the card's shadow inside the transparent window. */
const SHADOW = 14;
/** Gap between a card and the screen edge. */
const INSET = 8;
/** Space between the pet and its card. */
const GAP = 6;
const POS_KEY = "zwork.companion.pos.v1";

export type Pt = { x: number; y: number };
export type Rect = Pt & { w: number; h: number };

/** Logical work area (screen minus menu bar / dock / taskbar) of the window's monitor. */
export async function workArea(): Promise<Rect> {
  const m = await currentMonitor().catch(() => null);
  if (!m) return { x: 0, y: 0, w: window.screen.availWidth, h: window.screen.availHeight };
  const s = m.scaleFactor || 1;
  const a = m.workArea ?? { position: m.position, size: m.size };
  return { x: a.position.x / s, y: a.position.y / s, w: a.size.width / s, h: a.size.height / s };
}

export function loadPetPos(): Pt | null {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  } catch {
    return null;
  }
}

export function savePetPos(p: Pt) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) }));
  } catch {
    /* private mode: position just isn't remembered */
  }
}

/** Keep the pet fully on screen; default to the bottom-right corner. */
export function clampPet(p: Pt | null, area: Rect): Pt {
  const fallback = { x: area.x + area.w - PET_W - 24, y: area.y + area.h - PET_H - 24 };
  const q = p ?? fallback;
  return {
    x: Math.min(Math.max(q.x, area.x), area.x + area.w - PET_W),
    y: Math.min(Math.max(q.y, area.y), area.y + area.h - PET_H),
  };
}

export type Layout = {
  /** Window rect in screen (logical) coordinates. */
  win: Rect;
  /** Pet and card offsets inside the window. */
  pet: Pt;
  card: Rect | null;
  /** True when the card sits below the pet (no room above). */
  below: boolean;
};

/**
 * Lay out the pet plus an optional card of `size`. The card is centred over
 * the pet, flipped below it when there's no room above, and slid sideways to
 * stay inside the work area.
 */
export function layout(pet: Pt, size: { w: number; h: number } | null, area: Rect): Layout {
  if (!size) return { win: { ...pet, w: PET_W, h: PET_H }, pet: { x: 0, y: 0 }, card: null, below: false };
  const w = Math.min(size.w, area.w - INSET * 2);
  const h = Math.min(size.h, area.h - PET_H - INSET * 2);
  const minX = area.x + INSET;
  const maxX = area.x + area.w - INSET - w;
  const cx = Math.min(Math.max(pet.x + PET_W / 2 - w / 2, minX), maxX);
  const above = pet.y - h - GAP;
  const below = above < area.y + INSET;
  const cy = below ? Math.min(pet.y + PET_H + GAP, area.y + area.h - INSET - h) : above;

  const left = Math.min(cx, pet.x) - SHADOW;
  const top = Math.min(cy, pet.y) - SHADOW;
  const right = Math.max(cx + w, pet.x + PET_W) + SHADOW;
  const bottom = Math.max(cy + h, pet.y + PET_H) + SHADOW;
  return {
    win: { x: left, y: top, w: right - left, h: bottom - top },
    pet: { x: pet.x - left, y: pet.y - top },
    card: { x: cx - left, y: cy - top, w, h },
    below,
  };
}

export async function applyWindow(r: Rect) {
  const win = getCurrentWindow();
  await Promise.all([
    win.setPosition(new LogicalPosition(Math.round(r.x), Math.round(r.y))),
    win.setSize(new LogicalSize(Math.round(r.w), Math.round(r.h))),
  ]);
}
