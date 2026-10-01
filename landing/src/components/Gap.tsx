import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { CheckCircle, CircleNotch } from "@phosphor-icons/react";
import { Eyebrow, H2, Reveal, Section } from "./ui";

type Task = { id: string; label: string; ask: string; chat: string[]; zwork: string[] };

const TASKS: Task[] = [
  {
    id: "finance",
    label: "Finance",
    ask: "Clean up the Q3 bank export and write a spending report.",
    chat: [
      "Paste 87 rows into the chat. It stops at 40.",
      "Paste the rest. It forgets the first half.",
      "Copy the table out, fix the columns in Excel.",
      "Write the report yourself from what survived.",
    ],
    zwork: [
      "Opens the CSV and normalizes vendors, dates and amounts.",
      "Catches the duplicate charge you missed.",
      "Builds a cleaned Excel file with a tab per view.",
      "Hands you a report ready to forward.",
    ],
  },
  {
    id: "school",
    label: "School",
    ask: "Turn this semester's lecture PDFs into a study guide.",
    chat: [
      "Upload one PDF. Hit the file limit on the third.",
      "Ask for a summary of each, one at a time.",
      "Stitch twelve answers into one document.",
      "Discover it skipped the slides with diagrams.",
    ],
    zwork: [
      "Reads the whole folder, scanned pages included.",
      "Builds one guide organized by topic, not by file.",
      "Adds practice questions with worked answers.",
      "Saves it as a Word doc you can print.",
    ],
  },
  {
    id: "ops",
    label: "Operations",
    ask: "Write the weekly update from my notes and the team tracker.",
    chat: [
      "Export the tracker, paste it in, lose the formatting.",
      "Paste your notes. Explain who everyone is again.",
      "Rewrite the tone. Then rewrite it again.",
      "Copy the result into an email by hand.",
    ],
    zwork: [
      "Pulls the tracker and your notes itself.",
      "Remembers your team, your tone and last week.",
      "Drafts the update in your house format.",
      "Leaves it in Gmail as a draft for you to send.",
    ],
  },
  {
    id: "sales",
    label: "Sales",
    ask: "Research these 30 companies and fill in the lead sheet.",
    chat: [
      "Ask about one company. Get a guess from 2023.",
      "Open 30 tabs to check what it said.",
      "Type every answer into the sheet yourself.",
      "Do it again next week.",
    ],
    zwork: [
      "Browses each company's site and recent news.",
      "Fills in size, contact and a one line pitch angle.",
      "Writes straight into your Google Sheet.",
      "Runs again every Monday on a schedule.",
    ],
  },
];

export function Gap() {
  const [active, setActive] = useState(TASKS[0].id);
  const task = TASKS.find((t) => t.id === active)!;

  return (
    <Section className="py-28 sm:py-40">
      <Reveal>
        <Eyebrow>The gap</Eyebrow>
        <H2 className="max-w-[22ch] sm:text-6xl">
          Developers got agents. Everyone else got a <span className="accent">chat box.</span>
        </H2>
        <p className="mt-6 max-w-[58ch] text-lg leading-relaxed text-ink-soft">
          A chatbot talks about your work. You still do the copying, pasting and fixing. zWork opens the files, runs the
          steps and hands back the finished thing.
        </p>
      </Reveal>

      <Reveal delay={0.1} className="mt-14">
        <div role="tablist" aria-label="Example tasks" className="flex flex-wrap gap-2">
          {TASKS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === active}
              onClick={() => setActive(t.id)}
              className={`h-10 rounded-full border px-5 text-sm font-medium transition-colors ${
                t.id === active ? "border-ink bg-ink text-paper" : "border-line-strong text-ink-soft hover:border-ink hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={task.id}
            role="tabpanel"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="mt-8"
          >
            <p className="font-mono text-sm text-ink-muted">"{task.ask}"</p>
            <div className="mt-6 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-2">
              <Column title="In a chat window" steps={task.chat} />
              <Run steps={task.zwork} />
            </div>
          </motion.div>
        </AnimatePresence>
      </Reveal>
    </Section>
  );
}

function Column({ title, steps }: { title: string; steps: string[] }) {
  return (
    <div className="bg-paper-sunken p-7 sm:p-9">
      <h3 className="text-sm font-semibold text-ink-muted">{title}</h3>
      <ol className="mt-6 space-y-4">
        {steps.map((s, i) => (
          <li key={s} className="grid grid-cols-[2rem_1fr] items-baseline">
            <span className="font-mono text-xs text-ink-muted">0{i + 1}</span>
            <span className="text-ink-muted">{s}</span>
          </li>
        ))}
      </ol>
      <p className="mt-8 text-sm text-ink-muted">You do every step.</p>
    </div>
  );
}

/** zWork's side ticks through its steps once it scrolls into view, the way the
 *  app's plan checklist does. */
function Run({ steps }: { steps: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-120px" });
  const reduce = useReducedMotion();
  const [ticked, setTicked] = useState(0);

  useEffect(() => {
    if (reduce || !inView) return;
    const timers = steps.map((_, i) => setTimeout(() => setTicked(i + 1), 650 * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, [inView, reduce, steps]);

  const done = reduce ? steps.length : ticked;

  const finished = done >= steps.length;
  return (
    <div ref={ref} className="bg-paper-raised p-7 sm:p-9">
      <h3 className="text-sm font-semibold text-ink">In zWork</h3>
      <ol className="mt-6 space-y-4">
        {steps.map((s, i) => {
          const state = i < done ? "done" : i === done ? "running" : "todo";
          return (
            <li key={s} className="grid grid-cols-[2rem_1fr] items-start">
              <span className="pt-0.5">
                {state === "done" ? (
                  <CheckCircle weight="fill" className="size-[18px] text-ok" />
                ) : state === "running" && inView ? (
                  <CircleNotch weight="bold" className="size-[18px] animate-spin text-ink-muted" />
                ) : (
                  <span className="ml-[3px] block size-3 rounded-full border border-line-strong" />
                )}
              </span>
              <span className={`transition-colors duration-300 ${state === "done" ? "text-ink" : "text-ink-muted"}`}>{s}</span>
            </li>
          );
        })}
      </ol>
      <p className={`mt-8 text-sm font-medium transition-opacity duration-500 ${finished ? "text-ok opacity-100" : "opacity-0"}`}>
        Done. You review the result.
      </p>
    </div>
  );
}
