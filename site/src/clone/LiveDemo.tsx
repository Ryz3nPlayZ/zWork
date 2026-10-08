import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { AppWindow } from "./AppWindow";
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
  pinnedContainer,
}: {
  scenario: Scenario;
  width: number;
  height: number;
  panelWidth?: number;
  render?: (s: CloneState) => ReactNode;
  onChapter?: (name: string) => void;
  className?: string;
  loopDelay?: number;
  /** The pinned ancestor, if any, so the play range includes the pin. */
  pinnedContainer?: string;
}) {
  const [state, setState] = useState<CloneState>(scenario.initial);
  const [scale, setScale] = useState(0);
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const chapterRef = useRef(onChapter);
  chapterRef.current = onChapter;

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
          // frames are slow.
          const commit = (s: CloneState) => (inTick ? flushSync(() => setState(s)) : setState(s));
          const script = new Script(scenario.initial, commit, root, (n) => chapterRef.current?.(n));
          scenario.build(script);
          const tl = script.tl;
          if (ctx.conditions?.reduce) {
            tl.progress(1, false);
            return;
          }
          tl.repeat(-1).repeatDelay(loopDelay);
          ScrollTrigger.create({
            trigger: outer.current,
            start: "top 80%",
            end: "bottom 15%",
            onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
            pinnedContainer,
            // Measure after the pin it sits in (created later, by the parent).
            refreshPriority: pinnedContainer ? -1 : 0,
          });
        },
      );
      return () => mm.revert();
    },
    { scope: outer },
  );

  return (
    <div ref={outer} className={`relative min-w-0 ${className ?? ""}`} style={{ height: scale ? height * scale : undefined, aspectRatio: scale ? undefined : `${width}/${height}` }}>
      <div ref={inner} className="absolute left-0 top-0" style={{ width, transform: `scale(${scale || 0.0001})`, transformOrigin: "top left" }}>
        {render ? (
          <div style={{ width, height }} className="clone relative">
            {render(state)}
          </div>
        ) : (
          <AppWindow s={state} width={width} height={height} panelWidth={panelWidth} />
        )}
      </div>
    </div>
  );
}
