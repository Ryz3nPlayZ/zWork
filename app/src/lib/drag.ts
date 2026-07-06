/**
 * Window drag — overlay-titlebar pattern for macOS.
 *
 * With `titleBarStyle: "Overlay"` + `hiddenTitle: true`, the native titlebar
 * is hidden and traffic lights float over our content. The window can only be
 * moved if we explicitly mark draggable regions.
 *
 * Two mechanisms, both attached:
 *  1. `data-tauri-drag-region` attribute — Tauri's declarative drag region.
 *     Works but has a known quirk on unfocused windows (tauri#11605): the
 *     first click only focuses, the second drags.
 *  2. `onMouseDown` → `startDragging()` IPC — works on first click, no focus
 *     dance. Requires the `core:window:allow-start-dragging` capability.
 *
 * We use #2 as the primary mechanism (better UX) and #1 as a passive hint.
 * Interactive children (buttons, inputs, links) are excluded so clicks on
 * them don't initiate a window drag.
 */

import type { MouseEvent } from "react";
import { IS_TAURI } from "./platform";

/** Attribute to spread onto draggable elements: `<div {...dragRegionAttrs()}`> */
export function dragRegionAttrs(): { "data-tauri-drag-region": true } {
  return { "data-tauri-drag-region": true };
}

/**
 * onMouseDown handler that initiates a native window drag on Tauri.
 * No-op in the browser. Interactive descendants are excluded.
 */
export function onDragMouseDown(e: MouseEvent<HTMLElement>): void {
  if (!IS_TAURI || e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest("button, a, input, textarea, select, [contenteditable], [data-no-drag]")) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    getCurrentWindow().startDragging().catch((err) => {
      console.warn("[drag] startDragging failed — is core:window:allow-start-dragging in capabilities?", err);
    });
  });
}
