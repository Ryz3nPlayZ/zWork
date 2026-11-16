import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarClock,
  Check,
  CheckCheck,
  FileText,
  HelpCircle,
  Inbox,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useApp } from "../lib/store";
import { api, type InboxItem } from "../lib/api";
import { AssistantMarkdown } from "./Message";
import {
  Button,
  EmptyState,
  IconTile,
  ListGroup,
  ListRow,
  PageShell,
  RowIconButton,
  SectionHeading,
  type Tone,
} from "./page/Page";

/** Icon, tone and plain label per kind of inbox item. */
function kindMeta(kind: InboxItem["kind"]): { icon: typeof Bot; tone: Tone; label: string } {
  switch (kind) {
    case "approval":
      return { icon: ShieldCheck, tone: "warning", label: "Needs your OK" };
    case "flag":
      return { icon: AlertTriangle, tone: "warning", label: "Worth a look" };
    case "question":
      return { icon: HelpCircle, tone: "info", label: "Has a question" };
    case "error":
      return { icon: AlertTriangle, tone: "error", label: "Didn't finish" };
    case "summary":
    default:
      return { icon: Bot, tone: "neutral", label: "Result" };
  }
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Which day group an item falls in. */
function dayGroup(ms: number, now: number): "Today" | "Yesterday" | "This week" | "Earlier" {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Earlier";
}

/** Time shown on the row: the clock for today and yesterday, the day or date before that. */
function rowTime(ms: number, now: number): string {
  const d = new Date(ms);
  const group = dayGroup(ms, now);
  if (group === "Today" || group === "Yesterday") return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (group === "This week") return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** First line of the body without markdown symbols, for the row preview. */
function preview(body: string): string {
  const line = body.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^[#>*\-\s\d.]+/, "").replace(/[*_`]/g, "").trim();
}

/** How long a dismissed item can be brought back before it is deleted. */
const UNDO_MS = 5000;

export function InboxPage() {
  const inboxItems = useApp((s) => s.inboxItems);
  const scheduledTasks = useApp((s) => s.scheduledTasks);
  const fetchInbox = useApp((s) => s.fetchInbox);
  const fetchSchedules = useApp((s) => s.fetchSchedules);
  const markRead = useApp((s) => s.markInboxRead);
  const markAllRead = useApp((s) => s.markAllInboxRead);
  const deleteItem = useApp((s) => s.deleteInboxItem);
  const runScheduleNow = useApp((s) => s.runScheduleNow);
  const openChat = useApp((s) => s.openChat);
  const setView = useApp((s) => s.setView);

  const [openId, setOpenId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [rerun, setRerun] = useState<Set<string>>(new Set());
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    void fetchInbox();
    // Task names label where each result came from.
    void fetchSchedules();
    // Pick up results that background runs post while the page is open.
    const id = setInterval(() => void fetchInbox(), 30_000);
    return () => clearInterval(id);
  }, [fetchInbox, fetchSchedules]);

  // Leaving the page commits any pending dismissals.
  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const [id, handle] of t) {
        window.clearTimeout(handle);
        void deleteItem(id);
      }
    };
  }, [deleteItem]);

  const taskName = useMemo(() => new Map(scheduledTasks.map((t) => [t.id, t.title])), [scheduledTasks]);

  function dismiss(id: string) {
    setDismissed((d) => new Set(d).add(id));
    if (openId === id) setOpenId(null);
    timers.current.set(
      id,
      window.setTimeout(() => {
        timers.current.delete(id);
        void deleteItem(id);
      }, UNDO_MS),
    );
  }

  function undo(id: string) {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setDismissed((d) => {
      const next = new Set(d);
      next.delete(id);
      return next;
    });
  }

  async function approve(item: InboxItem) {
    setBusy(item.id);
    setRowError(null);
    try {
      const res = await api.approveInboxItem(item.id);
      if (!res.ok) {
        setRowError({ id: item.id, message: res.error ?? "That didn't go through. Try again." });
        setOpenId(item.id); // the message shows inside the row
      }
      if (!item.read) void markRead(item.id);
      await fetchInbox();
    } catch {
      setRowError({ id: item.id, message: "That didn't go through. Try again." });
      setOpenId(item.id);
    } finally {
      setBusy(null);
    }
  }

  async function runAgain(item: InboxItem) {
    if (!item.task_id) return;
    setRerun((s) => new Set(s).add(item.id));
    await runScheduleNow(item.task_id);
  }

  const now = Date.now();
  const waiting = inboxItems.filter((i) => i.pending_action);
  const rest = inboxItems.filter((i) => !i.pending_action);
  const groups = (["Today", "Yesterday", "This week", "Earlier"] as const)
    .map((label) => ({ label, items: rest.filter((i) => dayGroup(i.created_at, now) === label) }))
    .filter((g) => g.items.length > 0);
  const unreadCount = inboxItems.filter((i) => !i.read).length;

  function renderRow(item: InboxItem) {
    if (dismissed.has(item.id)) {
      return (
        <li key={item.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[12.5px] text-ink-muted">
          <span className="truncate">
            {item.pending_action ? "Skipped" : "Dismissed"} &ldquo;{item.title}&rdquo;
          </span>
          <button
            type="button"
            onClick={() => undo(item.id)}
            className="press ring-focus shrink-0 rounded-md px-2 py-0.5 font-medium text-ink hover:bg-line/40"
          >
            Undo
          </button>
        </li>
      );
    }
    const meta = kindMeta(item.kind);
    const Icon = meta.icon;
    const open = openId === item.id;
    const source = (item.task_id && taskName.get(item.task_id)) || meta.label;
    const pending = !!item.pending_action;
    const firstLine = preview(item.body);

    return (
      <ListRow
        key={item.id}
        icon={
          <IconTile tone={meta.tone}>
            <Icon />
          </IconTile>
        }
        title={item.title}
        meta={
          <>
            {/* Under "Needs your OK" the kind is already the heading, so say where it came from. */}
            {item.kind === "summary" || pending ? source : meta.label}
            {!open && firstLine && <span className="text-ink-faint"> · {firstLine}</span>}
          </>
        }
        muted={item.read && !pending}
        onClick={() => {
          // Opening an item is reading it, like email; no separate "Mark read" step.
          if (!open && !item.read) void markRead(item.id);
          setOpenId(open ? null : item.id);
        }}
        expanded={open}
        actions={
          !pending && (
            <RowIconButton label="Dismiss" onClick={() => dismiss(item.id)}>
              <X />
            </RowIconButton>
          )
        }
        trailing={
          pending ? (
            <>
              <Button onClick={() => dismiss(item.id)}>Don&rsquo;t do this</Button>
              <Button variant="primary" icon={<Check />} disabled={busy === item.id} onClick={() => void approve(item)}>
                {busy === item.id ? "Working…" : "Approve"}
              </Button>
            </>
          ) : (
            <span>{rowTime(item.created_at, now)}</span>
          )
        }
      >
        {item.body.trim() && (
          <div className="max-w-[68ch] text-[13px] text-ink-soft">
            <AssistantMarkdown content={item.body} />
          </div>
        )}
        {pending && item.task_id && taskName.get(item.task_id) && (
          <p className="mt-2 text-[12px] text-ink-faint">
            From &ldquo;{taskName.get(item.task_id)}&rdquo;, {rowTime(item.created_at, now)}
          </p>
        )}
        {item.files && item.files.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {item.files.map((path) => (
              <Button key={path} icon={<FileText />} onClick={() => void api.openFile(path)}>
                Open {path.split(/[\\/]/).pop()}
              </Button>
            ))}
          </div>
        )}
        {rowError?.id === item.id && (
          <p role="alert" className="mt-3 text-[13px] text-error">
            {rowError.message}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {item.kind === "error" && item.task_id && (
            <Button
              variant="primary"
              icon={<RotateCw />}
              disabled={rerun.has(item.id)}
              onClick={() => void runAgain(item)}
            >
              {rerun.has(item.id) ? "Started again" : "Try again"}
            </Button>
          )}
          {item.chat_id && (
            <Button
              variant={item.kind === "question" ? "primary" : undefined}
              icon={<ArrowRight />}
              onClick={() => void openChat(item.chat_id!)}
            >
              {item.kind === "question" ? "Answer in chat" : item.kind === "error" ? "See what happened" : "Open conversation"}
            </Button>
          )}
          {!pending && (
            <Button icon={<X />} onClick={() => dismiss(item.id)}>
              Dismiss
            </Button>
          )}
        </div>
      </ListRow>
    );
  }

  return (
    <PageShell
      title="Inbox"
      subtitle={
        waiting.length > 0
          ? `${waiting.length} waiting for your OK${unreadCount > waiting.length ? `, ${unreadCount - waiting.length} new` : ""}.`
          : unreadCount > 0
            ? `${unreadCount} new. Results from your scheduled tasks and anything zWork wants you to see.`
            : "Results from your scheduled tasks and anything zWork wants you to see."
      }
      actions={
        unreadCount > 0 ? (
          <Button icon={<CheckCheck />} onClick={() => void markAllRead()}>
            Mark all read
          </Button>
        ) : undefined
      }
    >
      {inboxItems.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="All clear"
          body="When a scheduled task finishes or zWork needs your OK, it shows up here."
          action={
            <Button icon={<CalendarClock />} onClick={() => setView("scheduled")}>
              Schedule a task
            </Button>
          }
        />
      ) : (
        <>
          {waiting.length > 0 && (
            <>
              <SectionHeading
                title="Needs your OK"
                count={waiting.length}
                description="zWork stopped before doing these. Approve to let it go ahead."
                className="mt-0"
              />
              <ListGroup>{waiting.map(renderRow)}</ListGroup>
            </>
          )}
          {groups.map((g, i) => (
            <div key={g.label}>
              <SectionHeading
                title={g.label}
                count={g.items.length}
                className={i === 0 && waiting.length === 0 ? "mt-0" : undefined}
              />
              <ListGroup>{g.items.map(renderRow)}</ListGroup>
            </div>
          ))}
        </>
      )}
    </PageShell>
  );
}
