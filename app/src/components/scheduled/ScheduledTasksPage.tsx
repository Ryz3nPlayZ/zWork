import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  CalendarDays,
  LogIn,
  Mail,
  Pencil,
  Play,
  ReceiptText,
  Repeat,
  ListChecks,
  Trash2,
} from "lucide-react";
import { useApp } from "../../lib/store";
import { api, type ScheduledTask } from "../../lib/api";
import { IS_TAURI } from "../../lib/platform";
import { cn } from "../../lib/cn";
import {
  Badge,
  Button,
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
import { CrewAvatar } from "../crew/CrewAvatar";

/** Starting points for the empty page: recurring office chores, editable before saving. */
const IDEAS: (ScheduleDraft & { icon: typeof Mail; blurb: string })[] = [
  {
    icon: Mail,
    title: "Morning email summary",
    blurb: "The emails that need a reply, every weekday before you start",
    prompt:
      "Look through the emails I got since yesterday morning. List the ones that need a reply or have a deadline: who sent it, what they need, and by when. Skip newsletters and notifications.",
    daily_time: "08:00",
    daily_weekdays: [1, 2, 3, 4, 5],
  },
  {
    icon: ReceiptText,
    title: "Bills and receipts",
    blurb: "A Monday table of what's due and when",
    prompt:
      "Search my email from the past week for invoices, bills and receipts. Make a table with who it's from, the amount and the due date, and point out anything due in the next 7 days.",
    daily_time: "09:00",
    daily_weekdays: [1],
  },
  {
    icon: CalendarDays,
    title: "Next week at a glance",
    blurb: "Friday afternoon: next week's meetings and clashes",
    prompt:
      "Look at my calendar for next week. List each day's meetings with the time and who's coming, and point out clashes, back-to-back days and anything I should prepare for.",
    daily_time: "16:00",
    daily_weekdays: [5],
  },
  {
    icon: ListChecks,
    title: "Weekly wrap-up",
    blurb: "What you worked on this week, ready to paste into a status update",
    prompt:
      "Using my sent emails and calendar from this week, write a short summary of what I worked on and what's still open, as bullet points I could paste into a status update.",
    daily_time: "17:00",
    daily_weekdays: [5],
  },
];

export function ScheduledTasksPage() {
  const scheduledTasks = useApp((s) => s.scheduledTasks);
  const crew = useApp((s) => s.crew);
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
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
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

  const describe = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setEditor({ task: null, initial: { title: "", prompt: draft.trim() } });
    setDraft("");
    if (draftRef.current) draftRef.current.style.height = "auto";
  };
  const ideas = IDEAS.filter((idea) => !scheduledTasks.some((t) => t.title === idea.title));

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
      {/* Same shell as the main chat composer (ChatInput), so a prompt box looks the same everywhere. */}
      <form onSubmit={describe} className={cn("hairline-ring rounded-2xl bg-paper transition-[box-shadow]", focused && "focus-ring")}>
        <textarea
          ref={draftRef}
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) describe(e);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-label="Describe a task"
          placeholder="Describe a task, like listing my unpaid invoices every Monday"
          className="block w-full resize-none bg-transparent px-5 pb-2 pt-4 text-[15px] leading-[25px] text-ink placeholder:text-ink-faint focus:outline-none [scrollbar-width:none]"
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <span className="truncate pl-2.5 text-[12px] text-ink-faint">You'll pick the day and time next</span>
          <button
            type="submit"
            aria-label="Set up this task"
            disabled={!draft.trim()}
            className={cn(
              "press ring-focus inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
              draft.trim() ? "bg-ink text-paper hover:bg-ink/90" : "cursor-not-allowed bg-ink/[0.07] text-ink-faint",
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </form>

      {IS_TAURI && (
        <div className="mt-3">
          <ListGroup>
            <ListRow
              icon={
                <IconTile>
                  <LogIn />
                </IconTile>
              }
              title="Open zWork when you log in"
              meta="Tasks only run while zWork is open and your computer is awake."
              trailing={<Switch checked={openAtLogin} onChange={toggleOpenAtLogin} label="Open zWork when you log in" />}
            />
          </ListGroup>
        </div>
      )}

      {scheduledTasks.length > 0 && (
        <>
          <SectionHeading title="Your tasks" count={scheduledTasks.length} />
          <ListGroup>
            {shown.map((t) => {
              const open = openId === t.id;
              const isStarted = started.has(t.id);
              const member = crew.find((m) => m.id === t.crew_id);
              return (
                <ListRow
                  key={t.id}
                  icon={member ? <CrewAvatar member={member} size={34} /> : <IconTile>{t.interval_minutes ? <Repeat /> : <CalendarDays />}</IconTile>}
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
        </>
      )}

      {ideas.length > 0 && (
        <>
          <SectionHeading title="Suggested" description="Each one opens ready to edit, so you can change the wording or time first." />
          <ListGroup>
            {ideas.map(({ icon: Icon, blurb, ...idea }) => (
              <ListRow
                key={idea.title}
                icon={
                  <IconTile>
                    <Icon />
                  </IconTile>
                }
                title={idea.title}
                meta={blurb}
                onClick={() => setEditor({ task: null, initial: idea })}
                trailing={<span>{describeSchedule({ interval_minutes: null, daily_time: idea.daily_time ?? null, daily_weekdays: idea.daily_weekdays ?? null })}</span>}
              />
            ))}
          </ListGroup>
        </>
      )}

      {editor && <ScheduleModal task={editor.task} initial={editor.initial} onClose={() => setEditor(null)} />}
      {confirmDialog}
    </PageShell>
  );
}
