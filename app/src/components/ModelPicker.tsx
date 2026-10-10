import { useEffect, useRef, useState, useCallback } from "react";
import { Check, ChevronDown, AlertCircle, Plus, Lock } from "lucide-react";
import { cn } from "../lib/cn";
import { IS_WEB } from "../lib/api";
import { fetchAnalyticsSummary, getCloudToken } from "../lib/cloud";
import { useApp, EFFORTS } from "../lib/store";

/**
 * Hosted tiers: how much of the allowance a message uses next to Flash
 * (from typical-task cost at floor prices), and the plan that unlocks it.
 * Free users get Flash plus a few Pro messages a month.
 */
const HOSTED_TIERS: Record<string, { multiplier: string; plan: 0 | 1 | 2 }> = {
  "zwork-flash": { multiplier: "1×", plan: 0 },
  "zwork-pro": { multiplier: "10×", plan: 0 },
  "zwork-ultra": { multiplier: "6×", plan: 1 },
  "zwork-apex": { multiplier: "15×", plan: 2 },
};
const PLAN_RANK = { free: 0, pro: 1, max: 2 } as const;
const PLAN_NAME = ["Free", "Pro", "Max"] as const;

export function ModelPicker() {
  const model = useApp((s) => s.model);
  const setModel = useApp((s) => s.setModel);
  const providers = useApp((s) => s.providers);
  const setView = useApp((s) => s.setView);
  const effort = useApp((s) => s.effort);
  const setEffort = useApp((s) => s.setEffort);
  const plan = PLAN_RANK[useApp((s) => s.user?.tier) ?? "free"];

  const [open, setOpen] = useState(false);
  const [dropDown, setDropDown] = useState(false);
  const [freeProLeft, setFreeProLeft] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const updateDirection = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    // Open toward whichever side has more room; the list scrolls past that.
    setDropDown(window.innerHeight - rect.bottom > rect.top);
  }, []);

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

  // Free users see how many Pro messages are left this month.
  useEffect(() => {
    if (!open || plan > 0 || IS_WEB || !getCloudToken()) return;
    let live = true;
    fetchAnalyticsSummary()
      .then((s) => { if (live) setFreeProLeft(s.free_pro_messages_left ?? null); })
      .catch(() => {});
    return () => { live = false; };
  }, [open, plan]);

  const models = providers?.models ?? [];
  const current = models.find((m) => m.id === model);
  const displayName = current?.name ?? (models.length === 0 ? "No models" : "Choose model");
  const effortLabel = EFFORTS.find((e) => e.id === effort)?.label ?? "Medium";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => { updateDirection(); setOpen((v) => !v); }}
        className={cn(
          "press ring-focus inline-flex items-center gap-1.5 rounded-full border border-line bg-paper",
          "pl-2.5 pr-2 py-1 text-[12px] font-medium text-ink",
          "hover:bg-paper-sunken hover:border-line-strong",
        )}
      >
        <span className="max-w-[200px] truncate">{displayName}</span>
        <span className="hidden text-ink-faint sm:inline">{effortLabel}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-ink-muted transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute right-0 z-40 w-[320px] max-h-[min(480px,calc(50vh-32px))] overflow-y-auto animate-fade-in rounded-xl border border-line bg-paper p-1 shadow-pop",
            dropDown ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]",
          )}
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
            const hosted = HOSTED_TIERS[m.id];
            const locked = !!hosted && plan < hosted.plan;
            const proUsedUp = m.id === "zwork-pro" && plan === 0 && freeProLeft === 0;
            const disabled = !m.configured || locked || proUsedUp;
            let note = "";
            if (locked) note = `${PLAN_NAME[hosted.plan]} plan`;
            else if (m.id === "zwork-pro" && plan === 0 && freeProLeft !== null) note = `${freeProLeft} left this month`;
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={selected}
                aria-disabled={disabled}
                onClick={() => {
                  if (locked) { setOpen(false); setView("plan"); return; }
                  if (disabled) return;
                  setModel(m.id);
                  setOpen(false);
                }}
                className={cn(
                  "press group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
                  "hover:bg-paper-sunken",
                  selected && "bg-paper-sunken",
                  disabled && !locked && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                <span className={cn("flex-1 min-w-0", locked && "opacity-55")}>
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium text-ink">{m.name}</span>
                    {hosted && (
                      <span className="shrink-0 rounded-full bg-paper-sunken px-1.5 py-px text-[10px] font-medium tabular-nums text-ink-muted">
                        {hosted.multiplier}
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] text-ink-muted truncate">
                    {m.subtitle}
                    {note && ` · ${note}`}
                    {!m.configured && !m.subtitle?.includes("sign in") && " · needs a key"}
                  </span>
                </span>
                {locked ? (
                  <Lock className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                ) : !m.configured ? (
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                ) : selected ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-ink" />
                ) : null}
              </button>
            );
          })}

          <div className="mt-1 border-t border-line px-2.5 pt-2.5 pb-2">
            <div className="pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Effort
            </div>
            <div role="radiogroup" aria-label="Effort" className="grid grid-cols-5 gap-0.5 rounded-lg bg-paper-sunken p-0.5">
              {EFFORTS.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="radio"
                  aria-checked={effort === e.id}
                  onClick={() => setEffort(e.id)}
                  className={cn(
                    "press rounded-md py-1 text-[11.5px] font-medium transition-colors",
                    effort === e.id ? "bg-paper text-ink shadow-sm" : "text-ink-muted hover:text-ink",
                  )}
                >
                  {e.label}
                </button>
              ))}
            </div>
            <div className="pt-1.5 text-[10.5px] leading-4 text-ink-faint">
              Higher effort thinks longer and uses more of your allowance.
            </div>
          </div>

          <div className="border-t border-line pt-1">
            {IS_WEB ? (
              <div className="px-2.5 py-2 text-[11.5px] text-ink-muted">
                Pro, Ultra and the rest of the lineup are in the desktop app.
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setOpen(false); setView("settings"); }}
                className="press flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
              >
                <Plus className="h-3.5 w-3.5" />
                Add custom model
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
