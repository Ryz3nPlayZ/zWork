import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";
import { Brain, FileSpreadsheet, FolderOpen, Layers, Plug, Sparkles } from "lucide-react";
import { Section } from "./ui";

gsap.registerPlugin(ScrollTrigger, SplitText, useGSAP);

/** Scroll-scrubbed statement: words light up as you read down the page. */
export function Statement() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const split = SplitText.create(".statement", { type: "words", wordsClass: "statement-word" });
        gsap.fromTo(
          split.words,
          { opacity: 0.14 },
          {
            opacity: 1,
            stagger: 0.1,
            ease: "none",
            scrollTrigger: { trigger: ".statement", start: "top 78%", end: "bottom 45%", scrub: true },
          },
        );
        return () => split.revert();
      });
    },
    { scope: root },
  );
  return (
    <Section className="py-32 sm:py-48">
      <div ref={root}>
        <p className="eyebrow mb-8">Why it's different</p>
        <p className="statement display max-w-[22ch] text-[40px] leading-[1.08] text-ink sm:text-[64px] lg:text-[76px]">
          Use ChatGPT for questions. Use zWork for the jobs you redo every week: it works on the files already on your computer,
          hands back real Excel and Word files, and asks before anything is sent.
        </p>
      </div>
    </Section>
  );
}

const CAPS = [
  {
    icon: FileSpreadsheet,
    title: "Real files, not chat replies",
    body: "Reads spreadsheets, PDFs and scanned pages. Writes Excel, Word, PowerPoint and PDF files you can open anywhere.",
  },
  {
    icon: FolderOpen,
    title: "Works through whole folders",
    body: "Every PDF, every export, every row. No upload limits, because nothing gets uploaded.",
  },
  {
    icon: Plug,
    title: "Works inside your tools",
    body: "Reads and acts in Gmail, Calendar, Slack, Notion, Sheets and hundreds more, each connected in one click.",
  },
  {
    icon: Brain,
    title: "Remembers",
    body: "Your team, your tone, how you like reports laid out. Tell it once.",
  },
  {
    icon: Layers,
    title: "Several jobs at once",
    body: "Splits big jobs across helper agents, and runs separate tasks side by side.",
  },
  {
    icon: Sparkles,
    title: "Save what worked",
    body: "Turn a task that went well into a skill and run it again with one slash command.",
  },
];

export function Capabilities() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        // The headline comes in word by word as it scrolls into view.
        const split = SplitText.create(".horizon-title", { type: "words" });
        gsap
          .timeline({ scrollTrigger: { trigger: ".horizon-title", start: "top 82%", toggleActions: "play none none reverse" } })
          .from(split.words, { autoAlpha: 0, y: 18, filter: "blur(10px)", duration: 0.9, stagger: 0.07, ease: "power3.out" })
          .from(".horizon-sub", { autoAlpha: 0, y: 12, duration: 0.8, ease: "power3.out" }, "-=0.5");

        // Then the rim lights from left to right, and the glow behind it
        // travels across with it.
        gsap
          .timeline({ scrollTrigger: { trigger: ".horizon-arc", start: "top 78%", toggleActions: "play none none reverse" } })
          .fromTo(".horizon", { "--sweep": "30deg" }, { "--sweep": "160deg", duration: 2.4, ease: "power2.inOut" }, 0)
          .fromTo(
            ".horizon-glow",
            { autoAlpha: 0, xPercent: -35, scaleX: 0.6 },
            { autoAlpha: 1, xPercent: 0, scaleX: 1, duration: 2.4, ease: "power2.inOut" },
            0,
          )
          .from(".horizon-cap", { autoAlpha: 0, y: 24, duration: 0.8, stagger: 0.07, ease: "power3.out" }, 0.7);

        return () => split.revert();
      });
    },
    { scope: root },
  );

  return (
    <Section className="pb-32 sm:pb-44">
      <div ref={root}>
        {/* A dark graphite horizon: the six capabilities sit on a planet whose rim
            lights up as you arrive. Dark in both themes. */}
        <div className="horizon relative overflow-hidden rounded-[28px] border border-cream/[.06] sm:rounded-[36px]">
          <header className="relative z-10 mx-auto max-w-[760px] px-6 pt-20 text-center sm:pt-28">
            <p className="eyebrow mb-6 !text-cream/40">What it can do</p>
            <h2 className="horizon-title display text-[44px] text-cream sm:text-[64px]">
              Everything you'd use to <em className="text-cream/50">do it yourself.</em>
            </h2>
            <p className="horizon-sub mx-auto mt-6 max-w-[52ch] text-[16px] leading-relaxed text-cream/55">
              zWork has the same tools you do: your files, a real browser, your desktop apps and your accounts. So the job
              ends with the work done, not with instructions for you.
            </p>
          </header>

          <div className="horizon-arc relative mt-16 sm:mt-24">
            <div className="horizon-glow" />
            <div className="horizon-planet" />
            <div className="horizon-light">
              <div className="horizon-halo" />
              <div className="horizon-rays" />
              <div className="horizon-rim" />
            </div>
            <div className="horizon-caps relative z-10 grid gap-x-12 px-6 pb-14 sm:grid-cols-2 sm:px-12 sm:pb-20 lg:grid-cols-3 lg:gap-x-14 lg:px-16">
              {CAPS.map(({ icon: Icon, title, body }) => (
                <article key={title} className="horizon-cap border-t border-cream/10 py-7 sm:py-8">
                  <Icon className="h-[18px] w-[18px] text-cream/70" strokeWidth={1.7} />
                  <h3 className="mt-4 text-[17px] font-semibold tracking-tight text-cream">{title}</h3>
                  <p className="mt-2 text-[14.5px] leading-relaxed text-cream/55">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </div>

      </div>
    </Section>
  );
}
