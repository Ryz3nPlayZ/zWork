/**
 * Sidebar translucency controller.
 *
 * Native macOS vibrancy where supported (real frosted glass showing the
 * desktop behind the window), falling back to a CSS-only tint on Windows /
 * Linux / web. Controlled by a single Settings toggle.
 *
 * Stored preference:
 *   localStorage["zwork.translucency"] = "off" | "on"
 *
 * The effect is applied two ways:
 *  1. A `<html>.sidebar-translucent` class drives the CSS (transparent sidebar
 *     region + a backdrop-blur fallback for non-vibrancy platforms).
 *  2. On macOS + Tauri, the native window effect (NSVisualEffectMaterial
 *     "sidebar") is toggled via Tauri v2's runtime setEffects/clearEffects.
 */

import { useEffect, useState } from "react";

import { IS_TAURI, isMacOS } from "./platform";

export type TranslucencyPref = "off" | "on";

const STORAGE_KEY = "zwork.translucency";
const HTML_CLASS = "sidebar-translucent";

export function loadTranslucencyPref(): TranslucencyPref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "on" || v === "off") return v;
  } catch {}
  return "off";
}

/** True only when native macOS vibrancy is actually available. */
export function nativeVibrancySupported(): boolean {
  // Web build → no window effect API. Non-macOS → no NSVisualEffectView.
  // The CSS class still applies a tasteful fallback in those cases.
  return IS_TAURI && isMacOS();
}

async function setNativeEffect(on: boolean): Promise<void> {
  if (!nativeVibrancySupported()) return;
  try {
    const { getCurrentWindow, EffectState, Effect } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (on) {
      // Effect.Sidebar maps to NSVisualEffectMaterial.sidebar — the material
      // Finder, Xcode, etc. use for their side columns. Active state keeps it
      // frosted regardless of window key status.
      await win.setEffects({
        effects: [Effect.Sidebar],
        state: EffectState.Active,
      });
    } else {
      await win.clearEffects();
    }
  } catch {
    // Non-fatal: if the Tauri call is unavailable or permission is missing,
    // the CSS fallback still gives a reasonable result.
  }
}

function setHtmlClass(on: boolean) {
  const root = document.documentElement;
  if (on) root.classList.add(HTML_CLASS);
  else root.classList.remove(HTML_CLASS);
}

/**
 * Apply the current preference. Safe to call at boot and on every toggle.
 * Returns immediately; the native effect is applied asynchronously.
 */
export function applyTranslucency(pref: TranslucencyPref): void {
  const on = pref === "on";
  setHtmlClass(on);
  void setNativeEffect(on);
}

export function setTranslucencyPref(pref: TranslucencyPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {}
  applyTranslucency(pref);
}

/**
 * React hook: returns the current preference and re-renders when it changes.
 * Components (Sidebar, Settings) use this so they stay in sync with toggles
 * made anywhere in the app.
 */
export function useTranslucencyPref(): TranslucencyPref {
  const [pref, setPref] = useState<TranslucencyPref>(loadTranslucencyPref);

  useEffect(() => {
    const root = document.documentElement;
    const read = (): TranslucencyPref =>
      root.classList.contains(HTML_CLASS) ? "on" : "off";
    const obs = new MutationObserver(() => setPref(read()));
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  return pref;
}
