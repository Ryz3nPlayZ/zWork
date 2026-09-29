import { motion } from "motion/react";
import { GithubLogo } from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { DownloadButton, Shot } from "./ui";
import { REPO_URL } from "../lib/site";

export function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-paper/85 backdrop-blur-md">
      <nav className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between px-4 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Logo className="size-6" />
          zWork
        </a>
        <div className="flex items-center gap-1 sm:gap-6">
          <a href="#how" className="hidden text-sm text-ink-soft hover:text-ink md:block">How it works</a>
          <a href="#pricing" className="hidden text-sm text-ink-soft hover:text-ink md:block">Pricing</a>
          <a href={REPO_URL} aria-label="zWork on GitHub" className="hidden p-2 text-ink-soft hover:text-ink sm:block">
            <GithubLogo className="size-5" />
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

export function Hero() {
  return (
    <section id="top" className="relative flex min-h-[100dvh] flex-col overflow-hidden pt-14 sm:pt-20">
      <div className="mx-auto grid w-full max-w-[1200px] gap-8 px-4 sm:px-8 lg:grid-cols-[1.35fr_1fr] lg:items-end lg:gap-16">
        <motion.h1
          variants={rise}
          initial="hidden"
          animate="show"
          custom={0}
          className="text-[clamp(2.6rem,7vw,5.4rem)] font-semibold leading-[0.98] tracking-[-0.045em] text-balance"
        >
          The AI coworker that <em className="font-semibold italic">does</em> the work.
        </motion.h1>
        <motion.div variants={rise} initial="hidden" animate="show" custom={1} className="lg:pb-2">
          <p className="max-w-[40ch] text-lg leading-relaxed text-ink-soft">
            Developers got AI agents that ship real work. zWork brings that to your spreadsheets, reports and inbox.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            <DownloadButton />
            <span className="text-sm text-ink-muted">Free to start. Mac, Windows, Linux.</span>
          </div>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 48 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="mx-auto mt-14 w-full max-w-[1320px] px-4 sm:mt-20 sm:px-8"
      >
        <Shot
          name="hero"
          eager
          alt="zWork after cleaning an 87 row bank export: the chat summarizes what it did and the finished Q3 spending report is open beside it."
        />
      </motion.div>
    </section>
  );
}
