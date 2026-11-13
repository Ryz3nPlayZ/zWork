/**
 * Window background (wallpaper) controller.
 *
 * A preset gradient or the user's own picture fills the window behind the
 * sidebar and the main pane; the pane goes slightly see-through over it.
 * Pattern from Freebuff Desktop: the picture is re-encoded through a canvas
 * before it is stored, so what we keep is a bounded, static raster (no EXIF,
 * no animation, no multi-megabyte originals).
 *
 * Stored:
 *   localStorage["zwork.wallpaper"]       = "none" | "image" | preset id
 *   localStorage["zwork.wallpaper.image"] = data:image/jpeg;base64,…
 *   localStorage["zwork.wallpaper.pane"]  = pane opacity, 70–100
 *
 * Applied as `<html>.has-wallpaper` plus the `--wallpaper` and `--pane-alpha`
 * CSS variables (see index.css).
 */

import { useEffect, useState } from "react";

const KEY = "zwork.wallpaper";
const IMAGE_KEY = "zwork.wallpaper.image";
const PANE_KEY = "zwork.wallpaper.pane";
const HTML_CLASS = "has-wallpaper";
const CHANGE_EVENT = "zwork:wallpaper";

export const WALLPAPER_PRESETS: { id: string; label: string; css: string }[] = [
  { id: "dawn", label: "Dawn", css: "linear-gradient(135deg, #f6d5c3 0%, #e9b8c9 45%, #b9c3e8 100%)" },
  { id: "meadow", label: "Meadow", css: "linear-gradient(160deg, #dfe9c8 0%, #a9cfb4 50%, #7fb3b0 100%)" },
  { id: "tide", label: "Tide", css: "linear-gradient(150deg, #cfe3f2 0%, #8fb8d9 55%, #5b84b8 100%)" },
  { id: "dune", label: "Dune", css: "linear-gradient(140deg, #f3e3c3 0%, #ddb98c 55%, #b98a63 100%)" },
  { id: "dusk", label: "Dusk", css: "linear-gradient(160deg, #3a3550 0%, #6b4e71 50%, #c07a6a 100%)" },
  { id: "night", label: "Night", css: "linear-gradient(160deg, #10141f 0%, #1d2a44 55%, #2e3f5c 100%)" },
];

export type WallpaperChoice = "none" | "image" | string;

export interface WallpaperState {
  choice: WallpaperChoice;
  image: string | null;
  pane: number;
}

const MAX_EDGE = 2560;
// Keeps one picture well inside WebKit's ~5MB localStorage quota.
const MAX_CHARS = 3_000_000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadWallpaper(): WallpaperState {
  const image = read(IMAGE_KEY);
  const raw = read(KEY) ?? "none";
  const choice =
    raw === "image" ? (image ? "image" : "none")
    : WALLPAPER_PRESETS.some((p) => p.id === raw) ? raw
    : "none";
  const pane = Number(read(PANE_KEY));
  return { choice, image, pane: pane >= 70 && pane <= 100 ? pane : 85 };
}

export function applyWallpaper(state: WallpaperState = loadWallpaper()): void {
  const root = document.documentElement;
  // The floating overlay window has no sidebar or pane to sit behind.
  if (root.classList.contains("overlay-window")) return;
  const css =
    state.choice === "image" && state.image
      ? `url("${state.image}")`
      : WALLPAPER_PRESETS.find((p) => p.id === state.choice)?.css;
  if (css) {
    root.style.setProperty("--wallpaper", css);
    root.style.setProperty("--pane-alpha", String(state.pane / 100));
    root.classList.add(HTML_CLASS);
  } else {
    root.style.removeProperty("--wallpaper");
    root.style.removeProperty("--pane-alpha");
    root.classList.remove(HTML_CLASS);
  }
}

/** Save and apply. Throws if the browser refuses to store it (quota). */
export function saveWallpaper(patch: Partial<WallpaperState>): WallpaperState {
  const next = { ...loadWallpaper(), ...patch };
  if (patch.image !== undefined) {
    if (patch.image) localStorage.setItem(IMAGE_KEY, patch.image);
    else localStorage.removeItem(IMAGE_KEY);
  }
  localStorage.setItem(KEY, next.choice);
  localStorage.setItem(PANE_KEY, String(next.pane));
  applyWallpaper(next);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

/**
 * Turn a picked file into a bounded JPEG data URL. Decoding through
 * createImageBitmap is also the validation: anything that isn't a picture
 * the webview can draw is rejected here. JPEG, not WebP, because Safari's
 * canvas can't encode WebP and would silently fall back to a huge PNG.
 */
export async function encodeWallpaper(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("That file isn't a picture.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("zWork couldn't open that picture. Try a JPEG or PNG.");
  }
  try {
    for (const [edge, quality] of [[MAX_EDGE, 0.85], [1600, 0.8]] as const) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.startsWith("data:image/jpeg") && url.length <= MAX_CHARS) return url;
    }
  } finally {
    bitmap.close();
  }
  throw new Error("That picture is too large to use as a background.");
}

/** React hook: the current wallpaper, re-read whenever it is saved anywhere. */
export function useWallpaper(): WallpaperState {
  const [state, setState] = useState(loadWallpaper);
  useEffect(() => {
    const onChange = () => setState(loadWallpaper());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  return state;
}
