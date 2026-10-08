import { Logo } from "../Logo";
import type { DemoActivity } from "../../demos/types";

export function DemoUserMessage({
  text,
  showCursor,
}: {
  text: string;
  showCursor?: boolean;
}) {
  return (
    <div className="group flex w-full justify-end animate-fade-in">
      <div className="max-w-[85%] min-w-0">
        <div className="rounded-2xl rounded-br-md bg-paper-raised border border-line px-3.5 py-2.5 text-[14px] leading-6 text-ink break-words">
          {text}
          {showCursor && (
            <span className="inline-block h-[1em] w-[2px] align-middle bg-ink animate-pulse ml-0.5" />
          )}
        </div>
      </div>
    </div>
  );
}

export function DemoAssistantMessage({
  activities,
  visibleCount,
  showWorking,
  children,
}: {
  activities: DemoActivity[];
  visibleCount: number;
  showWorking?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="group flex w-full gap-3 justify-start animate-fade-in">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-paper">
        <Logo size={14} />
      </div>
      <div className="min-w-0 flex-1 max-w-[92%]">
        {activities.slice(0, visibleCount).map((step) => (
          <div key={step.id} className="mb-2 animate-fade-in">
            <DemoActivityBlock label={step.label} done={step.done} />
          </div>
        ))}

        {showWorking && (
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink-faint">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-ink-faint/70 animate-pulse" />
            <span className="shimmer-text">Working...</span>
          </p>
        )}

        {children}
      </div>
    </div>
  );
}

function DemoActivityBlock({ label, done }: { label: string; done?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors ${
        done
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-line bg-paper-sunken text-ink"
      }`}
    >
      <svg
        className={`h-3.5 w-3.5 shrink-0 ${
          done ? "text-emerald-600" : "text-ink-muted"
        }`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13 10V3L4 14h7v7l9-11h-7z"
        />
      </svg>
      <span className="flex-1 truncate">{label}</span>
      {done && (
        <svg
          className="ml-auto h-3.5 w-3.5 text-emerald-600"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4.5 12.75l6 6 9-13.5"
          />
        </svg>
      )}
      {!done && (
        <div className="h-1 w-16 overflow-hidden rounded-full bg-line">
          <div className="h-full w-full animate-shimmer rounded-full bg-gradient-to-r from-transparent via-ink/20 to-transparent bg-[length:200%_100%]" />
        </div>
      )}
    </div>
  );
}
