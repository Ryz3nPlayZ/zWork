import { useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";
import { ArrowRight, Download, Menu, Moon, Sun, X } from "lucide-react";
import { Logo, LogoSlat } from "../clone/Logo";
import { cn } from "../lib/cn";
import { onReveal } from "../lib/intro";
import { Link, usePath } from "../lib/router";
import { DEMO_URL, REPO_URL, detectPlatform, downloadUrl, useRepoStats } from "../lib/site";
import { GithubIcon } from "./ui";

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

const NAV_LINKS: [string, string][] = [
  ["Features", "/features"],
  ["Pricing", "/pricing"],
  ["Open source", "/open-source"],
];

export function Nav() {
  const { stars } = useRepoStats();
  const [theme, toggle] = useTheme();
  const [open, setOpen] = useState(false);
  const path = usePath();
  const ref = useRef<HTMLElement>(null);

  useGSAP(() => {
    // Not onToggle: with end "max" the trigger goes inactive at the very bottom.
    // Tucks away while you read down (it would cover the pinned desktop) and
    // comes back the moment you scroll up.
    const sync = (y: number, dir: number) => {
      const el = ref.current;
      if (!el) return;
      el.classList.toggle("is-scrolled", y > 40);
      if (dir) el.classList.toggle("is-hidden", dir > 0 && y > 160);
    };
    sync(window.scrollY, 0);
    ScrollTrigger.create({ start: 0, end: "max", onUpdate: (self) => sync(self.scroll(), self.direction) });
  });

  return (
    <header
      ref={ref}
      className="group fixed inset-x-0 top-0 z-50 transition-[background-color,box-shadow,translate] duration-300 [&.is-hidden]:-translate-y-full [&.is-scrolled]:bg-paper/80 [&.is-scrolled]:shadow-[0_1px_0_rgb(var(--border-overlay)/.08)] [&.is-scrolled]:backdrop-blur-xl"
    >
      <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-4 px-4 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="zWork home" onClick={() => setOpen(false)}>
          <Logo size={26} className="text-ink" />
          <span className="text-[16px] font-semibold tracking-tight text-ink">zWork</span>
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-8 text-[14px] text-ink-muted md:flex">
          {NAV_LINKS.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              aria-current={path === href ? "page" : undefined}
              className="transition-colors hover:text-ink aria-[current=page]:text-ink"
            >
              {label}
            </Link>
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
          <Link
            href="/download"
            className="press inline-flex h-9 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-medium text-paper hover:bg-ink/90"
          >
            Download
          </Link>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="press inline-flex h-9 w-9 items-center justify-center rounded-full text-ink hover:bg-line/50 md:hidden"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {open && (
        <nav aria-label="Main" className="border-t border-line bg-paper px-4 pb-5 pt-2 md:hidden">
          {NAV_LINKS.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className="block border-b border-line-soft py-3.5 text-[17px] text-ink"
            >
              {label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

export function Hero() {
  const platform = useMemo(detectPlatform, []);
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(
        { motion: "(prefers-reduced-motion: no-preference)", reduce: "(prefers-reduced-motion: reduce)" },
        (ctx) => {
          if (ctx.conditions?.reduce) return;
          // The headline rises in as the preloader slides off. Split only once
          // the serif is in, so the first measurement uses real line breaks
          // (the title is CSS-hidden until then); autoSplit handles resizes,
          // and the returned tween keeps its progress across re-splits.
          let split: SplitText | undefined;
          let dead = false;
          const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
          tl.from(
            ".dive-mark-intro",
            { rotation: -140, scale: 0.4, autoAlpha: 0, transformOrigin: "50% 50%", duration: 1.4, ease: "expo.out" },
            0,
          )
            .fromTo(".hero-sub", { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.8 }, 0.55)
            .fromTo(".hero-cta > *", { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.08 }, "-=0.5");
          const off = onReveal(() => {
            document.fonts.ready.then(() => {
              if (dead) return;
              split = SplitText.create(".hero-title", {
                type: "words,lines",
                mask: "lines",
                autoSplit: true,
                onSplit: (self) => gsap.from(self.words, { yPercent: 110, duration: 1.0, stagger: 0.06, ease: "power3.out" }),
              });
              gsap.set(".hero-title", { visibility: "visible" });
              tl.play();
            });
          });
          return () => {
            dead = true;
            off();
            split?.revert();
          };
        },
      );
    },
    { scope: root },
  );

  return (
    <div
      ref={root}
      id="top"
      className="dive-hero relative flex min-h-[92dvh] items-center overflow-hidden bg-paper pb-16 pt-24 sm:pt-28"
    >
      {/* The paper behind the hero; it fades on the way into the desktop. */}
      <div className="hero-bg pointer-events-none absolute inset-0 bg-paper">
        <div className="grain absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_70%)]" />
      </div>
      {/* The mark you dive through on the way to the desktop. It's drawn
          across the whole stage so it stays sharp at any size; the slot below
          only marks where it starts. */}
      <svg className="dive-mark pointer-events-none absolute inset-0 z-20 h-full w-full text-ink" aria-hidden="true">
        <g className="dive-mark-g" fill="currentColor">
          <g className="dive-mark-intro">
            {Array.from({ length: 6 }, (_, i) => (
              <g key={i} className="dive-slat" transform={`rotate(${i * 60}) translate(0 -12.5)`}>
                <LogoSlat />
              </g>
            ))}
          </g>
        </g>
      </svg>
      <div className="relative mx-auto w-full max-w-[1240px] px-4 text-center sm:px-8">
        <div className="dive-logo-slot mx-auto mb-7 h-11 w-11 sm:mb-9 sm:h-14 sm:w-14">
          <Logo className="h-full w-full text-ink" />
        </div>
        <div className="hero-body">
          <h1 className="hero-title display mx-auto max-w-[13ch] text-[56px] text-ink sm:text-[92px] lg:text-[118px]">
            Your weekly paperwork, <em className="text-ink-soft">done.</em>
          </h1>
          <p className="hero-sub mx-auto mt-8 max-w-[60ch] text-[17px] leading-relaxed text-ink-muted sm:text-[19px]">
            zWork is an AI assistant on your computer for the reports, spreadsheets and emails you redo every week. Show it the
            job once and it does it on schedule, in real Excel and Word files, and asks before anything is sent.
          </p>
          <div className="hero-cta mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
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
        </div>
      </div>
    </div>
  );
}
