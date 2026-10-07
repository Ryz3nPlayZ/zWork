import { HandPalm, HardDrives, LockKeyOpen } from "@phosphor-icons/react";
import { Reveal, Section } from "./ui";

const POINTS = [
  {
    icon: HardDrives,
    title: "Runs on your computer",
    body: "Your files are opened and saved locally. Only the text the model needs for a step goes to the AI provider you picked.",
  },
  {
    icon: HandPalm,
    title: "Asks before it changes things",
    body: "Edits, deletes and sent messages wait for your OK until you decide otherwise. Every step is shown as it happens.",
  },
  {
    icon: LockKeyOpen,
    title: "Open source, MIT licensed",
    body: "Read every line of the agent on GitHub. Bring your own model key and your work never touches our servers.",
  },
];

export function Private() {
  return (
    <Section className="pb-28 sm:pb-40">
      <div className="grid gap-12 rounded-2xl bg-ink px-6 py-14 text-paper sm:px-12 sm:py-20 lg:grid-cols-[1fr_1.4fr] lg:gap-20">
        <Reveal>
          <h2 className="max-w-[14ch] text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">
            Your files stay yours.
          </h2>
        </Reveal>
        <div className="grid gap-10">
          {POINTS.map(({ icon: Icon, title, body }, i) => (
            <Reveal key={title} delay={0.08 * i} className="grid grid-cols-[2.25rem_1fr] gap-4">
              <Icon className="mt-0.5 size-6 opacity-80" />
              <div>
                <h3 className="text-lg font-semibold">{title}</h3>
                <p className="mt-2 max-w-[52ch] leading-relaxed opacity-75">{body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}
