import { useEffect, useRef, useState } from "react";
import { useApp } from "../../lib/store";
import type { ScheduledTask } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button, Dialog, Field, Segmented, Switch, inputClass } from "../page/Page";
import { ALL_DAYS, WEEKDAYS, describeSchedule, sameDays } from "./describe";

const DAY_LETTERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MIN_INTERVAL_MINUTES = 15;

type Repeat = "daily" | "weekdays" | "days" | "interval";
type Unit = "minutes" | "hours";

/** What a new task starts from: a blank form or one of the starter ideas. */
export interface ScheduleDraft {
  title: string;
  prompt: string;
  daily_time?: string;
  daily_weekdays?: number[];
  interval_minutes?: number;
}

function initialRepeat(src: ScheduleDraft | ScheduledTask | null | undefined): Repeat {
  if (src?.interval_minutes) return "interval";
  const days = src?.daily_weekdays ?? WEEKDAYS;
  if (days.length === 0 || sameDays(days, ALL_DAYS)) return "daily";
  if (sameDays(days, WEEKDAYS)) return "weekdays";
  return "days";
}

export function ScheduleModal({
  task,
  initial,
  onClose,
}: {
  task: ScheduledTask | null;
  initial?: ScheduleDraft;
  onClose: () => void;
}) {
  const createSchedule = useApp((s) => s.createSchedule);
  const updateSchedule = useApp((s) => s.updateSchedule);
  const src = task ?? initial ?? null;

  const [title, setTitle] = useState(src?.title ?? "");
  const [prompt, setPrompt] = useState(src?.prompt ?? "");
  const [repeat, setRepeat] = useState<Repeat>(initialRepeat(src));
  const [time, setTime] = useState(src?.daily_time ?? "09:00");
  const [days, setDays] = useState<number[]>(() => {
    const d = src?.daily_weekdays ?? [];
    return d.length && !sameDays(d, ALL_DAYS) && !sameDays(d, WEEKDAYS) ? d : [1];
  });
  const startMinutes = src?.interval_minutes ?? 60;
  const [unit, setUnit] = useState<Unit>(startMinutes % 60 === 0 ? "hours" : "minutes");
  const [amount, setAmount] = useState(String(startMinutes % 60 === 0 ? startMinutes / 60 : startMinutes));
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const intervalMinutes = Math.round(Number(amount) * (unit === "hours" ? 60 : 1));
  const chosenDays = repeat === "daily" ? ALL_DAYS : repeat === "weekdays" ? WEEKDAYS : days;
  const trigger =
    repeat === "interval"
      ? { interval_minutes: intervalMinutes, daily_time: null, daily_weekdays: null }
      : { interval_minutes: null, daily_time: time, daily_weekdays: [...chosenDays].sort((a, b) => a - b) };

  const timingProblem =
    repeat === "interval"
      ? !Number.isFinite(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES
        ? "Pick 15 minutes or more."
        : null
      : !/^\d{2}:\d{2}$/.test(time)
        ? "Pick a time."
        : chosenDays.length === 0
          ? "Pick at least one day."
          : null;
  const canSave = title.trim().length > 0 && prompt.trim().length > 0 && !timingProblem;

  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (task) {
        await updateSchedule(task.id, { title: title.trim(), prompt: prompt.trim(), enabled, ...trigger });
      } else {
        const body =
          trigger.interval_minutes !== null
            ? { interval_minutes: trigger.interval_minutes }
            : { daily_time: trigger.daily_time!, daily_weekdays: trigger.daily_weekdays! };
        const res = await createSchedule({ title: title.trim(), prompt: prompt.trim(), enabled, ...body });
        if (res?.error) {
          setError(res.error);
          return;
        }
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={task ? "Edit scheduled task" : "New scheduled task"}
      description="zWork does this on its own at the times you pick and puts what it finds in your Inbox."
      onClose={onClose}
      width={520}
      footer={
        <>
          {task && (
            <label className="mr-auto flex items-center gap-2 text-[12.5px] text-ink-muted">
              <Switch checked={enabled} onChange={() => setEnabled((v) => !v)} label="Run on schedule" />
              {enabled ? "On" : "Paused"}
            </label>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave || busy} onClick={() => void save()}>
            {busy ? "Saving…" : task ? "Save changes" : "Create task"}
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="schedule-title">
        <input
          id="schedule-title"
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Morning email summary"
          className={inputClass}
        />
      </Field>

      <Field
        label="What should zWork do?"
        htmlFor="schedule-prompt"
        hint="Write it as if you were asking for the first time. Each run starts fresh and doesn't see your other chats."
      >
        <textarea
          id="schedule-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          placeholder="Look through the emails I got since yesterday. List the ones that need a reply, who sent them and what they need."
          className={cn(inputClass, "resize-none leading-relaxed")}
        />
      </Field>

      <Field label="When">
        <Segmented
          label="How often"
          value={repeat}
          onChange={setRepeat}
          options={[
            { value: "daily", label: "Every day" },
            { value: "weekdays", label: "Weekdays" },
            { value: "days", label: "Some days" },
            { value: "interval", label: "Every few hours" },
          ]}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {repeat === "interval" ? (
            <>
              <span className="text-[12.5px] text-ink-muted">Every</span>
              <input
                type="number"
                aria-label="How many"
                min={unit === "hours" ? 1 : MIN_INTERVAL_MINUTES}
                step={unit === "hours" ? 1 : 5}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={cn(inputClass, "w-20")}
              />
              <select
                aria-label="Unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value as Unit)}
                className={cn(inputClass, "w-auto pr-8")}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </>
          ) : (
            <>
              {repeat === "days" &&
                DAY_LETTERS.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={days.includes(i)}
                    onClick={() => toggleDay(i)}
                    className={cn(
                      "press ring-focus h-8 rounded-lg border px-2.5 text-[12px] font-medium transition-colors",
                      days.includes(i)
                        ? "border-transparent bg-ink text-paper"
                        : "border-line bg-paper text-ink-muted hover:border-line-strong hover:text-ink",
                    )}
                  >
                    {d}
                  </button>
                ))}
              <span className="text-[12.5px] text-ink-muted">at</span>
              <input
                type="time"
                aria-label="Time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={cn(inputClass, "w-auto")}
              />
            </>
          )}
        </div>
        <p className={cn("mt-2 text-[11.5px]", timingProblem ? "text-error" : "text-ink-faint")}>
          {timingProblem ??
            `${describeSchedule(trigger)}, while zWork is open and your computer is awake.`}
        </p>
      </Field>

      {error && (
        <p role="alert" className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-[12.5px] text-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
