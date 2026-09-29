import { Reveal, Section } from "./ui";

const STEPS = [
  {
    title: "Hand it the files",
    body: "Drop in a spreadsheet, a folder of PDFs or a messy export. Or connect Gmail, Drive and Notion once and let it find things itself.",
  },
  {
    title: "Say what done looks like",
    body: "Write it the way you'd brief a colleague. zWork makes a plan, shows it as a checklist and works through it step by step.",
  },
  {
    title: "Get the finished thing",
    body: "Real files, saved where you want them: Excel, Word, PowerPoint, PDF. Ask before changes stays on until you trust it.",
  },
];

export function How() {
  return (
    <Section id="how" className="scroll-mt-20 py-28 sm:py-36">
      <Reveal>
        <h2 className="max-w-[18ch] text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">
          Brief it like a person. Get work back like one.
        </h2>
      </Reveal>
      <ol className="mt-16 grid gap-12 md:grid-cols-3 md:gap-10">
        {STEPS.map((s, i) => (
          <Reveal key={s.title} delay={0.08 * i}>
            <li className="border-t border-ink pt-6">
              <span className="font-mono text-sm text-ink-muted">0{i + 1}</span>
              <h3 className="mt-4 text-xl font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-3 leading-relaxed text-ink-soft">{s.body}</p>
            </li>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}
