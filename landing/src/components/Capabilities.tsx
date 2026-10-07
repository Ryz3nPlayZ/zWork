import type { Icon } from "@phosphor-icons/react";
import { AppWindow as AppIcon, Brain, Browser, Files, PlugsConnected, StackSimple, TerminalWindow } from "@phosphor-icons/react";
import { H2, Reveal, Section } from "./ui";

type Tile = { icon: Icon; title: string; body: string; wide?: "sm" | "lg"; tag?: string; extra?: "files" | "command" };

const TILES: Tile[] = [
  {
    icon: Files,
    title: "Real files, not chat replies",
    body: "Reads spreadsheets, PDFs and scanned pages. Writes Excel, Word, PowerPoint and PDF files you can open anywhere.",
    wide: "sm",
    extra: "files",
  },
  {
    icon: Browser,
    title: "Uses the web",
    body: "Searches, reads current pages, clicks through sites and fills in forms in a real browser.",
  },
  {
    icon: AppIcon,
    title: "Uses your apps",
    body: "Operates desktop apps that have no API, reading the screen the way you would.",
    tag: "Mac",
  },
  {
    icon: Brain,
    title: "Remembers",
    body: "Your team, your tone, how you like reports laid out. Tell it once.",
  },
  {
    icon: PlugsConnected,
    title: "Works inside your tools",
    body: "Reads and acts in Gmail, Calendar, Slack, Notion, Sheets and hundreds more, each connected in one click.",
  },
  {
    icon: StackSimple,
    title: "Several jobs at once",
    body: "Splits big jobs across helper agents, and runs separate tasks side by side.",
  },
  {
    icon: TerminalWindow,
    title: "Save what worked",
    body: "Turn a task that went well into a skill and run it again with one slash command.",
    wide: "lg",
    extra: "command",
  },
];

const EXT = [".xlsx", ".docx", ".pptx", ".pdf", ".csv", ".md"];

export function Capabilities() {
  return (
    <Section className="pb-28 sm:pb-40">
      <Reveal>
        <H2 className="max-w-[18ch]">Everything you'd use to do it yourself.</H2>
      </Reveal>
      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((t, i) => (
          <Reveal key={t.title} delay={0.05 * (i % 3)} className={t.wide === "sm" ? "sm:col-span-2" : t.wide === "lg" ? "lg:col-span-2" : ""}>
            <article className="flex h-full flex-col rounded-2xl border border-line bg-paper-sunken p-7 transition-colors hover:border-line-strong">
              <div className="flex items-center justify-between">
                <t.icon className="size-6" />
                {t.tag && (
                  <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-muted">{t.tag}</span>
                )}
              </div>
              <h3 className="mt-6 text-lg font-semibold tracking-tight">{t.title}</h3>
              <p className="mt-2 max-w-[48ch] leading-relaxed text-ink-soft">{t.body}</p>
              {t.extra === "files" && (
                <ul className="mt-6 flex flex-wrap gap-2" aria-label="File types">
                  {EXT.map((e) => (
                    <li key={e} className="rounded-lg border border-line bg-paper px-2.5 py-1 font-mono text-xs text-ink-soft">
                      {e}
                    </li>
                  ))}
                </ul>
              )}
              {t.extra === "command" && (
                <div className="mt-6 flex items-center gap-2 rounded-xl border border-line bg-paper px-4 py-3 font-mono text-sm" aria-hidden="true">
                  <span className="text-ink">/weekly-update</span>
                  <span className="text-ink-muted">for the design team, same as last week</span>
                </div>
              )}
            </article>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
