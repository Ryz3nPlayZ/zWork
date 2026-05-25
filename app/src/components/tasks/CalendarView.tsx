import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { cn } from "../../lib/cn";
import type { Task, CalendarEvent } from "../../lib/store";

interface Props {
  tasks: Task[];
  events: CalendarEvent[];
  onTaskClick: (task: Task) => void;
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function addMonths(d: Date, n: number) {
  const copy = new Date(d);
  copy.setMonth(copy.getMonth() + n);
  return copy;
}

function addDays(d: Date, n: number) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toISODate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function CalendarView({ tasks, events, onTaskClick }: Props) {
  const [mode, setMode] = useState<"month" | "week" | "day">("month");
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const goToday = () => {
    const now = new Date();
    if (mode === "month") setCursor(startOfMonth(now));
    else if (mode === "week") {
      const d = new Date(now);
      d.setDate(d.getDate() - d.getDay());
      d.setHours(0, 0, 0, 0);
      setCursor(d);
    } else setCursor(now);
  };
  useEffect(() => {
    const now = new Date();
    if (mode === "month") setCursor(startOfMonth(now));
    else if (mode === "week") {
      const d = new Date(now);
      d.setDate(d.getDate() - d.getDay());
      d.setHours(0, 0, 0, 0);
      setCursor(d);
    } else {
      setCursor(now);
    }
  }, [mode]);

  const goPrev = () => {
    if (mode === "month") setCursor((c) => addMonths(c, -1));
    else if (mode === "week") setCursor((c) => addDays(c, -7));
    else setCursor((c) => addDays(c, -1));
  };
  const goNext = () => {
    if (mode === "month") setCursor((c) => addMonths(c, 1));
    else if (mode === "week") setCursor((c) => addDays(c, 7));
    else setCursor((c) => addDays(c, 1));
  };

  const title = useMemo(() => {
    if (mode === "month") {
      return cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }
    if (mode === "week") {
      const end = addDays(cursor, 6);
      const sameMonth = cursor.getMonth() === end.getMonth();
      const startStr = cursor.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const endStr = end.toLocaleDateString("en-US", { month: sameMonth ? undefined : "short", day: "numeric", year: "numeric" });
      return `${startStr} – ${endStr}`;
    }
    return cursor.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }, [cursor, mode]);

  const calendarDays = useMemo(() => {
    if (mode === "month") {
      const year = cursor.getFullYear();
      const month = cursor.getMonth();
      const total = daysInMonth(year, month);
      const firstDay = new Date(year, month, 1).getDay();
      const days: { date: Date; current: boolean }[] = [];
      const prevMonthDays = daysInMonth(year, month - 1);
      for (let i = firstDay - 1; i >= 0; i--) {
        days.push({ date: new Date(year, month - 1, prevMonthDays - i), current: false });
      }
      for (let i = 1; i <= total; i++) {
        days.push({ date: new Date(year, month, i), current: true });
      }
      const remaining = 42 - days.length;
      for (let i = 1; i <= remaining; i++) {
        days.push({ date: new Date(year, month + 1, i), current: false });
      }
      return days;
    }
    if (mode === "week") {
      const start = cursor;
      const days: { date: Date; current: boolean }[] = [];
      for (let i = 0; i < 7; i++) {
        days.push({ date: addDays(start, i), current: true });
      }
      return days;
    }
    return [{ date: cursor, current: true }];
  }, [cursor, mode]);

  const tasksByDate = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of tasks) {
      if (!t.due_date) continue;
      map[t.due_date] = map[t.due_date] || [];
      map[t.due_date].push(t);
    }
    return map;
  }, [tasks]);

  const eventsByDate = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const e of events) {
      map[e.date] = map[e.date] || [];
      map[e.date].push(e);
    }
    return map;
  }, [events]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goToday}
            className="press rounded-lg border border-line bg-paper px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-paper-sunken"
          >
            Today
          </button>
          <div className="inline-flex rounded-lg border border-line bg-paper">
            <button type="button" onClick={goPrev} className="press rounded-l-lg p-1 text-ink-faint hover:text-ink hover:bg-paper-sunken">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" onClick={goNext} className="press rounded-r-lg p-1 text-ink-faint hover:text-ink hover:bg-paper-sunken">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        </div>
        <div className="inline-flex rounded-lg border border-line bg-paper p-0.5">
          {(["month", "week", "day"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "press rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors",
                mode === m ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {mode === "month" ? (
        <div className="flex flex-col">
          <div className="grid grid-cols-7 border-b border-line">
            {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => (
              <div key={d} className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {calendarDays.map((day, idx) => {
              const iso = toISODate(day.date);
              const dayTasks = tasksByDate[iso] || [];
              const dayEvents = eventsByDate[iso] || [];
              const isToday = isSameDay(day.date, today);
              return (
                <div
                  key={idx}
                  className={cn(
                    "min-h-[100px] border-b border-r border-line p-1.5 transition-colors",
                    !day.current && "bg-paper-soft/50",
                    day.current && "bg-paper"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className={cn(
                      "text-[11px] font-medium",
                      isToday ? "rounded-full bg-ink px-1.5 py-px text-paper" : "text-ink-muted"
                    )}>
                      {day.date.getDate()}
                    </span>
                    {(dayTasks.length + dayEvents.length) > 0 && (
                      <span className="text-[9px] font-semibold text-ink-faint">
                        {dayTasks.length + dayEvents.length}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-col gap-0.5">
                    {dayEvents.map((ev) => (
                      <div
                        key={ev.id}
                        className="truncate rounded border border-line bg-paper-raised px-1 py-px text-[10px] text-ink-muted"
                        title={ev.title}
                      >
                        <Clock className="inline h-2.5 w-2.5 mr-0.5" />
                        {ev.title}
                      </div>
                    ))}
                    {dayTasks.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onTaskClick(t)}
                        className={cn(
                          "truncate rounded px-1 py-px text-left text-[10px] font-medium transition-colors",
                          t.column === "done"
                            ? "bg-green-500/10 text-green-700 line-through"
                            : t.priority === "high"
                            ? "bg-red-500/10 text-red-600"
                            : t.priority === "medium"
                            ? "bg-paper-sunken text-ink-muted"
                            : "bg-paper-sunken text-ink-faint"
                        )}
                        title={t.title}
                      >
                        {t.title}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {calendarDays.map((day) => {
            const iso = toISODate(day.date);
            const dayTasks = tasksByDate[iso] || [];
            const dayEvents = eventsByDate[iso] || [];
            const isToday = isSameDay(day.date, today);
            return (
              <div key={iso} className={cn(
                "rounded-xl border border-line bg-paper p-3",
                isToday && "ring-1 ring-accent/30"
              )}>
                <div className="mb-2 text-[12px] font-semibold text-ink">
                  {day.date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                  {isToday && <span className="ml-2 text-[10px] uppercase tracking-wider text-accent">Today</span>}
                </div>
                {dayEvents.length === 0 && dayTasks.length === 0 && (
                  <div className="text-[11px] text-ink-faint">No events or tasks.</div>
                )}
                <div className="flex flex-col gap-1.5">
                  {dayEvents.map((ev) => (
                    <div key={ev.id} className="flex items-center gap-2 rounded-lg border border-line bg-paper-raised px-2.5 py-1.5">
                      <Clock className="h-3.5 w-3.5 text-ink-faint" />
                      <span className="text-[12px] text-ink">{ev.title}</span>
                      {ev.start_time && (
                        <span className="ml-auto text-[11px] text-ink-muted">
                          {ev.start_time}{ev.end_time ? ` – ${ev.end_time}` : ""}
                        </span>
                      )}
                    </div>
                  ))}
                  {dayTasks.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onTaskClick(t)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                        t.column === "done"
                          ? "border-green-500/20 bg-green-500/5 text-green-700 line-through"
                          : t.priority === "high"
                          ? "border-red-500/20 bg-red-500/5 text-red-600"
                          : "border-line bg-paper-raised text-ink"
                      )}
                    >
                      <span className="text-[12px]">{t.title}</span>
                      <span className={cn(
                        "ml-auto rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-wider",
                        t.column === "done" ? "border-green-500/20 text-green-600" : "border-line text-ink-faint"
                      )}>
                        {t.column}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
