import { useRef, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { onReveal } from "../lib/intro";
import { Section } from "../sections/ui";

gsap.registerPlugin(useGSAP);

/** Top of an inner page. Rises in as the preloader leaves (or straight away). */
export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.set("[data-intro]", { autoAlpha: 0, y: 32 });
        const tl = gsap.timeline({ paused: true });
        tl.to("[data-intro]", { autoAlpha: 1, y: 0, duration: 0.9, stagger: 0.08, ease: "power3.out" });
        return onReveal(() => tl.play());
      });
      return () => mm.revert();
    },
    { scope: root },
  );
  return (
    <Section className="pb-8 pt-36 sm:pb-12 sm:pt-44">
      <div ref={root}>
        <p data-intro className="eyebrow mb-6">
          {eyebrow}
        </p>
        <h1 data-intro className="display max-w-[16ch] pb-1 text-[52px] leading-[1.02] text-ink sm:text-[88px]">
          {title}
        </h1>
        {children && (
          <p data-intro className="mt-7 max-w-[58ch] text-[17px] leading-relaxed text-ink-muted sm:text-[19px]">
            {children}
          </p>
        )}
      </div>
    </Section>
  );
}
