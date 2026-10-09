import { forwardRef, useLayoutEffect, useRef } from "react";
import { ChevronDown, Download, History } from "lucide-react";
import gsap from "gsap";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { ArtifactPanel } from "./ArtifactPanel";
import { Composer } from "./Composer";
import { AssistantMessage, UserBubble, WorkingLabel } from "./Message";
import { InboxPage, ScheduledPage } from "./Pages";
import { Sidebar } from "./Sidebar";
import type { CloneState } from "./types";

gsap.registerPlugin(ScrollToPlugin);

function Welcome({ s }: { s: CloneState }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center px-6 pb-16">
      <h1 className="text-center font-serif text-[42px] font-light leading-tight tracking-tight text-ink">
        Welcome back, <span className="italic text-ink-soft">Sam</span>.
      </h1>
      <div className="mt-8 w-full max-w-[720px]">
        <Composer s={s} placeholder="What can I help with?" />
      </div>
    </div>
  );
}

function ChatView({ s }: { s: CloneState }) {
  const scroller = useRef<HTMLDivElement>(null);
  const lastHeight = useRef(0);

  // Follow the conversation like the app does while it streams.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const h = el.scrollHeight;
    if (h === lastHeight.current) return;
    const jump = h < lastHeight.current;
    lastHeight.current = h;
    if (jump) el.scrollTop = el.scrollHeight;
    else gsap.to(el, { scrollTo: { y: "max" }, duration: 0.6, ease: "power2.out", overwrite: true });
  });

  const last = s.messages[s.messages.length - 1];
  const showWorking =
    s.working && last && (last.role === "user" || (last.role === "assistant" && !last.text && last.steps.every((st) => st.done)));

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between bg-gradient-to-b from-paper via-paper/95 to-transparent py-2.5 pl-5 pr-5">
        <span className="max-w-[60%] truncate text-[13px] font-medium text-ink">{s.chatTitle}</span>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-[11px] font-medium text-ink">
            <History className="h-3 w-3" />
            Branches
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-[11px] font-medium text-ink">
            <Download className="h-3 w-3" />
            Export
            <ChevronDown className="h-3 w-3" />
          </span>
        </div>
      </div>
      <div ref={scroller} className="clone-scroll flex-1 overflow-y-auto pb-44">
        <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-6 pb-8 pt-14">
          {s.messages.map((m) =>
            m.role === "user" ? <UserBubble key={m.id} m={m} /> : <AssistantMessage key={m.id} m={m} pressed={s.pressed} />,
          )}
          {showWorking && <WorkingLabel word={s.workingWord} />}
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-paper via-paper/95 to-transparent px-6 pb-5 pt-10">
        <div className="mx-auto max-w-[960px]">
          <Composer s={s} placeholder="Reply to zWork" />
        </div>
      </div>
    </div>
  );
}

/** A pixel-for-pixel picture of the zWork desktop window, rendered at the
 *  app's real size. Callers scale it to fit (see ScaledWindow). */
export const AppWindow = forwardRef<
  HTMLDivElement,
  { s: CloneState; width: number; height: number; panelWidth?: number; className?: string; live?: boolean }
>(function AppWindow({ s, width, height, panelWidth = 560, live }, ref) {
  return (
    <div
      ref={ref}
      aria-hidden={live ? undefined : true}
      className="clone relative overflow-hidden rounded-[12px] bg-paper-sidebar text-left"
      style={{ width, height }}
    >
      <Sidebar s={s} />
      <main className="absolute bottom-[5px] left-[253px] right-[5px] top-[5px] flex overflow-hidden rounded-[14px] bg-paper shadow-float">
        {s.view === "welcome" && <Welcome s={s} />}
        {s.view === "chat" && <ChatView s={s} />}
        {s.view === "scheduled" && <ScheduledPage s={s} />}
        {s.view === "inbox" && <InboxPage s={s} />}
        {s.view === "chat" && s.panel && <ArtifactPanel panel={s.panel} width={panelWidth} />}
      </main>
      <Cursor />
    </div>
  );
});

/** The demo pointer. Scenarios move it with GSAP via [data-cursor]. */
export function Cursor() {
  return (
    <div data-cursor className="pointer-events-none absolute left-0 top-0 z-50 opacity-0" style={{ transform: "translate(-100px,-100px)" }}>
      <svg width="22" height="22" viewBox="0 0 24 24" className="drop-shadow-[0_2px_3px_rgba(0,0,0,0.3)]">
        <path
          d="M5.5 3.2v15.6c0 .5.6.8 1 .4l3.7-3.6 2.4 5.6c.2.4.6.6 1 .4l2-.9c.4-.2.6-.6.4-1l-2.4-5.5h5.2c.5 0 .8-.6.4-1L6.4 2.8c-.4-.3-.9 0-.9.4z"
          fill="#111"
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <span data-cursor-ring className="absolute -left-2.5 -top-2.5 h-5 w-5 rounded-full border-2 border-ink/40 opacity-0" />
    </div>
  );
}
