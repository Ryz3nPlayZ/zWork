import { Plus } from "@phosphor-icons/react";
import { H2, Reveal, Section } from "./ui";
import { ISSUES_URL } from "../lib/site";

const FAQ: [string, string][] = [
  [
    "How is this different from ChatGPT or Claude?",
    "Those answer in a chat window, and you do the work. zWork works on your actual files and apps, carries a multi-step job through to the end, and can repeat it on a schedule.",
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

export function Faq() {
  return (
    <Section id="faq" className="py-28 sm:py-36">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.6fr] lg:gap-20">
        <Reveal>
          <H2 className="max-w-[12ch]">Questions, answered.</H2>
          <p className="mt-6 max-w-[34ch] leading-relaxed text-ink-soft">
            Something missing?{" "}
            <a href={ISSUES_URL} className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
              Ask on GitHub
            </a>
            .
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="divide-y divide-line border-y border-line">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[17px] font-medium [&::-webkit-details-marker]:hidden">
                  {q}
                  <Plus weight="bold" className="size-4 shrink-0 text-ink-muted transition-transform duration-200 group-open:rotate-45" />
                </summary>
                <p className="max-w-[62ch] pb-6 leading-relaxed text-ink-soft">{a}</p>
              </details>
            ))}
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
