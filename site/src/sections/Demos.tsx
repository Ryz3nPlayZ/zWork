import { useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Cpu, KeyRound, Lock, MonitorSmartphone } from "lucide-react";
import { Cursor } from "../clone/AppWindow";
import { Composer, PRESET_META } from "../clone/Composer";
import { LiveDemo } from "../clone/LiveDemo";
import { approvalScenario, modelScenario, scheduleScenario } from "../clone/scenarios";
import type { Preset } from "../clone/types";
import { cn } from "../lib/cn";
import { ChapterList, DemoFrame, H2, Section } from "./ui";

gsap.registerPlugin(ScrollTrigger, useGSAP);

/** Fades a section's [data-reveal] children up as they scroll in. */
function useReveal() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        ScrollTrigger.batch(root.current!.querySelectorAll("[data-reveal]"), {
          start: "top 88%",
          once: true,
          onEnter: (els) => gsap.from(els, { autoAlpha: 0, y: 36, duration: 0.9, stagger: 0.1, ease: "power3.out" }),
        });
      });
    },
    { scope: root },
  );
  return root;
}

const SCHEDULE_CHAPTERS = [
  {
    id: "ask",
    title: "Ask once, in plain words",
    body: "“Every weekday at 8:30, check Gmail for new invoices.” zWork sets up the schedule itself. No cron, no flowchart builder.",
  },
  {
    id: "schedule",
    title: "It runs on its own",
    body: "Each run is a full agent run with the same tools and the same approvals. Run it now any time to check it works.",
  },
  {
    id: "inbox",
    title: "Results land in your Inbox",
    body: "Summaries, things that need a look and questions it couldn't answer alone, all in one place.",
  },
];

export function Schedules() {
  const root = useReveal();
  const [chapter, setChapter] = useState<string | null>(null);
  return (
    <Section id="schedules" className="py-28 sm:py-40">
      <div ref={root} className="grid items-center gap-12 xl:grid-cols-[0.8fr_1.6fr] xl:gap-14">
        <div>
          <p data-reveal className="eyebrow mb-5">
            Schedules
          </p>
          <H2 className="max-w-[11ch]">
            <span data-reveal className="block">
              Do it once.
            </span>
            <em data-reveal className="block text-ink-soft">
              Then every week.
            </em>
          </H2>
          <div data-reveal className="mt-10">
            <ChapterList items={SCHEDULE_CHAPTERS} active={chapter} />
          </div>
          <p data-reveal className="mt-6 max-w-[44ch] text-[13.5px] leading-relaxed text-ink-faint">
            Schedules run on your computer while zWork is open, including from the menu bar or tray. A run missed while the
            computer slept happens once when zWork is back.
          </p>
        </div>
        <div data-reveal>
          <DemoFrame label="Scripted demo in the real interface">
            <LiveDemo scenario={scheduleScenario} width={1240} height={780} onChapter={setChapter} />
          </DemoFrame>
        </div>
      </div>
    </Section>
  );
}

const SAFETY_CHAPTERS = [
  { id: "ask", title: "It drafts", body: "Finds the thread, reads the invoice, writes the email. Nothing has left your computer yet." },
  {
    id: "ask-ok",
    title: "It asks",
    body: "Sending, editing and deleting wait for your OK, with exactly what will happen spelled out. You can say no or tell it what to do instead.",
  },
  { id: "sent", title: "Then it acts", body: "Only after you click Allow. Every step stays in the chat, so you can see what it did later." },
];

export function Safety() {
  const root = useReveal();
  const [chapter, setChapter] = useState<string | null>(null);
  return (
    <div id="safety" className="relative border-y border-line bg-paper-soft">
      <Section className="py-28 sm:py-40">
        <div ref={root}>
          <div className="mb-14 grid gap-8 lg:grid-cols-2 lg:items-end">
            <div>
              <p data-reveal className="eyebrow mb-5">
                You stay in charge
              </p>
              <H2 className="max-w-[13ch]">
                <span data-reveal className="block">
                  Nothing goes out
                </span>
                <em data-reveal className="block text-ink-soft">
                  without your OK.
                </em>
              </H2>
            </div>
            <p data-reveal className="max-w-[48ch] text-[16px] leading-relaxed text-ink-muted lg:justify-self-end">
              An agent that can send email and delete files needs a brake. In zWork it's on by default: anything that changes or
              sends something stops and asks first. Loosen it per chat once you trust it.
            </p>
          </div>

          <div className="grid gap-10 xl:grid-cols-[1.75fr_0.85fr]">
            <div data-reveal>
              <DemoFrame label="Scripted demo in the real interface">
                <LiveDemo scenario={approvalScenario} width={1320} height={800} panelWidth={520} onChapter={setChapter} />
              </DemoFrame>
            </div>
            <div data-reveal className="flex flex-col gap-8">
              <ChapterList items={SAFETY_CHAPTERS} active={chapter} />
              <div>
                <p className="mb-3 text-[12.5px] font-medium text-ink-faint">Four modes, picked per chat</p>
                <ul className="divide-y divide-line rounded-2xl border border-line bg-paper">
                  {(Object.keys(PRESET_META) as Preset[]).map((k) => (
                    <li key={k} className="flex items-start gap-3 px-4 py-3">
                      <span className="mt-0.5 text-ink-muted">{PRESET_META[k].icon}</span>
                      <div>
                        <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                          {PRESET_META[k].label}
                          {k === "ask" && (
                            <span className="rounded-full border border-line px-1.5 text-[10.5px] font-medium text-ink-muted">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="text-[12.5px] text-ink-muted">{PRESET_META[k].description}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

const PROVIDERS = ["zWork hosted", "Anthropic", "OpenAI", "Google", "DeepSeek", "OpenRouter", "Ollama (local)", "Claude login", "200+ more"];

const MODEL_POINTS = [
  { icon: Cpu, title: "Our models, free to start", body: "zWork's hosted models work out of the box, no account with anyone else needed." },
  { icon: KeyRound, title: "Or your own key", body: "Paste a key and requests go straight to that provider. Their limits, not ours." },
  { icon: MonitorSmartphone, title: "Or fully local", body: "Run a model through Ollama and your prompts never leave this computer." },
  {
    icon: Lock,
    title: "Your files stay put",
    body: "They're opened and saved on your computer. Only the text a step needs is sent to the model.",
  },
];

export function Models() {
  const root = useReveal();
  return (
    <Section className="py-28 sm:py-40">
      <div ref={root} className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
        <div className="order-2 lg:order-1" data-reveal>
          <div className="relative overflow-hidden rounded-3xl border border-line bg-paper-raised">
            <div className="grain pointer-events-none absolute inset-0 opacity-60" />
            <LiveDemo
              scenario={modelScenario}
              width={760}
              height={560}
              loopDelay={1.5}
              render={(s) => (
                <div className="flex h-full flex-col justify-end p-12">
                  <div className="mb-auto pt-2 text-[13px] text-ink-faint">Switch models mid-conversation. The chat keeps going.</div>
                  <Composer s={s} placeholder="Reply to zWork" />
                  <Cursor />
                </div>
              )}
            />
          </div>
        </div>
        <div className="order-1 lg:order-2">
          <p data-reveal className="eyebrow mb-5">
            Any model
          </p>
          <H2 className="max-w-[12ch]">
            <span data-reveal className="block">
              Use the brain
            </span>
            <em data-reveal className="block text-ink-soft">
              you already trust.
            </em>
          </H2>
          <div data-reveal className="mt-8 flex flex-wrap gap-2">
            {PROVIDERS.map((p) => (
              <span
                key={p}
                className={cn(
                  "rounded-full border px-3 py-1 text-[12.5px]",
                  p === "zWork hosted" ? "border-ink bg-ink text-paper" : "border-line text-ink-muted",
                )}
              >
                {p}
              </span>
            ))}
          </div>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {MODEL_POINTS.map(({ icon: Icon, title, body }) => (
              <div key={title} data-reveal>
                <Icon className="h-[18px] w-[18px] text-ink-muted" />
                <h3 className="mt-3 text-[15px] font-semibold text-ink">{title}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-ink-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

export { useReveal };
