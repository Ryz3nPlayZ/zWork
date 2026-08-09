import { useCallback, useEffect, useRef, useState } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { IS_TAURI } from "../lib/platform";
import { attachPositionPersistence, fitOverlayWindow, resetOverlayPlacement } from "../lib/overlayGeometry";
import { dragRegionAttrs, onDragMouseDown } from "../lib/drag";
import { Message } from "./Message";
import { ChatInput } from "./ChatInput";
import { QuestionModal } from "./QuestionModal";

/**
 * OverlayChatView — the floating zWork chat.
 *
 * Renders in the always-on-top, transparent, undecorated overlay window
 * (summoned by ⌃⌥Space). Unlike the previous full card design, this is a
 * single, draggable, bottom-center chatbar — similar to Gemini's overlay.
 *
 * Design:
 *   - Idle: just a rounded chatbar with a + menu, text input, model picker
 *     and send button. The whole bar is draggable.
 *   - Active: expands upward to show the conversation above the chatbar.
 *   - Transparent window background so only the chat UI is visible.
 *   - Escape hides the overlay; the webview stays alive so the conversation
 *     persists across summons.
 */

export function OverlayChatView() {
  const [mounted, setMounted] = useState(false);
  const [barHeight, setBarHeight] = useState(0);

  const bootstrap = useApp((s) => s.bootstrap);
  const regenerateMessage = useApp((s) => s.regenerateMessage);
  const flagBadResponse = useApp((s) => s.flagBadResponse);
  const activeChatId = useApp((s) => s.activeChatId);
  const chat = useApp((s) => (activeChatId ? s.chats[activeChatId] : undefined));

  const scrollRef = useRef<HTMLDivElement>(null);

  const hasMessages = !!chat && chat.messages.length > 0;

  // Entry choreography + initial window placement.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Make the overlay window truly transparent. The `overlay-window` class on
  // <html> forces html/body/#root transparent (see index.css) so the global
  // `bg-paper` body doesn't paint a dark rectangle behind the window.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    const body = document.body;
    html.classList.add("overlay-window");
    const originalHtmlBg = html.style.backgroundColor;
    const originalBodyBg = body.style.backgroundColor;
    html.style.backgroundColor = "transparent";
    body.style.backgroundColor = "transparent";
    return () => {
      html.classList.remove("overlay-window");
      html.style.backgroundColor = originalHtmlBg;
      body.style.backgroundColor = originalBodyBg;
    };
  }, []);

  // Load providers + model so `send` works; fire-and-forget, non-blocking.
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Listen for captures from the standalone Share Window picker (its own OS
  // window). On capture, push the image to the store for the active ChatInput
  // to consume as an attachment, and switch to zwork-vision so the model can
  // process the image. (This logic used to live in ChatInput's in-overlay
  // picker; it moved here when the picker became a separate window.)
  useEffect(() => {
    if (!IS_TAURI) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      if (cancelled) return;
      listen<{ dataUrl: string; mime: string }>("share-window-captured", (event) => {
        const payload = event.payload;
        if (!payload?.dataUrl) return;
        useApp.getState().pushPendingShareImage({
          dataUrl: payload.dataUrl,
          mime: payload.mime || "image/png",
          name: "Shared window",
        });
        useApp.getState().setModel("zwork-vision");
      }).then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Position/resize the overlay window: idle chatbar (growing with the typed
  // draft) when empty, expanded chat panel when a conversation is active.
  // (The Share Window picker is now its own OS window and doesn't touch the
  // overlay's geometry.)
  useEffect(() => {
    void fitOverlayWindow(hasMessages ? "chat" : "idle", { contentHeight: barHeight || undefined });
  }, [hasMessages, barHeight]);

  // Persist the overlay position across drags; restore-on-launch is handled by
  // fitOverlayWindow's first call.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void attachPositionPersistence().then((u) => {
      if (cancelled) u?.();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Auto-scroll to the latest message / streaming delta (mirrors ChatView).
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    if (distance <= 0) return;
    if (distance < 300) {
      scrollEl.scrollBy({ top: distance, behavior: "smooth" });
    } else {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "auto" });
    }
  }, [chat?.messages.length, chat?.working, chat?.status]);

  // Hide the overlay window (keeps the webview alive → chat persists).
  const dismiss = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
      // Reset placement so the next summon defaults to bottom-center (unless
      // the user explicitly dragged during this session).
      resetOverlayPlacement();
    } catch {
      // Not in Tauri (browser dev) — no-op.
    }
  }, []);

  // Escape dismisses the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  // Resize the overlay window by dragging the top edge of the expanded panel.
  // The handle calls win.setSize() with a new height based on the drag delta
  // (dragging up = taller, down = shorter), keeping the bottom pinned.
  const onResizeMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!IS_TAURI) return;
    e.preventDefault();
    e.stopPropagation();
    // Capture the window's height and top position ONCE at mousedown, then
    // derive every subsequent size from these fixed starts. Two correctness
    // invariants, both fixed here:
    //  1. Reference the captured starts, never the live size — otherwise the
    //     cumulative delta compounds and the panel walks downward.
    //  2. Do NOT attach the pointermove listener until `begin()` resolves.
    //     The previous code attached the listener synchronously and dispatched
    //     the async `begin()` afterwards, so early pointermove events ran with
    //     the starts still 0 → newY = -(newH) → the window jumped up, then
    //     snapped back when begin() resolved. That was the "pill moves then
    //     corrects itself" jitter. The `ready` flag + late attach close the race.
    let startH = 0;
    let startWindowY = 0;
    let startW = 0;
    let startX = 0;
    let scale = 1;
    let active = false;
    let ready = false;
    const startY = e.clientY;

    const onMove = async (ev: PointerEvent) => {
      if (!ready) return; // begin() hasn't populated the starts yet
      const delta = startY - ev.clientY; // up = positive
      if (!active && Math.abs(delta) < 3) return;
      active = true;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const newH = Math.max(76, Math.min(900, startH + delta));
        const newY = startWindowY - (newH - startH);
        await win.setSize(new LogicalSize(startW, newH));
        await win.setPosition(new LogicalPosition(Math.round(startX), Math.round(newY)));
      } catch { /* noop */ }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    const begin = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const size = await win.outerSize();
        const pos = await win.outerPosition();
        scale = window.devicePixelRatio || 1;
        startH = size.height / scale;
        startW = size.width / scale;
        startWindowY = pos.y / scale;
        startX = pos.x / scale;
        ready = true;
        // Attach listeners ONLY after the starts are captured, so no move ever
        // fires against zeroed values.
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      } catch {
        // Couldn't read geometry — nothing to resize. No listeners attached.
      }
    };
    void begin();
  };
  // The pill itself is the primary drag grip (its whole non-interactive chrome
  // is a data-tauri-drag-region — see ChatInput). The expanded panel adds a
  // dedicated drag-header strip (below) as a generous grab target once it has
  // grown. The root div is intentionally NOT a drag region, so users can
  // select and copy message text without the window following the cursor.

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent">
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-end px-4 pb-4 pt-2 transition-opacity duration-200",
          mounted ? "opacity-100" : "opacity-0",
        )}
      >
        {hasMessages && chat && (
          <div
            className={cn(
              // The panel floats above the pill with an mb-3 gap, so it reads
              // as its own card — all four corners rounded. (A flush join with
              // the pill would need square bottom corners, but the gap makes
              // that look like a clipped edge instead.)
              "mb-3 w-full max-w-[720px] flex-1 min-h-0 overflow-hidden rounded-2xl border border-line shadow-float",
              // NOTE: no backdrop-blur here. On a fully-transparent Tauri
              // overlay window, `backdrop-filter` has nothing behind it to
              // sample (the window's own backing store is transparent), so
              // WebKit fills the element's bounding box with an opaque frosted
              // rectangle — clipped to border-radius only on some platforms.
              // A solid fill is the correct treatment for a floating overlay.
              "bg-paper",
            )}
          >
            {/* Resize handle — a thin strip at the very top of the expanded
                panel. Drag up to make taller, down to shorten. Bottom stays
                pinned so the pill doesn't move. */}
            <div
              onMouseDown={onResizeMouseDown}
              className="h-1.5 w-full shrink-0 cursor-ns-resize hover:bg-ink/5"
              title="Drag to resize"
              aria-label="Resize handle"
            />
            {/* Drag header — draggable part of the expanded panel for moving.
                Generous height (28px) so it's easy to grab. Marks the panel
                as movable without sacrificing text selection in the body. */}
            <div
              onMouseDown={onDragMouseDown}
              {...dragRegionAttrs()}
              className="flex h-7 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
              title="Drag to move"
              aria-label="Drag handle"
            >
              <span className="h-1 w-10 rounded-full bg-ink/15" />
            </div>
            {/* Message body is explicitly no-drag so text selection, links,
                and code copy work normally. */}
            <div
              ref={scrollRef}
              data-no-drag
              className="h-full overflow-y-auto overflow-x-hidden px-5 pb-6"
            >
              <div className="mx-auto flex max-w-[640px] flex-col gap-4 pb-6">
                {chat.messages.map((m, idx) => {
                  const isLast = idx === chat.messages.length - 1;
                  const isStreaming = !!chat.working && isLast;
                  const activities = isStreaming && m.role === "assistant" ? chat.activities : m.activities;
                  return (
                    <Message
                      key={m.id}
                      message={m}
                      streaming={isStreaming}
                      activities={activities}
                      status={isStreaming ? chat.status : undefined}
                      onRetry={regenerateMessage}
                      onBadResponse={flagBadResponse}
                    />
                  );
                })}
                {chat.error && (
                  <div className="flex animate-fade-in items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-snug text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                    <span className="break-words">{chat.error}</span>
                  </div>
                )}

              </div>
            </div>
          </div>
        )}

        <div className="w-full max-w-[720px]">
          <ChatInput
            variant="overlay"
            autoFocus
            placeholder="Ask zWork…"
            onDismiss={dismiss}
            onHeightChange={setBarHeight}
          />
        </div>

        {/* Agent question modal — blocks interaction until answered */}
        {chat?.pendingQuestion && activeChatId && (
          <QuestionModal
            question={chat.pendingQuestion.question}
            options={chat.pendingQuestion.options}
            onSubmit={(answer) => void useApp.getState().answerQuestion(activeChatId, answer)}
            onDismiss={dismiss}
          />
        )}
      </div>
    </div>
  );
}
