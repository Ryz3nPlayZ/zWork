// The voice glow's colours, from the Look's `glow` setting and the theme's accent.
import type { VoiceBeamColorVariant } from "voice-glow";
import type { GlowStyle } from "./wallpaper";

type Rgb = [number, number, number];

function hsl([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

const css = (h: number, s: number, l: number) =>
  `hsl(${Math.round((h + 360) % 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

/** Seven lobes around the accent (centre, then pairs outward), varying a little in hue so it isn't flat. */
export function accentLobes(accent: Rgb): string[] {
  const [h, s0] = hsl(accent);
  const s = Math.max(0.6, s0);
  return [css(h, s, 0.62), css(h - 8, s, 0.58), css(h + 8, s, 0.66), css(h - 16, s, 0.55), css(h + 16, s, 0.7), css(h - 22, s, 0.6), css(h + 22, s, 0.72)];
}

/** voice-glow drifts every palette's hue by up to 40°, which turns Ocean's violet and a blue accent pink.
 *  Only the rainbow is meant to wander; a chosen palette barely moves. */
const STEADY = 6;

/** Props for VoiceBeam. "auto" reads the live --accent: a grey accent (the default zWork palette) gets the rainbow. */
export function glowProps(style: GlowStyle): { colorVariant: VoiceBeamColorVariant; colors?: string[]; hueRange?: number } {
  if (style === "rainbow") return { colorVariant: "colorful" };
  if (style !== "auto" && style !== "accent") return { colorVariant: style, hueRange: STEADY };
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().split(/\s+/).map(Number) as Rgb;
  if (accent.length !== 3 || accent.some(Number.isNaN)) return { colorVariant: "colorful" };
  if (style === "auto" && hsl(accent)[1] < 0.25) return { colorVariant: "colorful" };
  return { colorVariant: "colorful", colors: accentLobes(accent), hueRange: STEADY };
}
