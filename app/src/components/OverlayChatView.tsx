import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { attachPositionPersistence, fitOverlayWindow } from "../lib/overlayGeometry";
import { Message } from "./Message";
import { ChatInput } from "./ChatInput";

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
  const send = useApp((s) => s.send);
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

  // Position/resize the overlay window: idle chatbar (growing with the typed
  // draft) when empty, expanded chat panel when a conversation is active.
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

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent">
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-end px-4 pb-4 transition-opacity duration-200",
          mounted ? "opacity-100" : "opacity-0",
        )}
      >
        {hasMessages && chat && (
          <div className="mb-3 w-full max-w-[720px] flex-1 min-h-0 overflow-hidden rounded-2xl border border-line bg-paper shadow-float">
            <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-hidden px-5 py-5">
              <div className="mx-auto flex max-w-[640px] flex-col gap-4 pb-2">
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
                      onAskSubmit={(_id, choice) => void send(choice)}
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
      </div>
    </div>
  );
}
