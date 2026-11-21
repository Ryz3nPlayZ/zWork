import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../../lib/store";
import type { ScheduledTask } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button, Dialog, Switch } from "../page/Page";
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
  crew_id?: string;
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
  const crew = useApp((s) => s.crew);
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
  const [crewId, setCrewId] = useState(src?.crew_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
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
  const name = title.trim() || nameFrom(prompt);
  const canSave = prompt.trim().length > 0 && !timingProblem;
  const selectedCrewId = crew.some((member) => member.id === crewId) ? crewId : "";

  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (task) {
        await updateSchedule(task.id, { title: name, prompt: prompt.trim(), enabled, crew_id: selectedCrewId, ...trigger });
      } else {
        const body =
          trigger.interval_minutes !== null
            ? { interval_minutes: trigger.interval_minutes }
            : { daily_time: trigger.daily_time!, daily_weekdays: trigger.daily_weekdays! };
        const res = await createSchedule({ title: name, prompt: prompt.trim(), enabled, crew_id: selectedCrewId, ...body });
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
            {busy ? "Saving…" : task ? "Save changes" : "Schedule it"}
          </Button>
        </>
      }
    >
      <input
        aria-label="Task name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={prompt.trim() ? nameFrom(prompt) : "Name this task"}
        className="ring-focus -mx-1 w-[calc(100%+8px)] rounded-lg bg-transparent px-1 py-0.5 text-[16px] font-semibold text-ink placeholder:text-ink-faint focus:outline-none"
      />

      <div>
        <textarea
          ref={promptRef}
          aria-label="What zWork should do"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="Look through the emails I got since yesterday. List the ones that need a reply, who sent them and what they need."
          className="ring-focus w-full resize-none rounded-xl bg-paper-sunken px-3.5 py-3 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <p className="mt-1.5 text-[11.5px] text-ink-faint">Each run starts fresh, so say everything it needs to know.</p>
      </div>

      <div>
        <div className="divide-y divide-line rounded-xl border border-line">
          <Row label="Repeat">
            <select aria-label="Repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} className={quietSelect}>
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="days">Some days</option>
              <option value="interval">Every few hours</option>
            </select>
          </Row>
          {repeat === "days" && (
            <Row label="Days">
              <div className="flex flex-wrap justify-end gap-1">
                {DAY_LETTERS.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={days.includes(i)}
                    onClick={() => toggleDay(i)}
                    className={cn(
                      "press ring-focus h-7 rounded-full px-2.5 text-[12px] font-medium transition-colors",
                      days.includes(i) ? "bg-ink text-paper" : "text-ink-muted hover:bg-state-hover hover:text-ink",
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </Row>
          )}
          {repeat === "interval" ? (
            <Row label="Every">
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  aria-label="How many"
                  min={unit === "hours" ? 1 : MIN_INTERVAL_MINUTES}
                  step={unit === "hours" ? 1 : 5}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={cn(quietSelect, "w-14 text-right")}
                />
                <select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={quietSelect}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
            </Row>
          ) : (
            <Row label="Time">
              <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} className={quietSelect} />
            </Row>
          )}
          <Row label="Crew member">
            <select aria-label="Crew member" value={selectedCrewId} onChange={(e) => setCrewId(e.target.value)} className={cn(quietSelect, "max-w-48")}>
              <option value="">None</option>
              {crew.map((member) => (
                <option key={member.id} value={member.id}>{member.name}</option>
              ))}
            </select>
          </Row>
        </div>
        <p className={cn("mt-1.5 text-[11.5px]", timingProblem ? "text-error" : "text-ink-faint")}>
          {timingProblem ?? `${describeSchedule(trigger)}, while zWork is open and your computer is awake. Results go to your Inbox.`}
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-[12.5px] text-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}

const quietSelect =
  "ring-focus rounded-lg bg-transparent px-2 py-1 text-[13px] text-ink-soft transition-colors hover:bg-state-hover hover:text-ink focus:outline-none";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 py-1.5 pl-3.5 pr-1.5">
      <span className="shrink-0 text-[13px] text-ink">{label}</span>
      {children}
    </div>
  );
}

/** A name for a task the user didn't name: its first few words. */
// shortcut: first six words of the plan, upgrade to a model-written title if these read badly.
export function nameFrom(prompt: string): string {
  const words = prompt.trim().replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "");
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}
