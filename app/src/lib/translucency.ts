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

/** True when the translucency toggle should exist at all.
 *  On Tauri Windows/Linux there is no compositor blur behind the window, so
 *  the CSS backdrop-blur fallback has nothing to sample — it renders as a
 *  flat grey slab (or black under VM/software rendering). Treat those
 *  platforms as unsupported; the web preview keeps the CSS fallback. */
export function translucencySupported(): boolean {
  return !IS_TAURI || isMacOS();
}

async function setNativeEffect(on: boolean): Promise<void> {
  if (!nativeVibrancySupported()) return;
  try {
    const { getCurrentWindow, EffectState, Effect } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    // Translucency is a window-wide NSVisualEffectView. Applying it to the
    // borderless overlay window fills the entire surface behind the chatbar —
    // a frosted-glass "box around the pill". Translucency is a main-window
    // feature (sidebar only); skip it here so the overlay stays a true
    // floating pill.
    if (win.label === "overlay") return;
    if (on) {
      // Sidebar (NSVisualEffectMaterial.sidebar) is the most-muted material —
      // it's what macOS itself uses for app sidebars (Finder, Mail, Notes).
      // Real desktop bleed-through but text stays crisp and readable.
      // HudWindow was too loud, FullScreenUI was still a bit too translucent;
      // Sidebar hits the calm-but-readable sweet spot. Active state keeps it
      // frosted regardless of window key/focus.
      await win.setEffects({
        effects: [Effect.Sidebar],
        state: EffectState.Active,
      });
    } else {
      await win.clearEffects();
    }
  } catch (err) {
    // Non-fatal for the user, but log so we can tell the difference between
    // "vibrancy applied but subtle" and "setEffects failed entirely" (e.g.
    // missing core:window:allow-set-effects permission, or running on a build
    // without macOSPrivateApi). Previously this was silent, which made the
    // translucency bug impossible to diagnose remotely.
    console.warn("[translucency] native setEffects failed — falling back to CSS only:", err);
  }
}

function setHtmlClass(on: boolean) {
  // The overlay window has no sidebar, so the `sidebar-translucent` class has
  // nothing to target there except the `body { background: transparent }` rule
  // — which would expose a window-wide vibrancy layer as a frosted "box around
  // the pill". Never apply translucency state to the overlay.
  if (typeof window !== "undefined") {
    const label = (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
    if (label === "overlay") return;
  }
  const root = document.documentElement;
  if (on) root.classList.add(HTML_CLASS);
  else root.classList.remove(HTML_CLASS);
}

/**
 * Apply the current preference. Safe to call at boot and on every toggle.
 * Returns immediately; the native effect is applied asynchronously.
 */
export function applyTranslucency(pref: TranslucencyPref): void {
  const on = pref === "on" && translucencySupported();
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
 * React hook: returns the current EFFECTIVE translucency (the applied <html>
 * class, not the raw stored pref) and re-renders when it changes. Components
 * (Sidebar, Settings) use this so they stay in sync with toggles made
 * anywhere in the app — and so a stored "on" pref on a platform where the
 * effect is unsupported (Tauri Windows/Linux) reads as "off".
 */
export function useTranslucencyPref(): TranslucencyPref {
  const [pref, setPref] = useState<TranslucencyPref>(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains(HTML_CLASS)
      ? "on"
      : "off",
  );

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
