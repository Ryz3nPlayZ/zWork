import { useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { ArrowRight, Download } from "lucide-react";
import { Logo } from "../clone/Logo";
import { cn } from "../lib/cn";
import { Link } from "../lib/router";
import { ASSET_LABEL, PLATFORMS, REPO_URL, detectPlatform, downloadUrl, type Platform } from "../lib/site";
import { GithubIcon } from "./ui";

gsap.registerPlugin(ScrollTrigger, useGSAP);

// The card the black screen settles into: at most 1080 x 620, with at least a
// gutter of page around it. Mirrored in the panel's CSS clip-path below.
const insetX = () => Math.max(16, (document.documentElement.clientWidth - 1080) / 2);
const insetY = () => Math.max(28, (window.innerHeight - 620) / 2);
const CARD = () => `inset(${insetY()}px ${insetX()}px ${insetY()}px ${insetX()}px round 32px)`;
const FULL = "inset(0px 0px 0px 0px round 0px)";

/**
 * The closing screen. A black panel rises like any section, pins, holds one
 * line, then draws itself in to a card around the download. The page doesn't
 * move while it does, so it reads as the screen becoming the card.
 *
 * Without motion it's simply the card.
 */
export function Outro() {
  const detected = useMemo(detectPlatform, []);
  const [platform, setPlatform] = useState<Platform>(detected ?? "Mac");
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const el = root.current!;
        const q = gsap.utils.selector(el);
        gsap.set(q(".outro-line"), { autoAlpha: 1 });
        gsap.set(q(".outro-in"), { autoAlpha: 0, y: 24 });
        // Set up front, not as a from(): the page's trigger refresh can undo
        // a from()'s first render, so the lines would show before rising in.
        // A transform left by a previous run is cleared first, or it's read
        // back as pixels and the lines settle too low.
        gsap.set(q(".outro-line > *"), { clearProps: "transform" });
        gsap.set(q(".outro-line > *"), { yPercent: 40, autoAlpha: 0 });

        gsap.to(q(".outro-line > *"), {
          yPercent: 0,
          autoAlpha: 1,
          duration: 1,
          stagger: 0.08,
          ease: "power3.out",
          scrollTrigger: { trigger: el, start: "top 60%", toggleActions: "play none none reverse" },
        });

        gsap
          .timeline({
            defaults: { ease: "power2.inOut" },
            scrollTrigger: {
              trigger: el,
              start: "top top",
              end: () => `+=${window.innerHeight * 1.4}`,
              pin: true,
              scrub: 0.7,
              invalidateOnRefresh: true,
            },
          })
          .to({}, { duration: 0.3 })
          .to(q(".outro-line"), { autoAlpha: 0, scale: 0.96, filter: "blur(8px)", duration: 0.3 })
          // fromTo: the start must be read back exactly as written, not normalised.
          .fromTo(q(".outro-panel"), { clipPath: FULL }, { clipPath: CARD, duration: 0.6 }, "-=0.1")
          .to(q(".outro-in"), { autoAlpha: 1, y: 0, duration: 0.3, stagger: 0.06, ease: "power2.out" }, "-=0.32")
          .to({}, { duration: 0.25 });
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} aria-labelledby="outro-title" className="relative h-[100dvh] overflow-hidden">
      <div className="outro-panel absolute inset-0 bg-ink [clip-path:inset(max(28px,calc((100%-620px)/2))_max(16px,calc((100%-1080px)/2))_round_32px)]" />

      {/* The line the black screen holds before it becomes the card. */}
      <p
        aria-hidden="true"
        className="outro-line invisible absolute inset-0 flex flex-col items-center justify-center px-6 text-center font-serif text-[56px] leading-[1.02] tracking-[-0.03em] text-paper sm:text-[96px] lg:text-[128px]"
      >
        <span className="block">Hand it something</span>
        <em className="block pb-[0.08em] text-paper/60">you'd rather not do.</em>
      </p>

      <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-paper sm:px-12">
        <div className="w-full max-w-[640px]">
          <div className="outro-in flex justify-center">
            <Logo size={44} />
          </div>
          <h2 id="outro-title" className="outro-in display mt-7 text-[40px] text-paper sm:text-[60px]">
            Ready to get to work?
          </h2>
          <p className="outro-in mx-auto mt-4 max-w-[46ch] text-[15px] leading-relaxed text-paper/60 sm:text-[16px]">
            zWork runs on your own computer: macOS, Windows or Linux. Free to start, with our models or your own key.
          </p>
          <div className="outro-in mt-8 inline-flex rounded-full bg-paper/10 p-1" role="tablist" aria-label="Platform">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={platform === p}
                onClick={() => setPlatform(p)}
                className={cn(
                  "press rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors",
                  platform === p ? "bg-paper text-ink" : "text-paper/60 hover:text-paper",
                )}
              >
                {p === "Mac" ? "macOS" : p}
              </button>
            ))}
          </div>
          <div className="outro-in mt-5 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={downloadUrl(platform)}
              className="press inline-flex h-12 items-center gap-2.5 rounded-full bg-paper px-7 text-[15px] font-medium text-ink hover:bg-paper/90"
            >
              <Download className="h-4 w-4" />
              Download for {platform === "Mac" ? "macOS" : platform}
            </a>
            <div className="flex gap-3">
              <Link
                href="/pricing"
                className="press inline-flex h-12 items-center gap-1.5 rounded-full border border-paper/20 px-5 text-[14px] font-medium text-paper/75 transition-colors hover:border-paper/40 hover:text-paper"
              >
                Pricing
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <a
                href={REPO_URL}
                className="press inline-flex h-12 items-center gap-2 rounded-full border border-paper/20 px-5 text-[14px] font-medium text-paper/75 transition-colors hover:border-paper/40 hover:text-paper"
              >
                <GithubIcon className="h-4 w-4" />
                GitHub
              </a>
            </div>
          </div>
          <p className="outro-in mt-4 text-[12.5px] text-paper/45">{ASSET_LABEL[platform]}</p>
        </div>
      </div>
    </section>
  );
}
