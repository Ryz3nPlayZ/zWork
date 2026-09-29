import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Eyebrow, Reveal, Section } from "./ui";

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
        <h2 className="max-w-[22ch] text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-6xl">
          Developers got agents. Everyone else got a chat box.
        </h2>
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
              <Column title="In a chat window" steps={task.chat} muted />
              <Column title="In zWork" steps={task.zwork} />
            </div>
          </motion.div>
        </AnimatePresence>
      </Reveal>
    </Section>
  );
}

function Column({ title, steps, muted = false }: { title: string; steps: string[]; muted?: boolean }) {
  return (
    <div className={`p-7 sm:p-9 ${muted ? "bg-paper-sunken" : "bg-paper-raised"}`}>
      <h3 className={`text-sm font-semibold ${muted ? "text-ink-muted" : "text-ink"}`}>{title}</h3>
      <ol className="mt-6 space-y-4">
        {steps.map((s, i) => (
          <li key={s} className="grid grid-cols-[2rem_1fr] items-baseline">
            <span className="font-mono text-xs text-ink-muted">0{i + 1}</span>
            <span className={muted ? "text-ink-muted" : "text-ink"}>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
