import { useEffect, useMemo, useRef, useState } from "react";
import { X, Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { useApp, type Task } from "../../lib/store";
import { cn } from "../../lib/cn";

const COLUMNS: { id: Task["column"]; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "todo", label: "To Do" },
  { id: "doing", label: "Doing" },
  { id: "done", label: "Done" },
];

const PRIORITIES: { id: "low" | "medium" | "high"; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

function toISODate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function addDays(d: Date, n: number) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function addMonths(d: Date, n: number) {
  const copy = new Date(d);
  copy.setMonth(copy.getMonth() + n);
  return copy;
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function NewTaskModal({
  task,
  onClose,
}: {
  task: Task | null;
  onClose: () => void;
}) {
  const addTask = useApp((s) => s.addTask);
  const updateTask = useApp((s) => s.updateTask);

  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [column, setColumn] = useState<Task["column"]>(task?.column ?? "inbox");
  const [assignee, setAssignee] = useState<string>(task?.assignee ?? "");
  const [priority, setPriority] = useState<"low" | "medium" | "high">(task?.priority ?? "medium");
  const [dueDate, setDueDate] = useState<string | null>(task?.due_date ?? null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [pickerMonth, setPickerMonth] = useState(() => {
    const d = task?.due_date ? new Date(`${task.due_date}T00:00:00`) : new Date();
    return startOfMonth(d);
  });
  const [busy, setBusy] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!datePickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setDatePickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [datePickerOpen]);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      if (task) {
        await updateTask(task.id, title.trim(), column, dueDate, description.trim() || undefined, assignee || undefined, priority);
      } else {
        await addTask(title.trim(), column, dueDate, description.trim() || undefined, assignee || undefined, priority);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const calendarDays = useMemo(() => {
    const year = pickerMonth.getFullYear();
    const month = pickerMonth.getMonth();
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
  }, [pickerMonth]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const quickOptions = [
    { label: "Today", date: today },
    { label: "Tomorrow", date: addDays(today, 1) },
    { label: "In 3 days", date: addDays(today, 3) },
    { label: "In 5 days", date: addDays(today, 5) },
    { label: "1 week", date: addDays(today, 7) },
    { label: "2 weeks", date: addDays(today, 14) },
    { label: "1 month", date: addMonths(today, 1) },
    { label: "No date", date: null },
  ];

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[460px] rounded-2xl border border-line bg-paper-raised shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">
            {task ? "Edit Task" : "New Task"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="press rounded-md p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-[12.5px] font-medium text-ink-muted mb-1.5">
              Name
            </label>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="What needs to be done?"
              className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-[12.5px] font-medium text-ink-muted mb-1.5">
              Description <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Add details..."
              className="block w-full resize-none rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
          </div>

          {/* Row: Status + Assignee */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12.5px] font-medium text-ink-muted mb-1.5">
                Status
              </label>
              <select
                value={column}
                onChange={(e) => setColumn(e.target.value as Task["column"])}
                className="w-full appearance-none rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink focus:border-line-strong focus:outline-none cursor-pointer"
              >
                {COLUMNS.map((c) => (
                  <option key={c.id} value={c.id} className="bg-paper text-ink">
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-ink-muted mb-1.5">
                Assignee
              </label>
              <select
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                className="w-full appearance-none rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink focus:border-line-strong focus:outline-none cursor-pointer"
              >
                <option value="" className="bg-paper text-ink">Unassigned</option>
                <option value="me" className="bg-paper text-ink">Me</option>
                <option value="zwork" className="bg-paper text-ink">zWork</option>
              </select>
            </div>
          </div>

          {/* Row: Due date + Priority */}
          <div className="grid grid-cols-2 gap-3">
            <div className="relative">
              <label className="block text-[12.5px] font-medium text-ink-muted mb-1.5">
                Due date
              </label>
              <button
                type="button"
                onClick={() => setDatePickerOpen((v) => !v)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-[13px] transition-colors",
                  dueDate
                    ? "border-line bg-paper text-ink"
                    : "border-line bg-paper text-ink-faint",
                  "hover:border-line-strong"
                )}
              >
                <CalendarIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {dueDate ? new Date(`${dueDate}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Set due date"}
                </span>
              </button>

              {datePickerOpen && (
                <div
                  ref={pickerRef}
                  className="absolute left-0 top-full z-50 mt-2 w-[320px] rounded-xl border border-line bg-paper-raised p-3 shadow-pop animate-fade-in"
                >
                  <div className="flex gap-3">
                    {/* Mini calendar */}
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-2">
                        <button
                          type="button"
                          onClick={() => setPickerMonth((m) => addMonths(m, -1))}
                          className="press rounded-md p-1 text-ink-faint hover:text-ink hover:bg-paper-sunken"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </button>
                        <span className="text-[12.5px] font-semibold text-ink">
                          {pickerMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                        </span>
                        <button
                          type="button"
                          onClick={() => setPickerMonth((m) => addMonths(m, 1))}
                          className="press rounded-md p-1 text-ink-faint hover:text-ink hover:bg-paper-sunken"
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-7 gap-0.5">
                        {["S","M","T","W","T","F","S"].map((d) => (
                          <div key={d} className="flex h-6 items-center justify-center text-[10px] font-semibold text-ink-faint uppercase">
                            {d}
                          </div>
                        ))}
                        {calendarDays.map((day, idx) => {
                          const selected = dueDate ? isSameDay(day.date, new Date(`${dueDate}T00:00:00`)) : false;
                          const isToday = isSameDay(day.date, today);
                          return (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                setDueDate(toISODate(day.date));
                                setDatePickerOpen(false);
                              }}
                              className={cn(
                                "press flex h-7 items-center justify-center rounded-md text-[11px]",
                                !day.current && "text-ink-faint/50",
                                day.current && !selected && "text-ink hover:bg-paper-sunken",
                                selected && "bg-ink text-paper",
                                isToday && !selected && "font-bold text-accent"
                              )}
                            >
                              {day.date.getDate()}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Quick options */}
                    <div className="w-[110px] shrink-0 border-l border-line pl-3">
                      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint mb-1.5">
                        Quick
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {quickOptions.map((opt) => (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() => {
                              setDueDate(opt.date ? toISODate(opt.date) : null);
                              setDatePickerOpen(false);
                            }}
                            className={cn(
                              "press text-left rounded-md px-2 py-1 text-[11.5px] transition-colors",
                              dueDate && opt.date && isSameDay(opt.date, new Date(`${dueDate}T00:00:00`))
                                ? "bg-ink text-paper"
                                : "text-ink-muted hover:bg-paper-sunken hover:text-ink"
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-ink-muted mb-1.5">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as "low" | "medium" | "high")}
                className="w-full appearance-none rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink focus:border-line-strong focus:outline-none cursor-pointer"
              >
                {PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id} className="bg-paper text-ink">
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="press rounded-md border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-paper-sunken"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy || !title.trim()}
            className="press rounded-md bg-ink px-4 py-1.5 text-[12.5px] font-medium text-paper hover:bg-ink-soft disabled:opacity-40"
          >
            {busy ? "Saving…" : task ? "Save Changes" : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}
