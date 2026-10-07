import { useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";
import { ArrowRight, Download, Moon, Sun } from "lucide-react";
import { LiveDemo } from "../clone/LiveDemo";
import { Logo } from "../clone/Logo";
import { heroScenario } from "../clone/scenarios";
import { cn } from "../lib/cn";
import { DEMO_URL, REPO_URL, detectPlatform, downloadUrl, useRepoStats } from "../lib/site";
import { DemoFrame, GithubIcon } from "./ui";

gsap.registerPlugin(ScrollTrigger, SplitText, useGSAP);

type Theme = "light" | "dark" | null;

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("zwork:theme") as Theme) ?? null;
    } catch {
      return null;
    }
  });
  const toggle = () => {
    const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = theme ? theme === "dark" : sysDark;
    const next: Theme = isDark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("zwork:theme", next);
    } catch {
      /* private mode */
    }
    setTheme(next);
  };
  return [theme, toggle];
}

function formatStars(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

export function Nav() {
  const { stars } = useRepoStats();
  const platform = useMemo(detectPlatform, []);
  const [theme, toggle] = useTheme();
  const ref = useRef<HTMLElement>(null);

  useGSAP(() => {
    // Not onToggle: with end "max" the trigger goes inactive at the very bottom.
    const sync = (y: number) => ref.current?.classList.toggle("is-scrolled", y > 40);
    sync(window.scrollY);
    ScrollTrigger.create({ start: 0, end: "max", onUpdate: (self) => sync(self.scroll()) });
  });

  return (
    <header
      ref={ref}
      className="group fixed inset-x-0 top-0 z-50 transition-[background-color,box-shadow] duration-300 [&.is-scrolled]:bg-paper/80 [&.is-scrolled]:shadow-[0_1px_0_rgb(var(--border-overlay)/.08)] [&.is-scrolled]:backdrop-blur-xl"
    >
      <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-4 px-4 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5" aria-label="zWork home">
          <Logo size={26} className="text-ink" />
          <span className="text-[16px] font-semibold tracking-tight text-ink">zWork</span>
        </a>
        <nav aria-label="Main" className="hidden items-center gap-7 text-[14px] text-ink-muted md:flex">
          {[
            ["How it works", "#how"],
            ["Schedules", "#schedules"],
            ["Safety", "#safety"],
            ["Pricing", "#pricing"],
            ["FAQ", "#faq"],
          ].map(([label, href]) => (
            <a key={href} href={href} className="transition-colors hover:text-ink">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggle}
            aria-label="Switch light or dark theme"
            className="press inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-line/50 hover:text-ink"
          >
            <Sun className={cn("h-4 w-4", theme === "light" ? "hidden" : theme === "dark" ? "block" : "hidden dark-sys:block")} />
            <Moon className={cn("h-4 w-4", theme === "dark" ? "hidden" : theme === "light" ? "block" : "block dark-sys:hidden")} />
          </button>
          <a
            href={REPO_URL}
            className="press hidden h-9 items-center gap-2 rounded-full border border-line px-3.5 text-[13px] font-medium text-ink hover:bg-paper-raised sm:inline-flex"
          >
            <GithubIcon className="h-4 w-4" />
            {stars !== null ? <span className="tabular-nums">{formatStars(stars)}</span> : "GitHub"}
          </a>
          <a
            href={downloadUrl(platform)}
            className="press inline-flex h-9 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-medium text-paper hover:bg-ink/90"
          >
            Download
          </a>
        </div>
      </div>
    </header>
  );
}

const HERO_CHAPTERS = [
  { id: "ask", title: "You hand it the job", body: "In plain words, with the file attached. No prompt tricks." },
  { id: "work", title: "It does the work", body: "Reads the data, writes and runs its own scripts, fixes what breaks. Every step is shown." },
  { id: "result", title: "You get the finished thing", body: "A cleaned workbook and a report you can send, saved on your computer." },
];

export function Hero() {
  const platform = useMemo(detectPlatform, []);
  const { version } = useRepoStats();
  const root = useRef<HTMLDivElement>(null);
  const [chapter, setChapter] = useState<string | null>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(
        { motion: "(prefers-reduced-motion: no-preference)", reduce: "(prefers-reduced-motion: reduce)" },
        (ctx) => {
          if (ctx.conditions?.reduce) return;
          // Split only once the serif is in, so the first measurement uses real
          // line breaks (the title is CSS-hidden until then); autoSplit handles
          // resizes, and the returned tween keeps its progress across re-splits.
          let split: SplitText | undefined;
          let dead = false;
          document.fonts.ready.then(() => {
            if (dead) return;
            split = SplitText.create(".hero-title", {
              type: "words,lines",
              mask: "lines",
              autoSplit: true,
              onSplit: (self) =>
                gsap.from(self.words, { yPercent: 110, duration: 1.0, stagger: 0.06, delay: 0.3, ease: "power3.out" }),
            });
            gsap.set(".hero-title", { visibility: "visible" });
          });
          const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
          tl.from(".hero-pill", { autoAlpha: 0, y: 12, duration: 0.6 })
            .from(".hero-sub", { autoAlpha: 0, y: 16, duration: 0.8 }, 0.9)
            .from(".hero-cta > *", { autoAlpha: 0, y: 14, duration: 0.6, stagger: 0.08 }, "-=0.5")
            .from(".hero-window", { autoAlpha: 0, y: 80, duration: 1.3, ease: "expo.out" }, "-=0.5");

          // The window settles flat as you scroll into it.
          gsap.fromTo(
            ".hero-tilt",
            { rotationX: 16, scale: 0.92, transformPerspective: 1600, transformOrigin: "50% 0%" },
            {
              rotationX: 0,
              scale: 1,
              ease: "none",
              scrollTrigger: { trigger: ".hero-window", start: "top 95%", end: "top 25%", scrub: 0.6 },
            },
          );
          gsap.to(".hero-glow", {
            yPercent: 30,
            ease: "none",
            scrollTrigger: { trigger: root.current, start: "top top", end: "bottom top", scrub: true },
          });
          return () => {
            dead = true;
            split?.revert();
          };
        },
      );
    },
    { scope: root },
  );

  return (
    <div ref={root} id="top" className="relative overflow-hidden pt-32 sm:pt-40">
      <div className="grain pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_70%)]" />
      <div
        className="hero-glow pointer-events-none absolute left-1/2 top-[-10%] h-[720px] w-[1100px] -translate-x-1/2 rounded-full opacity-70 blur-3xl"
        style={{ background: "radial-gradient(closest-side, rgb(var(--paper-sunken)), transparent)" }}
      />
      <div className="relative mx-auto max-w-[1240px] px-4 text-center sm:px-8">
        <a
          href={`${REPO_URL}/releases`}
          className="hero-pill press inline-flex items-center gap-2 rounded-full border border-line bg-paper-sunken/70 py-1 pl-1.5 pr-3 text-[12.5px] text-ink-muted backdrop-blur hover:text-ink"
        >
          <span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-paper">{version ? `v${version}` : "New"}</span>
          Open source<span className="hidden sm:inline"> · macOS, Windows and Linux</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </a>
        <h1 className="hero-title display mx-auto mt-7 max-w-[13ch] text-[56px] text-ink sm:text-[92px] lg:text-[112px]">
          Your weekly paperwork, <em className="text-ink-soft">done.</em>
        </h1>
        <p className="hero-sub mx-auto mt-7 max-w-[60ch] text-[17px] leading-relaxed text-ink-muted sm:text-[19px]">
          zWork is an AI assistant on your computer for the reports, spreadsheets and emails you redo every week. Show it the
          job once and it does it on schedule, in real Excel and Word files, and asks before anything is sent.
        </p>
        <div className="hero-cta mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={downloadUrl(platform)}
            className="press inline-flex h-12 items-center gap-2.5 rounded-full bg-ink px-6 text-[15px] font-medium text-paper shadow-lift hover:bg-ink/90"
          >
            <Download className="h-4 w-4" />
            {platform ? `Download for ${platform === "Mac" ? "macOS" : platform}` : "Download zWork"}
          </a>
          <a
            href={DEMO_URL}
            className="press inline-flex h-12 items-center gap-2 rounded-full border border-line bg-paper px-6 text-[15px] font-medium text-ink hover:bg-paper-raised"
          >
            Try it in your browser
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
        <p className="hero-cta mt-4 text-[13px] text-ink-faint">
          <span>Free to start · Pro is $12, less than ChatGPT Plus · Open source</span>
        </p>
      </div>

      <div id="how" className="relative mx-auto mt-16 max-w-[1440px] px-3 sm:mt-20 sm:px-8">
        <div className="hero-window">
          <div className="hero-tilt will-change-transform">
            <DemoFrame label="The real zWork interface, playing a scripted run. Not a video.">
              <LiveDemo scenario={heroScenario} width={1440} height={880} panelWidth={600} onChapter={setChapter} />
            </DemoFrame>
          </div>
        </div>
        <div className="mx-auto mt-10 grid max-w-[1100px] gap-2 md:grid-cols-3">
          {HERO_CHAPTERS.map((c, i) => {
            const idx = HERO_CHAPTERS.findIndex((h) => h.id === chapter);
            const on = idx === i;
            return (
              <div
                key={c.id}
                className={cn(
                  "rounded-2xl border px-5 py-4 text-left transition-[background-color,border-color,opacity] duration-500",
                  on ? "border-line bg-paper-raised" : "border-transparent",
                  idx !== -1 && !on && "opacity-60",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span className={cn("font-mono text-[12px]", on ? "text-ink" : "text-ink-faint")}>0{i + 1}</span>
                  <h3 className="text-[15px] font-semibold text-ink">{c.title}</h3>
                </div>
                <p className="mt-1.5 text-[14px] leading-relaxed text-ink-muted">{c.body}</p>
                <div className="mt-3 h-[2px] overflow-hidden rounded-full bg-line">
                  <div
                    className={cn("h-full origin-left bg-ink transition-transform", on ? "scale-x-100 duration-[6000ms] ease-linear" : idx > i ? "scale-x-100 duration-300" : "scale-x-0 duration-300")}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

