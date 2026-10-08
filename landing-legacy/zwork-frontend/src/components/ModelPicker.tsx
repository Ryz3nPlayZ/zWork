import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, AlertCircle, Plus } from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";

export function ModelPicker() {
  const model = useApp((s) => s.model);
  const setModel = useApp((s) => s.setModel);
  const providers = useApp((s) => s.providers);
  const setView = useApp((s) => s.setView);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const models = providers?.models ?? [];
  const current = models.find((m) => m.id === model);
  const displayName = current?.name ?? (models.length === 0 ? "No models" : "Choose model");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "press ring-focus inline-flex items-center gap-1.5 rounded-full border border-line bg-paper",
          "pl-2.5 pr-2 py-1 text-[12px] font-medium text-ink",
          "hover:bg-paper-sunken hover:border-line-strong",
        )}
      >
        <span className="max-w-[200px] truncate">{displayName}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-ink-muted transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-[calc(100%+8px)] right-0 z-40 w-[320px] animate-fade-in rounded-xl border border-line bg-paper p-1 shadow-pop"
        >
          <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Model
          </div>

          {models.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-ink-muted">
              No models configured.{" "}
              <button
                type="button"
                className="text-ink underline underline-offset-2"
                onClick={() => { setOpen(false); setView("settings"); }}
              >
                Add one in Settings
              </button>
            </div>
          )}

          {models.map((m) => {
            const selected = m.id === model;
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={selected}
                disabled={!m.configured}
                onClick={() => {
                  if (!m.configured) return;
                  setModel(m.id);
                  setOpen(false);
                }}
                className={cn(
                  "press group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
                  "hover:bg-paper-sunken",
                  selected && "bg-paper-sunken",
                  !m.configured && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] font-medium text-ink truncate">
                    {m.name}
                  </span>
                  <span className="block text-[11px] text-ink-muted truncate">
                    {m.subtitle}
                    {!m.configured && " · no key"}
                  </span>
                </span>
                {!m.configured ? (
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                ) : selected ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-ink" />
                ) : null}
              </button>
            );
          })}

          <div className="mt-1 border-t border-line pt-1">
            <button
              type="button"
              onClick={() => { setOpen(false); setView("settings"); }}
              className="press flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" />
              Add custom model
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
