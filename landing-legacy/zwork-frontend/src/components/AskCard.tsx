import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "../lib/cn";

export interface AskOption {
  label: string;
  description: string;
}

export interface AskPayload {
  question: string;
  options: AskOption[];
  allow_other?: boolean;
  allow_multiple?: boolean;
}

interface AskCardProps {
  payload: AskPayload;
  onSubmit: (choice: string) => void;
  submitted?: boolean;
  chosenLabel?: string;
}

export function AskCard({ payload, onSubmit, submitted, chosenLabel }: AskCardProps) {
  const multi = payload.allow_multiple ?? false;
  const [selected, setSelected] = useState<Set<string>>(
    chosenLabel ? new Set([chosenLabel]) : new Set(),
  );
  const [other, setOther] = useState("");
  const [otherActive, setOtherActive] = useState(false);

  function toggle(label: string) {
    if (submitted) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (multi) {
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      return next;
    });
  }

  function submit() {
    if (submitted) return;
    const parts: string[] = [];
    selected.forEach((l) => parts.push(l));
    if (otherActive && other.trim()) parts.push(other.trim());
    if (parts.length === 0) return;
    onSubmit(parts.join(", "));
  }

  return (
    <div className={cn(
      "my-2 rounded-xl border border-line bg-paper-sunken p-4 shadow-sm",
      submitted && "opacity-70",
    )}>
      <p className="mb-3 text-[13px] font-medium text-ink leading-snug">
        {payload.question}
      </p>

      <div className="flex flex-col gap-1.5">
        {payload.options.map((opt) => {
          const active = selected.has(opt.label);
          return (
            <button
              key={opt.label}
              type="button"
              disabled={submitted}
              onClick={() => toggle(opt.label)}
                className={cn(
                "press flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-line-strong bg-paper-sunken shadow-sm"
                  : "border-line hover:border-line-strong hover:bg-paper",
                submitted && "cursor-default",
              )}
            >
              <span className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                multi ? "rounded" : "rounded-full",
                active ? "border-line-strong bg-paper-raised text-ink" : "border-line-strong bg-paper",
              )}>
                {active && <Check className="h-2.5 w-2.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-semibold text-ink">
                  {opt.label}
                </span>
                {opt.description && (
                  <span className="block text-[11.5px] text-ink-muted leading-snug mt-0.5">
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        {payload.allow_other && !submitted && (
          <button
            type="button"
            onClick={() => setOtherActive((v) => !v)}
            className={cn(
              "press flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
              otherActive
                ? "border-line-strong bg-paper-sunken shadow-sm"
                : "border-line hover:border-line-strong hover:bg-paper",
            )}
          >
            <span className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
              otherActive ? "border-line-strong bg-paper-raised text-ink" : "border-line-strong bg-paper",
            )}>
              {otherActive && <Check className="h-2.5 w-2.5" />}
            </span>
            <span className="text-[12px] text-ink-muted">Other…</span>
          </button>
        )}

        {otherActive && !submitted && (
          <textarea
            className="mt-1 w-full resize-none rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] text-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
            rows={2}
            placeholder="Type your answer…"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
        )}
      </div>

      {!submitted && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={selected.size === 0 && !(otherActive && other.trim())}
            onClick={submit}
            className={cn(
              "press rounded-full px-4 py-1.5 text-[12px] font-semibold transition-colors",
              "border border-line bg-paper-sunken text-ink hover:bg-paper hover:border-line-strong",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            Submit
          </button>
        </div>
      )}

      {submitted && (
        <div className="mt-2 text-[11.5px] text-ink-muted">
          Responded: <span className="font-medium text-ink">{chosenLabel}</span>
        </div>
      )}
    </div>
  );
}

export function parseAskPayload(text: string): AskPayload | null {
  const m = text.match(/<<ASK>>([\s\S]*?)<<\/ASK>>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim()) as AskPayload;
  } catch {
    return null;
  }
}

export function splitAroundAsk(
  content: string,
): Array<{ type: "text" | "ask"; value: string }> {
  const parts: Array<{ type: "text" | "ask"; value: string }> = [];
  const re = /<<ASK>>[\s\S]*?<<\/ASK>>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) parts.push({ type: "text", value: content.slice(last, m.index) });
    parts.push({ type: "ask", value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < content.length) parts.push({ type: "text", value: content.slice(last) });
  return parts;
}
