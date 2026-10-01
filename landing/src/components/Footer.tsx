import { useState } from "react";
import { Check, Copy, DownloadSimple, GithubLogo } from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { Reveal, Section, TryButton } from "./ui";
import {
  ASSET_LABEL, CONTRIBUTING_URL, DEMO_URL, DISCUSSIONS_URL, DOCS_URL, INSTALL, ISSUES_URL, PLATFORMS, PRIVACY_URL,
  RELEASES_URL, REPO_URL, TERMS_URL, detectPlatform, downloadUrl, useRepoStats, type Platform,
} from "../lib/site";

export function Install() {
  const [platform, setPlatform] = useState<Platform>(() => detectPlatform() ?? "Mac");
  const [copied, setCopied] = useState(false);
  const { version } = useRepoStats();
  const install = INSTALL[platform];

  const copy = () => {
    navigator.clipboard?.writeText(install.command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };

  return (
    <Section id="download" className="pb-28 pt-8 sm:pb-36">
      <Reveal className="rounded-2xl border border-line bg-paper-sunken px-6 py-14 sm:px-12 sm:py-20">
        <div className="grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-16">
          <div>
            <h2 className="max-w-[16ch] text-[clamp(2.3rem,5.4vw,4.2rem)] font-semibold leading-[1] tracking-[-0.045em] text-balance">
              Give it the task you've been <span className="accent">putting off.</span>
            </h2>
            <p className="mt-6 max-w-[42ch] text-lg leading-relaxed text-ink-soft">
              Takes a minute to set up. Or try the real app in your browser first, no account needed.
            </p>
            <div className="mt-8">
              <TryButton />
            </div>
          </div>

          <div>
            <div role="tablist" aria-label="Platform" className="inline-flex rounded-full border border-line bg-paper p-1">
              {PLATFORMS.map((p) => (
                <button
                  key={p}
                  role="tab"
                  aria-selected={p === platform}
                  onClick={() => setPlatform(p)}
                  className={`h-9 rounded-full px-4 text-sm transition-colors ${p === platform ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
                >
                  {p}
                </button>
              ))}
            </div>

            <a
              href={downloadUrl(platform)}
              className="mt-5 flex items-center justify-between gap-4 rounded-2xl bg-ink px-5 py-4 text-paper transition-transform active:scale-[0.99]"
            >
              <span>
                <span className="block font-medium">Download for {platform}</span>
                <span className="block text-sm opacity-70">
                  {version ? `v${version} · ` : ""}
                  {ASSET_LABEL[platform]}
                </span>
              </span>
              <DownloadSimple weight="bold" className="size-5 shrink-0" />
            </a>

            <p className="mb-2 mt-6 text-sm text-ink-muted">Or install from {install.shell}</p>
            <div className="flex items-center gap-2 rounded-xl border border-line bg-paper py-2 pl-4 pr-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] [scrollbar-width:none]">
                {install.command}
              </code>
              <button
                onClick={copy}
                aria-label={copied ? "Copied" : "Copy install command"}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-paper-raised hover:text-ink"
              >
                {copied ? <Check weight="bold" className="size-4 text-ok" /> : <Copy className="size-4" />}
              </button>
            </div>
            <p className="mt-4 text-sm text-ink-muted">
              Updates install themselves.{" "}
              <a href={RELEASES_URL} className="underline decoration-line-strong underline-offset-4 hover:text-ink">
                All releases
              </a>
            </p>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

const COLUMNS: [string, [string, string][]][] = [
  [
    "Product",
    [
      ["Download", "#download"],
      ["Try in browser", DEMO_URL],
      ["Pricing", "#pricing"],
      ["Release notes", RELEASES_URL],
    ],
  ],
  [
    "Community",
    [
      ["GitHub", REPO_URL],
      ["Discussions", DISCUSSIONS_URL],
      ["Report a bug", ISSUES_URL],
      ["Contributing", CONTRIBUTING_URL],
    ],
  ],
  [
    "More",
    [
      ["Docs", DOCS_URL],
      ["Privacy", PRIVACY_URL],
      ["Terms", TERMS_URL],
    ],
  ],
];

const YEAR = new Date().getFullYear();

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid w-full max-w-[1200px] gap-12 px-4 py-14 sm:px-8 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <a href="#top" className="flex items-center gap-2.5 font-semibold tracking-tight">
            <Logo className="size-6" />
            zWork
          </a>
          <p className="mt-4 max-w-[30ch] text-sm leading-relaxed text-ink-muted">
            The AI coworker that does the work. Open source, MIT licensed.
          </p>
          <a href={REPO_URL} aria-label="zWork on GitHub" className="mt-5 inline-flex text-ink-muted hover:text-ink">
            <GithubLogo className="size-5" />
          </a>
        </div>
        {COLUMNS.map(([title, links]) => (
          <nav key={title} aria-label={title}>
            <p className="text-sm font-medium">{title}</p>
            <ul className="mt-4 grid gap-2.5 text-sm text-ink-muted">
              {links.map(([label, href]) => (
                <li key={label}>
                  <a href={href} className="hover:text-ink">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="mx-auto w-full max-w-[1200px] border-t border-line px-4 py-6 text-xs text-ink-muted sm:px-8">
        © {YEAR} zWork
      </div>
    </footer>
  );
}
