/**
 * windowSync — cross-window chat-list bridge between the main window and the
 * Ctrl+Alt+Space overlay.
 *
 * The two windows are separate OS webviews with independent JS contexts, each
 * with its own copy of the Zustand store. Tauri's event bus
 * (`@tauri-apps/api/event`) is the only channel they share, and it's already
 * permitted by `core:default` (see src-tauri/capabilities/default.json).
 *
 * Design intent: the overlay is an *independent quick-chat surface*. You're
 * working on some other problem in some other app, hit the shortcut, and
 * summon zWork to ask a throwaway question. It is NOT a mirror of the main
 * window's active conversation.
 *
 * So we sync only one thing:
 *
 *   `chat:list-changed` — emitted after any mutation that changes the chat
 *                          list (new chat, rename, delete, send). Both windows
 *                          listen and call `refreshChats()` so a quick
 *                          question asked in the overlay shows up in the main
 *                          window's sidebar afterward, and vice versa.
 *
 * We deliberately do NOT sync `activeChatId`. The overlay always opens to a
 * fresh pill; the main window's view is never disturbed by what happens in
 * the popup. Every event carries an `origin` field and listeners skip events
 * they originated, which prevents echo loops. All helpers no-op outside
 * Tauri (browser dev) so the same store loads everywhere.
 */

import { emit, listen } from "@tauri-apps/api/event";
import { IS_WEB } from "./api";

/** The current window's label, or null in browser dev mode. */
export function windowLabel(): "main" | "overlay" | null {
  if (typeof window === "undefined") return null;
  if (IS_WEB) return null;
  const internals = (window as any).__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label;
  return label === "main" || label === "overlay" ? label : null;
}

type ListChangedPayload = { origin: string };

/** Emit `chat:list-changed`. No-op in browser dev or before the label resolves. */
export async function emitChatListChanged(): Promise<void> {
  const origin = windowLabel();
  if (!origin) return;
  try {
    await emit("chat:list-changed", { origin } satisfies ListChangedPayload);
  } catch {
    // Event delivery is best-effort; never let it crash a store mutation.
  }
}

export interface WindowSyncHandlers {
  /** Fired when the other window's chat list changed. Calls `refreshChats()`. */
  onListChanged: () => void | Promise<void>;
}

/**
 * Register the list-changed listener. Returns an unsubscribe fn. No-op
 * (returns a no-op unsubscriber) in browser dev mode or when the window label
 * can't be resolved, so callers don't need to branch.
 *
 * The listener skips events it originated via the `origin` field, which is
 * what keeps the two windows from echoing events at each other forever.
 */
export async function registerWindowSync(handlers: WindowSyncHandlers): Promise<() => void> {
  const label = windowLabel();
  if (label === null) return () => {};

  try {
    const unlisten = await listen<ListChangedPayload>("chat:list-changed", (e) => {
      if (e.payload.origin === label) return;
      void handlers.onListChanged();
    });
    return () => {
      try {
        unlisten();
      } catch {
        /* ignore */
      }
    };
  } catch {
    // If registration fails (e.g. capabilities changed), swallow so the app
    // still boots — sync is a nice-to-have, not a boot dependency.
    return () => {};
  }
}
