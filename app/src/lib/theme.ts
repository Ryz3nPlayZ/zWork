import { useEffect, useState } from "react";

import {
  applySchemeTokens,
  clearSchemeTokens,
  DEFAULT_SCHEME_ID,
  getScheme,
  schemeModes,
} from "./themes";

/**
 * Theme controller — applies `light` / `dark` class to <html> AND the active
 * color scheme's token values to :root.
 *
 * Two orthogonal prefs:
 *   localStorage["zwork.scheme"] = scheme id (e.g. "parchment", "catppuccin-mocha")
 *   localStorage["zwork.theme"]  = "system" | "light" | "dark"   (appearance mode)
 *
 * The mode switches a scheme's light↔dark variant when both exist. A
 * single-mode scheme (e.g. Mocha = dark-only) forces that mode and the
 * Appearance toggle locks to it.
 *
 * System preference is read from `prefers-color-scheme` and auto-updates.
 */

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const SCHEME_KEY = "zwork.scheme";
const MODE_KEY = "zwork.theme";

function systemResolved(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// ---- scheme pref ----
export function loadSchemePref(): string {
  try {
    const v = localStorage.getItem(SCHEME_KEY);
    if (v && v !== DEFAULT_SCHEME_ID) return v;
  } catch {}
  return DEFAULT_SCHEME_ID;
}

export function setSchemePref(id: string) {
  try {
    localStorage.setItem(SCHEME_KEY, id);
  } catch {}
  // Re-applying with the current mode pref picks the right variant (and may
  // flip the mode for single-variant schemes).
  applyTheme(resolveTheme(loadThemePref()));
}

// ---- mode pref ----
export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "system" || v === "light" || v === "dark") return v;
  } catch {}
  return "system";
}

/**
 * Resolve the mode pref to a concrete light/dark, taking the active scheme's
 * supported modes into account. A single-mode scheme overrides the pref.
 */
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  const scheme = getScheme(loadSchemePref());
  const modes = schemeModes(scheme);
  if (modes.length === 1) return modes[0]!;
  const wanted = pref === "system" ? systemResolved() : pref;
  return modes.includes(wanted) ? wanted : (modes[0] ?? "dark");
}

/** Modes the active scheme supports — drives the Appearance toggle's enabled
 *  state in Settings. */
export function resolvedSchemeModes(): Array<"light" | "dark"> {
  return schemeModes(getScheme(loadSchemePref()));
}

export function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  // Apply the active scheme's tokens for this mode. Parchment writes no
  // inline overrides (clearSchemeTokens) so the :root CSS fallbacks show.
  const scheme = getScheme(loadSchemePref());
  if (scheme.id === DEFAULT_SCHEME_ID) {
    // Default scheme: rely on index.css :root.light/.dark. Clear any inline
    // overrides left by a previous non-default scheme.
    clearSchemeTokens();
  } else {
    applySchemeTokens(scheme, resolved);
  }
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(MODE_KEY, pref);
  } catch {}
  applyTheme(resolveTheme(pref));
}

/**
 * Call once at app boot. Wires prefers-color-scheme change listener so when
 * the user's OS theme flips, we follow (only when pref === "system").
 */
export function initTheme(): () => void {
  applyTheme(resolveTheme(loadThemePref()));

  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (loadThemePref() === "system") {
      applyTheme(resolveTheme("system"));
    }
  };
  media?.addEventListener?.("change", onChange);
  return () => media?.removeEventListener?.("change", onChange);
}

/**
 * React hook: returns the current resolved theme and re-renders whenever the
 * <html> class flips between "light" and "dark" (via a MutationObserver on
 * `documentElement.className`).
 */
export function useResolvedTheme(): ResolvedTheme {
  const read = (): ResolvedTheme =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";

  const [theme, setTheme] = useState<ResolvedTheme>(read);

  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    // Sync once in case the class changed between render and effect.
    setTheme(read());
    return () => obs.disconnect();
  }, []);

  return theme;
}
