import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Draggable } from "gsap/Draggable";
import { useGSAP } from "@gsap/react";
import { ArrowUp, Paperclip, RotateCcw } from "lucide-react";
import { LiveDemo } from "../clone/LiveDemo";
import { heroScenario } from "../clone/scenarios";
import { Dock, MenuBar, TrafficLights } from "./MacOS";
import { cn } from "../lib/cn";

gsap.registerPlugin(ScrollTrigger, Draggable, useGSAP);

// Phones get a narrower, taller window: the 1440-wide one scales to ~0.23 there
// and is unreadable, and a portrait desk leaves room above and below it.
const PHONE = "(max-width: 639px)";
// A mouse or trackpad: the windows drag and zWork can be tried.
const FINE = "(pointer: fine)";
function useMedia(query: string) {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

const CHAPTERS = [
  { id: "ask", title: "You hand it the job", body: "In plain words, with the file attached." },
  { id: "work", title: "It does the work", body: "Reads the data, writes and runs its own scripts. Every step is shown." },
  { id: "result", title: "You get the finished thing", body: "A cleaned workbook and a report you can send." },
];

// In viewport heights of scroll: the dive through the mark, then the hold
// while the run plays out.
const DIVE = 1.6;
const PIN_LENGTH = 1.5;
// From the mark opening onto the desktop to just after the pin lets go.
const DEMO_RANGE = {
  trigger: ".dive",
  start: () => `top+=${window.innerHeight * DIVE * 0.75} top`,
  end: () => `+=${window.innerHeight * (DIVE * 0.25 + PIN_LENGTH + 0.8)}`,
};

/**
 * A Mac desktop, framed in the page: menu bar, dock, a chat app answering the
 * question, and zWork doing the job.
 *
 * The hero lies over it. Scrolling spins the zWork mark at the top of the
 * hero and flies you through the middle of it: the mark grows towards the
 * centre of the screen, then its slats burst outward past the edges while
 * the hero fades and the desktop comes into focus behind it. Then it holds while the run
 * plays out. Without motion the two are simply stacked.
 */
export function Desktop({ children }: { children?: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const [chapter, setChapter] = useState<string | null>(null);
  // Set while the visitor has the zWork window; puts the scripted run back.
  const [replay, setReplay] = useState<(() => void) | null>(null);
  const onLive = useCallback((r: (() => void) | null) => setReplay(() => r), []);
  const phone = useMedia(PHONE);
  const fine = useMedia(FINE);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const stage = root.current!;
        const hero = stage.querySelector<HTMLElement>(".dive-hero");
        const slot = stage.querySelector<HTMLElement>(".dive-logo-slot");
        const mark = stage.querySelector<SVGGElement>(".dive-mark-g");
        const slats = gsap.utils.toArray<SVGGElement>(".dive-slat", stage);
        if (!hero || !slot || !mark || slats.length !== 6) return;
        stage.classList.add("is-diving");

        // Where the mark starts, how big it gets, and how far out its slats
        // have to fly for their inner ends to clear the corners of the screen.
        let W = 0, H = 0, x0 = 0, y0 = 0, size = 1, sEnd = 1, rEnd = 12.5;
        const measure = () => {
          const sr = stage.getBoundingClientRect();
          const r = slot.getBoundingClientRect();
          W = stage.clientWidth;
          H = stage.clientHeight;
          x0 = r.left - sr.left + r.width / 2;
          y0 = r.top - sr.top + r.height / 2;
          size = r.width || 1;
          const half = Math.hypot(W, H) / 2;
          // A slat ends up about a fifth of the screen's diagonal long.
          sEnd = Math.max(3, (0.2 * half * 2) / ((11 * size) / 40));
          rEnd = 5.5 + (half * 1.15) / ((size * sEnd) / 40);
        };
        const travel = gsap.parseEase("power2.inOut");
        const spin = gsap.parseEase("sine.inOut");
        const burst = gsap.parseEase("power3.in");
        const dive = { p: 0 };
        const render = () => {
          const p = dive.p;
          const m = travel(Math.min(1, p / 0.5));
          const cx = x0 + (W / 2 - x0) * m;
          const cy = y0 + (H / 2 - y0) * m;
          const s = 1 + (sEnd - 1) * Math.pow(p, 1.6);
          // The slats leave the ring faster than the mark grows, so the
          // middle opens and you pass through it.
          const b = burst(Math.max(0, (p - 0.3) / 0.7));
          const r = 12.5 + (rEnd - 12.5) * b;
          mark.setAttribute("transform", `translate(${cx} ${cy}) rotate(${spin(p) * 240}) scale(${(size * s) / 40})`);
          slats.forEach((el, i) => el.setAttribute("transform", `rotate(${i * 60}) translate(0 ${-r}) rotate(${b * 35})`));
        };
        measure();
        render();

        gsap
          .timeline({
            defaults: { ease: "none" },
            scrollTrigger: {
              trigger: stage,
              start: "top top",
              end: () => `+=${window.innerHeight * (DIVE + PIN_LENGTH)}`,
              pin: true,
              scrub: 0.6,
              invalidateOnRefresh: true,
              onRefresh: () => {
                measure();
                render();
              },
            },
          })
          .to(dive, { p: 1, duration: DIVE, onUpdate: render }, 0)
          .to(".hero-body", { autoAlpha: 0, y: -40, scale: 0.97, duration: DIVE * 0.2 }, 0)
          .to(".hero-bg", { autoAlpha: 0, duration: DIVE * 0.4, ease: "power1.inOut" }, DIVE * 0.35)
          // Landing: the desktop settles into focus as you come through.
          .fromTo(
            ".desk",
            { scale: 1.15, filter: "blur(16px)" },
            { scale: 1, filter: "blur(0px)", duration: DIVE * 0.6, ease: "power2.out" },
            DIVE * 0.35,
          )
          .to(".dive-mark", { autoAlpha: 0, duration: DIVE * 0.12 }, DIVE * 0.88)
          .from(".desk-app-in", { y: 70, scale: 0.95, autoAlpha: 0, duration: DIVE * 0.3, ease: "power2.out" }, DIVE * 0.66)
          .from(".desk-chat-in", { y: 50, autoAlpha: 0, duration: DIVE * 0.28, ease: "power2.out" }, DIVE * 0.72)
          .set(hero, { autoAlpha: 0 }, DIVE)
          .to({}, { duration: PIN_LENGTH });

        return () => stage.classList.remove("is-diving");
      });
      // Without motion only the desktop pins: the run needs room either way.
      mm.add("(prefers-reduced-motion: reduce)", () => {
        ScrollTrigger.create({
          trigger: ".desk-pin",
          start: "top top",
          end: () => `+=${window.innerHeight * PIN_LENGTH}`,
          pin: true,
        });
      });
      // The windows can be moved by their title bars; whichever was touched
      // last comes to the front.
      mm.add(FINE, () => {
        const area = root.current!.querySelector(".desk-windows")!;
        let z = 1;
        const raise = (el: Element | null) => el && gsap.set(el, { zIndex: ++z });
        const app = root.current!.querySelector(".desk-app")!;
        const chat = root.current!.querySelector(".desk-chat-in")!;
        const strip = app.querySelector<HTMLElement>("[data-drag-handle]");
        const onApp = () => raise(app);
        const onChat = () => raise(chat);
        app.addEventListener("pointerdown", onApp);
        chat.addEventListener("pointerdown", onChat);
        const drags = [
          ...Draggable.create(app, {
            trigger: strip,
            bounds: area,
            zIndexBoost: false,
            edgeResistance: 0.85,
            cursor: "grab",
            activeCursor: "grabbing",
            // The strip lies over the window's top bar; a click that didn't
            // drag goes on to whatever it covers (the document's close button).
            onClick(e: PointerEvent) {
              if (!strip) return;
              strip.style.pointerEvents = "none";
              const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-live]");
              strip.style.pointerEvents = "";
              under?.click();
            },
          }),
          ...Draggable.create(".desk-chat-drag", { trigger: ".desk-titlebar", bounds: area, zIndexBoost: false, edgeResistance: 0.85, cursor: "grab", activeCursor: "grabbing" }),
        ];
        return () => {
          for (const d of drags) d.kill();
          app.removeEventListener("pointerdown", onApp);
          chat.removeEventListener("pointerdown", onChat);
        };
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  const active = CHAPTERS.findIndex((c) => c.id === chapter);
  const current = CHAPTERS[active] ?? CHAPTERS[0];

  return (
    <section ref={root} id="how" className="dive relative overflow-hidden">
      {children}
      <div
        role="region"
        aria-label="zWork doing a job on a Mac desktop"
        className="desk-pin flex items-center justify-center p-[10px] sm:p-5"
      >
        <div className="desk relative w-full max-w-[1680px] overflow-hidden rounded-[12px] will-change-transform sm:rounded-[14px]">
          <MenuBar />

          <div className="desk-windows absolute inset-x-0 bottom-[60px] top-[26px] isolate sm:bottom-[80px]">
            {/* The chat app: an answer, and the work left to you. */}
            <div className="desk-chat-in absolute left-[3%] top-[7%] hidden h-[66%] w-[46%] lg:block xl:h-[54%]">
              <div className="desk-chat-drag h-full">
                <ChatWindow />
              </div>
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
                  interactive={fine}
                  onLive={onLive}
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
              {replay ? (
                <div className="flex items-center justify-between gap-2 border-t border-black/5 px-3 pb-1 pt-2">
                  <span className="text-[11.5px] font-medium text-ink">You're driving.</span>
                  <ReplayButton onClick={replay} />
                </div>
              ) : (
                <p className="border-t border-black/5 px-3 pb-1.5 pt-2.5 text-[11.5px] leading-snug text-ink-muted pointer-coarse:hidden">
                  Drag the windows around, or click into zWork and try it.
                </p>
              )}
            </div>

            {/* Smaller screens: one line under the window instead. */}
            <div className="absolute inset-x-0 bottom-[5%] flex justify-center px-4 xl:hidden">
              {replay ? (
                <p className="desk-glass flex animate-[fade-in_400ms_ease] items-center gap-2 rounded-full py-1 pl-4 pr-1 text-[12.5px] text-ink ring-[0.5px] ring-black/10">
                  <span className="font-semibold">You're driving.</span>
                  <ReplayButton onClick={replay} />
                </p>
              ) : (
                <p
                  key={current.id}
                  className="desk-glass animate-[fade-in_400ms_ease] rounded-full px-4 py-2 text-center text-[12.5px] text-ink ring-[0.5px] ring-black/10"
                >
                  <span className="font-semibold">{current.title}.</span>{" "}
                  <span className="text-ink-muted">{current.body}</span>
                </p>
              )}
            </div>
          </div>

          <Dock />
        </div>
      </div>
    </section>
  );
}

function ReplayButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-paper/70 px-2.5 py-1 text-[12px] font-medium text-ink ring-[0.5px] ring-black/10 hover:bg-paper"
    >
      <RotateCcw className="h-3 w-3" />
      Replay the demo
    </button>
  );
}

/** A generic chat app, giving the usual answer: instructions. */
function ChatWindow() {
  return (
    <div className="desk-window-shadow flex h-full flex-col overflow-hidden rounded-[16px] bg-paper-sunken text-[12.5px] text-ink">
      <div className="desk-titlebar flex h-10 shrink-0 items-center gap-3 border-b border-line-soft px-3.5">
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
