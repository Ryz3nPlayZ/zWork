/**
 * Window look: wallpaper, its effects (opacity, blur, fade, dithering), how
 * see-through the panels are, flat vs 3D surfaces, theme presets, saved
 * themes, and theme import/export. Modelled on Freebuff Desktop's appearance
 * settings.
 *
 * Stored:
 *   localStorage["zwork.look"]            = Look (JSON)
 *   localStorage["zwork.wallpaper.image"] = the user's picture, data:image/jpeg
 *   localStorage["zwork.look.saved"]      = SavedTheme[] (at most 3)
 *
 * Applied as a fixed `#app-wallpaper` layer behind the app, `<html>` classes
 * `has-wallpaper` / `surface-3d`, and the `--pane-alpha` / `--pane-blur`
 * variables (see index.css).
 */

import { useEffect, useState } from "react";
import {
  CUSTOM_SCHEME_ID,
  isHex,
  loadCustomColors,
  saveCustomColors,
  type ThemeColors,
} from "./themes/custom";
import { DEFAULT_SCHEME_ID } from "./themes";
import { loadSchemePref, loadThemePref, setSchemePref, setThemePref } from "./theme";

const LOOK_KEY = "zwork.look";
const IMAGE_KEY = "zwork.wallpaper.image";
const SAVED_KEY = "zwork.look.saved";
const CHANGE_EVENT = "zwork:look";
export const MAX_SAVED = 3;

// ---------------- model ----------------

export type FadeDir = "top" | "bottom" | "left" | "right";
export type DitherPattern = 2 | 4 | 8;

export interface Dither {
  on: boolean;
  pattern: DitherPattern;
  /** Size of one dither pixel, in screen points. */
  size: number;
  /** Color levels, 2–8. */
  steps: number;
  invert: boolean;
  /** Keep the picture's own colors instead of the three below. */
  original: boolean;
  back: string;
  front: string;
  highlight: string;
}

export interface Look {
  /** "none" | "image" | a WALLPAPER_PRESETS id */
  wallpaper: string;
  opacity: number; // 10–100 %
  blur: number; // 0–24 px
  fade: { on: boolean; dir: FadeDir; at: number /* 0–100 % */ };
  dither: Dither;
  pane: number; // 50–100 % panel opacity
  paneBlur: number; // 0–40 px
  surface: "flat" | "3d";
  /** The THEME_PRESETS entry this look came from; null once edited. */
  preset: string | null;
}

export const DEFAULT_LOOK: Look = {
  wallpaper: "none",
  opacity: 100,
  blur: 0,
  fade: { on: false, dir: "bottom", at: 40 },
  dither: {
    on: false,
    pattern: 4,
    size: 2,
    steps: 4,
    invert: false,
    original: true,
    back: "#14181c",
    front: "#4f7a6a",
    highlight: "#e4efe6",
  },
  pane: 85,
  paneBlur: 24,
  surface: "flat",
  preset: null,
};

export interface Gradient {
  id: string;
  label: string;
  angle: number;
  stops: [string, number][];
}

export const WALLPAPER_PRESETS: Gradient[] = [
  { id: "dawn", label: "Dawn", angle: 135, stops: [["#f6d5c3", 0], ["#e9b8c9", 45], ["#b9c3e8", 100]] },
  { id: "meadow", label: "Meadow", angle: 160, stops: [["#dfe9c8", 0], ["#a9cfb4", 50], ["#7fb3b0", 100]] },
  { id: "tide", label: "Tide", angle: 150, stops: [["#cfe3f2", 0], ["#8fb8d9", 55], ["#5b84b8", 100]] },
  { id: "dune", label: "Dune", angle: 140, stops: [["#f3e3c3", 0], ["#ddb98c", 55], ["#b98a63", 100]] },
  { id: "dusk", label: "Dusk", angle: 160, stops: [["#3a3550", 0], ["#6b4e71", 50], ["#c07a6a", 100]] },
  { id: "night", label: "Night", angle: 160, stops: [["#10141f", 0], ["#1d2a44", 55], ["#2e3f5c", 100]] },
  { id: "aurora", label: "Aurora", angle: 200, stops: [["#0e1a1c", 0], ["#1f5a52", 45], ["#5b3f7a", 100]] },
  { id: "ember", label: "Ember", angle: 170, stops: [["#1a0f0d", 0], ["#5a2416", 55], ["#c2582c", 100]] },
];

export const gradientCss = (g: Gradient) =>
  `linear-gradient(${g.angle}deg, ${g.stops.map(([c, p]) => `${c} ${p}%`).join(", ")})`;

// ---------------- theme presets ----------------

export interface ThemePreset {
  id: string;
  label: string;
  colors: ThemeColors;
  look: Partial<Omit<Look, "preset">>;
}

const dither = (d: Partial<Dither>): Dither => ({ ...DEFAULT_LOOK.dither, on: true, ...d });

export const THEME_PRESETS: ThemePreset[] = [
  { id: "paper", label: "Paper", colors: { accent: "#3f3f46", surface: "#f8f6f1", text: "#1f1f1f" }, look: {} },
  { id: "dune", label: "Dune", colors: { accent: "#b8733f", surface: "#f4ecdc", text: "#3b2f22" }, look: { wallpaper: "dune", pane: 82 } },
  { id: "tide", label: "Tide", colors: { accent: "#2f74b5", surface: "#eef3f8", text: "#1c2a38" }, look: { wallpaper: "tide", pane: 82 } },
  { id: "meadow", label: "Meadow", colors: { accent: "#4c8a4a", surface: "#f0f4ea", text: "#24311f" }, look: { wallpaper: "meadow", pane: 82 } },
  { id: "blossom", label: "Blossom", colors: { accent: "#c0567c", surface: "#f8eff2", text: "#3a2830" }, look: { wallpaper: "dawn", pane: 80 } },
  { id: "frost", label: "Frost", colors: { accent: "#3d88b8", surface: "#f2f6fa", text: "#1d2939" }, look: { wallpaper: "tide", pane: 78, blur: 12, surface: "3d" } },
  { id: "graphite", label: "Graphite", colors: { accent: "#a1a8b3", surface: "#1c1d20", text: "#e7e7e9" }, look: {} },
  { id: "night", label: "Night", colors: { accent: "#7aa2f7", surface: "#141823", text: "#dfe6f2" }, look: { wallpaper: "night", pane: 84 } },
  { id: "violet", label: "Violet hour", colors: { accent: "#a98bf0", surface: "#1d1828", text: "#ece4fa" }, look: { wallpaper: "dusk", pane: 82, surface: "3d" } },
  { id: "ember", label: "Ember", colors: { accent: "#e47a3c", surface: "#1c1412", text: "#f2e3d7" }, look: { wallpaper: "ember", pane: 84, fade: { on: true, dir: "top", at: 30 } } },
  { id: "aurora", label: "Aurora", colors: { accent: "#5fd0b0", surface: "#111a1b", text: "#dcefea" }, look: { wallpaper: "aurora", pane: 80, surface: "3d" } },
  {
    id: "phosphor",
    label: "Phosphor",
    colors: { accent: "#46e07a", surface: "#0c120d", text: "#c4f2cc" },
    look: { wallpaper: "aurora", pane: 86, dither: dither({ original: false, back: "#0c120d", front: "#1f6b35", highlight: "#7cf29b", size: 3, steps: 3 }) },
  },
  {
    id: "riso",
    label: "Riso",
    colors: { accent: "#e5533d", surface: "#f6efe3", text: "#2a2320" },
    look: { wallpaper: "dawn", pane: 84, dither: dither({ original: false, back: "#f6efe3", front: "#e5533d", highlight: "#2b4fa0", size: 2, steps: 3 }) },
  },
];

// ---------------- load / save ----------------

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const hex = (v: unknown, d: string) => (isHex(v) ? v : d);

/** Every field checked and clamped: this also parses imported theme files. */
export function sanitizeLook(raw: unknown): Look {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const d = DEFAULT_LOOK;
  const f = r.fade ?? {};
  const t = r.dither ?? {};
  const wallpaper =
    r.wallpaper === "image" || WALLPAPER_PRESETS.some((p) => p.id === r.wallpaper) ? r.wallpaper : "none";
  return {
    wallpaper,
    opacity: clamp(r.opacity, 10, 100, d.opacity),
    blur: clamp(r.blur, 0, 24, d.blur),
    fade: {
      on: bool(f.on, d.fade.on),
      dir: ["top", "bottom", "left", "right"].includes(f.dir) ? f.dir : d.fade.dir,
      at: clamp(f.at, 0, 100, d.fade.at),
    },
    dither: {
      on: bool(t.on, d.dither.on),
      pattern: [2, 4, 8].includes(t.pattern) ? t.pattern : d.dither.pattern,
      size: clamp(t.size, 1, 8, d.dither.size),
      steps: clamp(t.steps, 2, 8, d.dither.steps),
      invert: bool(t.invert, d.dither.invert),
      original: bool(t.original, d.dither.original),
      back: hex(t.back, d.dither.back),
      front: hex(t.front, d.dither.front),
      highlight: hex(t.highlight, d.dither.highlight),
    },
    pane: clamp(r.pane, 50, 100, d.pane),
    paneBlur: clamp(r.paneBlur, 0, 40, d.paneBlur),
    surface: r.surface === "3d" ? "3d" : "flat",
    preset: typeof r.preset === "string" ? r.preset : null,
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadLook(): Look {
  try {
    const look = sanitizeLook(JSON.parse(read(LOOK_KEY) ?? "{}"));
    if (look.wallpaper === "image" && !read(IMAGE_KEY)) look.wallpaper = "none";
    return look;
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

export const loadImage = () => read(IMAGE_KEY);

export type LookPatch = Partial<Omit<Look, "fade" | "dither">> & {
  fade?: Partial<Look["fade"]>;
  dither?: Partial<Dither>;
};

function changed() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Merge, save and apply. Any edit that doesn't name a preset drops the
 * "from preset" mark, so the gallery stops highlighting it.
 * Throws if the browser refuses to store it (quota).
 */
export function saveLook(patch: LookPatch, image?: string | null): Look {
  const cur = loadLook();
  const next = sanitizeLook({
    ...cur,
    ...patch,
    fade: { ...cur.fade, ...patch.fade },
    dither: { ...cur.dither, ...patch.dither },
    preset: "preset" in patch ? patch.preset : null,
  });
  if (image !== undefined) {
    if (image) localStorage.setItem(IMAGE_KEY, image);
    else localStorage.removeItem(IMAGE_KEY);
  }
  localStorage.setItem(LOOK_KEY, JSON.stringify(next));
  applyWallpaper(next);
  changed();
  return next;
}

/** Custom colors: switch to the three-color scheme and repaint. */
export function setThemeColors(colors: ThemeColors): void {
  saveCustomColors(colors);
  setSchemePref(CUSTOM_SCHEME_ID);
  const cur = loadLook();
  if (cur.preset) saveLook({ preset: null });
  else changed();
}

export function applyPreset(p: ThemePreset): void {
  saveCustomColors(p.colors);
  setSchemePref(CUSTOM_SCHEME_ID);
  saveLook({ ...DEFAULT_LOOK, ...p.look, preset: p.id });
}

/** System / Light / Dark: the zWork palette in that mode. Keeps the wallpaper. */
export function applyMode(mode: "system" | "light" | "dark"): void {
  setSchemePref(DEFAULT_SCHEME_ID);
  setThemePref(mode);
  saveLook({ preset: null });
}

// ---------------- saved themes, import / export ----------------

export interface SavedTheme {
  name: string;
  colors: ThemeColors | null;
  look: Look;
  image?: string;
}

export function loadSaved(): SavedTheme[] {
  try {
    const list = JSON.parse(read(SAVED_KEY) ?? "[]");
    return Array.isArray(list) ? list.map(parseTheme).filter((t): t is SavedTheme => !!t).slice(0, MAX_SAVED) : [];
  } catch {
    return [];
  }
}

function writeSaved(list: SavedTheme[]) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  changed();
}

/** The current look as a theme. Parchment-family schemes other than custom export as null colors. */
export function currentTheme(name: string): SavedTheme {
  const look = loadLook();
  const image = look.wallpaper === "image" ? loadImage() ?? undefined : undefined;
  return {
    name: name.trim().slice(0, 40) || "My theme",
    colors: loadSchemePref() === CUSTOM_SCHEME_ID ? loadCustomColors() : null,
    look: { ...look, preset: null },
    ...(image ? { image } : {}),
  };
}

/** Throws a plain-words error when full or out of room. */
export function saveCurrentTheme(name: string): void {
  const list = loadSaved();
  if (list.length >= MAX_SAVED) throw new Error(`You can keep ${MAX_SAVED} themes. Remove one to save another.`);
  try {
    writeSaved([...list, currentTheme(name)]);
  } catch {
    throw new Error("There isn't room to save this theme with its picture. Remove a saved theme or use a smaller picture.");
  }
}

export function removeSaved(index: number): void {
  writeSaved(loadSaved().filter((_, i) => i !== index));
}

export function applyTheme(t: SavedTheme): void {
  if (t.colors) {
    saveCustomColors(t.colors);
    setSchemePref(CUSTOM_SCHEME_ID);
  } else {
    setSchemePref(DEFAULT_SCHEME_ID);
  }
  saveLook({ ...t.look, preset: null }, t.image);
}

/** Validate a theme from a file, the clipboard, or storage. Untrusted: every field is checked. */
export function parseTheme(raw: unknown): SavedTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const c = r.colors;
  const colors =
    c && isHex(c.accent) && isHex(c.surface) && isHex(c.text) ? { accent: c.accent, surface: c.surface, text: c.text } : null;
  const image =
    typeof r.image === "string" && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(r.image) && r.image.length <= 3_000_000
      ? r.image
      : undefined;
  const look = sanitizeLook(r.look);
  if (look.wallpaper === "image" && !image) look.wallpaper = "none";
  return { name: typeof r.name === "string" ? r.name.slice(0, 40) : "Imported theme", colors, look, ...(image ? { image } : {}) };
}

export function exportTheme(name = "My theme"): string {
  return JSON.stringify({ zwork: "theme", v: 1, ...currentTheme(name) });
}

/** Throws a plain-words error if the text isn't a zWork theme. */
export function importTheme(text: string): SavedTheme {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That isn't a zWork theme.");
  }
  if ((raw as any)?.zwork !== "theme") throw new Error("That isn't a zWork theme.");
  const theme = parseTheme(raw)!;
  try {
    applyTheme(theme);
  } catch {
    throw new Error("zWork couldn't store that theme's picture. Try a theme without one.");
  }
  return theme;
}

// ---------------- rendering ----------------

const LAYER_ID = "app-wallpaper";

function layer(): { img: HTMLDivElement; fade: HTMLDivElement } {
  let el = document.getElementById(LAYER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = LAYER_ID;
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = '<div class="wp-img"></div><div class="wp-fade"></div>';
    document.body.prepend(el);
  }
  return { img: el.firstElementChild as HTMLDivElement, fade: el.lastElementChild as HTMLDivElement };
}

let renderToken = 0;
let resizeTimer: number | undefined;
let resizeHooked = false;

export function applyWallpaper(look: Look = loadLook()): void {
  const root = document.documentElement;
  // The floating overlay window has no sidebar or pane to sit behind.
  if (root.classList.contains("overlay-window")) return;
  root.classList.toggle("surface-3d", look.surface === "3d");

  const gradient = WALLPAPER_PRESETS.find((p) => p.id === look.wallpaper);
  const image = look.wallpaper === "image" ? loadImage() : null;
  const on = !!(gradient || image);
  root.classList.toggle("has-wallpaper", on);
  root.style.setProperty("--pane-alpha", String(look.pane / 100));
  root.style.setProperty("--pane-blur", `${look.paneBlur}px`);
  if (!on) {
    document.getElementById(LAYER_ID)?.remove();
    return;
  }

  const { img, fade } = layer();
  img.style.opacity = String(look.opacity / 100);
  img.style.filter = look.blur ? `blur(${look.blur}px)` : "";
  // Blur pulls transparent edges in; overscan hides them.
  img.style.inset = look.blur ? `-${look.blur * 2}px` : "0";
  fade.style.background = look.fade.on
    ? `linear-gradient(to ${look.fade.dir}, rgb(var(--paper) / 0) ${look.fade.at}%, rgb(var(--paper)) 100%)`
    : "";

  const token = ++renderToken;
  if (!look.dither.on) {
    img.classList.remove("dithered");
    img.style.backgroundImage = image ? `url("${image}")` : gradientCss(gradient!);
    return;
  }
  img.classList.add("dithered");
  if (!resizeHooked) {
    resizeHooked = true;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (loadLook().dither.on) applyWallpaper();
      }, 250);
    });
  }
  void renderDither(look, gradient, image).then((url) => {
    if (token === renderToken && url) img.style.backgroundImage = `url("${url}")`;
  });
}

/** Bayer threshold matrix of size n (power of two), values in [0, 1). */
export function bayer(n: number): number[][] {
  let m = [[0]];
  while (m.length < n) {
    const s = m.length;
    const next: number[][] = Array.from({ length: s * 2 }, () => Array(s * 2).fill(0));
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const v = m[y]![x]! * 4;
        next[y]![x] = v;
        next[y]![x + s] = v + 2;
        next[y + s]![x] = v + 3;
        next[y + s]![x + s] = v + 1;
      }
    m = next;
  }
  return m.map((row) => row.map((v) => (v + 0.5) / (n * n)));
}

const rgbOf = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Ordered (Bayer) dithering of `data` in place. */
export function ditherPixels(data: Uint8ClampedArray, width: number, d: Dither): void {
  const m = bayer(d.pattern);
  const levels = d.steps - 1;
  const [b, f, h] = [rgbOf(d.back), rgbOf(d.front), rgbOf(d.highlight)];
  const ramp = Array.from({ length: d.steps }, (_, k) => {
    const t = k / levels;
    const [from, to, u] = t < 0.5 ? [b, f, t * 2] : [f, h, (t - 0.5) * 2];
    return from.map((c, i) => c + (to[i]! - c) * u);
  });
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4;
    const th = m[Math.floor(p / width) % d.pattern]![(p % width) % d.pattern]!;
    if (d.original) {
      for (let c = 0; c < 3; c++) {
        const v = d.invert ? 255 - data[i + c]! : data[i + c]!;
        data[i + c] = (Math.min(levels, Math.floor((v / 255) * levels + th)) / levels) * 255;
      }
    } else {
      let l = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
      if (d.invert) l = 1 - l;
      const c = ramp[Math.min(levels, Math.floor(l * levels + th))]!;
      data[i] = c[0]!;
      data[i + 1] = c[1]!;
      data[i + 2] = c[2]!;
    }
    data[i + 3] = 255;
  }
}

async function renderDither(look: Look, gradient: Gradient | undefined, image: string | null): Promise<string | null> {
  const w = Math.max(1, Math.ceil(window.innerWidth / look.dither.size));
  const h = Math.max(1, Math.ceil(window.innerHeight / look.dither.size));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  if (image) {
    const el = new Image();
    el.src = image;
    try {
      await el.decode();
    } catch {
      return null;
    }
    const s = Math.max(w / el.width, h / el.height); // cover
    ctx.drawImage(el, (w - el.width * s) / 2, (h - el.height * s) / 2, el.width * s, el.height * s);
  } else if (gradient) {
    const a = (gradient.angle * Math.PI) / 180;
    const [dx, dy] = [Math.sin(a), -Math.cos(a)];
    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    const g = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
    for (const [c, p] of gradient.stops) g.addColorStop(p / 100, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const px = ctx.getImageData(0, 0, w, h);
  ditherPixels(px.data, w, look.dither);
  ctx.putImageData(px, 0, 0);
  return canvas.toDataURL("image/png");
}

// ---------------- picture upload ----------------

const MAX_EDGE = 2560;
// Keeps one picture well inside WebKit's ~5MB localStorage quota.
const MAX_CHARS = 3_000_000;

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

// ---------------- React ----------------

/** The current look, saved themes and picture; re-read whenever any of them changes. */
export function useLook() {
  const snap = () => ({ look: loadLook(), image: loadImage(), saved: loadSaved(), scheme: loadSchemePref(), mode: loadThemePref(), colors: loadCustomColors() });
  const [state, setState] = useState(snap);
  useEffect(() => {
    const onChange = () => setState(snap());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  return state;
}

export const notifyLookChanged = changed;
