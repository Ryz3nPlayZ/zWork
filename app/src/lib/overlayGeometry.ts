import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";

/** Logical-pixel geometry for the idle (just-chatbar) overlay state. */
const IDLE_WIDTH = 720;
const IDLE_HEIGHT = 120;

/** Logical-pixel geometry when a conversation is active. */
const CHAT_HEIGHT = 640;

/** Bottom margin from the monitor's work area edge. */
const BOTTOM_MARGIN = 24;

export type OverlayMode = "idle" | "chat";

/**
 * Position and size the overlay window.
 *
 * - Idle: a compact, pill-shaped chatbar centered near the bottom of the
 *   current monitor.
 * - Chat: expands upward from the same bottom edge so the chatbar stays in
 *   place and the conversation appears above it.
 */
export async function fitOverlayWindow(mode: OverlayMode): Promise<void> {
  const width = IDLE_WIDTH;
  const height = mode === "idle" ? IDLE_HEIGHT : CHAT_HEIGHT;

  const win = getCurrentWindow();
  const monitor = (await currentMonitor()) ?? (await primaryMonitor());

  let x: number;
  let y: number;

  const currentPos = await win.outerPosition().catch(() => null);
  const currentSize = await win.outerSize().catch(() => null);

  if (monitor) {
    const scale = monitor.scaleFactor || 1;
    const workX = monitor.workArea.position.x / scale;
    const workY = monitor.workArea.position.y / scale;
    const workW = monitor.workArea.size.width / scale;
    const workH = monitor.workArea.size.height / scale;

    // Center horizontally on the current monitor.
    x = workX + (workW - width) / 2;

    if (currentPos && currentSize && mode === "chat") {
      // Keep the window's bottom edge anchored so the chatbar doesn't jump
      // when the conversation panel opens above it.
      const currentBottom = currentPos.y / scale + currentSize.height / scale;
      y = currentBottom - height;
    } else {
      // Initial placement: bottom center with a small margin.
      y = workY + workH - height - BOTTOM_MARGIN;
    }
  } else if (currentPos && currentSize && mode === "chat") {
    // Fallback: keep bottom edge fixed using browser screen dims.
    const currentBottom = currentPos.y + currentSize.height;
    x = currentPos.x;
    y = currentBottom - height;
  } else {
    // Final fallback: center on the primary/assumed screen.
    x = (window.screen.availWidth - width) / 2;
    y = window.screen.availHeight - height - BOTTOM_MARGIN;
  }

  await win.setSize(new LogicalSize(width, height));
  await win.setPosition(new LogicalPosition(x, y));
}

/** Place the overlay in its idle bottom-center position. */
export async function centerOverlayIdle(): Promise<void> {
  await fitOverlayWindow("idle");
}
