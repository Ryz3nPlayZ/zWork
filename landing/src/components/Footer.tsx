import { GithubLogo } from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { DownloadButton, Reveal, Section } from "./ui";
import { PRIVACY_URL, REPO_URL, TERMS_URL } from "../lib/site";

export function FinalCta() {
  return (
    <Section className="pb-28 pt-8 sm:pb-40">
      <Reveal className="border-t border-line pt-20 sm:pt-28">
        <h2 className="max-w-[18ch] text-[clamp(2.4rem,6vw,4.6rem)] font-semibold leading-[1] tracking-[-0.045em] text-balance">
          Give it the task you've been putting off.
        </h2>
        <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-3">
          <DownloadButton />
          <span className="text-sm text-ink-muted">Takes a minute to set up.</span>
        </div>
      </Reveal>
    </Section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-10 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="flex items-center gap-2.5 text-ink">
          <Logo className="size-5" />
          <span className="font-semibold">zWork</span>
          <span className="text-ink-muted">MIT licensed</span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <a href={PRIVACY_URL} className="hover:text-ink">Privacy</a>
          <a href={TERMS_URL} className="hover:text-ink">Terms</a>
          <a href={REPO_URL} className="inline-flex items-center gap-1.5 hover:text-ink">
            <GithubLogo className="size-4" />
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
