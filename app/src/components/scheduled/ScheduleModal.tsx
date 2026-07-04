/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useApp } from "../../lib/store";
import type { ScheduledTask } from "../../lib/api";
import { cn } from "../../lib/cn";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type TriggerMode = "interval" | "daily";

export function ScheduleModal({
  task,
  onClose,
}: {
  task: ScheduledTask | null;
  onClose: () => void;
}) {
  const createSchedule = useApp((s) => s.createSchedule);
  const updateSchedule = useApp((s) => s.updateSchedule);

  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(
    task?.interval_minutes ? "interval" : task?.daily_time ? "daily" : "daily",
  );
  const [intervalMinutes, setIntervalMinutes] = useState(
    String(task?.interval_minutes ?? 30),
  );
  const [dailyTime, setDailyTime] = useState(task?.daily_time ?? "09:00");
  const [dailyWeekdays, setDailyWeekdays] = useState<number[]>(
    task?.daily_weekdays ?? [1, 2, 3, 4, 5],
  );
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleWeekday = (day: number) => {
    setDailyWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  };

  const canSave =
    title.trim().length > 0 &&
    prompt.trim().length > 0 &&
    (triggerMode === "interval"
      ? Number(intervalMinutes) >= 15
      : /^\d{2}:\d{2}$/.test(dailyTime));

  const handleSave = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);

    try {
      if (task) {
        // Edit mode — send only the trigger that's active, clearing the other.
        await updateSchedule(task.id, {
          title: title.trim(),
          prompt: prompt.trim(),
          enabled,
          ...(triggerMode === "interval"
            ? { interval_minutes: Number(intervalMinutes), daily_time: null, daily_weekdays: null }
            : { interval_minutes: null, daily_time: dailyTime, daily_weekdays: dailyWeekdays }),
        });
      } else {
        // Create mode.
        const res = await createSchedule({
          title: title.trim(),
          prompt: prompt.trim(),
          enabled,
          ...(triggerMode === "interval"
            ? { interval_minutes: Number(intervalMinutes) }
            : { daily_time: dailyTime, daily_weekdays: dailyWeekdays }),
        });
        if (res?.error) {
          setError(res.error);
          setBusy(false);
          return;
        }
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-ink/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] rounded-2xl border border-line bg-paper-raised shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[14px] font-semibold text-ink">
            {task ? "Edit scheduled task" : "New scheduled task"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="press ring-focus rounded-lg p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-5 py-4">
          {/* Title */}
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-ink-muted">
              Title
            </label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Email invoice check"
              className="ring-focus w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
          </div>

          {/* Prompt */}
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-ink-muted">
              What should the agent do each run?
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Be specific and self-contained — the agent has no memory of this conversation during a scheduled run. E.g. 'Check the Gmail inbox for invoices received since the last run. Extract vendor, amount, and due date. Flag any amount over $1000.'"
              className="ring-focus w-full resize-none rounded-lg border border-line bg-paper px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-ink-faint">
              The agent runs this fresh each time and posts findings to your Inbox.
            </p>
          </div>

          {/* Trigger mode toggle */}
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-ink-muted">
              Schedule
            </label>
            <div className="inline-flex rounded-lg border border-line bg-paper p-0.5">
              <button
                type="button"
                onClick={() => setTriggerMode("interval")}
                className={cn(
                  "press ring-focus rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                  triggerMode === "interval"
                    ? "bg-ink text-paper"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                Repeat every
              </button>
              <button
                type="button"
                onClick={() => setTriggerMode("daily")}
                className={cn(
                  "press ring-focus rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                  triggerMode === "daily"
                    ? "bg-ink text-paper"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                Daily at
              </button>
            </div>

            {/* Trigger config */}
            <div className="mt-2.5">
              {triggerMode === "interval" ? (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={15}
                    step={5}
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(e.target.value)}
                    className="ring-focus w-24 rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink focus:border-line-strong focus:outline-none"
                  />
                  <span className="text-[12.5px] text-ink-muted">minutes</span>
                  <span className="text-[11px] text-ink-faint">
                    (min 15)
                  </span>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <input
                    type="time"
                    value={dailyTime}
                    onChange={(e) => setDailyTime(e.target.value)}
                    className="ring-focus rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink focus:border-line-strong focus:outline-none"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((day, i) => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleWeekday(i)}
                        className={cn(
                          "press ring-focus rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                          dailyWeekdays.includes(i)
                            ? "bg-ink text-paper"
                            : "border border-line bg-paper text-ink-muted hover:bg-paper-sunken",
                        )}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-ink-faint">
                    {dailyWeekdays.length === 0
                      ? "Select at least one day"
                      : `${dailyWeekdays.length} day${dailyWeekdays.length === 1 ? "" : "s"} selected`}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Enabled toggle */}
          {task && (
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 accent-ink"
              />
              <span className="text-[12.5px] text-ink-muted">
                Active (runs on schedule)
              </span>
            </label>
          )}

          {error && (
            <div className="rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-[12px] text-error">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="press ring-focus inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-paper-sunken"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || busy}
            className={cn(
              "press ring-focus inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink/90",
              (!canSave || busy) && "cursor-not-allowed opacity-50 hover:bg-ink",
            )}
          >
            {busy ? "Saving…" : task ? "Save changes" : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}
