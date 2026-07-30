/**
 * Window drag — threshold-based drag pattern for the overlay and main panes.
 *
 * The overlay pill must be draggable from its non-interactive surface (the
 * bar chrome, gutters, empty header space) while a plain click still
 * registers as a click. Interactive children (textarea, buttons — see
 * INTERACTIVE_SELECTOR) keep their own mouse behavior: dragging there is
 * text selection / click-cancel, never a window move. For everything else
 * this is the standard "click vs drag distinguished by movement threshold"
 * pattern:
 *
 *  1. On `mousedown`: record start coords, attach a `pointermove` listener.
 *  2. On `pointermove`: if distance from start > DRAG_THRESHOLD (4px), call
 *     `startDragging()` and set a `didDrag` flag.
 *  3. On `click` (capture phase): if `didDrag` is set, `preventDefault()` +
 *     `stopPropagation()` so the element's onClick doesn't fire.
 *
 * This lets the user grab the pill anywhere and drag it, while clicks on
 * interactive children still work normally.
 *
 * The declarative `data-tauri-drag-region` attribute is still attached to
 * non-interactive gutters as a fallback for the macOS first-click-focus race
 * (on an unfocused always-on-top window, macOS eats the first mousedown to
 * activate the window; the declarative region hooks at the native layer before
 * that focus event, so the first click both focuses AND drags).
 */

import type { MouseEvent as ReactMouseEvent } from "react";
import { IS_TAURI } from "./platform";

/** Pixels of movement before a mousedown becomes a drag. */
const DRAG_THRESHOLD = 4;

/**
 * Elements whose own mouse interactions must never turn into a window drag:
 * dragging inside a textarea is text selection, dragging off a button is a
 * cancelled click, and `[data-no-drag]` is the explicit opt-out used by
 * headers (Settings, ChatView) around their interactive clusters. Without
 * this walk, mousedowns bubbling up from e.g. sidebar buttons through the
 * full-window base layer (App.tsx) turned drag-selects into window moves.
 */
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='menuitem']",
  "[contenteditable='true']",
  "[data-no-drag]",
].join(", ");

/** Attribute to spread onto draggable elements: `<div {...dragRegionAttrs()}`> */
export function dragRegionAttrs(): { "data-tauri-drag-region": true } {
  return { "data-tauri-drag-region": true };
}

/**
 * Tracks whether the current pointer interaction resulted in a drag, so the
 * capture-phase click handler can swallow the synthetic click. Module-level
 * because the click fires on a different element than the mousedown.
 */
let didDragThisInteraction = false;

/**
 * onMouseDown handler that initiates a native window drag on Tauri when the
 * pointer moves beyond the threshold. No-op in the browser and on interactive
 * children (see INTERACTIVE_SELECTOR) — for everything else the threshold
 * distinguishes clicks from drags.
 *
 * Also attaches a one-shot click swallower on capture so a drag doesn't
 * accidentally trigger a button's onClick.
 */
export function onDragMouseDown(e: ReactMouseEvent<HTMLElement>): void {
  if (!IS_TAURI || e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest?.(INTERACTIVE_SELECTOR)) return;

  const startX = e.clientX;
  const startY = e.clientY;
  didDragThisInteraction = false;
  let dragStarted = false;

  const onPointerMove = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (dragStarted) return; // startDragging already called; OS handles the rest
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;

    // Past threshold — initiate the native drag.
    dragStarted = true;
    didDragThisInteraction = true;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().startDragging().catch((err) => {
        console.warn("[drag] startDragging failed — is core:window:allow-start-dragging in capabilities?", err);
      });
    });
    // Clean up listeners once the drag starts — the OS owns the pointer now.
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  const onPointerUp = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // didDragThisInteraction is already set if we dragged; it persists for the
    // imminent click event so the capture-phase swallower can read it.
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  // Also install a one-shot click swallower on capture for the NEXT click only.
  // This prevents a drag-terminated-by-mouseup from firing a click on the
  // element under the cursor (e.g. the send button).
  const swallowClick = (clickEv: MouseEvent) => {
    if (didDragThisInteraction) {
      clickEv.preventDefault();
      clickEv.stopPropagation();
    }
    didDragThisInteraction = false;
    window.removeEventListener("click", swallowClick, true);
  };
  // Defer attaching so the current mousedown's synthetic click (if any) is
  // caught, but we don't swallow clicks that were already in flight.
  setTimeout(() => window.addEventListener("click", swallowClick, true), 0);
}
