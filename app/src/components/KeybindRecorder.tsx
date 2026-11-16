import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

/**
 * KeybindRecorder — a self-contained keybind editor.
 *
 * States:
 *   idle       → shows current keybind + edit/delete buttons
 *   listening  → waiting for modifier key
 *   recording  → modifier held, waiting for the final key
 *   success    → keybind registered (flashes green)
 *
 * The shortcut string is in Tauri format: e.g. "Super+Alt+Space"
 */

const MODIFIERS = new Set(["Meta", "Alt", "Control", "Shift"]);
const MOD_LABELS: Record<string, string> = {
  Meta: "⌘",
  Alt: "⌥",
  Control: "⌃",
  Shift: "⇧",
};

function formatShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((k) => {
      const lower = k.toLowerCase();
      if (lower === "super" || lower === "cmd" || lower === "command") return "⌘";
      if (lower === "alt" || lower === "option") return "⌥";
      if (lower === "control" || lower === "ctrl") return "⌃";
      if (lower === "shift") return "⇧";
      if (lower === "space") return "Space";
      if (lower === "escape") return "Esc";
      if (lower === "return" || lower === "enter") return "↵";
      if (lower === "tab") return "⇥";
      if (lower === "backspace") return "⌫";
      if (lower === "delete") return "⌦";
      // Capitalize first letter for single-char keys
      return k.length === 1 ? k.toUpperCase() : k;
    })
    .join(" + ");
}

function keyToTauri(e: KeyboardEvent): string | null {
  // We need at least one modifier
  const mods: string[] = [];
  if (e.metaKey) mods.push("Super");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  if (mods.length === 0) return null;

  // Ignore bare modifier presses (user must press modifier+key combo)
  if (MODIFIERS.has(e.key)) return null;

  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [...mods, key].join("+");
}

interface KeybindRecorderProps {
  /** Current shortcut string in Tauri format, or empty if none. */
  value: string;
  /** Called when a new shortcut is confirmed. Empty string = unbound. */
  onChange: (shortcut: string) => void;
  /** Label shown above the recorder. */
  label: string;
  /** Optional description. */
  description?: string;
}

export function KeybindRecorder({ value, onChange, label, description }: KeybindRecorderProps) {
  const [state, setState] = useState<"idle" | "listening" | "recording" | "success">("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [heldMods, setHeldMods] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  const startListening = useCallback(() => {
    setState("listening");
    setPreview(null);
    setHeldMods(new Set());
  }, []);

  const cancel = useCallback(() => {
    setState("idle");
    setPreview(null);
    setHeldMods(new Set());
  }, []);

  useEffect(() => {
    if (state === "idle") return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Update held modifiers for visual feedback
      const mods = new Set(heldMods);
      if (e.metaKey) mods.add("Meta");
      if (e.ctrlKey) mods.add("Control");
      if (e.altKey) mods.add("Alt");
      if (e.shiftKey) mods.add("Shift");

      // Escape cancels
      if (e.key === "Escape" && mods.size === 0) {
        cancel();
        return;
      }

      // If we have modifiers and a non-modifier key, record the combo
      const shortcut = keyToTauri(e);
      if (shortcut) {
        setPreview(shortcut);
        setState("recording");
        // Immediately confirm
        onChange(shortcut);
        setState("success");
        setTimeout(() => setState("idle"), 1200);
        return;
      }

      // Show partial feedback: just modifiers held
      setHeldMods(mods);
      const partial = [...mods]
        .map((m) => MOD_LABELS[m] || m)
        .join(" + ");
      setPreview(partial + " + …");
      setState("listening");
    };

    const onKeyUp = (e: KeyboardEvent) => {
      // If user releases all modifiers without pressing a key, stay in listening
      const mods = new Set(heldMods);
      if (e.key === "Meta") mods.delete("Meta");
      if (e.key === "Control") mods.delete("Control");
      if (e.key === "Alt") mods.delete("Alt");
      if (e.key === "Shift") mods.delete("Shift");
      setHeldMods(mods);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [state, heldMods, cancel, onChange]);

  const displayValue = state === "idle" && value ? formatShortcut(value) : null;
  const displayPreview = preview ? formatShortcut(preview) : null;

  return (
    <div ref={containerRef} className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">{label}</div>
          {description && <p className="text-[11.5px] text-ink-muted mt-0.5">{description}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Keybind display pill */}
          <div
            className={cn(
              "inline-flex h-8 min-w-[100px] items-center justify-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-medium transition-colors duration-200",
              state === "success"
                ? "border-success/30 bg-success/10 text-success"
                : state !== "idle"
                  ? "border-line-strong bg-paper text-ink animate-pulse"
                  : value
                    ? "border-line bg-paper text-ink"
                    : "border-dashed border-line bg-paper text-ink-faint",
            )}
          >
            {state === "success"
              ? "✓ Saved"
              : displayPreview
                ? displayPreview
                : displayValue
                  ? displayValue
                  : state === "listening"
                    ? "Press shortcut…"
                    : "Not set"}
          </div>

          {/* Edit / Cancel button */}
          {state === "idle" ? (
            <button
              type="button"
              onClick={startListening}
              className="press ring-focus inline-flex h-8 items-center rounded-lg border border-line bg-paper px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-paper-sunken"
            >
              Edit
            </button>
          ) : (
            <button
              type="button"
              onClick={cancel}
              className="press ring-focus inline-flex h-8 items-center rounded-lg border border-line bg-paper px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-paper-sunken"
            >
              Cancel
            </button>
          )}

          {/* Delete button */}
          {state === "idle" && value && (
            <button
              type="button"
              onClick={() => onChange("")}
              className="press ring-focus inline-flex h-8 items-center rounded-lg px-3 text-[12.5px] font-medium text-error transition-colors hover:bg-error/10"
              title="Remove shortcut"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
