import { useState, useMemo } from "react";
import { useApp } from "../../lib/store";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Trash2,
  X,
  PlusCircle,
  AlertTriangle,
} from "lucide-react";

function timeToMinutes(timeStr: string): number {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function checkOverlap(
  s1: string,
  e1: string,
  s2: string,
  e2: string
): boolean {
  const start1 = timeToMinutes(s1);
  const end1 = timeToMinutes(e1 || "23:59");
  const start2 = timeToMinutes(s2);
  const end2 = timeToMinutes(e2 || "23:59");
  return start1 < end2 && start2 < end1;
}

export function DailyAgenda() {
  const events = useApp((s) => s.events);
  const tasks = useApp((s) => s.tasks);
  const addEvent = useApp((s) => s.addEvent);
  const deleteEvent = useApp((s) => s.deleteEvent);

  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [showAddEvent, setShowAddEvent] = useState(false);
  
  // New event form state
  const [eventTitle, setEventTitle] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");

  const formattedDate = currentDate.toISOString().split("T")[0]; // YYYY-MM-DD

  // Format date readable
  const displayDateStr = currentDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const navigateDate = (days: number) => {
    const next = new Date(currentDate);
    next.setDate(next.getDate() + days);
    setCurrentDate(next);
  };

  const handleAddEvent = async () => {
    if (!eventTitle.trim()) return;
    await addEvent(eventTitle.trim(), formattedDate, startTime, endTime);
    setEventTitle("");
    setShowAddEvent(false);
  };

  // Filter events and tasks for the currently navigated date
  const todaysEvents = useMemo(() => events.filter((e) => e.date === formattedDate), [events, formattedDate]);
  const todaysTasks = useMemo(() => tasks.filter((t) => t.due_date === formattedDate), [tasks, formattedDate]);

  // Compute conflicts
  const conflicts = useMemo(() => {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < todaysEvents.length; i++) {
      for (let j = i + 1; j < todaysEvents.length; j++) {
        const ev1 = todaysEvents[i];
        const ev2 = todaysEvents[j];
        if (
          ev1.start_time &&
          ev2.start_time &&
          checkOverlap(ev1.start_time, ev1.end_time || "23:59", ev2.start_time, ev2.end_time || "23:59")
        ) {
          pairs.push([ev1.title, ev2.title]);
        }
      }
    }
    return pairs;
  }, [todaysEvents]);

  // Check form conflict
  const formConflict = useMemo(() => {
    if (!startTime || !endTime) return null;
    return todaysEvents.find(
      (e) =>
        e.start_time &&
        checkOverlap(startTime, endTime, e.start_time, e.end_time || "23:59")
    );
  }, [startTime, endTime, todaysEvents]);

  // Hours array for timeline view (8:00 AM to 7:00 PM)
  const HOURS = Array.from({ length: 12 }, (_, i) => i + 8); // 8 to 19

  const formatHourLabel = (h: number) => {
    const period = h >= 12 ? "PM" : "AM";
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    return `${displayHour}:00 ${period}`;
  };

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Date Navigation Header */}
      <div className="flex items-center justify-between bg-paper-raised border border-line p-2.5 rounded-xl shadow-xs">
        <button
          onClick={() => navigateDate(-1)}
          className="p-1 rounded hover:bg-paper text-ink-muted hover:text-ink duration-150"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-ink-soft" />
          <span className="text-[12.5px] font-bold text-ink">{displayDateStr}</span>
        </div>

        <button
          onClick={() => navigateDate(1)}
          className="p-1 rounded hover:bg-paper text-ink-muted hover:text-ink duration-150"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Overview stats */}
      <div className="flex gap-2">
        <div className="flex-1 p-2 rounded-xl border border-line bg-paper text-center">
          <div className="text-[10px] uppercase font-bold text-ink-muted">Agenda Events</div>
          <div className="text-[18px] font-bold text-ink mt-0.5">{todaysEvents.length}</div>
        </div>
        <div className="flex-1 p-2 rounded-xl border border-line bg-paper text-center">
          <div className="text-[10px] uppercase font-bold text-ink-muted">Tasks Due</div>
          <div className="text-[18px] font-bold text-ink-soft mt-0.5">{todaysTasks.length}</div>
        </div>
      </div>

      {/* Conflict Warnings */}
      {conflicts.length > 0 && (
        <div className="flex flex-col gap-1.5 p-3 rounded-xl border border-rose-500/20 bg-rose-500/5 text-rose-400 text-[11.5px] animate-fade-in">
          {conflicts.map(([t1, t2], idx) => (
            <div key={idx} className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-rose-500 flex-shrink-0" />
              <span>
                <strong>Double Booking:</strong> "{t1}" overlaps with "{t2}"
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Event Form Toggle */}
      <button
        onClick={() => setShowAddEvent(true)}
        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-line text-ink-soft text-[11px] font-bold hover:bg-paper-sunken transition-all duration-200"
      >
        <PlusCircle className="h-4 w-4" />
        <span>Schedule Event</span>
      </button>

      {/* Events timeline list */}
      <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar space-y-4">
        {/* Timeline Block View */}
        <div className="border border-line rounded-xl bg-paper overflow-hidden">
          {HOURS.map((h, idx) => {
            const hrStr = String(h).padStart(2, "0");
            
            // Find events starting in this hour slot
            const matchedEvents = todaysEvents.filter((e) => {
              if (!e.start_time) return false;
              const startHr = e.start_time.split(":")[0];
              return startHr === hrStr;
            });

            return (
              <div
                key={h}
                className={`flex border-b border-line last:border-b-0 min-h-[50px] relative ${
                  idx % 2 === 0 ? "bg-paper" : "bg-paper-raised/30"
                }`}
              >
                {/* Time indicator */}
                <div className="w-[64px] border-r border-line py-2 px-2 flex-shrink-0 text-right text-[10px] font-semibold text-ink-muted select-none">
                  {formatHourLabel(h)}
                </div>

                {/* Slot Events Container */}
                <div className="flex-1 p-1.5 flex flex-col gap-1.5 relative justify-center">
                  {matchedEvents.length > 0 ? (
                    matchedEvents.map((evt) => (
                      <div
                        key={evt.id}
                        className="group flex items-center justify-between p-2 rounded-lg border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 transition-all duration-150 animate-scale-up"
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[12px] font-semibold text-ink leading-none">
                              {evt.title}
                            </span>
                            {todaysEvents.some(
                              (other) =>
                                other.id !== evt.id &&
                                evt.start_time &&
                                other.start_time &&
                                checkOverlap(evt.start_time, evt.end_time || "23:59", other.start_time, other.end_time || "23:59")
                            ) && (
                              <span title="Scheduling conflict detected">
                                <AlertTriangle className="h-3 w-3 text-rose-500 flex-shrink-0 animate-pulse" />
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-amber-500/80 flex items-center gap-1 font-medium mt-0.5">
                            <Clock className="h-2.5 w-2.5" />
                            <span>
                              {evt.start_time} - {evt.end_time || "All day"}
                            </span>
                          </span>
                        </div>

                        <button
                          onClick={() => deleteEvent(evt.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded text-rose-500/70 hover:text-rose-500 hover:bg-paper transition-all"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  ) : (
                    <span className="text-[10px] text-ink-muted/30 italic pl-1.5 select-none">
                      Free slot
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Add Event Modal overlay */}
      {showAddEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in" onClick={() => setShowAddEvent(false)}>
          <div
            className="w-full max-w-sm rounded-xl border border-line bg-paper p-4 shadow-xl animate-scale-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line pb-2 mb-3">
              <span className="text-[13px] font-bold text-ink">Schedule Event</span>
              <button
                onClick={() => setShowAddEvent(false)}
                className="p-1 rounded hover:bg-paper-raised text-ink-muted hover:text-ink duration-150"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">Event Title</label>
                <input
                  type="text"
                  placeholder="e.g. Weekly Sync Meeting"
                  autoFocus
                  value={eventTitle}
                  onChange={(e) => setEventTitle(e.target.value)}
                  className="w-full mt-1 bg-paper px-2.5 py-2 text-[12px] border border-line rounded-lg focus:outline-none focus:border-amber-500/50 text-ink"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">Start Time</label>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full mt-1 bg-paper px-2 py-1.5 text-[12.5px] border border-line rounded-lg focus:outline-none text-ink"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">End Time</label>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-full mt-1 bg-paper px-2 py-1.5 text-[12.5px] border border-line rounded-lg focus:outline-none text-ink"
                  />
                </div>
              </div>

              {formConflict && (
                <div className="flex items-center gap-1.5 text-[11px] text-rose-500 font-semibold mt-2 p-2.5 rounded-lg border border-rose-500/20 bg-rose-500/5 animate-slide-down">
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-500 flex-shrink-0" />
                  <span>Conflict: Overlaps with "{formConflict.title}"</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-line mt-4 pt-3">
              <button
                onClick={() => setShowAddEvent(false)}
                className="px-3.5 py-1.5 rounded-lg text-ink-muted text-[11px] font-bold hover:bg-paper-raised transition-colors"
              >
                Cancel
              </button>
              
              <button
                onClick={handleAddEvent}
                className="px-4 py-1.5 rounded-lg bg-amber-500 text-paper-raised text-[11px] font-semibold hover:bg-amber-600 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
