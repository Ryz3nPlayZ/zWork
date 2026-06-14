import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Lightbulb,
  ListChecks,
  Moon,
  PenLine,
  Plus,
  Sun,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { setThemePref, useResolvedTheme } from "../lib/theme";
import { Logo } from "./Logo";
import { Message } from "./Message";
import { ChatInput } from "./ChatInput";

/**
 * OverlayChatView — the floating zWork chat.
 *
 * Renders in the always-on-top, transparent, undecorated 500×650 overlay
 * window (summoned by ⌃⌥Space). Instead of a command bar, it shows a real
 * instance of the main chat: same message bubbles, same composer, same
 * typography — driven by the same `useApp` store, so a conversation here is
 * fully functional (stream / stop / regenerate / theme).
 *
 * Design:
 *   - A rounded, shadowed card inset inside the transparent window so it
 *     reads as floating over the desktop (see `.shadow-float`).
 *   - A macOS-style draggable header (.titlebar-drag) with brand mark,
 *     live chat title, and theme / new-chat / close actions.
 *   - The exact `Message` + `ChatInput` components used by the main app,
 *     so bubbles, markdown, thinking shimmer, and the input bar are
 *     pixel-identical to ChatView.
 *   - An editorial-serif empty state (Instrument Serif) — the brand's
 *     display voice — with a few starter prompts.
 *   - Scale + fade + lift entry (220ms, the app's signature easing).
 *   - Escape (or the close button) hides the window; the webview stays
 *     alive, so the conversation persists across summons.
 */

const SUGGESTIONS = [
  { icon: ListChecks, label: "Plan my day", prompt: "Help me plan my day and prioritize what matters." },
  { icon: PenLine, label: "Draft a message", prompt: "Help me draft a clear, polite message." },
  { icon: Lightbulb, label: "Brainstorm ideas", prompt: "Brainstorm some ideas with me." },
  { icon: BookOpen, label: "Explain a concept", prompt: "Explain a concept to me, simply." },
] as const;

/** Compact, theme-aware icon button for the overlay header. */
function HeaderButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "press ring-focus inline-flex h-7 w-7 items-center justify-center rounded-lg",
        "text-ink-muted hover:bg-paper-sunken hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** Editorial empty state — the brand's serif voice with starter prompts. */
function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-7 py-10 text-center">
      <div className="logo-hover-trigger mb-5 animate-fade-in">
        <div className="logo-spin-target">
          <Logo size={42} className="text-ink" />
        </div>
      </div>

      <h2 className="animate-fade-in font-serif text-[26px] font-light leading-tight tracking-tight text-ink">
        What can I help with?
      </h2>
      <p className="mt-2 animate-fade-in text-[12.5px] text-ink-muted">
        Summon anytime with{" "}
        <kbd className="rounded border border-line bg-paper-sunken px-1 py-px font-sans text-[10px] font-medium text-ink-soft">
          ⌃⌥Space
        </kbd>
      </p>

      <div className="mt-7 grid w-full max-w-[380px] animate-fade-in grid-cols-2 gap-2">
        {SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
          <button
            key={label}
            type="button"
            onClick={() => onPick(prompt)}
            className={cn(
              "press ring-focus group flex items-center gap-2 rounded-xl border border-line bg-paper-raised px-3 py-2.5 text-left",
              "text-[12.5px] font-medium text-ink-soft hover:border-line-strong hover:bg-paper-sunken hover:text-ink",
            )}
          >
            <Icon className="h-4 w-4 shrink-0 text-ink-muted transition-colors group-hover:text-ink" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function OverlayChatView() {
  const [mounted, setMounted] = useState(false);

  const bootstrap = useApp((s) => s.bootstrap);
  const send = useApp((s) => s.send);
  const openLanding = useApp((s) => s.openLanding);
  const regenerateMessage = useApp((s) => s.regenerateMessage);
  const flagBadResponse = useApp((s) => s.flagBadResponse);
  const activeChatId = useApp((s) => s.activeChatId);
  const chat = useApp((s) => (activeChatId ? s.chats[activeChatId] : undefined));

  const theme = useResolvedTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Entry choreography — scale + fade + lift on the app's signature easing.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Load providers + model so `send` works; fire-and-forget, non-blocking.
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

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

  const toggleTheme = useCallback(() => {
    setThemePref(theme === "dark" ? "light" : "dark");
  }, [theme]);

  const hasMessages = !!chat && chat.messages.length > 0;

  return (
    <div className="h-screen w-screen p-3">
      <div
        className={cn(
          "shadow-float flex h-full w-full flex-col overflow-hidden rounded-[20px] border border-line bg-paper",
          "transition-all duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform",
          mounted
            ? "translate-y-0 scale-100 opacity-100"
            : "translate-y-1.5 scale-[0.975] opacity-0",
        )}
      >
        {/* ---- Header (drag to move the floating window) ---- */}
        <header
          className={cn(
            "titlebar-drag relative flex shrink-0 select-none items-center justify-between",
            "border-b border-line bg-paper-soft px-3.5 py-2.5",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Logo size={15} className="text-ink" />
            <span className="text-[12.5px] font-semibold tracking-tight text-ink">zWork</span>
            {chat && (
              <>
                <span className="text-ink-faint">·</span>
                <span className="truncate text-[11.5px] text-ink-faint">{chat.title}</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-0.5" data-no-drag>
            <HeaderButton onClick={toggleTheme} label="Toggle theme">
              {theme === "dark" ? <Sun className="h-[15px] w-[15px]" /> : <Moon className="h-[15px] w-[15px]" />}
            </HeaderButton>
            <HeaderButton onClick={() => openLanding()} label="New chat">
              <Plus className="h-[15px] w-[15px]" />
            </HeaderButton>
            <HeaderButton onClick={() => void dismiss()} label="Close (Esc)">
              <X className="h-[15px] w-[15px]" />
            </HeaderButton>
          </div>
        </header>

        {/* ---- Body: messages or empty state, with a floating composer ---- */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
            {hasMessages && chat ? (
              <div className="mx-auto flex max-w-[460px] flex-col gap-4 px-4 py-5 pb-44">
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
                <div ref={endRef} />
              </div>
            ) : (
              <EmptyState onPick={(prompt) => void send(prompt)} />
            )}
          </div>

          {/* Composer — pinned, with the same gradient fade ChatView uses */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-paper via-paper/95 to-transparent px-3.5 pb-3 pt-9">
            <div className="pointer-events-auto mx-auto max-w-[460px]">
              <ChatInput autoFocus placeholder="Message zWork…" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
