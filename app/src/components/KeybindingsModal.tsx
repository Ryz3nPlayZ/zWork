import { useEffect, useRef } from "react";
import { X, Keyboard, Command } from "lucide-react";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { isMacOS } from "../lib/platform";

export function KeybindingsModal() {
  const open = useApp((s) => s.keybindingsOpen);
  const setOpen = useApp((s) => s.setKeybindingsOpen);
  const modalRef = useRef<HTMLDivElement>(null);
  const isMac = isMacOS();

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, setOpen]);

  if (!open) return null;

  const cmdKey = isMac ? "⌘" : "Ctrl";
  const altKey = isMac ? "⌥" : "Alt";

  const categories = [
    {
      title: "Global Navigation",
      shortcuts: [
        { keys: [`${cmdKey}`, "Shift", "Space"], desc: "Toggle Glass Chatbox Overlay", note: "Summons AI overlay over any app" },
        { keys: [`${cmdKey}`, "K"], desc: "Open Global Search Command Bar" },
        { keys: [`${cmdKey}`, "\\"], desc: "Toggle Sidebar panel" },
        { keys: [`${cmdKey}`, ","], desc: "Open Settings dashboard" },
        { keys: [`${cmdKey}`, "N"], desc: "New Chat / Return to Home" },
      ],
    },
    {
      title: "Chat & Composer",
      shortcuts: [
        { keys: ["Enter"], desc: "Send Message", note: "Submit composer contents" },
        { keys: ["Shift", "Enter"], desc: "Insert New Line", note: "Soft wrap line break" },
        { keys: [`${cmdKey}`, "L"], desc: "Focus Chat Input", note: "Direct focus to composer text area" },
        { keys: ["/"], desc: "Trigger Prompt Template Menu", note: "Type slash at the start of composer" },
      ],
    },
    {
      title: "View & Controls",
      shortcuts: [
        { keys: [`${cmdKey}`, "J"], desc: "Toggle Cockpit panel" },
        { keys: [`${cmdKey}`, "+"], desc: "Zoom In Page font size" },
        { keys: [`${cmdKey}`, "-"], desc: "Zoom Out Page font size" },
        { keys: [`${cmdKey}`, "0"], desc: "Reset Page Zoom font size" },
      ],
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 animate-fade-in"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard Shortcuts Cheatsheet"
    >
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "w-full max-w-[540px] rounded-2xl border border-line bg-paper-raised p-6 shadow-pop",
          "flex flex-col gap-5 max-h-[85vh] overflow-y-auto animate-scale-up"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-paper text-accent">
              <Keyboard className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2 className="font-serif text-[17px] font-semibold text-ink">
                Keyboard Shortcuts
              </h2>
              <p className="text-[11.5px] text-ink-muted">
                Navigate and control zWork with speed
              </p>
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="press rounded-lg p-1.5 text-ink-faint hover:bg-line/50 hover:text-ink transition-colors"
            aria-label="Close shortcuts modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Shortcuts Content */}
        <div className="flex flex-col gap-6">
          {categories.map((cat) => (
            <div key={cat.title} className="flex flex-col gap-2">
              <h3 className="text-[11.5px] font-bold uppercase tracking-wider text-ink-faint">
                {cat.title}
              </h3>
              <div className="flex flex-col rounded-xl border border-line/65 bg-paper overflow-hidden">
                {cat.shortcuts.map((shortcut, sIdx) => (
                  <div
                    key={sIdx}
                    className={cn(
                      "flex items-center justify-between px-4 py-3 text-[13px] border-b border-line last:border-0",
                      "hover:bg-paper-raised/35 transition-colors"
                    )}
                  >
                    <div className="flex flex-col min-w-0 pr-4">
                      <span className="font-medium text-ink truncate">
                        {shortcut.desc}
                      </span>
                      {shortcut.note && (
                        <span className="text-[10.5px] text-ink-muted leading-none mt-0.5 truncate">
                          {shortcut.note}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 select-none">
                      {shortcut.keys.map((key, kIdx) => (
                        <span key={kIdx} className="flex items-center">
                          {kIdx > 0 && <span className="text-[10px] text-ink-faint mx-0.5 font-medium">+</span>}
                          <kbd className={cn(
                            "inline-flex min-w-[20px] h-6 items-center justify-center rounded-md border border-line bg-paper-raised px-1.5 font-mono text-[11px] font-semibold text-ink-muted shadow-xs",
                            key === "Enter" || key === "Space" || key === "Shift" ? "px-2" : ""
                          )}>
                            {key === "Command" || key === "⌘" ? (
                              <Command className="h-3 w-3" />
                            ) : (
                              key
                            )}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer info */}
        <div className="text-center text-[11px] text-ink-muted pt-1 border-t border-line/50">
          Press <kbd className="rounded border border-line bg-paper px-1 py-[0.5px] font-mono text-[10.5px]">Esc</kbd> to close this dashboard.
        </div>
      </div>
    </div>
  );
}
