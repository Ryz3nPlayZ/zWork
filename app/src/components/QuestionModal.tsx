import { useState } from "react";
import { X, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

interface QuestionModalProps {
  question: string;
  options: string[];
  onSubmit: (answer: string) => void;
  onDismiss?: () => void;
}

/**
 * Popup modal card for the native `ask_question` tool.
 *
 * When the agent calls `ask_question`, the backend emits an SSE event that
 * sets `chat.pendingQuestion` in the store. This modal renders as an overlay
 * card centered over the chat — not inline above the composer — blocking
 * interaction until the user picks an answer.
 *
 * Design: clean centered card with backdrop blur, option rows with hover
 * states, and an optional "Other" free-text input. Mirrors the clarify
 * pattern from Hermes desktop and Vellum's question card.
 */
export function QuestionModal({ question, options, onSubmit, onDismiss }: QuestionModalProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [otherActive, setOtherActive] = useState(false);
  const [otherText, setOtherText] = useState("");

  // Filter out meta-options the agent shouldn't show as clickable choices.
  const cleanOptions = options.filter((opt) => {
    const o = opt.toLowerCase();
    return !o.includes("tell me what to do") && !o.includes("instead");
  });
  const hasOther = options.some((o) => o.toLowerCase().includes("other"));

  function submit(choice: string) {
    if (!choice.trim()) return;
    onSubmit(choice);
  }

  function handleSubmit() {
    if (otherActive && otherText.trim()) {
      submit(otherText.trim());
    } else if (selected) {
      submit(selected);
    }
  }

  const canSubmit = (selected !== null) || (otherActive && otherText.trim().length > 0);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-sm animate-fade-in"
        onClick={() => onDismiss?.()}
      />

      {/* Card */}
      <div className="relative z-10 w-full max-w-[440px] mx-4 animate-fade-in rounded-2xl hairline bg-paper-raised shadow-lift overflow-hidden">
        {/* Question header */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[14px] font-medium text-ink leading-snug pr-4">
              {question}
            </p>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="press shrink-0 rounded-lg p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Options */}
        <div className="px-3 pb-3 flex flex-col gap-1">
          {cleanOptions.map((opt) => {
            const isActive = selected === opt && !otherActive;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  setSelected(opt);
                  setOtherActive(false);
                }}
                className={cn(
                  "press flex items-center justify-between rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors",
                  isActive
                    ? "bg-line/40 text-ink font-medium"
                    : "text-ink-muted hover:bg-line/30 hover:text-ink",
                )}
              >
                <span>{opt}</span>
                {isActive && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                )}
              </button>
            );
          })}

          {/* Other option */}
          {hasOther && (
            <button
              type="button"
              onClick={() => {
                setOtherActive((v) => !v);
                if (!otherActive) setSelected(null);
              }}
              className={cn(
                "press flex items-center justify-between rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors",
                otherActive
                  ? "bg-line/40 text-ink font-medium"
                  : "text-ink-muted hover:bg-line/30 hover:text-ink",
              )}
            >
              <span>Other…</span>
            </button>
          )}

          {/* Free-text input for "Other" */}
          {otherActive && (
            <div className="px-1 pt-1">
              <input
                type="text"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) handleSubmit();
                }}
                placeholder="Type your answer…"
                autoFocus
                className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-ink/10"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-line/40">
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="press rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-ink-muted hover:bg-paper-sunken hover:text-ink transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className={cn(
              "press rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors",
              "bg-ink text-paper hover:bg-ink/90",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
