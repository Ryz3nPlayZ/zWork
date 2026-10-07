import { Reveal, Section, Shot } from "./ui";

/* Numbers from one real run of the demo task in the hero screenshot. */
const STATS = [
  ["87", "rows of a messy bank export, cleaned"],
  ["1", "double charge caught before it hit the totals"],
  ["3", "date formats turned into one"],
  ["2 min", "from brief to a report you can forward"],
];

export function Proof() {
  return (
    <Section className="py-28 sm:py-36">
      <Reveal>
        <h2 className="max-w-[20ch] text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">
          One brief. A finished report and a clean spreadsheet.
        </h2>
      </Reveal>

      <div className="mt-16 grid gap-4 lg:grid-cols-12">
        <Reveal className="lg:col-span-7 lg:row-span-2">
          <figure className="h-full rounded-2xl border border-line bg-paper-sunken p-3 sm:p-4">
            <Shot name="report" alt="The Q3 2026 spending report zWork wrote: total spend, a table of every category with its share, and monthly totals." />
            <figcaption className="px-2 pb-1 pt-4 text-sm text-ink-muted">
              The report, written as a document you can edit, export to Word or PDF, or send.
            </figcaption>
          </figure>
        </Reveal>

        <Reveal delay={0.08} className="lg:col-span-5">
          <figure className="rounded-2xl border border-line bg-paper-sunken p-3 sm:p-4">
            <Shot name="steps" alt="The list of steps zWork took: reading the file, running Python to clean it, building the Excel file and writing the report." />
            <figcaption className="px-2 pb-1 pt-4 text-sm text-ink-muted">
              Every step it took, open to inspect.
            </figcaption>
          </figure>
        </Reveal>

        <Reveal delay={0.14} className="lg:col-span-5">
          <dl className="grid h-full grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line">
            {STATS.map(([n, label]) => (
              <div key={label} className="flex flex-col justify-between gap-6 bg-paper-sunken p-5 sm:p-6">
                <dt className="text-4xl font-semibold tracking-[-0.04em] tabular-nums">{n}</dt>
                <dd className="text-sm leading-snug text-ink-soft">{label}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </Section>
  );
}
