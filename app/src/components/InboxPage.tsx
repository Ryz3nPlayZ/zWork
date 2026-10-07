/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */

import { useState, useEffect, useRef } from "react";
import { Inbox, Check, CheckCheck, AlertTriangle, HelpCircle, X, Bot, ArrowRight, CalendarClock } from "lucide-react";
import { useApp } from "../lib/store";
import type { InboxItem } from "../lib/api";
import {
  Button,
  EmptyState,
  IconTile,
  ListGroup,
  ListRow,
  PageShell,
  RowIconButton,
  SectionHeading,
  Segmented,
  type Tone,
} from "./page/Page";

/** Icon and tone per inbox item kind. */
function kindMeta(kind: InboxItem["kind"]): { icon: typeof Bot; tone: Tone; label: string } {
  switch (kind) {
    case "flag":
      return { icon: AlertTriangle, tone: "warning", label: "Needs attention" };
    case "question":
      return { icon: HelpCircle, tone: "info", label: "Question" };
    case "error":
      return { icon: AlertTriangle, tone: "error", label: "Failed" };
    case "summary":
    default:
      return { icon: Bot, tone: "neutral", label: "Summary" };
  }
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** How long a dismissed item can be brought back before it is deleted. */
const UNDO_MS = 5000;

export function InboxPage() {
  const inboxItems = useApp((s) => s.inboxItems);
  const fetchInbox = useApp((s) => s.fetchInbox);
  const markRead = useApp((s) => s.markInboxRead);
  const markAllRead = useApp((s) => s.markAllInboxRead);
  const deleteItem = useApp((s) => s.deleteInboxItem);
  const openChat = useApp((s) => s.openChat);
  const setView = useApp((s) => s.setView);
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const [openId, setOpenId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    void fetchInbox();
    // Refresh inbox every 30s so items posted by background runs appear.
    const id = setInterval(() => void fetchInbox(), 30_000);
    return () => clearInterval(id);
  }, [fetchInbox]);

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

  const unread = inboxItems.filter((i) => !i.read);
  const read = inboxItems.filter((i) => i.read);
  const showTabs = read.length > 0;
  const view = showTabs ? tab : "unread";

  function renderRow(item: InboxItem) {
    if (dismissed.has(item.id)) {
      return (
        <li key={item.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[12.5px] text-ink-muted">
          <span className="truncate">Dismissed &ldquo;{item.title}&rdquo;</span>
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
            {meta.label}
            {!open && item.body && <span className="text-ink-faint"> · {item.body.split("\n")[0]}</span>}
          </>
        }
        muted={item.read}
        onClick={() => setOpenId(open ? null : item.id)}
        expanded={open}
        trailing={<span>{timeAgo(item.created_at)}</span>}
        actions={
          <>
            {!item.read && (
              <RowIconButton label="Mark read" onClick={() => void markRead(item.id)}>
                <Check />
              </RowIconButton>
            )}
            <RowIconButton label="Dismiss" onClick={() => dismiss(item.id)}>
              <X />
            </RowIconButton>
          </>
        }
      >
        <p className="max-w-[68ch] whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{item.body}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {item.chat_id && (
            <Button
              variant="primary"
              icon={<ArrowRight />}
              onClick={() => {
                void markRead(item.id);
                void openChat(item.chat_id!);
              }}
            >
              Open run
            </Button>
          )}
          {!item.read && (
            <Button icon={<Check />} onClick={() => void markRead(item.id)}>
              Mark read
            </Button>
          )}
          <Button icon={<X />} onClick={() => dismiss(item.id)}>
            Dismiss
          </Button>
        </div>
      </ListRow>
    );
  }

  return (
    <PageShell
      title="Inbox"
      subtitle={
        unread.length > 0
          ? `${unread.length} new. Results from scheduled tasks and anything zWork wants you to see.`
          : "Results from scheduled tasks and anything zWork wants you to see."
      }
      actions={
        unread.length > 0 ? (
          <Button icon={<CheckCheck />} onClick={() => void markAllRead()}>
            Mark all read
          </Button>
        ) : undefined
      }
      toolbar={
        showTabs ? (
          <Segmented
            label="Show"
            value={tab}
            onChange={setTab}
            options={[
              { value: "unread", label: "New", count: unread.length },
              { value: "all", label: "All", count: inboxItems.length },
            ]}
          />
        ) : undefined
      }
    >
      {inboxItems.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="All clear"
          body="When a scheduled task finishes or zWork needs your attention, it shows up here."
          action={
            <Button icon={<CalendarClock />} onClick={() => setView("scheduled")}>
              Schedule a task
            </Button>
          }
        />
      ) : view === "unread" ? (
        unread.length > 0 ? (
          <ListGroup>{unread.map(renderRow)}</ListGroup>
        ) : (
          <EmptyState
            compact
            icon={<Check />}
            title="Nothing new"
            body="You've seen everything. Earlier items are under All."
            action={<Button onClick={() => setTab("all")}>Show all</Button>}
          />
        )
      ) : (
        <>
          {unread.length > 0 && (
            <>
              <SectionHeading title="New" count={unread.length} className="mt-0" />
              <ListGroup>{unread.map(renderRow)}</ListGroup>
            </>
          )}
          <SectionHeading title="Earlier" count={read.length} className={unread.length > 0 ? undefined : "mt-0"} />
          <ListGroup>{read.map(renderRow)}</ListGroup>
        </>
      )}
    </PageShell>
  );
}
