import { useRef, useState } from "react";
import gsap from "gsap";
import { ScrollSmoother } from "gsap/ScrollSmoother";
import { useGSAP } from "@gsap/react";
import { Logo } from "../clone/Logo";
import { hasRevealed, reveal } from "../lib/intro";

gsap.registerPlugin(ScrollSmoother, useGSAP);

/**
 * The first thing every page load shows: the mark rolls left into place while
 * the wordmark is wiped in behind it, then the whole panel slides away to
 * uncover the page. Scrolling is locked until it's gone.
 *
 * The lockup is laid out once, already centred as a pair. Only the mark moves
 * (from the viewport centre into its slot) and the wordmark never does, so
 * nothing re-centres at the end.
 */
export function Preloader() {
  const [done, setDone] = useState(hasRevealed);
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (done || !root.current) return;
      const html = document.documentElement;
      const unlock = () => {
        html.style.overflow = "";
        ScrollSmoother.get()?.paused(false);
      };
      html.style.overflow = "hidden";
      ScrollSmoother.get()?.paused(true);
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      window.scrollTo(0, 0);

      const q = gsap.utils.selector(root);
      const [logo] = q(".pl-logo");
      const [word] = q(".pl-word");
      const [cover] = q(".pl-cover");
      const [lockup] = q(".pl-lockup");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let tl: gsap.core.Timeline | undefined;
      let dead = false;

      const start = () => {
        if (dead) return;
        tl = gsap.timeline({
          onComplete: () => {
            unlock();
            setDone(true);
          },
        });
        if (reduce) {
          tl.set(logo, { scale: 1 })
            .set(cover, { scaleX: 0 })
            .set(word, { visibility: "visible" })
            .to({}, { duration: 0.6 })
            .call(reveal)
            .to(root.current, { autoAlpha: 0, duration: 0.3 });
          return;
        }
        // Measured with the wordmark in place (fonts loaded), so the slot is final.
        const r = logo.getBoundingClientRect();
        const dx = window.innerWidth / 2 - (r.left + r.width / 2);
        tl.set(logo, { x: dx, rotation: 0, scale: 0 })
          .to(logo, { scale: 1.45, duration: 0.34, ease: "back.out(2.2)" })
          .to(logo, { x: 0, rotation: -360, scale: 1, duration: 0.95, ease: "power3.inOut" }, 0.3)
          // Cover, then reveal: a block draws out of the mark's trail and
          // retracts to the right with the wordmark underneath.
          .fromTo(cover, { scaleX: 0, transformOrigin: "0% 50%" }, { scaleX: 1, duration: 0.36, ease: "power3.in" }, 0.74)
          .set(word, { visibility: "visible" })
          .set(cover, { transformOrigin: "100% 50%" })
          .to(cover, { scaleX: 0, duration: 0.44, ease: "power3.out" })
          .from(word, { x: -18, duration: 0.6, ease: "power3.out" }, "<")
          .addLabel("exit", "+=0.28")
          .to(root.current, { xPercent: -100, duration: 0.9, ease: "expo.inOut" }, "exit")
          .to(lockup, { x: () => window.innerWidth * 0.35, duration: 0.9, ease: "expo.inOut" }, "exit")
          .call(reveal, [], "exit+=0.32");
      };

      // The wordmark's width sets the mark's slot; wait for the serif (it's
      // preloaded, so this is near-instant) but never hang on it.
      Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 900))]).then(start);

      return () => {
        dead = true;
        tl?.kill();
        unlock();
      };
    },
    { scope: root },
  );

  if (done) return null;
  return (
    <div
      ref={root}
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-hidden bg-ink text-paper will-change-transform"
      role="presentation"
    >
      <div className="pl-lockup flex items-center gap-[0.22em] text-[68px] sm:text-[112px] lg:text-[136px]">
        <span className="pl-logo block scale-0 will-change-transform">
          <Logo size={96} className="h-[0.86em] w-[0.86em]" />
        </span>
        <span className="relative block overflow-hidden pb-[0.1em]">
          <span className="pl-word invisible block font-serif leading-none tracking-[-0.025em]">zWork</span>
          <span className="pl-cover absolute inset-0 scale-x-0 bg-paper" />
        </span>
      </div>
    </div>
  );
}
