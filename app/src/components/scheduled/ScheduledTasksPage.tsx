/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */

import { useState, useEffect } from "react";
import { Clock, Plus, Play, Trash2, Pencil, CalendarDays, Repeat, ArrowRight, Loader2 } from "lucide-react";
import { useApp } from "../../lib/store";
import type { ScheduledTask } from "../../lib/api";
import {
  Button,
  EmptyState,
  IconTile,
  ListGroup,
  ListRow,
  OverflowMenu,
  PageShell,
  RowIconButton,
  Segmented,
  Switch,
  useConfirm,
} from "../page/Page";
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
  if (!ms) return "not set";
  const d = new Date(ms);
  const now = Date.now();
  const diff = ms - now;
  if (diff < 0) return "overdue";
  if (diff < 60_000) return "in under a minute";
  if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ScheduledTasksPage() {
  const scheduledTasks = useApp((s) => s.scheduledTasks);
  const fetchSchedules = useApp((s) => s.fetchSchedules);
  const deleteSchedule = useApp((s) => s.deleteSchedule);
  const updateSchedule = useApp((s) => s.updateSchedule);
  const runScheduleNow = useApp((s) => s.runScheduleNow);
  const openChat = useApp((s) => s.openChat);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");
  const [confirmDialog, confirm] = useConfirm();

  useEffect(() => {
    void fetchSchedules();
  }, [fetchSchedules]);

  const activeCount = scheduledTasks.filter((t) => t.enabled).length;
  const pausedCount = scheduledTasks.length - activeCount;
  const showFilter = activeCount > 0 && pausedCount > 0;
  const shown = scheduledTasks.filter((t) =>
    !showFilter || filter === "all" ? true : filter === "active" ? t.enabled : !t.enabled,
  );

  const openEditor = (t: ScheduledTask | null) => {
    setEditingTask(t);
    setModalOpen(true);
  };

  const handleRunNow = async (t: ScheduledTask) => {
    setRunning(t.id);
    try {
      await runScheduleNow(t.id);
    } finally {
      setRunning(null);
    }
  };

  const handleDelete = async (t: ScheduledTask) => {
    const ok = await confirm({
      title: `Delete "${t.title}"?`,
      body: "The task stops running. Results already in your Inbox stay there.",
      confirmLabel: "Delete task",
    });
    if (ok) void deleteSchedule(t.id);
  };

  return (
    <PageShell
      title="Scheduled"
      subtitle={
        scheduledTasks.length > 0
          ? `${activeCount} active. Results land in your Inbox.`
          : "Tasks zWork runs on a schedule. Results land in your Inbox."
      }
      actions={
        <Button variant="primary" icon={<Plus />} onClick={() => openEditor(null)}>
          New task
        </Button>
      }
      toolbar={
        showFilter ? (
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: scheduledTasks.length },
              { value: "active", label: "Active", count: activeCount },
              { value: "paused", label: "Paused", count: pausedCount },
            ]}
          />
        ) : undefined
      }
    >
      {scheduledTasks.length === 0 ? (
        <EmptyState
          icon={<Clock />}
          title="No scheduled tasks yet"
          body="Have zWork check your email, watch a page or sum up the week on a schedule. Results land in your Inbox."
          action={
            <Button variant="primary" icon={<Plus />} onClick={() => openEditor(null)}>
              New task
            </Button>
          }
        />
      ) : (
        <ListGroup>
          {shown.map((t) => {
            const open = openId === t.id;
            const isRunning = running === t.id;
            return (
              <ListRow
                key={t.id}
                icon={
                  <IconTile>
                    {t.interval_minutes ? <Repeat /> : <CalendarDays />}
                  </IconTile>
                }
                title={t.title}
                meta={
                  t.enabled ? (
                    <>
                      {describeTrigger(t)} · Next {formatNext(t.next_run_at)}
                      {t.last_run_at ? ` · Last run ${formatTimestamp(t.last_run_at).replace("Just now", "just now")}` : ""}
                    </>
                  ) : (
                    <>Paused · {describeTrigger(t)}</>
                  )
                }
                muted={!t.enabled}
                onClick={() => setOpenId(open ? null : t.id)}
                expanded={open}
                actions={
                  <RowIconButton label="Run now" disabled={isRunning} onClick={() => void handleRunNow(t)}>
                    {isRunning ? <Loader2 className="animate-spin" /> : <Play />}
                  </RowIconButton>
                }
                trailing={
                  <>
                    <Switch
                      checked={t.enabled}
                      label={t.enabled ? `Pause ${t.title}` : `Resume ${t.title}`}
                      onChange={() => void updateSchedule(t.id, { enabled: !t.enabled })}
                    />
                    <OverflowMenu
                      items={[
                        { label: "Edit", icon: <Pencil />, onSelect: () => openEditor(t) },
                        { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => void handleDelete(t) },
                      ]}
                    />
                  </>
                }
              >
                <p className="max-w-[68ch] whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{t.prompt}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {t.last_chat_id && (
                    <Button variant="primary" icon={<ArrowRight />} onClick={() => openChat(t.last_chat_id!)}>
                      Open last run
                    </Button>
                  )}
                  <Button
                    icon={isRunning ? <Loader2 className="animate-spin" /> : <Play />}
                    disabled={isRunning}
                    onClick={() => void handleRunNow(t)}
                  >
                    Run now
                  </Button>
                  <Button icon={<Pencil />} onClick={() => openEditor(t)}>
                    Edit
                  </Button>
                </div>
              </ListRow>
            );
          })}
        </ListGroup>
      )}

      {modalOpen && <ScheduleModal task={editingTask} onClose={() => setModalOpen(false)} />}
      {confirmDialog}
    </PageShell>
  );
}
