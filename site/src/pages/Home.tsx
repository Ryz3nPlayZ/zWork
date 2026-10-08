import { ArrowRight } from "lucide-react";
import { Hero } from "../sections/Hero";
import { Desktop } from "../sections/Desktop";
import { Capabilities, Statement } from "../sections/Story";
import { Outro } from "../sections/Outro";
import { Link } from "../lib/router";
import { Section } from "../sections/ui";

export function Home() {
  return (
    <>
      <Hero />
      <Desktop />
      <Statement />
      <Capabilities />
      <Section>
        <div className="grid gap-3 border-t border-line pt-10 sm:grid-cols-3">
          {[
            ["Schedules, approvals and models", "See everything it does", "/features"],
            ["Free to start, Pro is $12", "Compare plans", "/pricing"],
            ["MIT licensed, on GitHub", "Read the code", "/open-source"],
          ].map(([label, cta, href]) => (
            <Link
              key={href}
              href={href}
              className="press group flex items-center justify-between gap-4 rounded-2xl px-5 py-4 transition-colors hover:bg-paper-raised"
            >
              <span>
                <span className="block text-[13px] text-ink-muted">{label}</span>
                <span className="mt-0.5 block text-[16px] font-medium text-ink">{cta}</span>
              </span>
              <ArrowRight className="h-4 w-4 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
            </Link>
          ))}
        </div>
      </Section>
      <Outro />
    </>
  );
}
