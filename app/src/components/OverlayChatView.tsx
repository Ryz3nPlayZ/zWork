import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

/**
 * OverlayCommandBar — a clean, minimal floating command/search bar
 * summoned by the global overlay shortcut (Cmd/Ctrl+Alt+Space).
 *
 * Design follows the zWork design system:
 *   - Scale + fade entry animation (200ms)
 *   - Escape to dismiss
 *   - Enter to submit the query
 *   - Theme-aware: uses --paper / --ink tokens, supports light + dark
 *   - Press effect on buttons (scale 0.97, 120ms)
 *   - Focus ring via ring-focus utility
 */

export function OverlayChatView() {
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Trigger entry animation on mount
  useEffect(() => {
    // Small delay so the CSS transition has a frame to start from
    const frame = requestAnimationFrame(() => {
      setVisible(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Auto-focus the input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close overlay window via Tauri
  const dismiss = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch {
      // Not in Tauri (dev in browser) — no-op
    }
  }, []);

  // Submit the query
  const submit = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    // For now: open the main window with the query.
    // Future: inject the query into the main window's chat input or
    // open a direct chat session. The main window can read from
    // sessionStorage / localStorage as a bridge.
    try {
      sessionStorage.setItem("zwork:overlay-query", trimmed);
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
      // Show and focus the main window
      try {
        const { getAllWindows } = await import("@tauri-apps/api/window");
        const windows = await getAllWindows();
        const main = windows.find((w) => w.label === "main");
        if (main) {
          await main.show();
          await main.setFocus();
        }
      } catch {
        // Best-effort
      }
    } catch {
      // Fallback for browser dev
      console.log("Overlay query:", trimmed);
      setQuery("");
      inputRef.current?.focus();
    }
  }, [query]);

  // Keyboard handlers
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void dismiss();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    },
    [dismiss, submit],
  );

  return (
    <div
      className={cn(
        "flex h-screen w-screen items-center justify-center p-8",
        "bg-paper/40 backdrop-blur-xl",
        "transition-all duration-200 ease-out",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      {/* Command bar card */}
      <div
        className={cn(
          "w-full max-w-[420px] rounded-2xl border border-line",
          "bg-paper-raised shadow-pop",
          "transition-all duration-200 ease-out",
          visible ? "scale-100 translate-y-0" : "scale-95 translate-y-2",
        )}
      >
        {/* Input area */}
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Subtle left icon: command/search indicator */}
          <svg
            className="h-4 w-4 shrink-0 text-ink-muted"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <path d="M10 10l4.5 4.5" />
          </svg>

          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything…"
            className={cn(
              "flex-1 bg-transparent border-none outline-none",
              "text-[14px] text-ink placeholder-ink-faint",
              "font-sans antialiased min-w-0",
              // Custom focus ring for this context
              "focus:outline-none",
            )}
            spellCheck={false}
            autoComplete="off"
          />

          {/* Submit hint */}
          <kbd
            className={cn(
              "hidden sm:inline-flex items-center gap-0.5 shrink-0",
              "text-[10px] font-medium text-ink-faint",
              "rounded-md border border-line px-1.5 py-0.5",
              "bg-paper-sunken",
            )}
          >
            ⏎
          </kbd>
        </div>

        {/* Subtle bottom hint row */}
        <div
          className={cn(
            "flex items-center justify-between px-4 py-2",
            "border-t border-line/60",
            "text-[11px] text-ink-faint",
          )}
        >
          <span>Ask a question or give a command</span>
          <button
            type="button"
            onClick={dismiss}
            className={cn(
              "press rounded-md px-2 py-0.5",
              "text-ink-faint hover:text-ink-muted",
              "hover:bg-paper-sunken ring-focus",
              "transition-colors",
            )}
            aria-label="Dismiss overlay"
          >
            esc
          </button>
        </div>
      </div>
    </div>
  );
}
