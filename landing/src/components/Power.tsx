import { Eyebrow, Reveal, Section } from "./ui";

const COMPAT = [
  ["MCP servers", "Claude, Cursor, VS Code, Windsurf, Gemini, opencode and Codex configs, imported in one click"],
  ["Agent Skills", "Every skill folder from Claude Code, Codex, opencode and pi, and each skill is a /command"],
  ["Slash commands", "Your .claude, .opencode, .pi and Codex prompt files, arguments included"],
  ["AGENTS.md", "Global and per-folder AGENTS.md and CLAUDE.md, read the same way the other agents read them"],
  ["Any model", "200+ providers: Anthropic, OpenAI, Google, DeepSeek, OpenRouter, local models, or your Claude login"],
  ["Batteries", "Python and Node installed for you, so skills and connectors run on a brand new laptop"],
];

export function Power() {
  return (
    <Section className="py-28 sm:py-40">
      <div className="grid gap-14 lg:grid-cols-[1fr_1.25fr] lg:gap-20">
        <Reveal>
          <Eyebrow>For the technical friend</Eyebrow>
          <h2 className="max-w-[16ch] text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">
            The same engine as the coding agents.
          </h2>
          <p className="mt-6 max-w-[44ch] text-lg leading-relaxed text-ink-soft">
            zWork runs a Rust port of the pi agent harness: the loop, the tools, the context handling. Whatever you
            already set up for Claude Code or opencode works here unchanged.
          </p>
        </Reveal>
        <Reveal delay={0.1}>
          <dl className="divide-y divide-line border-y border-line">
            {COMPAT.map(([term, desc]) => (
              <div key={term} className="grid gap-1 py-5 sm:grid-cols-[9.5rem_1fr] sm:gap-6">
                <dt className="font-mono text-sm text-ink">{term}</dt>
                <dd className="text-ink-soft">{desc}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </Section>
  );
}
