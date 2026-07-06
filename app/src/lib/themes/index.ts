/**
 * Theme scheme helpers. A scheme is a named palette family (Parchment,
 * Catppuccin, Dracula, …). Each scheme has one or two variants (light/dark);
 * the variant chosen depends on the resolved appearance mode (light/dark/
 * system).
 */

import {
  COLOR_SCHEMES,
  type ColorScheme,
  type TokenSet,
} from "./presets";

export type { ColorScheme, TokenSet } from "./presets";
export { COLOR_SCHEMES, DEFAULT_SCHEME_ID } from "./presets";

const TOKEN_CSS_VARS: Array<{ token: keyof TokenSet; var: string }> = [
  { token: "paper", var: "--paper" },
  { token: "paperSoft", var: "--paper-soft" },
  { token: "paperRaised", var: "--paper-raised" },
  { token: "paperSunken", var: "--paper-sunken" },
  { token: "paperSidebar", var: "--paper-sidebar" },
  { token: "ink", var: "--ink" },
  { token: "inkSoft", var: "--ink-soft" },
  { token: "inkMuted", var: "--ink-muted" },
  { token: "inkFaint", var: "--ink-faint" },
  { token: "line", var: "--line" },
  { token: "lineSoft", var: "--line-soft" },
  { token: "lineStrong", var: "--line-strong" },
  { token: "accent", var: "--accent" },
  { token: "shadow", var: "--shadow" },
  { token: "success", var: "--success" },
  { token: "successFg", var: "--success-fg" },
  { token: "warning", var: "--warning" },
  { token: "warningFg", var: "--warning-fg" },
  { token: "error", var: "--error" },
  { token: "errorFg", var: "--error-fg" },
  { token: "info", var: "--info" },
  { token: "infoFg", var: "--info-fg" },
];

export function getScheme(id: string): ColorScheme {
  return COLOR_SCHEMES.find((s) => s.id === id) ?? COLOR_SCHEMES[0]!;
}

/** Which appearance modes this scheme supports. */
export function schemeModes(scheme: ColorScheme): Array<"light" | "dark"> {
  const modes: Array<"light" | "dark"> = [];
  if (scheme.variants.light) modes.push("light");
  if (scheme.variants.dark) modes.push("dark");
  return modes;
}

function schemeSupportsMode(
  scheme: ColorScheme,
  mode: "light" | "dark",
): boolean {
  return scheme.variants[mode] !== undefined;
}

/**
 * Write a scheme's token values to :root. When `mode` isn't available on the
 * scheme, fall back to whichever variant exists. Returns the mode actually
 * applied (so the caller can sync the appearance toggle).
 */
export function applySchemeTokens(
  scheme: ColorScheme,
  mode: "light" | "dark",
): "light" | "dark" {
  const resolvedMode = schemeSupportsMode(scheme, mode)
    ? mode
    : scheme.variants.dark
      ? "dark"
      : "light";
  const tokens = scheme.variants[resolvedMode];
  if (!tokens) return resolvedMode; // defensive — parchment always has both

  const root = document.documentElement;
  for (const { token, var: cssVar } of TOKEN_CSS_VARS) {
    root.style.setProperty(cssVar, tokens[token]);
  }
  return resolvedMode;
}

/** Remove inline token overrides so the Parchment CSS fallbacks take over. */
export function clearSchemeTokens(): void {
  const root = document.documentElement;
  for (const { var: cssVar } of TOKEN_CSS_VARS) {
    root.style.removeProperty(cssVar);
  }
}
