import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { AppWindow } from "./AppWindow";
import { LiveContext, LiveSession, liveApi } from "./live";
import { Script, type Scenario } from "./engine";
import type { CloneState } from "./types";

gsap.registerPlugin(ScrollTrigger, useGSAP);

// True only while GSAP's ticker renders the root timeline. Timelines also
// render synchronously from play() or a ScrollTrigger refresh, which can
// happen inside a React effect where flushSync isn't allowed.
let inTick = false;
gsap.ticker.add(() => { inTick = true; }, false, true);
gsap.ticker.add(() => { inTick = false; });

/**
 * A scenario playing in a clone, drawn at its native size and scaled to the
 * container's width. It plays while on screen, pauses off screen, and loops.
 * With reduced motion it jumps straight to the finished state.
 *
 * `interactive` lets the visitor take the window over: the first click into
 * it stops the run and the clone starts responding (see live.tsx). The top
 * strip is left as a drag handle for whoever moves the window. `onLive`
 * hears about it, with a way to put the scripted run back.
 */
export function LiveDemo({
  scenario,
  width,
  height,
  panelWidth,
  render,
  onChapter,
  className,
  loopDelay = 3,
  range,
  interactive = false,
  onLive,
}: {
  scenario: Scenario;
  width: number;
  height: number;
  panelWidth?: number;
  render?: (s: CloneState) => ReactNode;
  onChapter?: (name: string) => void;
  className?: string;
  loopDelay?: number;
  /** Where it plays, when that isn't simply "while on screen" (e.g. inside a pin). */
  range?: Pick<ScrollTrigger.Vars, "trigger" | "start" | "end">;
  interactive?: boolean;
  onLive?: (replay: (() => void) | null) => void;
}) {
  const [state, setState] = useState<CloneState>(scenario.initial);
  const [scale, setScale] = useState(0);
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const chapterRef = useRef(onChapter);
  chapterRef.current = onChapter;
  const liveRef = useRef(onLive);
  liveRef.current = onLive;
  const script = useRef<Script | null>(null);
  const trigger = useRef<ScrollTrigger | null>(null);
  const session = useRef<LiveSession | null>(null);
  const [live, setLive] = useState(false);

  const replay = useCallback(() => {
    session.current?.dispose();
    session.current = null;
    setLive(false);
    liveRef.current?.(null);
    const tl = script.current?.tl;
    if (!tl) return;
    tl.restart();
    if (!trigger.current?.isActive) tl.pause();
  }, []);

  const takeOver = useCallback(() => {
    if (session.current) return session.current;
    const run = script.current!;
    // Mid-run, land it (forwards only), so there's a finished chat to look around in.
    if (run.state.messages.length && run.tl.progress() < 0.999) run.tl.progress(0.999, false);
    run.tl.pause();
    const cursor = inner.current?.querySelector("[data-cursor]");
    if (cursor) gsap.set(cursor, { autoAlpha: 0 });
    session.current = new LiveSession(run.state, setState, scenario.chats ?? {});
    setLive(true);
    liveRef.current?.(replay);
    return session.current;
  }, [scenario, replay]);

  const api = useMemo(() => liveApi(() => session.current ?? takeOver()), [takeOver]);
  const ctx = useMemo(() => (interactive ? { api, active: live } : null), [interactive, api, live]);

  useEffect(() => () => session.current?.dispose(), []);

  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  useGSAP(
    () => {
      const root = inner.current?.firstElementChild as HTMLElement | null;
      if (!root) return;
      const mm = gsap.matchMedia();
      mm.add(
        { motion: "(prefers-reduced-motion: no-preference)", reduce: "(prefers-reduced-motion: reduce)" },
        (ctx) => {
          // Commit synchronously during ticks so a cursor move that starts in
          // the same frame as a view change measures the new DOM, even when
          // frames are slow. Once the visitor has the window the script goes
          // quiet, lazy renders left over from landing it included.
          const commit = (s: CloneState) => {
            if (session.current) return;
            if (inTick) flushSync(() => setState(s));
            else setState(s);
          };
          const run = new Script(scenario.initial, commit, root, (n) => chapterRef.current?.(n));
          scenario.build(run);
          script.current = run;
          const tl = run.tl;
          if (ctx.conditions?.reduce) {
            tl.progress(1, false);
            return;
          }
          tl.repeat(-1).repeatDelay(loopDelay);
          trigger.current = ScrollTrigger.create({
            trigger: outer.current,
            start: "top 80%",
            end: "bottom 15%",
            ...range,
            // Selector strings would resolve inside this component's scope.
            ...(typeof range?.trigger === "string" && { trigger: document.querySelector(range.trigger) }),
            onToggle: (self) => !session.current && (self.isActive ? tl.play() : tl.pause()),
          });
        },
      );
      return () => mm.revert();
    },
    { scope: outer },
  );

  // Anywhere in the window but the drag strip takes it over; the click
  // itself then lands on whatever it was aimed at.
  const onPointerDown = (e: PointerEvent) => {
    if (!interactive || session.current || (e.target as HTMLElement).closest("[data-drag-handle]")) return;
    takeOver();
    if (!(e.target as HTMLElement).closest("[data-live]"))
      requestAnimationFrame(() => inner.current?.querySelector<HTMLElement>("[data-composer]")?.focus({ preventScroll: true }));
  };

  return (
    <div
      ref={outer}
      className={`group/demo relative min-w-0 ${className ?? ""}`}
      style={{ height: scale ? height * scale : undefined, aspectRatio: scale ? undefined : `${width}/${height}` }}
    >
      <div
        ref={inner}
        onPointerDownCapture={onPointerDown}
        className="absolute left-0 top-0"
        style={{ width, transform: `scale(${scale || 0.0001})`, transformOrigin: "top left" }}
      >
        <LiveContext.Provider value={ctx}>
          {render ? (
            <div style={{ width, height }} className="clone relative">
              {render(state)}
            </div>
          ) : (
            <AppWindow s={state} width={width} height={height} panelWidth={panelWidth} live={live} />
          )}
        </LiveContext.Provider>
        {interactive && <div data-drag-handle className="absolute inset-x-0 top-0 z-40 h-[38px]" />}
      </div>
      {interactive && !live && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[7%] flex justify-center opacity-0 transition-opacity duration-300 group-hover/demo:opacity-100">
          <span className="desk-glass rounded-full px-3.5 py-1.5 text-[12.5px] font-medium text-ink shadow-[0_6px_20px_-8px_rgb(0_0_0/.35)] ring-[0.5px] ring-black/10">
            Click in to try it yourself
          </span>
        </div>
      )}
    </div>
  );
}
