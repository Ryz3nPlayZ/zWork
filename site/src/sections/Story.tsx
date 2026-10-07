import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";
import {
  AppWindow,
  Brain,
  FileSpreadsheet,
  FolderOpen,
  Globe,
  Layers,
  Plug,
  Sparkles,
} from "lucide-react";
import { LiveDemo } from "../clone/LiveDemo";
import { AssistantMessage } from "../clone/Message";
import { browserScenario } from "../clone/scenarios";
import type { AssistantMsg } from "../clone/types";
import { H2, Section } from "./ui";

gsap.registerPlugin(ScrollTrigger, SplitText, useGSAP);

/** Scroll-scrubbed statement: words light up as you read down the page. */
export function Statement() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const split = SplitText.create(".statement", { type: "words" });
        gsap.fromTo(
          split.words,
          { opacity: 0.14 },
          {
            opacity: 1,
            stagger: 0.1,
            ease: "none",
            scrollTrigger: { trigger: ".statement", start: "top 78%", end: "bottom 45%", scrub: true },
          },
        );
        return () => split.revert();
      });
    },
    { scope: root },
  );
  return (
    <Section className="py-32 sm:py-48">
      <div ref={root}>
        <p className="eyebrow mb-8">Why it's different</p>
        <p className="statement display max-w-[22ch] text-[40px] leading-[1.08] text-ink sm:text-[64px] lg:text-[76px]">
          Use ChatGPT for questions. Use zWork for the jobs you redo every week: it works on the files already on your computer,
          hands back real Excel and Word files, and asks before anything is sent.
        </p>
      </div>
    </Section>
  );
}

const ACTIONS = [
  "Read expenses_q3_export.csv",
  "Matched 41 payments to open invoices",
  "Searched Gmail: invoices newer_than:1d",
  "Clicked “Download statement”",
  "Wrote q3_board_deck.pptx",
  "Updated the Leads sheet: 30 rows",
  "Posted the summary in #ops",
  "Opened Numbers and pasted 3 rows",
  "Created a schedule: Fridays at 16:00",
  "Read 14 PDFs in ~/Contracts",
  "Filled in the vendor form on portal.acme.com",
  "Drafted 6 overdue-invoice reminders",
  "Drafted a reply to Priya",
  "Added 3 events to Calendar",
];

/** A ticker of real-looking tool calls, looped with GSAP. */
export function Ticker() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.utils.toArray<HTMLElement>(".ticker-track").forEach((track, i) => {
          gsap.fromTo(
            track,
            { xPercent: i % 2 ? -50 : 0 },
            { xPercent: i % 2 ? 0 : -50, duration: 60, ease: "none", repeat: -1 },
          );
        });
      });
    },
    { scope: root },
  );
  const row = (items: string[]) => (
    <div className="ticker-track flex w-max gap-3 pr-3">
      {[...items, ...items].map((a, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-paper-sunken px-3 py-1.5 text-[13px] text-ink-muted"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          {a}
        </span>
      ))}
    </div>
  );
  return (
    <div
      ref={root}
      aria-hidden="true"
      className="flex flex-col gap-3 overflow-hidden py-2 [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]"
    >
      {row(ACTIONS.slice(0, 7))}
      {row(ACTIONS.slice(7))}
    </div>
  );
}

const CAPS = [
  {
    icon: FileSpreadsheet,
    title: "Real files, not chat replies",
    body: "Reads spreadsheets, PDFs and scanned pages. Writes Excel, Word, PowerPoint and PDF files you can open anywhere.",
  },
  {
    icon: FolderOpen,
    title: "Works through whole folders",
    body: "Every PDF, every export, every row. No upload limits, because nothing gets uploaded.",
  },
  {
    icon: Plug,
    title: "Works inside your tools",
    body: "Reads and acts in Gmail, Calendar, Slack, Notion, Sheets and hundreds more, each connected in one click.",
  },
  {
    icon: Brain,
    title: "Remembers",
    body: "Your team, your tone, how you like reports laid out. Tell it once.",
  },
  {
    icon: Layers,
    title: "Several jobs at once",
    body: "Splits big jobs across helper agents, and runs separate tasks side by side.",
  },
  {
    icon: Sparkles,
    title: "Save what worked",
    body: "Turn a task that went well into a skill and run it again with one slash command.",
  },
];

function BrowserCard() {
  return (
    <LiveDemo
      scenario={browserScenario}
      width={560}
      height={330}
      loopDelay={2.5}
      render={(s) => {
        const m = s.messages.find((x) => x.role === "assistant") as AssistantMsg | undefined;
        return <div className="bg-paper p-5">{m && <AssistantMessage m={m} pressed={null} />}</div>;
      }}
    />
  );
}

export function Capabilities() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        ScrollTrigger.batch(".cap", {
          start: "top 88%",
          once: true,
          onEnter: (els) => gsap.from(els, { autoAlpha: 0, y: 40, duration: 0.9, stagger: 0.08, ease: "power3.out" }),
        });
      });
    },
    { scope: root },
  );

  return (
    <Section className="pb-32 sm:pb-44">
      <div ref={root}>
        <div className="mb-14 flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <H2 className="max-w-[14ch]">
            Everything you'd use to <em className="text-ink-soft">do it yourself.</em>
          </H2>
          <p className="max-w-[42ch] text-[16px] leading-relaxed text-ink-muted">
            zWork has the same tools you do: your files, a real browser, your desktop apps and your accounts. So the
            job ends with the work done, not with instructions for you.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <article className="cap relative overflow-hidden rounded-3xl border border-line bg-paper-raised lg:col-span-2 lg:row-span-2">
            <div className="flex h-full flex-col gap-7 p-7 sm:p-9">
              <div>
                <div className="flex gap-2 text-ink-muted">
                  <Globe className="h-5 w-5" />
                  <AppWindow className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-[22px] font-semibold tracking-tight text-ink">Uses the web and your apps</h3>
                <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-ink-muted">
                  Searches, reads current pages, clicks through sites and fills in forms in a real browser. Operates desktop apps
                  that have no API, reading the screen the way you would.
                </p>
              </div>
              <div className="mt-auto overflow-hidden rounded-2xl border border-line bg-paper shadow-lift">
                <BrowserCard />
              </div>
            </div>
          </article>
          {CAPS.map(({ icon: Icon, title, body }) => (
            <article key={title} className="cap rounded-3xl border border-line bg-paper-raised p-7">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-paper text-ink-muted">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <h3 className="mt-5 text-[17px] font-semibold tracking-tight text-ink">{title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-muted">{body}</p>
            </article>
          ))}
          <article className="cap flex flex-col justify-between gap-6 overflow-hidden rounded-3xl border border-line bg-paper-raised p-7 lg:col-span-2">
            <div className="flex items-center gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-paper text-ink-muted">
                <FolderOpen className="h-[18px] w-[18px]" />
              </span>
              <p className="max-w-[52ch] text-[14.5px] leading-relaxed text-ink-muted">
                <span className="font-semibold text-ink">The kind of steps it takes.</span> Each one shows up in the chat as it
                happens, so you can follow along or stop it.
              </p>
            </div>
            <div className="-mx-7 min-w-0">
              <Ticker />
            </div>
          </article>
        </div>
      </div>
    </Section>
  );
}
