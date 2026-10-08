import { useEffect, useState } from "react";

/**
 * Theme controller — applies `light` / `dark` class to <html>.
 *
 * Stored preference:
 *   localStorage["zwork.theme"] = "system" | "light" | "dark"
 *
 * System preference is read from `prefers-color-scheme` and auto-updates.
 */

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "zwork.theme";

function systemResolved(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "system" || v === "light" || v === "dark") return v;
  } catch {}
  return "system";
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === "system" ? systemResolved() : pref;
}

export function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {}
  applyTheme(resolveTheme(pref));
}

/**
 * Call once at app boot. Wires prefers-color-scheme change listener so when
 * the user's OS theme flips, we follow (only when pref === "system").
 */
export function initTheme(): () => void {
  const pref = loadThemePref();
  applyTheme(resolveTheme(pref));

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
