import { useRef, useState, useSyncExternalStore } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { ArrowUp, Paperclip } from "lucide-react";
import { LiveDemo } from "../clone/LiveDemo";
import { heroScenario } from "../clone/scenarios";
import { Dock, MenuBar, TrafficLights } from "./MacOS";
import { cn } from "../lib/cn";

gsap.registerPlugin(ScrollTrigger, useGSAP);

// Phones get a narrower, taller window: the 1440-wide one scales to ~0.23 there
// and is unreadable, and a portrait desk leaves room above and below it.
const PHONE = "(max-width: 639px)";
const subscribePhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const usePhone = () => useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches);

const CHAPTERS = [
  { id: "ask", title: "You hand it the job", body: "In plain words, with the file attached." },
  { id: "work", title: "It does the work", body: "Reads the data, writes and runs its own scripts. Every step is shown." },
  { id: "result", title: "You get the finished thing", body: "A cleaned workbook and a report you can send." },
];

// From the desktop coming into view to just after the pin lets go.
const PIN_LENGTH = 1.5;
const DEMO_RANGE = { trigger: ".desk-pin", start: "top 45%", end: () => `+=${window.innerHeight * (PIN_LENGTH + 0.8)}` };

/**
 * A Mac desktop, framed in the page: menu bar, dock, a chat app answering the
 * question, and zWork doing the job. It pins for a while so the run plays out
 * before you can scroll past it.
 */
export function Desktop() {
  const root = useRef<HTMLDivElement>(null);
  const [chapter, setChapter] = useState<string | null>(null);
  const phone = usePhone();

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        // Grows into the frame as it arrives, then holds while the demo runs.
        gsap.fromTo(
          ".desk",
          { scale: 0.86, borderRadius: 40 },
          {
            scale: 1,
            borderRadius: 24,
            ease: "none",
            scrollTrigger: { trigger: ".desk-pin", start: "top bottom", end: "top top", scrub: true },
          },
        );
        gsap.from(".desk-app-in", {
          y: 60,
          scale: 0.94,
          autoAlpha: 0,
          ease: "power3.out",
          duration: 1,
          scrollTrigger: { trigger: ".desk-pin", start: "top 55%", toggleActions: "play none none reverse" },
        });
        gsap.from(".desk-chat-in", {
          y: 40,
          autoAlpha: 0,
          ease: "power3.out",
          duration: 1,
          delay: 0.1,
          scrollTrigger: { trigger: ".desk-pin", start: "top 65%", toggleActions: "play none none reverse" },
        });
      });
      // Pinned with or without motion: the run needs room either way.
      ScrollTrigger.create({ trigger: ".desk-pin", start: "top top", end: () => `+=${window.innerHeight * PIN_LENGTH}`, pin: true });
      return () => mm.revert();
    },
    { scope: root },
  );

  const active = CHAPTERS.findIndex((c) => c.id === chapter);
  const current = CHAPTERS[active] ?? CHAPTERS[0];

  return (
    <section ref={root} id="how" aria-label="zWork doing a job on a Mac desktop">
      <div className="desk-pin flex items-center justify-center p-[10px] sm:p-5">
        <div className="desk relative w-full max-w-[1680px] overflow-hidden rounded-[24px] will-change-transform">
          <MenuBar />

          <div className="absolute inset-x-0 bottom-[60px] top-[26px] sm:bottom-[80px]">
            {/* The chat app: an answer, and the work left to you. */}
            <div className="desk-chat-in absolute left-[3%] top-[7%] hidden h-[66%] w-[46%] lg:block xl:h-[54%]">
              <ChatWindow />
            </div>

            {/* zWork, in front and doing it. */}
            <div className="desk-app absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 lg:left-auto lg:right-[3.5%] lg:translate-x-0">
              <div className="desk-app-in desk-window-shadow overflow-hidden rounded-[16px]">
                <LiveDemo
                  key={phone ? "phone" : "wide"}
                  scenario={heroScenario}
                  width={phone ? 1040 : 1440}
                  height={phone ? 1400 : 880}
                  panelWidth={phone ? 420 : 600}
                  onChapter={setChapter}
                  range={DEMO_RANGE}
                  loopDelay={2}
                />
              </div>
            </div>

            {/* What's happening, as a desktop widget. */}
            <div className="desk-glass absolute bottom-[4%] left-[2.2%] hidden w-[min(17%,250px)] rounded-[22px] p-2 shadow-[0_10px_30px_-12px_rgb(0_0_0/.3)] ring-[0.5px] ring-black/10 xl:block">
              <ol>
                {CHAPTERS.map((c, i) => (
                  <li
                    key={c.id}
                    className={cn(
                      "rounded-[14px] px-3 py-2.5 transition-[background-color,opacity] duration-500",
                      i === active ? "bg-paper/60" : active !== -1 && "opacity-55",
                    )}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[11px] text-ink-muted">0{i + 1}</span>
                      <span className="text-[13px] font-semibold leading-snug text-ink">{c.title}</span>
                    </div>
                    <p className="mt-0.5 pl-[22px] text-[12px] leading-snug text-ink-muted">{c.body}</p>
                  </li>
                ))}
              </ol>
            </div>

            {/* Smaller screens: one line under the window instead. */}
            <div className="absolute inset-x-0 bottom-[5%] flex justify-center px-4 xl:hidden">
              <p
                key={current.id}
                className="desk-glass animate-[fade-in_400ms_ease] rounded-full px-4 py-2 text-center text-[12.5px] text-ink ring-[0.5px] ring-black/10"
              >
                <span className="font-semibold">{current.title}.</span>{" "}
                <span className="text-ink-muted">{current.body}</span>
              </p>
            </div>
          </div>

          <Dock />
        </div>
      </div>
    </section>
  );
}

/** A generic chat app, giving the usual answer: instructions. */
function ChatWindow() {
  return (
    <div className="desk-window-shadow flex h-full flex-col overflow-hidden rounded-[16px] bg-paper-sunken text-[12.5px] text-ink">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line-soft px-3.5">
        <TrafficLights dim />
        <span className="flex-1 text-center text-[12px] font-medium text-ink-muted">ChatGPT</span>
        <span className="w-[52px]" />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden px-[9%] pt-5">
        <div className="ml-auto w-fit max-w-[78%] rounded-[16px] bg-paper-raised px-3.5 py-2 leading-relaxed">
          How do I clean up a messy bank export in Excel and sort it into categories?
        </div>
        <div className="mt-4 space-y-2.5 leading-relaxed text-ink-soft">
          <p>Here's a step-by-step way to do it:</p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              Open the CSV and use <b className="font-semibold text-ink">Data → Text to Columns</b> to split the fields.
            </li>
            <li>
              Fix mixed date formats with <code className="rounded bg-paper-raised px-1 font-mono text-[11px]">=DATEVALUE()</code>,
              then format the column as a date.
            </li>
            <li>
              Remove duplicates: <b className="font-semibold text-ink">Data → Remove Duplicates</b>.
            </li>
            <li>Clean vendor names with TRIM and a lookup table of the spellings you want.</li>
            <li>Add a Category column and fill it in with a VLOOKUP on the vendor.</li>
            <li>Insert a PivotTable to total spending by category and month.</li>
          </ol>
          <p>Then you can copy the totals into a document for your report.</p>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-paper-sunken to-transparent" />
      </div>
      <div className="shrink-0 px-[7%] pb-4">
        <div className="flex items-center gap-2 rounded-full border border-line bg-paper px-3 py-2 text-ink-faint">
          <Paperclip className="h-3.5 w-3.5" />
          <span className="flex-1">Ask anything</span>
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-line text-paper">
            <ArrowUp className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
    </div>
  );
}
