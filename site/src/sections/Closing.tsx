import { useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollSmoother } from "gsap/ScrollSmoother";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { ArrowRight, ArrowUp, Check, Download, Plus } from "lucide-react";
import { Logo } from "../clone/Logo";
import { cn } from "../lib/cn";
import { Link } from "../lib/router";
import {
  ASSET_LABEL,
  CONTRIBUTING_URL,
  DEMO_URL,
  DISCUSSIONS_URL,
  DOCS_URL,
  INSTALL,
  ISSUES_URL,
  PLATFORMS,
  PRIVACY_URL,
  RELEASES_URL,
  REPO_URL,
  TERMS_URL,
  detectPlatform,
  downloadUrl,
  useRepoStats,
  type Platform,
} from "../lib/site";
import { useReveal } from "./Demos";
import { CopyCommand, GithubIcon, H2, Section } from "./ui";

gsap.registerPlugin(ScrollTrigger, ScrollSmoother, useGSAP);

export function OpenSource() {
  const { stars } = useRepoStats();
  const root = useRef<HTMLDivElement>(null);
  const count = useRef<HTMLSpanElement>(null);

  // Count the stars up once the band scrolls in.
  useGSAP(
    () => {
      if (stars === null || !count.current) return;
      const el = count.current;
      const mm = gsap.matchMedia();
      mm.add(
        { motion: "(prefers-reduced-motion: no-preference)", reduce: "(prefers-reduced-motion: reduce)" },
        (ctx) => {
          if (ctx.conditions?.reduce) {
            el.textContent = stars.toLocaleString();
            return;
          }
          const o = { n: 0 };
          gsap.to(o, {
            n: stars,
            duration: 1.6,
            ease: "power2.out",
            onUpdate: () => (el.textContent = Math.round(o.n).toLocaleString()),
            scrollTrigger: { trigger: root.current, start: "top 75%", once: true },
          });
        },
      );
    },
    { scope: root, dependencies: [stars] },
  );

  return (
    <div ref={root} data-theme-band className="relative overflow-hidden bg-[#141416] text-[#ececea]">
      <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:radial-gradient(#fff_1px,transparent_1px)] [background-size:22px_22px]" />
      <Section className="py-24 sm:py-32">
        <div className="grid items-center gap-12 lg:grid-cols-[1.3fr_1fr]">
          <div>
            <p className="eyebrow mb-5 !text-[#8a8a87]">Open source</p>
            <h2 className="display max-w-[16ch] text-[44px] sm:text-[64px]">
              Read every line <em className="text-[#a0a09d]">it runs.</em>
            </h2>
            <p className="mt-6 max-w-[52ch] text-[16px] leading-relaxed text-[#a0a09d]">
              The desktop app, the agent loop and the local backend are MIT licensed and on GitHub. If you want to know exactly what
              an agent on your computer is allowed to do, you can check.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href={REPO_URL}
                className="press inline-flex h-11 items-center gap-2.5 rounded-full bg-[#ececea] px-5 text-[14px] font-medium text-[#141416] hover:bg-white"
              >
                <GithubIcon className="h-4 w-4" />
                View on GitHub
              </a>
              <a
                href={CONTRIBUTING_URL}
                className="press inline-flex h-11 items-center gap-2 rounded-full border border-white/15 px-5 text-[14px] font-medium hover:bg-white/5"
              >
                Contribute
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { k: "stars", v: <span ref={count}>{stars === null ? "–" : "0"}</span>, l: "GitHub stars" },
              { k: "lic", v: "MIT", l: "License" },
              { k: "os", v: "3", l: "Desktop platforms" },
              { k: "prov", v: "200+", l: "Model providers" },
            ].map((x) => (
              <div key={x.k} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="display text-[44px] tabular-nums">{x.v}</div>
                <div className="mt-1 text-[13px] text-[#8a8a87]">{x.l}</div>
              </div>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}

type Tier = {
  name: string;
  monthly: number;
  yearly: number;
  blurb: string;
  features: string[];
  cta: string;
  featured?: boolean;
};

const TIERS: Tier[] = [
  {
    name: "Free",
    monthly: 0,
    yearly: 0,
    blurb: "Everything zWork can do, on a shared pool or your own key.",
    features: [
      "zWork's hosted models (shared pool), or your own key",
      "Every tool, skill and connector",
      "Up to 3 active schedules",
      "One task at a time",
    ],
    cta: "Download free",
  },
  {
    name: "Pro",
    monthly: 12,
    yearly: 10,
    blurb: "For using zWork every day on hosted models.",
    features: [
      "200 messages every 5 hours",
      "1,000 messages a week",
      "Up to 5 tasks at once",
      "Unlimited schedules",
      "Detailed usage stats",
      "Priority support",
    ],
    cta: "Get Pro",
    featured: true,
  },
  {
    name: "Max",
    monthly: 50,
    yearly: 41.67,
    blurb: "For running zWork hard, all day.",
    features: [
      "1,000 messages every 5 hours",
      "5,000 messages a week",
      "Up to 10 tasks at once",
      "Everything in Pro",
      "Faster replies when busy",
      "Dedicated support",
    ],
    cta: "Get Max",
  },
];

function Price({ value }: { value: number }) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useGSAP(
    () => {
      const o = { n: shown.current };
      gsap.to(o, {
        n: value,
        duration: 0.5,
        ease: "power2.out",
        onUpdate: () => {
          shown.current = o.n;
          if (el.current) el.current.textContent = fmt(o.n);
        },
      });
    },
    { dependencies: [value] },
  );
  return <span ref={el}>{fmt(value)}</span>;
}

function fmt(n: number) {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

// `heading="h1"` when the section is the page itself (/pricing, /download).
export function Pricing({ heading }: { heading?: "h1" } = {}) {
  const root = useReveal();
  const [yearly, setYearly] = useState(false);
  const platform = useMemo(detectPlatform, []);
  return (
    <Section id="pricing" className="py-28 sm:py-40">
      <div ref={root}>
        <div className="flex flex-col items-center text-center">
          <p data-reveal className="eyebrow mb-5">
            Pricing
          </p>
          <H2 as={heading} className="max-w-[15ch]">
            <span data-reveal className="block">
              Free to use.
            </span>
            <em data-reveal className="block text-ink-soft">
              Pay for more hosted runs.
            </em>
          </H2>
          <p data-reveal className="mt-6 max-w-[54ch] text-[16px] leading-relaxed text-ink-muted">
            Plans only cover zWork's hosted models. Bring your own key and the free plan has no message limits beyond your
            provider's.
          </p>
          <div data-reveal role="radiogroup" aria-label="Billing period" className="mt-8 inline-flex rounded-full bg-paper-raised p-1">
            {[
              [false, "Monthly"],
              [true, "Yearly, 2 months free"],
            ].map(([v, label]) => (
              <button
                key={String(v)}
                type="button"
                role="radio"
                aria-checked={yearly === v}
                onClick={() => setYearly(v as boolean)}
                className={cn(
                  "press rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors",
                  yearly === v ? "bg-paper text-ink shadow-sm" : "text-ink-muted hover:text-ink",
                )}
              >
                {label as string}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {TIERS.map((t) => (
            <article
              key={t.name}
              data-reveal
              className={cn(
                "relative flex flex-col rounded-3xl border p-7 sm:p-8",
                t.featured ? "border-ink bg-ink text-paper shadow-lift" : "border-line bg-paper-raised text-ink",
              )}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-[17px] font-semibold">{t.name}</h3>
                {t.featured && (
                  <span className="rounded-full bg-paper/15 px-2.5 py-0.5 text-[11.5px] font-medium">Most popular</span>
                )}
              </div>
              <div className="mt-6 flex items-baseline gap-1.5">
                <span className="display text-[56px] tabular-nums">
                  $<Price value={yearly ? t.yearly : t.monthly} />
                </span>
                <span className={cn("text-[14px]", t.featured ? "text-paper/60" : "text-ink-muted")}>
                  {t.monthly === 0 ? "forever" : "/ month"}
                </span>
              </div>
              <p className={cn("mt-1 h-5 text-[12.5px]", t.featured ? "text-paper/60" : "text-ink-faint")}>
                {t.monthly > 0 && yearly ? `$${fmt(t.monthly * 10)} billed yearly` : ""}
              </p>
              <p className={cn("mt-4 text-[14.5px] leading-relaxed", t.featured ? "text-paper/75" : "text-ink-muted")}>{t.blurb}</p>
              <ul className="mt-6 flex flex-1 flex-col gap-2.5">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-[14px]">
                    <Check className={cn("mt-0.5 h-4 w-4 shrink-0", t.featured ? "text-paper/70" : "text-ink-muted")} />
                    {f}
                  </li>
                ))}
              </ul>
              <a
                href={downloadUrl(platform)}
                className={cn(
                  "press mt-8 inline-flex h-11 items-center justify-center rounded-full text-[14px] font-medium",
                  t.featured ? "bg-paper text-ink hover:bg-paper/90" : "border border-line bg-paper hover:bg-paper-sunken",
                )}
              >
                {t.cta}
              </a>
            </article>
          ))}
        </div>
        <p data-reveal className="mt-6 text-center text-[13px] text-ink-faint">
          Every plan starts with the same download. Pro and Max are bought from inside the app.
        </p>
      </div>
    </Section>
  );
}

const FAQ: [string, string][] = [
  [
    "How is this different from ChatGPT or Claude?",
    "Use ChatGPT for questions. Use zWork for the jobs you do every week. It works on the files already on your computer, so nothing gets uploaded, gives you back a real Excel or Word file, runs the job on a schedule and asks before it sends or deletes anything. It costs $12 instead of $20, and it's free if you bring your own AI key.",
  ],
  [
    "Is it really free?",
    "Yes. The free plan includes hosted models from a shared pool, every tool, skill and connector, up to 3 active schedules and one task at a time. Bring your own model key and the only limits are your provider's.",
  ],
  [
    "Which AI models does it use?",
    "zWork's hosted models, or your own: Anthropic, OpenAI, Google, DeepSeek, OpenRouter, local models, your Claude login, or any of 200+ providers.",
  ],
  [
    "Does it upload my files?",
    "Files are opened and saved on your computer. Only the text a step needs goes to the model. With your own key it goes straight to that provider; with zWork's hosted models it passes through our API on the way.",
  ],
  [
    "Can it change or delete things without asking?",
    "Not by default. Edits, deletes and sent messages wait for your OK, and every step is shown as it happens. You can loosen that once you trust it.",
  ],
  [
    "Does my computer have to be on for schedules?",
    "Schedules run on your computer while zWork is running. Closing the window keeps it in the menu bar or tray. If a run was missed while the computer slept, it runs once when zWork is back.",
  ],
  [
    "What do I need to run it?",
    "macOS on Apple silicon or Intel, Windows on x64, or Linux on x86_64. Python and Node are installed for you, so skills and connectors work on a fresh laptop.",
  ],
  [
    "Is it open source?",
    "Yes, MIT licensed. The app, the agent and the local backend are on GitHub, and issues and pull requests are welcome.",
  ],
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const { contextSafe } = useGSAP();
  const toggle = contextSafe(() => {
    const el = body.current;
    if (!el) return;
    const next = !open;
    setOpen(next);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    gsap.to(el, { height: next ? "auto" : 0, duration: reduce ? 0 : 0.45, ease: "power3.inOut" });
  });
  return (
    <div className="border-b border-line">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex w-full items-center justify-between gap-6 py-5 text-left text-[17px] font-medium text-ink"
        >
          {q}
          <Plus className={cn("h-4 w-4 shrink-0 text-ink-muted transition-transform duration-300", open && "rotate-45")} />
        </button>
      </h3>
      <div ref={body} className="h-0 overflow-hidden" aria-hidden={!open}>
        <p className="max-w-[62ch] pb-6 text-[15.5px] leading-relaxed text-ink-muted">{a}</p>
      </div>
    </div>
  );
}

export function Faq() {
  const root = useReveal();
  return (
    <div className="border-t border-line bg-paper-soft">
      <Section id="faq" className="py-28 sm:py-36">
        <div ref={root} className="grid gap-12 lg:grid-cols-[1fr_1.6fr] lg:gap-20">
          <div data-reveal>
            <H2 className="max-w-[12ch]">Questions, answered.</H2>
            <p className="mt-6 max-w-[34ch] leading-relaxed text-ink-muted">
              Something missing?{" "}
              <a href={DISCUSSIONS_URL} className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                Ask on GitHub
              </a>
              .
            </p>
          </div>
          <div data-reveal className="border-t border-line">
            {FAQ.map(([q, a]) => (
              <FaqItem key={q} q={q} a={a} />
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}

export function FinalCta({ heading }: { heading?: "h1" } = {}) {
  const detected = useMemo(detectPlatform, []);
  const [platform, setPlatform] = useState<Platform>(detected ?? "Mac");
  const root = useReveal();
  return (
    <Section className="py-28 sm:py-40">
      <div ref={root} className="relative overflow-hidden rounded-[32px] border border-line bg-paper-raised px-6 py-16 text-center sm:px-12 sm:py-24">
        <div className="grain pointer-events-none absolute inset-0 opacity-70 [mask-image:radial-gradient(closest-side,black,transparent)]" />
        <div className="relative">
          <div data-reveal className="flex justify-center">
            <Logo size={52} className="text-ink" />
          </div>
          <H2 as={heading} className="mx-auto mt-8 max-w-[14ch] sm:text-[76px]">
            <span data-reveal className="block">
              Hand it something
            </span>
            <em data-reveal className="block text-ink-soft">
              you'd rather not do.
            </em>
          </H2>
          <div data-reveal className="mx-auto mt-10 inline-flex rounded-full bg-paper p-1" role="tablist" aria-label="Platform">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={platform === p}
                onClick={() => setPlatform(p)}
                className={cn(
                  "press rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors",
                  platform === p ? "bg-ink text-paper" : "text-ink-muted hover:text-ink",
                )}
              >
                {p === "Mac" ? "macOS" : p}
              </button>
            ))}
          </div>
          <div data-reveal className="mt-6 flex flex-col items-center gap-2">
            <a
              href={downloadUrl(platform)}
              className="press inline-flex h-12 items-center gap-2.5 rounded-full bg-ink px-7 text-[15px] font-medium text-paper shadow-lift hover:bg-ink/90"
            >
              <Download className="h-4 w-4" />
              Download for {platform === "Mac" ? "macOS" : platform}
            </a>
            <span className="text-[12.5px] text-ink-faint">{ASSET_LABEL[platform]}</span>
          </div>
          <div data-reveal className="mx-auto mt-8 max-w-[560px] text-left">
            <p className="mb-2 text-center text-[12.5px] text-ink-faint">Or from {INSTALL[platform].shell}</p>
            <CopyCommand command={INSTALL[platform].command} className="bg-paper" />
          </div>
          <p data-reveal className="mt-8 text-[13.5px] text-ink-muted">
            Not ready to install?{" "}
            <a href={DEMO_URL} className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
              Try it in your browser
            </a>
            . Older builds are on the{" "}
            <a href={RELEASES_URL} className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
              releases page
            </a>
            .
          </p>
        </div>
      </div>
    </Section>
  );
}

/**
 * The page's last word: the link columns over a full-bleed "zWork" that the
 * footer's bottom edge crops. The letters rise into place as the page runs
 * out and, with a mouse, lift a little under the pointer.
 */
export function Footer() {
  const root = useRef<HTMLElement>(null);
  const cols: [string, [string, string][]][] = [
    [
      "Product",
      [
        ["How it works", "/#how"],
        ["Features", "/features"],
        ["Pricing", "/pricing"],
        ["Open source", "/open-source"],
        ["Download", "/download"],
        ["Try in browser", DEMO_URL],
      ],
    ],
    [
      "Resources",
      [
        ["Docs", DOCS_URL],
        ["Releases", RELEASES_URL],
        ["Report an issue", ISSUES_URL],
        ["Discussions", DISCUSSIONS_URL],
      ],
    ],
    [
      "Legal",
      [
        ["Privacy", PRIVACY_URL],
        ["Terms", TERMS_URL],
        ["MIT license", `${REPO_URL}/blob/main/LICENSE`],
      ],
    ],
  ];

  useGSAP(
    () => {
      const el = root.current!;
      const word = el.querySelector<HTMLElement>(".fw-word")!;
      const letters = gsap.utils.toArray<HTMLElement>(".fw-letter", el);
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        // Set up front, not as a fromTo(): the page's trigger refresh can undo
        // its first render, so the letters would show risen before dropping.
        // Any transform a previous run left behind is cleared first, or it's
        // read back as pixels and the letters end up lowered twice.
        gsap.set(letters, { clearProps: "transform" });
        gsap.set(letters, { yPercent: 75 });
        gsap.to(letters, {
          yPercent: 0,
          ease: "none",
          stagger: 0.08,
          scrollTrigger: { trigger: word, start: "top bottom", end: "bottom bottom", scrub: 0.6 },
        });
      });
      mm.add("(prefers-reduced-motion: no-preference) and (pointer: fine)", () => {
        const inner = letters.map((l) => l.firstElementChild as HTMLElement);
        const lift = inner.map((l) => gsap.quickTo(l, "y", { duration: 0.7, ease: "power3.out" }));
        const move = (e: PointerEvent) =>
          letters.forEach((l, i) => {
            const r = l.getBoundingClientRect();
            const d = Math.abs(e.clientX - (r.left + r.width / 2)) / r.width;
            lift[i](-Math.max(0, 1 - d * 0.7) * r.height * 0.1);
          });
        const leave = () => lift.forEach((f) => f(0));
        word.addEventListener("pointermove", move);
        word.addEventListener("pointerleave", leave);
        return () => {
          word.removeEventListener("pointermove", move);
          word.removeEventListener("pointerleave", leave);
        };
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  const toTop = () => {
    const smoother = ScrollSmoother.get();
    if (smoother) smoother.scrollTo(0, true);
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <footer ref={root} className="relative overflow-hidden border-t border-line">
      <Section className="pt-16 sm:pt-20">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 md:grid-cols-[1.6fr_repeat(3,1fr)] md:gap-12">
          <div className="col-span-full md:col-span-1">
            <p className="display max-w-[14ch] text-[34px] text-ink sm:text-[44px]">
              Your weekly paperwork, <em className="text-ink-muted">done.</em>
            </p>
            <Link
              href="/download"
              className="press mt-7 inline-flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-[13.5px] font-medium text-paper hover:bg-ink/90"
            >
              <Download className="h-4 w-4" />
              Download free
            </Link>
          </div>
          {cols.map(([title, links]) => (
            <div key={title}>
              <h3 className="eyebrow">{title}</h3>
              <ul className="mt-4 flex flex-col gap-2.5">
                {links.map(([label, href]) => (
                  <li key={label}>
                    <Link href={href} className="text-[14px] text-ink-muted transition-colors hover:text-ink">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-16 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-5 text-[12.5px] text-ink-faint">
          <span>© {new Date().getFullYear()} zWork. MIT licensed.</span>
          <a href={REPO_URL} className="inline-flex items-center gap-1.5 transition-colors hover:text-ink">
            <GithubIcon className="h-3.5 w-3.5" />
            Ryz3nPlayZ/zWork
          </a>
          <button
            type="button"
            onClick={toTop}
            className="press ml-auto inline-flex items-center gap-1.5 transition-colors hover:text-ink"
          >
            Back to top
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </Section>

      {/* Sized to the viewport so it runs edge to edge; the footer's own edge crops the bottom. */}
      <div aria-hidden="true" className="fw-word mt-10 flex h-[32vw] select-none justify-center px-[2vw]">
        {[..."zWork"].map((c, i) => (
          <span key={i} className="fw-letter block">
            <span className="block font-serif text-[48.5vw] leading-[0.82] tracking-[-0.045em] text-ink">{c}</span>
          </span>
        ))}
      </div>
    </footer>
  );
}
