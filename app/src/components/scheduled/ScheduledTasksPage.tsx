import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  Clock,
  LogIn,
  Mail,
  Pencil,
  Play,
  Plus,
  ReceiptText,
  Repeat,
  ListChecks,
  Trash2,
} from "lucide-react";
import { useApp } from "../../lib/store";
import { api, type ScheduledTask } from "../../lib/api";
import { IS_TAURI } from "../../lib/platform";
import {
  Badge,
  Button,
  EmptyState,
  IconTile,
  ListGroup,
  ListRow,
  OverflowMenu,
  PageShell,
  RowIconButton,
  SectionHeading,
  Segmented,
  Switch,
  useConfirm,
} from "../page/Page";
import { ScheduleModal, type ScheduleDraft } from "./ScheduleModal";
import { describeSchedule, formatAgo, formatNext } from "./describe";

/** Starting points for the empty page: recurring office chores, editable before saving. */
const IDEAS: (ScheduleDraft & { icon: typeof Mail })[] = [
  {
    icon: Mail,
    title: "Morning email summary",
    prompt:
      "Look through the emails I got since yesterday morning. List the ones that need a reply or have a deadline: who sent it, what they need, and by when. Skip newsletters and notifications.",
    daily_time: "08:00",
    daily_weekdays: [1, 2, 3, 4, 5],
  },
  {
    icon: ReceiptText,
    title: "Bills and receipts",
    prompt:
      "Search my email from the past week for invoices, bills and receipts. Make a table with who it's from, the amount and the due date, and point out anything due in the next 7 days.",
    daily_time: "09:00",
    daily_weekdays: [1],
  },
  {
    icon: CalendarDays,
    title: "Next week at a glance",
    prompt:
      "Look at my calendar for next week. List each day's meetings with the time and who's coming, and point out clashes, back-to-back days and anything I should prepare for.",
    daily_time: "16:00",
    daily_weekdays: [5],
  },
  {
    icon: ListChecks,
    title: "Weekly wrap-up",
    prompt:
      "Using my sent emails and calendar from this week, write a short summary of what I worked on and what's still open, as bullet points I could paste into a status update.",
    daily_time: "17:00",
    daily_weekdays: [5],
  },
];

export function ScheduledTasksPage() {
  const scheduledTasks = useApp((s) => s.scheduledTasks);
  const fetchSchedules = useApp((s) => s.fetchSchedules);
  const deleteSchedule = useApp((s) => s.deleteSchedule);
  const updateSchedule = useApp((s) => s.updateSchedule);
  const runScheduleNow = useApp((s) => s.runScheduleNow);
  const openChat = useApp((s) => s.openChat);

  const [editor, setEditor] = useState<{ task: ScheduledTask | null; initial?: ScheduleDraft } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [started, setStarted] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");
  const [confirmDialog, confirm] = useConfirm();
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    void fetchSchedules();
    if (IS_TAURI) void api.getLaunchAtLogin().then(setOpenAtLogin).catch(() => {});
    // Keep "next run" and "last ran" current while the page is open.
    const id = window.setInterval(() => void fetchSchedules(), 60_000);
    const t = timers.current;
    return () => {
      window.clearInterval(id);
      for (const h of t.values()) window.clearTimeout(h);
    };
  }, [fetchSchedules]);

  const toggleOpenAtLogin = () => {
    const next = !openAtLogin;
    setOpenAtLogin(next);
    void api.setLaunchAtLogin(next).catch(() => setOpenAtLogin(!next));
  };

  const activeCount = scheduledTasks.filter((t) => t.enabled).length;
  const pausedCount = scheduledTasks.length - activeCount;
  const showFilter = activeCount > 0 && pausedCount > 0;
  const shown = scheduledTasks.filter((t) =>
    !showFilter || filter === "all" ? true : filter === "active" ? t.enabled : !t.enabled,
  );

  const runNow = async (t: ScheduledTask) => {
    setStarted((s) => new Set(s).add(t.id));
    await runScheduleNow(t.id);
    // The run happens in the background; show "Started" briefly, then pick up the new "last ran".
    window.clearTimeout(timers.current.get(t.id));
    timers.current.set(
      t.id,
      window.setTimeout(() => {
        timers.current.delete(t.id);
        setStarted((s) => {
          const n = new Set(s);
          n.delete(t.id);
          return n;
        });
        void fetchSchedules();
      }, 6000),
    );
  };

  const remove = async (t: ScheduledTask) => {
    const ok = await confirm({
      title: `Delete "${t.title}"?`,
      body: "It stops running. What it already put in your Inbox stays there.",
      confirmLabel: "Delete task",
    });
    if (ok) void deleteSchedule(t.id);
  };

  const newTask = (
    <Button variant="primary" icon={<Plus />} onClick={() => setEditor({ task: null })}>
      New task
    </Button>
  );

  return (
    <PageShell
      title="Scheduled"
      subtitle={
        scheduledTasks.length === 0
          ? "Work zWork does on its own, on a schedule. What it finds lands in your Inbox."
          : activeCount === 0
            ? "Everything is paused."
            : `${activeCount} running on a schedule. What they find lands in your Inbox.`
      }
      actions={scheduledTasks.length > 0 ? newTask : undefined}
      toolbar={
        showFilter ? (
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: scheduledTasks.length },
              { value: "active", label: "On", count: activeCount },
              { value: "paused", label: "Paused", count: pausedCount },
            ]}
          />
        ) : undefined
      }
    >
      {scheduledTasks.length === 0 ? (
        <>
          <EmptyState
            compact
            icon={<Clock />}
            title="Nothing scheduled yet"
            body="Pick an idea below or write your own, like checking your email every morning."
            action={newTask}
          />
          <SectionHeading
            title="Ideas to start from"
            description="Each one opens ready to edit, so you can change the wording or time first."
          />
          <ListGroup>
            {IDEAS.map(({ icon: Icon, ...idea }) => (
              <ListRow
                key={idea.title}
                icon={
                  <IconTile>
                    <Icon />
                  </IconTile>
                }
                title={idea.title}
                meta={idea.prompt}
                onClick={() => setEditor({ task: null, initial: idea })}
                trailing={<span>{describeSchedule({ interval_minutes: null, daily_time: idea.daily_time ?? null, daily_weekdays: idea.daily_weekdays ?? null })}</span>}
              />
            ))}
          </ListGroup>
        </>
      ) : (
        <ListGroup>
          {shown.map((t) => {
            const open = openId === t.id;
            const isStarted = started.has(t.id);
            return (
              <ListRow
                key={t.id}
                icon={<IconTile>{t.interval_minutes ? <Repeat /> : <CalendarDays />}</IconTile>}
                title={t.title}
                meta={
                  t.enabled
                    ? `${describeSchedule(t)} · next ${formatNext(t.next_run_at)}`
                    : `Paused · ${describeSchedule(t)}`
                }
                muted={!t.enabled}
                onClick={() => setOpenId(open ? null : t.id)}
                expanded={open}
                actions={
                  !isStarted && (
                    <RowIconButton label="Run now" onClick={() => void runNow(t)}>
                      <Play />
                    </RowIconButton>
                  )
                }
                trailing={
                  <>
                    {isStarted && <Badge tone="info">Started</Badge>}
                    <Switch
                      checked={t.enabled}
                      label={t.enabled ? `Pause ${t.title}` : `Turn on ${t.title}`}
                      onChange={() => void updateSchedule(t.id, { enabled: !t.enabled })}
                    />
                    <OverflowMenu
                      items={[
                        { label: "Run now", icon: <Play />, onSelect: () => void runNow(t) },
                        { label: "Edit", icon: <Pencil />, onSelect: () => setEditor({ task: t }) },
                        { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => void remove(t) },
                      ]}
                    />
                  </>
                }
              >
                <p className="max-w-[68ch] whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{t.prompt}</p>
                <p className="mt-2 text-[12px] text-ink-faint">
                  {t.last_run_at ? `Last ran ${formatAgo(t.last_run_at)}` : "Hasn't run yet"}
                  {isStarted && " · running now, the result will show up in your Inbox"}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {t.last_chat_id && (
                    <Button variant="primary" icon={<ArrowRight />} onClick={() => void openChat(t.last_chat_id!)}>
                      See last result
                    </Button>
                  )}
                  <Button icon={<Play />} disabled={isStarted} onClick={() => void runNow(t)}>
                    Run now
                  </Button>
                  <Button icon={<Pencil />} onClick={() => setEditor({ task: t })}>
                    Edit
                  </Button>
                </div>
              </ListRow>
            );
          })}
        </ListGroup>
      )}

      {IS_TAURI && scheduledTasks.length > 0 && (
        <div className="mt-6">
          <ListGroup>
            <ListRow
              icon={
                <IconTile>
                  <LogIn />
                </IconTile>
              }
              title="Open zWork when you log in"
              meta="Scheduled tasks only run while zWork is open and your computer is awake."
              trailing={<Switch checked={openAtLogin} onChange={toggleOpenAtLogin} label="Open zWork when you log in" />}
            />
          </ListGroup>
        </div>
      )}

      {editor && <ScheduleModal task={editor.task} initial={editor.initial} onClose={() => setEditor(null)} />}
      {confirmDialog}
    </PageShell>
  );
}
