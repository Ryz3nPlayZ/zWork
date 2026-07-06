/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */

import { useState, useEffect } from "react";
import {
  Clock,
  Plus,
  Play,
  MoreHorizontal,
  Trash2,
  Pencil,
  Power,
  CalendarDays,
  Repeat,
  Bot,
} from "lucide-react";
import { useApp, type View } from "../../lib/store";
import type { ScheduledTask } from "../../lib/api";
import { cn } from "../../lib/cn";
import { ScheduleModal } from "./ScheduleModal";

/** Human-readable trigger description. */
function describeTrigger(t: ScheduledTask): string {
  if (t.interval_minutes) {
    return `Every ${t.interval_minutes} min`;
  }
  if (t.daily_time) {
    const days = t.daily_weekdays?.length
      ? t.daily_weekdays
          .map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d] ?? "?")
          .join(", ")
      : "Every day";
    return `${t.daily_time} · ${days}`;
  }
  return "On a schedule";
}

function formatTimestamp(ms: number | null): string {
  if (!ms) return "Never";
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatNext(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = Date.now();
  const diff = ms - now;
  if (diff < 0) return "Overdue";
  if (diff < 60_000) return "In <1m";
  if (diff < 3_600_000) return `In ${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `In ${Math.floor(diff / 3_600_000)}h`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ScheduledTasksPage() {
  const scheduledTasks = useApp((s) => s.scheduledTasks);
  const fetchSchedules = useApp((s) => s.fetchSchedules);
  const deleteSchedule = useApp((s) => s.deleteSchedule);
  const updateSchedule = useApp((s) => s.updateSchedule);
  const runScheduleNow = useApp((s) => s.runScheduleNow);
  const openChat = useApp((s) => s.openChat);
  const setView = useApp((s) => s.setView);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);

  useEffect(() => {
    void fetchSchedules();
  }, [fetchSchedules]);

  // Close the row menu on outside click.
  useEffect(() => {
    if (!menuTaskId) return;
    const onClick = () => setMenuTaskId(null);
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [menuTaskId]);

  const enabledCount = scheduledTasks.filter((t) => t.enabled).length;

  const handleToggle = async (t: ScheduledTask) => {
    await updateSchedule(t.id, { enabled: !t.enabled });
  };

  const handleRunNow = async (t: ScheduledTask) => {
    await runScheduleNow(t.id);
  };

  const handleOpenRunChat = (t: ScheduledTask) => {
    if (t.last_chat_id) {
      openChat(t.last_chat_id);
    } else {
      setView("inbox" as View);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      {/* Header — matches TasksPage Pattern A */}
      <div className="shrink-0 border-b border-line bg-paper-soft px-6 py-4">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight text-ink">
              Scheduled
            </h1>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              {enabledCount} active task{enabledCount === 1 ? "" : "s"} · results land in your Inbox
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setEditingTask(null); setModalOpen(true); }}
            className="press ring-focus inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink/90 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            New task
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1200px] px-6 py-6">
          {scheduledTasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line p-16 text-center">
              <Clock className="mx-auto h-8 w-8 text-ink-faint" />
              <h3 className="mt-3 text-[13.5px] font-semibold text-ink">
                No scheduled tasks yet
              </h3>
              <p className="mt-1 text-[12.5px] text-ink-muted max-w-[320px] mx-auto">
                Create a recurring task and the agent will run it on a schedule — checking
                email, monitoring sources, summarizing changes — then post findings to your Inbox.
              </p>
              <button
                type="button"
                onClick={() => { setEditingTask(null); setModalOpen(true); }}
                className="press ring-focus mt-4 inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink/90 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Create your first task
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {scheduledTasks.map((t) => (
                <div
                  key={t.id}
                  className={cn(
                    "group rounded-2xl border border-line bg-paper-raised p-4 transition-colors",
                    !t.enabled && "opacity-60"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    {/* Left: title + prompt */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-semibold text-ink">{t.title}</span>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-px text-[10px] font-medium",
                            t.enabled
                              ? "bg-success/10 text-success"
                              : "bg-paper-sunken text-ink-muted"
                          )}
                        >
                          {t.enabled ? (
                            <>
                              <span className="h-1.5 w-1.5 rounded-full bg-success" />
                              Active
                            </>
                          ) : (
                            "Paused"
                          )}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-muted">
                        {t.prompt}
                      </p>

                      {/* Meta row */}
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
                        <span className="inline-flex items-center gap-1">
                          {t.interval_minutes ? (
                            <Repeat className="h-3 w-3" />
                          ) : (
                            <CalendarDays className="h-3 w-3" />
                          )}
                          {describeTrigger(t)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          Last run: {formatTimestamp(t.last_run_at)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          Next: {formatNext(t.next_run_at)}
                        </span>
                        {t.last_chat_id && (
                          <button
                            type="button"
                            onClick={() => handleOpenRunChat(t)}
                            className="press inline-flex items-center gap-1 text-ink-muted hover:text-ink"
                          >
                            <Bot className="h-3 w-3" />
                            View last run
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Right: actions */}
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleRunNow(t)}
                        title="Run now"
                        aria-label="Run now"
                        className="press ring-focus rounded-lg p-1.5 text-ink-faint hover:bg-paper-sunken hover:text-ink"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggle(t)}
                        title={t.enabled ? "Pause" : "Enable"}
                        aria-label={t.enabled ? "Pause" : "Enable"}
                        className="press ring-focus rounded-lg p-1.5 text-ink-faint hover:bg-paper-sunken hover:text-ink"
                      >
                        <Power className="h-3.5 w-3.5" />
                      </button>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuTaskId(menuTaskId === t.id ? null : t.id);
                          }}
                          title="More"
                          aria-label="More actions"
                          aria-haspopup="menu"
                          aria-expanded={menuTaskId === t.id}
                          className="press ring-focus rounded-lg p-1.5 text-ink-faint hover:bg-paper-sunken hover:text-ink"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                        {menuTaskId === t.id && (
                          <div
                            className="absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded-lg border border-line bg-paper-raised shadow-pop"
                            role="menu"
                            aria-label="Task actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setEditingTask(t);
                                setModalOpen(true);
                                setMenuTaskId(null);
                              }}
                              className="press flex w-full items-center gap-2 px-3 py-2 text-[12px] text-ink hover:bg-paper-sunken"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (confirm("Delete this scheduled task? This cannot be undone.")) {
                                  void deleteSchedule(t.id);
                                }
                                setMenuTaskId(null);
                              }}
                              className="press flex w-full items-center gap-2 px-3 py-2 text-[12px] text-error hover:bg-error/10"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {modalOpen && (
        <ScheduleModal task={editingTask} onClose={() => setModalOpen(false)} />
      )}
    </div>
  );
}
