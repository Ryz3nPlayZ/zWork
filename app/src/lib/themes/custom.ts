/**
 * A theme built from three colors (accent, surface, text), the way Freebuff
 * Desktop's custom themes work. Every other token is mixed from these, so a
 * user only ever picks three colors and the whole app stays consistent.
 *
 * Stored as localStorage["zwork.scheme.custom"] = {"accent","surface","text"}
 * (hex). Selected like any other scheme, with id "custom".
 */

import type { ColorScheme, TokenSet } from "./presets";

export interface ThemeColors {
  accent: string;
  surface: string;
  text: string;
}

export const CUSTOM_SCHEME_ID = "custom";
const KEY = "zwork.scheme.custom";
export const DEFAULT_CUSTOM_COLORS: ThemeColors = { accent: "#c9825b", surface: "#f2f0e8", text: "#302e28" };

type Rgb = [number, number, number];

export function isHex(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

/** t = 0 → a, t = 1 → b. Negative t pushes away from b. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return a.map((c, i) => Math.max(0, Math.min(255, c + (b[i]! - c) * t))) as Rgb;
}

const triplet = (c: Rgb) => c.map(Math.round).join(" ");

/** WCAG relative luminance, 0–1. */
export function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function isDarkSurface(colors: ThemeColors): boolean {
  return luminance(hexToRgb(colors.surface)) < 0.18;
}

/** Body text never drops below WCAG AA (4.5:1) against the surface, whatever was picked. */
export function readableText(surface: Rgb, text: Rgb): Rgb {
  const toward: Rgb = luminance(surface) < 0.18 ? [255, 255, 255] : [0, 0, 0];
  let t = text;
  for (let i = 0; i < 20 && contrast(surface, t) < 4.5; i++) t = mix(t, toward, 0.15);
  return t;
}

// Status colors aren't part of a three-color theme; borrow Parchment's.
const STATUS = {
  light: {
    success: "46 125 80", successFg: "255 255 255",
    warning: "176 112 20", warningFg: "255 255 255",
    error: "190 60 50", errorFg: "255 255 255",
    info: "50 100 170", infoFg: "255 255 255",
  },
  dark: {
    success: "110 190 140", successFg: "20 30 24",
    warning: "222 170 90", warningFg: "30 24 14",
    error: "235 120 110", errorFg: "34 18 16",
    info: "120 165 230", infoFg: "16 22 34",
  },
};

export function tokensFromColors(colors: ThemeColors): TokenSet {
  const s = hexToRgb(colors.surface);
  const dark = isDarkSurface(colors);
  const t = readableText(s, hexToRgb(colors.text));
  return {
    paper: triplet(s),
    paperSoft: triplet(mix(s, t, 0.025)),
    paperRaised: triplet(mix(s, t, 0.05)),
    paperSunken: triplet(mix(s, t, -0.03)),
    paperSidebar: triplet(mix(s, t, 0.035)),
    ink: triplet(t),
    inkSoft: triplet(mix(t, s, 0.18)),
    inkMuted: triplet(mix(t, s, 0.38)),
    inkFaint: triplet(mix(t, s, 0.55)),
    line: triplet(mix(s, t, 0.12)),
    lineSoft: triplet(mix(s, t, 0.08)),
    lineStrong: triplet(mix(s, t, 0.2)),
    accent: triplet(hexToRgb(colors.accent)),
    shadow: dark ? "0 0 0" : triplet(mix(t, [0, 0, 0], 0.4)),
    ...STATUS[dark ? "dark" : "light"],
  };
}

export function loadCustomColors(): ThemeColors {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && isHex(v.accent) && isHex(v.surface) && isHex(v.text)) {
      return { accent: v.accent, surface: v.surface, text: v.text };
    }
  } catch {}
  return DEFAULT_CUSTOM_COLORS;
}

export function saveCustomColors(colors: ThemeColors): void {
  localStorage.setItem(KEY, JSON.stringify(colors));
}

/** The custom theme as a single-mode scheme: its surface decides light or dark. */
export function customScheme(): ColorScheme {
  const colors = loadCustomColors();
  const tokens = tokensFromColors(colors);
  return {
    id: CUSTOM_SCHEME_ID,
    label: "Custom",
    variants: isDarkSurface(colors) ? { dark: tokens } : { light: tokens },
  };
}
