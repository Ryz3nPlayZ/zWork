/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */

import { useState, useEffect } from "react";
import {
  Inbox,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Eye,
  X,
  Clock,
  Bot,
  ArrowRight,
} from "lucide-react";
import { useApp } from "../lib/store";
import type { InboxItem } from "../lib/api";
import { cn } from "../lib/cn";

/** Visual treatment per inbox item kind. */
function kindMeta(kind: InboxItem["kind"]) {
  switch (kind) {
    case "flag":
      return {
        icon: AlertTriangle,
        dot: "bg-warning",
        iconWrap: "border-warning/20 bg-warning/10 text-warning",
        label: "Needs attention",
      };
    case "question":
      return {
        icon: HelpCircle,
        dot: "bg-info",
        iconWrap: "border-info/20 bg-info/10 text-info",
        label: "Question",
      };
    case "error":
      return {
        icon: AlertTriangle,
        dot: "bg-error",
        iconWrap: "border-error/20 bg-error/10 text-error",
        label: "Error",
      };
    case "summary":
    default:
      return {
        icon: Bot,
        dot: "bg-ink-faint",
        iconWrap: "border-line bg-paper text-ink-muted",
        label: "Summary",
      };
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

export function InboxPage() {
  const inboxItems = useApp((s) => s.inboxItems);
  const fetchInbox = useApp((s) => s.fetchInbox);
  const markRead = useApp((s) => s.markInboxRead);
  const markAllRead = useApp((s) => s.markAllInboxRead);
  const deleteItem = useApp((s) => s.deleteInboxItem);
  const openChat = useApp((s) => s.openChat);
  const [revealedId, setRevealedId] = useState<string | null>(null);

  useEffect(() => {
    void fetchInbox();
    // Refresh inbox every 30s so items posted by background runs appear.
    const id = setInterval(() => void fetchInbox(), 30_000);
    return () => clearInterval(id);
  }, [fetchInbox]);

  const unread = inboxItems.filter((i) => !i.read);
  const read = inboxItems.filter((i) => i.read);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      {/* Header — consistent with Scheduled and Projects */}
      <div className="shrink-0 border-b border-line bg-paper-soft px-6 py-4">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight text-ink">
              Inbox
            </h1>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              {unread.length} unread · updates from scheduled runs and the agent
            </p>
          </div>
          {unread.length > 0 && (
            <button
              type="button"
              onClick={() => void markAllRead()}
              className="press ring-focus inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-paper-sunken transition-colors"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Mark all read
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[860px] px-6 py-6">
          {/* Unread items */}
          <div className="flex flex-col gap-4">
            {inboxItems.length === 0 && (
              <div className="rounded-2xl border border-dashed border-line p-12 text-center">
                <Inbox className="mx-auto h-8 w-8 text-ink-faint" />
                <h3 className="mt-3 text-[13.5px] font-semibold text-ink">
                  All clear
                </h3>
                <p className="mx-auto mt-1 max-w-[280px] text-[12.5px] text-ink-muted">
                  Nothing waiting for you. Scheduled-task results and agent
                  flags will appear here.
                </p>
              </div>
            )}

            {unread.map((item) => {
              const meta = kindMeta(item.kind);
              const Icon = meta.icon;
              const revealed = revealedId === item.id || item.kind === "flag" || item.kind === "error";
              return (
                <div
                  key={item.id}
                  className="relative rounded-2xl border border-line bg-paper-raised p-5"
                >
                  {/* Top row: icon + title + time + dismiss */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
                          meta.iconWrap,
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-ink">
                            {item.title}
                          </span>
                          <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} aria-hidden />
                          <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-faint">
                            <Clock className="h-3 w-3" />
                            {timeAgo(item.created_at)}
                          </span>
                        </div>
                        <p className="mt-0.5 max-w-[520px] text-[12.5px] leading-relaxed text-ink-muted">
                          {item.body}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm("Dismiss this inbox item?")) {
                          void deleteItem(item.id);
                        }
                      }}
                      title="Dismiss"
                      aria-label="Dismiss"
                      className="press ring-focus rounded-lg p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Action area */}
                  <div className="mt-4 flex items-center gap-2">
                    {item.kind === "summary" && !revealed && (
                      <button
                        type="button"
                        onClick={() => setRevealedId(item.id)}
                        className="press ring-focus inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink/90 transition-colors"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Reveal summary
                      </button>
                    )}

                    {item.chat_id && (
                      <button
                        type="button"
                        onClick={() => {
                          void markRead(item.id);
                          void openChat(item.chat_id!);
                        }}
                        className="press ring-focus inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-paper-sunken transition-colors"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                        Open run
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void markRead(item.id)}
                      className="press ring-focus inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink-muted hover:bg-paper-sunken transition-colors"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Mark read
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Read items */}
          {read.length > 0 && (
            <div className="mt-8">
              <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-ink-faint" />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Read ({read.length})
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {read.map((item) => {
                  const meta = kindMeta(item.kind);
                  const Icon = meta.icon;
                  return (
                    <div
                      key={item.id}
                      className="group flex items-center justify-between rounded-xl border border-line bg-paper-soft px-4 py-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Icon className="h-4 w-4 shrink-0 text-ink-faint" />
                        <span className="truncate text-[12.5px] text-ink-muted">
                          {item.title}: {item.body.slice(0, 60)}
                          {item.body.length > 60 ? "…" : ""}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[10.5px] text-ink-faint">
                          {timeAgo(item.created_at)}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm("Delete this read item?")) {
                              void deleteItem(item.id);
                            }
                          }}
                          title="Delete"
                          aria-label="Delete"
                          className="press ring-focus rounded p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
