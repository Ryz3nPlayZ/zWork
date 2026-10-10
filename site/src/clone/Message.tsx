import { Fragment, useMemo, type ReactNode } from "react";
import {
  BarChart3,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  FileCode,
  FileText,
  GitFork,
  Globe,
  Loader2,
  Mail,
  MessageSquare,
  MousePointer2,
  RefreshCcw,
  Search,
  Table2,
  Terminal,
  ThumbsDown,
  Wrench,
} from "lucide-react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { cn } from "../lib/cn";
import { detectPlatform, downloadUrl } from "../lib/site";
import { useHit, useLive } from "./live";
import { Logo } from "./Logo";
import type { AssistantMsg, ArtifactKind, Step, ToolIcon, UserMsg } from "./types";

const TOOL_ICON: Record<ToolIcon, typeof Wrench> = {
  wrench: Wrench,
  terminal: Terminal,
  file: FileText,
  code: FileCode,
  globe: Globe,
  mail: Mail,
  calendar: Calendar,
  message: MessageSquare,
  pointer: MousePointer2,
  search: Search,
  table: Table2,
};

const ARTIFACT_ICON: Record<ArtifactKind, typeof FileText> = {
  report: FileText,
  sheet: Table2,
  email: Mail,
};

/* ---- A tiny markdown renderer. Streaming slices text mid-token, so unclosed
   markers simply run to the end of the string. ---- */

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]*\*{0,2}|`[^`]*`?|\*[^*]+\*?)/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k++} className="font-semibold">{tok.replace(/\*/g, "")}</strong>);
    else if (tok.startsWith("`"))
      out.push(
        <code key={k++} className="rounded bg-paper-raised px-[5px] py-px font-mono text-[13px]">
          {tok.replace(/`/g, "")}
        </code>,
      );
    else out.push(<em key={k++}>{tok.replace(/\*/g, "")}</em>);
    last = i + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = text.split("\n\n");
  const caret = streaming ? (
    <span className="ml-0.5 inline-block h-[1em] w-[2px] bg-ink align-middle animate-typing-cursor" />
  ) : null;
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((b, bi) => {
        const isLast = bi === blocks.length - 1;
        const lines = b.split("\n");
        if (lines.every((l) => l.startsWith("- "))) {
          return (
            <ul key={bi} className="flex list-disc flex-col gap-1.5 pl-6 marker:text-ink-faint">
              {lines.map((l, li) => (
                <li key={li} className="pl-1">
                  {inline(l.slice(2))}
                  {isLast && li === lines.length - 1 && caret}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
            {isLast && caret}
          </p>
        );
      })}
    </div>
  );
}

export function UserBubble({ m }: { m: UserMsg }) {
  return (
    <div data-msg className="group flex w-full justify-end">
      <div className="flex max-w-[85%] flex-col items-end">
        {m.attachment && (
          <div className="mb-1.5 flex items-center gap-2 rounded-full border border-line bg-paper px-2.5 py-1 text-[11.5px] text-ink-muted">
            <FileText className="h-3.5 w-3.5" />
            {m.attachment}
          </div>
        )}
        <div className="whitespace-pre-wrap rounded-2xl rounded-br-md border border-line bg-paper-raised px-3.5 py-2.5 text-[15px] leading-[25px] text-ink">
          {m.text}
        </div>
        <div className="mt-1 text-right text-[11px] text-ink-faint">{m.time}</div>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const Icon = TOOL_ICON[step.icon];
  return (
    <div
      data-step
      className="press flex w-full items-center gap-2 rounded-lg border border-line bg-paper-sunken px-2.5 py-1.5 text-left text-[13px] text-ink-muted"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {step.label}
        {!step.done && "…"}
      </span>
      {step.done ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-ink-faint" />
      )}
    </div>
  );
}

const ORB_STATES: readonly OrbState[] = ["searching", "solving", "listening", "connecting", "weaving", "composing", "breathing"];
function orbFor(label: string): OrbState {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (Math.imul(31, h) + label.charCodeAt(i)) | 0;
  return ORB_STATES[Math.abs(h) % ORB_STATES.length];
}

export function WorkingLabel({ word }: { word: string }) {
  return (
    <div className="flex w-full items-center gap-3">
      <ThinkingOrb state={orbFor(word)} size={64} style={{ width: 32, height: 32 }} className="shrink-0" />
      <span className="shimmer-text text-[14px] font-medium text-ink-faint">{word}…</span>
    </div>
  );
}

/** The way out of the hands-on demo: the app, or back to the composer. */
function GetTheApp({ id }: { id: string }) {
  const live = useLive();
  const platform = useMemo(detectPlatform, []);
  if (!live) return null;
  return (
    <div className="mt-3.5 flex flex-wrap gap-2 animate-[fade-in_320ms_ease-out]">
      <a
        data-live
        href={downloadUrl(platform)}
        className="press inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full bg-ink px-4 text-[13.5px] font-medium text-paper hover:bg-ink/90"
      >
        <Download className="h-4 w-4" />
        {platform ? `Download for ${platform === "Mac" ? "macOS" : platform}` : "Download zWork"}
      </a>
      <button
        data-live
        type="button"
        onClick={(e) => {
          const win = e.currentTarget.closest(".clone");
          live.api.dismissCta(id);
          win?.querySelector<HTMLElement>("[data-composer]")?.focus({ preventScroll: true });
        }}
        className="press h-9 whitespace-nowrap rounded-full border border-line bg-paper px-4 text-[13.5px] font-medium text-ink hover:bg-paper-sunken"
      >
        Keep looking
      </button>
    </div>
  );
}

export function AssistantMessage({ m, pressed }: { m: AssistantMsg; pressed: string | null }) {
  const running = m.steps.find((st) => !st.done);
  const summary = m.working
    ? running
      ? `${running.label}…`
      : "Thinking…"
    : `${m.steps.length} step${m.steps.length === 1 ? "" : "s"}`;
  const ArtIcon = m.artifact ? ARTIFACT_ICON[m.artifact.kind] : FileText;
  const hit = useHit();

  return (
    <div data-msg className="group flex w-full justify-start gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-paper text-ink">
        <Logo size={14} />
      </div>
      <div className="min-w-0 max-w-[92%] flex-1">
        {m.steps.length > 0 && (
          <div className="mb-2">
            <div
              {...(m.working ? {} : hit((api) => api.toggleSteps(m.id)))}
              className="flex w-fit max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-faint [&[data-live]:hover]:text-ink-muted"
            >
              {m.working ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              ) : (
                <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", m.stepsOpen && "rotate-180")} />
              )}
              <span className="truncate">{summary}</span>
            </div>
            {m.stepsOpen && (
              <div className="mt-1.5 space-y-1.5">
                {m.steps.map((st) => (
                  <StepRow key={st.id} step={st} />
                ))}
              </div>
            )}
          </div>
        )}
        {m.text && (
          <div className="text-[15px] leading-[25px] text-ink">
            <RichText text={m.text} streaming={m.streaming} />
          </div>
        )}
        {m.cta && <GetTheApp id={m.id} />}
        {m.artifact && (
          <div
            data-target="artifact-card"
            data-pressed={pressed === "artifact-card"}
            {...hit((api) => api.openPanel(m.artifact!.title, m.artifact!.kind))}
            className="press mt-3 flex w-full items-center gap-3 rounded-2xl border border-line bg-paper-raised px-3.5 py-3"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-paper-sunken text-ink-muted">
              {m.artifact.kind === "sheet" ? <BarChart3 className="h-4 w-4" /> : <ArtIcon className="h-4 w-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-ink">{m.artifact.title}</span>
              <span className="block text-[12px] text-ink-muted">Click to open in the sidebar</span>
            </span>
          </div>
        )}
        {m.footer && (
          <div className="mt-1 flex items-center gap-0.5 text-ink-faint">
            {[Copy, RefreshCcw, GitFork, ThumbsDown].map((I, i) => (
              <span key={i} className="inline-flex h-7 w-7 items-center justify-center rounded-md">
                <I className="h-3.5 w-3.5" />
              </span>
            ))}
            <span className="ml-auto font-mono text-[11px] text-ink-faint">{m.footer}</span>
          </div>
        )}
      </div>
    </div>
  );
}
