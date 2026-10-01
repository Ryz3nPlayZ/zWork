import { motion } from "motion/react";
import { ArrowRight, CheckCircle, FileText, GithubLogo, MicrosoftExcelLogo, Star } from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { AppWindow, DownloadButton, Shot, TryButton } from "./ui";
import { RELEASES_URL, REPO_URL, useRepoStats } from "../lib/site";

const LINKS = [
  ["How it works", "#how"],
  ["Schedules", "#schedules"],
  ["Pricing", "#pricing"],
  ["FAQ", "#faq"],
];

export function Nav() {
  const { stars } = useRepoStats();
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-paper/85 backdrop-blur-md">
      <nav className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between px-4 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Logo className="size-6" />
          zWork
        </a>
        <div className="flex items-center gap-1 sm:gap-2">
          {LINKS.map(([label, href]) => (
            <a key={href} href={href} className="hidden rounded-full px-3 py-1.5 text-sm text-ink-soft hover:text-ink lg:block">
              {label}
            </a>
          ))}
          <a
            href={REPO_URL}
            aria-label={stars === null ? "zWork on GitHub" : `zWork on GitHub, ${stars} stars`}
            className="mr-1 hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-ink-soft hover:text-ink sm:flex"
          >
            <GithubLogo className="size-5" />
            {stars !== null && (
              <span className="flex items-center gap-1 tabular-nums">
                <Star weight="fill" className="size-3" />
                {stars}
              </span>
            )}
          </a>
          <DownloadButton size="sm" />
        </div>
      </nav>
    </header>
  );
}

const rise = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number) => ({ opacity: 1, y: 0, transition: { duration: 0.8, delay: 0.08 * i, ease: [0.16, 1, 0.3, 1] as const } }),
};

/* The same run as the screenshot: the Q3 bank export. */
const PLAN = ["Read bank_export_q3.csv", "Normalize vendors and dates", "Flag the duplicate charge", "Write the spending report"];

export function Hero() {
  const { version } = useRepoStats();
  return (
    <section id="top" className="relative overflow-hidden pt-14 sm:pt-20">
      <div className="dot-grid pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />

      <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center px-4 text-center sm:px-8">
        <motion.a
          variants={rise}
          initial="hidden"
          animate="show"
          custom={0}
          href={version ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL}
          className="group mb-8 inline-flex items-center gap-2 rounded-full border border-line bg-paper-sunken py-1 pl-1 pr-3 text-[13px] text-ink-soft hover:border-line-strong hover:text-ink"
        >
          <span className="rounded-full bg-ink px-2 py-0.5 font-mono text-[11px] font-medium text-paper">
            {version ? `v${version}` : "New"}
          </span>
          Open source, free to start
          <ArrowRight weight="bold" className="size-3 transition-transform group-hover:translate-x-0.5" />
        </motion.a>

        <motion.h1
          variants={rise}
          initial="hidden"
          animate="show"
          custom={1}
          className="max-w-[14ch] text-[clamp(2.7rem,7.4vw,5.8rem)] font-semibold leading-[0.97] tracking-[-0.045em] text-balance"
        >
          The AI coworker that <span className="accent">does</span> the work.
        </motion.h1>

        <motion.p
          variants={rise}
          initial="hidden"
          animate="show"
          custom={2}
          className="mt-7 max-w-[54ch] text-lg leading-relaxed text-ink-soft sm:text-xl"
        >
          Hand it the files and say what done looks like. zWork works through the steps on your computer and gives
          back the finished spreadsheet, report or email. Every week, if you want.
        </motion.p>

        <motion.div
          variants={rise}
          initial="hidden"
          animate="show"
          custom={3}
          className="mt-9 flex flex-wrap items-center justify-center gap-3"
        >
          <DownloadButton />
          <TryButton />
        </motion.div>
        <motion.p variants={rise} initial="hidden" animate="show" custom={4} className="mt-5 text-sm text-ink-muted">
          Mac, Windows and Linux. No account needed to try it.
        </motion.p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 48 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="relative mx-auto mt-16 w-full max-w-[1240px] px-4 sm:mt-20 sm:px-8"
      >
        <AppWindow title="zWork">
          <Shot
            name="hero"
            eager
            className="rounded-none border-0 shadow-none"
            alt="zWork after cleaning an 87 row bank export: the chat summarizes what it did and the finished Q3 spending report is open beside it."
          />
        </AppWindow>

        <FloatCard className="-left-2 top-[18%] xl:-left-10" delay={0.9}>
          <p className="mb-3 text-xs font-medium text-ink-muted">Plan · 4 of 4 done</p>
          <ul className="grid gap-2 text-[13px]">
            {PLAN.map((step) => (
              <li key={step} className="flex items-center gap-2">
                <CheckCircle weight="fill" className="size-4 shrink-0 text-ok" />
                {step}
              </li>
            ))}
          </ul>
        </FloatCard>

        <FloatCard className="-right-2 bottom-[16%] xl:-right-10" delay={1.1}>
          <p className="mb-3 text-xs font-medium text-ink-muted">Saved to outputs/</p>
          <ul className="grid gap-2.5 text-[13px]">
            <li className="flex items-center gap-2.5">
              <MicrosoftExcelLogo weight="duotone" className="size-5 shrink-0" />
              <span>
                q3_expenses_cleaned.xlsx
                <span className="block text-xs text-ink-muted">3 sheets, 86 rows</span>
              </span>
            </li>
            <li className="flex items-center gap-2.5">
              <FileText weight="duotone" className="size-5 shrink-0" />
              <span>
                q3_spending_report.md
                <span className="block text-xs text-ink-muted">Ready to forward</span>
              </span>
            </li>
          </ul>
        </FloatCard>
      </motion.div>
    </section>
  );
}

function FloatCard({ children, className, delay }: { children: React.ReactNode; className: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
      className={`absolute hidden w-[248px] rounded-2xl border border-line-strong bg-paper-sunken/95 p-4 text-left shadow-[0_24px_60px_-24px_rgb(var(--ink)/0.4)] backdrop-blur lg:block ${className}`}
      aria-hidden="true"
    >
      {children}
    </motion.div>
  );
}
