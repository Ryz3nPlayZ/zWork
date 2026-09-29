import { useMemo, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { detectPlatform, downloadUrl } from "../lib/site";
import { Reveal, Section } from "./ui";

type Tier = { name: string; monthly: number; annualPerMonth: number; blurb: string; features: string[]; featured?: boolean };

/* Mirrors app/src/components/PlanPage.tsx. Keep the two in step. */
const TIERS: Tier[] = [
  {
    name: "Free",
    monthly: 0,
    annualPerMonth: 0,
    blurb: "Bring your own model key or Claude login.",
    features: ["Every tool, skill and connector", "Up to 3 scheduled tasks", "One task at a time"],
  },
  {
    name: "Pro",
    monthly: 12,
    annualPerMonth: 10,
    blurb: "Models included. No keys, no setup.",
    features: ["200 requests every 5 hours", "1,000 requests a week", "Up to 5 tasks in parallel", "Unlimited scheduled tasks", "Priority support"],
    featured: true,
  },
  {
    name: "Max",
    monthly: 50,
    annualPerMonth: 41.67,
    blurb: "For the people who hand it everything.",
    features: ["1,000 requests every 5 hours", "5,000 requests a week", "Up to 10 tasks in parallel", "Priority processing", "Dedicated support"],
  },
];

export function Pricing() {
  const href = useMemo(() => downloadUrl(detectPlatform()), []);
  const [annual, setAnnual] = useState(true);
  return (
    <Section id="pricing" className="scroll-mt-20 py-28 sm:py-36">
      <Reveal className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
        <h2 className="max-w-[14ch] text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">
          Cheaper than the hour it saves.
        </h2>
        <div role="radiogroup" aria-label="Billing period" className="inline-flex self-start rounded-full border border-line bg-paper-sunken p-1 md:self-auto">
          {[
            [false, "Monthly"],
            [true, "Yearly, 2 months free"],
          ].map(([value, label]) => (
            <button
              key={String(value)}
              role="radio"
              aria-checked={annual === value}
              onClick={() => setAnnual(value as boolean)}
              className={`h-9 rounded-full px-4 text-sm transition-colors ${annual === value ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
            >
              {label as string}
            </button>
          ))}
        </div>
      </Reveal>

      <div className="mt-14 grid gap-4 lg:grid-cols-[1fr_1.15fr_1fr]">
        {TIERS.map((t, i) => {
          const price = annual ? t.annualPerMonth : t.monthly;
          return (
            <Reveal key={t.name} delay={0.06 * i}>
              <article
                className={`flex h-full flex-col rounded-2xl border p-7 sm:p-8 ${
                  t.featured ? "border-ink bg-ink text-paper" : "border-line bg-paper-sunken"
                }`}
              >
                <h3 className="text-lg font-semibold">{t.name}</h3>
                <p className={`mt-1 text-sm ${t.featured ? "opacity-75" : "text-ink-muted"}`}>{t.blurb}</p>
                <p className="mt-8 flex items-baseline gap-1.5">
                  <span className="text-5xl font-semibold tracking-[-0.04em] tabular-nums">
                    ${price % 1 ? price.toFixed(2) : price}
                  </span>
                  <span className={`text-sm ${t.featured ? "opacity-75" : "text-ink-muted"}`}>
                    {price ? (annual ? "a month, billed yearly" : "a month") : "forever"}
                  </span>
                </p>
                <ul className="mt-8 grid gap-3 text-[15px]">
                  {t.features.map((f) => (
                    <li key={f} className="flex gap-3">
                      <Check weight="bold" className="mt-1 size-4 shrink-0 opacity-70" />
                      {f}
                    </li>
                  ))}
                </ul>
                <a
                  href={href}
                  className={`mt-10 inline-flex h-11 items-center justify-center rounded-full text-[15px] font-medium transition-transform active:scale-[0.98] ${
                    t.featured ? "bg-paper text-ink" : "border border-line-strong text-ink hover:bg-paper-raised"
                  }`}
                >
                  {t.monthly ? `Start with ${t.name}` : "Download free"}
                </a>
              </article>
            </Reveal>
          );
        })}
      </div>
      <p className="mt-6 text-sm text-ink-muted">Upgrade from inside the app whenever you like. Cancel any time.</p>
    </Section>
  );
}
