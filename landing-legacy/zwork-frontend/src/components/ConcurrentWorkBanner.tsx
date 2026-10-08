import { ChevronDown, ChevronUp, Bot, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { useState } from "react";
import { useApp, type SubagentTask } from "../lib/store";
import { cn } from "../lib/cn";

export function ConcurrentWorkBanner() {
  const subagents = useApp((s) => s.subagents);
  const [expanded, setExpanded] = useState(false);

  if (subagents.length === 0) return null;

  const runningCount = subagents.filter((s) => s.status === "running").length;
  const completedCount = subagents.filter((s) => s.status === "completed").length;
  const failedCount = subagents.filter((s) => s.status === "failed").length;

  return (
    <div className="mx-auto mb-4 max-w-3xl">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "press w-full rounded-xl border border-line bg-paper-raised px-4 py-3",
          "transition-shadow hover:shadow-pop",
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Bot className="h-5 w-5 text-ink" />
              {runningCount > 0 && (
                <Loader2 className="absolute -right-1 -top-1 h-3 w-3 animate-spin text-brand" />
              )}
            </div>
            <div className="text-left">
              <div className="text-sm font-medium text-ink">
                {runningCount > 0
                  ? `Working on ${subagents.length} task${subagents.length > 1 ? "s" : ""}...`
                  : `Completed ${subagents.length} task${subagents.length > 1 ? "s" : ""}`}
              </div>
              <div className="text-xs text-ink-faint">
                {completedCount > 0 && `${completedCount} done`}
                {completedCount > 0 && runningCount > 0 && " • "}
                {runningCount > 0 && `${runningCount} in progress`}
                {failedCount > 0 && (runningCount > 0 || completedCount > 0) && " • "}
                {failedCount > 0 && `${failedCount} failed`}
              </div>
            </div>
          </div>
          {expanded ? (
            <ChevronUp className="h-5 w-5 text-ink-faint" />
          ) : (
            <ChevronDown className="h-5 w-5 text-ink-faint" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 rounded-xl border border-line bg-paper px-4 py-3">
          {subagents.map((task) => (
            <SubagentRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubagentRow({ task }: { task: SubagentTask }) {
  const [showOutput, setShowOutput] = useState(false);

  return (
    <div className="rounded-lg border border-line/50 bg-paper-subtle px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {task.status === "running" && (
            <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-brand mt-0.5" />
          )}
          {task.status === "completed" && (
            <CheckCircle className="h-4 w-4 flex-shrink-0 text-success mt-0.5" />
          )}
          {task.status === "failed" && (
            <XCircle className="h-4 w-4 flex-shrink-0 text-critical mt-0.5" />
          )}
          <span className="truncate text-sm text-ink">{task.description}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {task.activityCount !== undefined && task.activityCount > 0 && (
            <span className="text-xs text-ink-faint">{task.activityCount} steps</span>
          )}
          {(task.result || task.error) && (
            <button
              type="button"
              onClick={() => setShowOutput((v) => !v)}
              className="text-xs text-link hover:underline"
            >
              {showOutput ? "Hide" : "Show"} result
            </button>
          )}
        </div>
      </div>
      {showOutput && (task.result || task.error) && (
        <div className="mt-2 rounded-md bg-paper-sunken p-2 text-xs">
          {task.error ? (
            <span className="text-critical">{task.error}</span>
          ) : (
            <span className="text-ink-dim whitespace-pre-wrap">{task.result}</span>
          )}
        </div>
      )}
    </div>
  );
}
