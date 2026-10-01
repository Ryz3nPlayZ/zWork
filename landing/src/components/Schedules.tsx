import { CalendarBlank, Check, Clock, Tray } from "@phosphor-icons/react";
import { Eyebrow, H2, Reveal, Section } from "./ui";

/* Illustrative schedules, drawn in the app's own layout (Scheduled page). The
   cadences are the two the app offers: every N minutes, or a time on chosen weekdays. */
const SCHEDULES = [
  { name: "Lead research", when: "Mondays at 9:00", last: "Added 30 companies to Leads", on: true },
  { name: "Invoice check", when: "Weekdays at 8:30", last: "2 due this week, 1 over $1,000", on: true },
  { name: "Weekly update", when: "Fridays at 16:00", last: "Draft left in Gmail", on: true },
  { name: "Competitor prices", when: "Every 4 hours", last: "No change since 10:00", on: false },
];

const POINTS = [
  [Clock, "Every few minutes, or at a set time on the days you pick"],
  [Tray, "Results land in your inbox, or on Telegram"],
  [CalendarBlank, "Missed a run while the laptop slept? It runs when zWork is back"],
] as const;

export function Schedules() {
  return (
    <Section id="schedules" className="py-28 sm:py-40">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-20">
        <Reveal>
          <Eyebrow>Schedules</Eyebrow>
          <H2 className="max-w-[15ch]">
            Set it once. It runs <span className="accent">every Monday.</span>
          </H2>
          <p className="mt-6 max-w-[46ch] text-lg leading-relaxed text-ink-soft">
            Any task you can brief, zWork can repeat. It runs on your computer, on time, with the same tools and
            connected apps, and leaves the result where you'll see it.
          </p>
          <ul className="mt-8 grid gap-4">
            {POINTS.map(([Icon, text]) => (
              <li key={text} className="flex items-start gap-3 text-ink-soft">
                <Icon className="mt-0.5 size-5 shrink-0 text-ink" />
                {text}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={0.1} className="relative">
          <div className="rounded-2xl border border-line-strong bg-paper-raised p-2 shadow-[0_32px_80px_-36px_rgb(var(--ink)/0.4)]">
            <div className="flex items-center justify-between px-3 pb-3 pt-2">
              <span className="text-sm font-semibold">Scheduled</span>
              <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted">3 active</span>
            </div>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper-sunken">
              {SCHEDULES.map((s) => (
                <li key={s.name} className="flex items-center gap-4 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className={`text-[15px] font-medium ${s.on ? "" : "text-ink-muted"}`}>{s.name}</p>
                    <p className="mt-0.5 truncate text-[13px] text-ink-muted">
                      {s.when} · <span className="text-ink-soft">{s.last}</span>
                    </p>
                  </div>
                  <span
                    aria-hidden="true"
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${s.on ? "bg-ink" : "bg-line-strong"}`}
                  >
                    <span className={`absolute top-0.5 size-4 rounded-full bg-paper transition-all ${s.on ? "left-[18px]" : "left-0.5"}`} />
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="relative z-10 -mt-6 ml-auto w-[min(100%,340px)] rounded-2xl border border-line-strong bg-paper-sunken p-4 shadow-[0_24px_60px_-24px_rgb(var(--ink)/0.45)] sm:-mr-6">
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <span className="pulse-dot size-1.5 rounded-full bg-ok" />
              Inbox · Invoice check · 8:31
            </div>
            <p className="mt-2.5 text-[14px] leading-relaxed">
              Two invoices are due this week. Northwind ($1,240, due Thursday) is over your $1,000 flag.
            </p>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-muted">
              <Check weight="bold" className="size-3.5 text-ok" />
              Payables sheet updated
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
