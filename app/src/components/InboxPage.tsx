import { useState } from "react";
import {
  Inbox,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Eye,
  ShieldCheck,
  MessageCircle,
  X,
  Clock,
  Bot,
} from "lucide-react";
import { cn } from "../lib/cn";

// ---- Mock data until backend wires up notifications ----

type NotificationKind = "brief" | "approval" | "clarification";

interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  timestamp: string;
  meta?: Record<string, string>;
  choices?: string[];
  resolved?: boolean;
}

const MOCK_NOTIFICATIONS: Notification[] = [
  {
    id: "n-1",
    kind: "brief",
    title: "Morning Brief",
    body: "Hey Zemu, while you were away, I reviewed your 15 real estate comps. I generated a side-by-side Sheet artifact and flagged 2 properties under market value.",
    timestamp: "2026-05-25T08:30:00",
    meta: { artifact: "Real Estate Comps Sheet" },
  },
  {
    id: "n-2",
    kind: "approval",
    title: "Approval Required",
    body: "Send 5 Drafts to Clients in Apple Mail",
    timestamp: "2026-05-25T09:15:00",
    meta: { count: "5", app: "Apple Mail" },
  },
  {
    id: "n-3",
    kind: "clarification",
    title: "Clarification Needed",
    body: "I am attempting to categorize your download receipts, but I found an image I can't read. Is this an electric bill or a restaurant receipt?",
    timestamp: "2026-05-25T10:05:00",
    choices: ["Electric bill", "Restaurant receipt", "Other"],
  },
];

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function InboxPage() {
  const [items, setItems] = useState<Notification[]>(MOCK_NOTIFICATIONS);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  const dismiss = (id: string) => {
    setDismissingId(id);
    setTimeout(() => {
      setItems((prev) => prev.filter((n) => n.id !== id));
      setDismissingId(null);
    }, 250);
  };

  const resolve = (id: string) => {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, resolved: true } : n))
    );
  };

  const pending = items.filter((n) => !n.resolved);
  const resolved = items.filter((n) => n.resolved);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[720px] px-6 py-14">
        {/* Header */}
        <div className="mb-10 flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-line bg-paper-raised text-accent">
            <Inbox className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-serif text-[32px] tracking-tight leading-none text-ink">
              Inbox
            </h1>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-muted max-w-[500px]">
              The Human-in-the-Loop Gateway. Review agent updates, approve sensitive actions, and clear blockers.
            </p>
          </div>
        </div>

        {/* Pending */}
        <div className="flex flex-col gap-4">
          {pending.length === 0 && resolved.length === 0 && (
            <div className="rounded-2xl border border-dashed border-line p-12 text-center">
              <Inbox className="mx-auto h-8 w-8 text-ink-faint" />
              <h3 className="mt-3 text-[13.5px] font-semibold text-ink">
                All clear
              </h3>
              <p className="mt-1 text-[12.5px] text-ink-muted max-w-[280px] mx-auto">
                No notifications, approvals, or clarifications waiting for you.
              </p>
            </div>
          )}

          {pending.map((n) => (
            <div
              key={n.id}
              className={cn(
                "relative rounded-2xl border bg-paper-raised p-5 shadow-sm transition-all duration-200",
                n.kind === "approval" && "border-amber-500/20",
                n.kind === "clarification" && "border-accent/20",
                n.kind === "brief" && "border-line",
                dismissingId === n.id && "opacity-0 translate-x-2"
              )}
            >
              {/* Top row: icon + title + time + dismiss */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
                      n.kind === "brief" && "border-line bg-paper text-accent",
                      n.kind === "approval" && "border-amber-500/20 bg-amber-500/10 text-amber-600",
                      n.kind === "clarification" && "border-accent/20 bg-accent/10 text-accent"
                    )}
                  >
                    {n.kind === "brief" && <Bot className="h-4 w-4" />}
                    {n.kind === "approval" && <ShieldCheck className="h-4 w-4" />}
                    {n.kind === "clarification" && <HelpCircle className="h-4 w-4" />}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink">
                        {n.title}
                      </span>
                      <span className="flex items-center gap-1 text-[10.5px] text-ink-faint">
                        <Clock className="h-3 w-3" />
                        {timeAgo(n.timestamp)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-ink-muted leading-relaxed max-w-[520px]">
                      {n.body}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(n.id)}
                  className="press rounded-lg p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Action area */}
              <div className="mt-4">
                {n.kind === "brief" && (
                  <div>
                    {revealedId === n.id ? (
                      <div className="rounded-xl border border-line bg-paper p-3 text-[12.5px] text-ink leading-relaxed animate-fade-in">
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                          Summary
                        </div>
                        {n.body}
                        {n.meta?.artifact && (
                          <button
                            type="button"
                            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-paper-sunken"
                          >
                            <Eye className="h-3 w-3" />
                            Open {n.meta.artifact}
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRevealedId(n.id)}
                        className="press inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink-soft"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Click to reveal
                      </button>
                    )}
                  </div>
                )}

                {n.kind === "approval" && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => resolve(n.id)}
                      className="press inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink-soft"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Approve & Execute
                    </button>
                    <button
                      type="button"
                      onClick={() => dismiss(n.id)}
                      className="press inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-paper-sunken"
                    >
                      <X className="h-3.5 w-3.5" />
                      Deny
                    </button>
                  </div>
                )}

                {n.kind === "clarification" && n.choices && (
                  <div className="flex flex-wrap gap-2">
                    {n.choices.map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        onClick={() => resolve(n.id)}
                        className="press inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-paper-sunken hover:border-line-strong"
                      >
                        <MessageCircle className="h-3.5 w-3.5" />
                        {choice}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Resolved section */}
        {resolved.length > 0 && (
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-ink-faint" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                Resolved ({resolved.length})
              </span>
            </div>
            <div className="flex flex-col gap-3">
              {resolved.map((n) => (
                <div
                  key={n.id}
                  className="flex items-center justify-between rounded-xl border border-line bg-paper-soft px-4 py-3 opacity-70"
                >
                  <div className="flex items-center gap-3">
                    {n.kind === "brief" && <Bot className="h-4 w-4 text-ink-faint" />}
                    {n.kind === "approval" && <AlertTriangle className="h-4 w-4 text-ink-faint" />}
                    {n.kind === "clarification" && <HelpCircle className="h-4 w-4 text-ink-faint" />}
                    <span className="text-[12.5px] text-ink-muted line-through">
                      {n.title}: {n.body.slice(0, 60)}
                      {n.body.length > 60 ? "..." : ""}
                    </span>
                  </div>
                  <span className="text-[10.5px] text-ink-faint">{timeAgo(n.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
