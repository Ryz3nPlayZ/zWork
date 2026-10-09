import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  CircleHelp,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Repeat,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useHit, type LiveApi } from "./live";
import type { CloneState, InboxItem, InboxKind } from "./types";

type Tone = "neutral" | "warning" | "info" | "error";
const TILE_TONE: Record<Tone, string> = {
  neutral: "border-line bg-paper text-ink-muted",
  warning: "border-warning/25 bg-warning/10 text-warning",
  error: "border-error/20 bg-error/10 text-error",
  info: "border-info/20 bg-info/10 text-info",
};

function IconTile({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[9px] border [&_svg]:h-4 [&_svg]:w-4", TILE_TONE[tone])}>
      {children}
    </div>
  );
}

function Button({
  primary,
  icon,
  children,
  target,
  pressed,
}: {
  primary?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  target?: string;
  pressed?: boolean;
}) {
  return (
    <span
      data-target={target}
      data-pressed={pressed}
      className={cn(
        "press inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[12.5px] font-medium [&_svg]:h-3.5 [&_svg]:w-3.5",
        primary ? "bg-ink text-paper" : "border border-line bg-paper text-ink",
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function RowIcon({ children, target, pressed }: { children: ReactNode; target?: string; pressed?: boolean }) {
  return (
    <span
      data-target={target}
      data-pressed={pressed}
      className={cn(
        "press inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-faint [&_svg]:h-3.5 [&_svg]:w-3.5",
        pressed && "bg-line/50 text-ink",
      )}
    >
      {children}
    </span>
  );
}

function Switch({ on, onHit }: { on: boolean; onHit?: (api: LiveApi) => void }) {
  const hit = useHit();
  return (
    <span
      {...(onHit && hit(onHit))}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors",
        on ? "border-transparent bg-accent" : "border-line bg-paper-sunken",
      )}
    >
      <span
        className={cn(
          "h-3 w-3 rounded-full shadow-sm transition-transform",
          on ? "translate-x-[15px] bg-paper" : "translate-x-[2px] bg-ink-faint",
        )}
      />
    </span>
  );
}

function Segmented({ options, value }: { options: { label: string; count: number }[]; value: string }) {
  return (
    <div className="inline-flex rounded-lg bg-paper-raised p-0.5">
      {options.map((o) => (
        <span
          key={o.label}
          className={cn(
            "rounded-md px-2.5 py-1 text-[12px] font-medium",
            o.label === value ? "bg-paper text-ink shadow-sm" : "text-ink-muted",
          )}
        >
          {o.label}
          <span className="ml-1 text-ink-faint">{o.count}</span>
        </span>
      ))}
    </div>
  );
}

function PageShell({
  title,
  subtitle,
  actions,
  toolbar,
  children,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      <div className="clone-scroll flex-1 overflow-hidden">
        <div className="mx-auto w-full max-w-[960px] px-6 pb-16 pt-12">
          <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
              <p className="mt-0.5 text-[13px] text-ink-muted">{subtitle}</p>
            </div>
            {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
          </header>
          {toolbar && <div className="mb-4 flex flex-wrap items-center justify-between gap-2">{toolbar}</div>}
          {children}
        </div>
      </div>
    </div>
  );
}

function ListGroup({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line rounded-2xl border border-line bg-paper-raised">{children}</ul>;
}

export function ScheduledPage({ s }: { s: CloneState }) {
  const active = s.tasks.filter((t) => t.enabled).length;
  return (
    <PageShell
      title="Scheduled"
      subtitle={`${active} active. Results land in your Inbox.`}
      actions={
        <Button primary icon={<Plus />} target="new-task" pressed={s.pressed === "new-task"}>
          New task
        </Button>
      }
      toolbar={
        <Segmented
          value="All"
          options={[
            { label: "All", count: s.tasks.length },
            { label: "Active", count: active },
            { label: "Paused", count: s.tasks.length - active },
          ]}
        />
      }
    >
      <ListGroup>
        {s.tasks.map((t) => (
          <li
            key={t.id}
            data-row={t.id}
            className={cn("transition-colors first:rounded-t-2xl last:rounded-b-2xl", t.running && "bg-line/20")}
          >
            <div className="flex items-center gap-3 px-3.5 py-2.5">
              <IconTile>{t.repeat ? <Repeat /> : <CalendarDays />}</IconTile>
              <div className="min-w-0 flex-1">
                <div className={cn("truncate text-[13px]", t.enabled ? "font-semibold text-ink" : "text-ink-muted")}>
                  {t.title}
                  {t.isNew && (
                    <span className="ml-2 inline-flex items-center rounded-full border border-info/25 bg-info/10 px-2 py-px align-middle text-[10.5px] font-medium leading-4 text-info">
                      New
                    </span>
                  )}
                </div>
                <div className="truncate text-[12px] text-ink-muted">
                  {t.enabled ? (
                    <>
                      {t.trigger} · Next {t.next}
                      {t.last ? ` · Last run ${t.last}` : ""}
                    </>
                  ) : (
                    <>Paused · {t.trigger}</>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <RowIcon target={`run-${t.id}`} pressed={s.pressed === `run-${t.id}` || t.running}>
                  {t.running ? <Loader2 className="animate-spin" /> : <Play />}
                </RowIcon>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-ink-faint">
                <Switch on={t.enabled} onHit={(api) => api.toggleTask(t.id)} />
                <RowIcon>
                  <MoreHorizontal />
                </RowIcon>
              </div>
            </div>
          </li>
        ))}
      </ListGroup>
    </PageShell>
  );
}

function kindMeta(kind: InboxKind): { icon: ReactNode; tone: Tone; label: string } {
  switch (kind) {
    case "flag":
      return { icon: <AlertTriangle />, tone: "warning", label: "Needs attention" };
    case "question":
      return { icon: <CircleHelp />, tone: "info", label: "Question" };
    case "error":
      return { icon: <AlertTriangle />, tone: "error", label: "Failed" };
    default:
      return { icon: <Bot />, tone: "neutral", label: "Summary" };
  }
}

function InboxRow({ item, s }: { item: InboxItem; s: CloneState }) {
  const meta = kindMeta(item.kind);
  const hit = useHit();
  return (
    <li data-row={item.id} className={cn("transition-colors first:rounded-t-2xl last:rounded-b-2xl", item.open && "bg-line/20")}>
      <div data-target={`row-${item.id}`} {...hit((api) => api.toggleInbox(item.id))} className="flex items-center gap-3 px-3.5 py-2.5">
        <IconTile tone={meta.tone}>{meta.icon}</IconTile>
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-[13px]", item.read ? "text-ink-muted" : "font-semibold text-ink")}>{item.title}</div>
          <div className="truncate text-[12px] text-ink-muted">
            {meta.label}
            {!item.open && <span className="text-ink-faint"> · {item.body.split("\n")[0]}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!item.read && (
            <RowIcon>
              <Check />
            </RowIcon>
          )}
          <RowIcon>
            <X />
          </RowIcon>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-ink-faint">{item.time}</div>
      </div>
      {item.open && (
        <div className="px-3.5 pb-3.5 pl-[58px]">
          <p className="max-w-[68ch] whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{item.body}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button primary icon={<ArrowRight />} target={`open-${item.id}`} pressed={s.pressed === `open-${item.id}`}>
              Open chat
            </Button>
            <Button icon={<Check />}>Mark read</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function SectionHeading({ title, count, first }: { title: string; count: number; first?: boolean }) {
  return (
    <div className={cn("mb-2.5", first ? "mt-0" : "mt-8")}>
      <h2 className="text-[13px] font-semibold text-ink">
        {title}
        <span className="ml-1.5 font-normal text-ink-faint">{count}</span>
      </h2>
    </div>
  );
}

export function InboxPage({ s }: { s: CloneState }) {
  const unread = s.inbox.filter((i) => !i.read);
  const read = s.inbox.filter((i) => i.read);
  return (
    <PageShell
      title="Inbox"
      subtitle={
        unread.length > 0
          ? `${unread.length} new. Results from scheduled tasks and anything zWork wants you to see.`
          : "Results from scheduled tasks and anything zWork wants you to see."
      }
      toolbar={
        <Segmented
          value="All"
          options={[
            { label: "New", count: unread.length },
            { label: "All", count: s.inbox.length },
          ]}
        />
      }
    >
      {unread.length > 0 && (
        <>
          <SectionHeading title="New" count={unread.length} first />
          <ListGroup>
            {unread.map((i) => (
              <InboxRow key={i.id} item={i} s={s} />
            ))}
          </ListGroup>
        </>
      )}
      <SectionHeading title="Earlier" count={read.length} first={unread.length === 0} />
      <ListGroup>
        {read.map((i) => (
          <InboxRow key={i.id} item={i} s={s} />
        ))}
      </ListGroup>
    </PageShell>
  );
}
