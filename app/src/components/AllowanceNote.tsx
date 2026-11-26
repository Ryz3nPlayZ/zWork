import { Hourglass } from "lucide-react";
import { refillLabel, type Allowance } from "../lib/allowance";

const windowName = (w: "week" | "hours") => (w === "week" ? "this week's" : "your 5-hour");

/**
 * The plan allowance, above the message box. Out: a calm note led by when
 * work can resume, not a warning. Near: one quiet line with a meter, no box.
 */
export function AllowanceNote({
  allowance,
  onSeeUsage,
  onUpgrade,
}: {
  allowance: Allowance;
  onSeeUsage: () => void;
  onUpgrade: () => void;
}) {
  if (allowance.kind === "near") {
    return (
      <div role="status" className="mx-4 mt-3 flex items-center gap-2 text-[12px] text-ink-faint">
        <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-line" aria-hidden>
          <span className="block h-full rounded-full bg-ink-muted" style={{ width: `${allowance.percent}%` }} />
        </span>
        <span className="min-w-0 truncate">{`${allowance.percent}% of ${windowName(allowance.window)} allowance used`}</span>
        <button
          type="button"
          onClick={onSeeUsage}
          className="press ring-focus ml-auto shrink-0 rounded-md px-1 transition-colors hover:text-ink"
        >
          See usage
        </button>
      </div>
    );
  }
  return (
    <div role="status" className="mx-3 mt-3 flex items-center gap-3 rounded-xl bg-ink/[0.045] py-2.5 pl-3 pr-2.5">
      <Hourglass className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
      <div className="min-w-0 flex-1 leading-5">
        <p className="text-[13px] font-medium text-ink">
          {allowance.refillsAt
            ? `You can start new tasks again ${refillLabel(allowance.refillsAt)}.`
            : "You can't start new tasks for now."}
        </p>
        <p className="text-[12px] text-ink-muted">
          {`You've used ${windowName(allowance.window)} allowance.`}
          {!allowance.refillsAt && (allowance.window === "week"
            ? " It frees up as older use passes seven days."
            : " It frees up over the next few hours.")}
        </p>
      </div>
      <button
        type="button"
        onClick={onSeeUsage}
        className="press ring-focus h-7 shrink-0 rounded-lg px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-state-hover hover:text-ink"
      >
        See usage
      </button>
      {allowance.upgradeTo && (
        <button
          type="button"
          onClick={onUpgrade}
          className="press ring-focus h-7 shrink-0 rounded-lg bg-ink px-2.5 text-[12px] font-medium text-paper transition-colors hover:bg-ink/90"
        >
          {allowance.upgradeTo === "max" ? "Upgrade to Max" : "Upgrade to Pro"}
        </button>
      )}
    </div>
  );
}
