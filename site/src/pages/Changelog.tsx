import { Fragment, useEffect, useState, type ReactNode } from "react";
import { RELEASES, type ChangeSection } from "../lib/changelog";
import { REPO, REPO_URL } from "../lib/site";
import { Section } from "../sections/ui";
import { PageHeader } from "./PageHeader";

/** `**bold**`, `` `code` `` and `[text](url)`, the inline markdown the changelog uses. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const k = m.index;
    if (m[1] !== undefined) out.push(<strong key={k} className="font-semibold text-ink">{inline(m[1])}</strong>);
    else if (m[2] !== undefined)
      out.push(
        <code key={k} className="rounded bg-paper-raised px-1 py-px font-mono text-[0.88em] text-ink-soft">
          {m[2]}
        </code>,
      );
    else
      out.push(
        <a key={k} href={m[4]} className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
          {m[3]}
        </a>,
      );
    at = re.lastIndex;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Release dates from GitHub; the page reads fine without them. */
function useReleaseDates(): Record<string, string> {
  const [dates, setDates] = useState<Record<string, string>>({});
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { tag_name?: string; published_at?: string }[]) => {
        const fmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });
        const next: Record<string, string> = {};
        for (const r of list) {
          if (r.tag_name && r.published_at) next[r.tag_name.replace(/^v/, "")] = fmt.format(new Date(r.published_at));
        }
        setDates(next);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  return dates;
}

function Changes({ section }: { section: ChangeSection }) {
  return (
    <div>
      <h3 className="text-[14px] font-semibold text-ink">
        {section.title}
        <span className="ml-2 font-normal tabular-nums text-ink-faint">{section.items.length}</span>
      </h3>
      <ul className="mt-4 flex flex-col gap-4 border-l border-line pl-5">
        {section.items.map((item, i) => (
          <li key={i} className="max-w-[68ch] text-[15px] leading-relaxed text-ink-muted">
            {item.split("\n").map((para, j) => (
              <Fragment key={j}>
                {j > 0 && <span className="mt-2 block" />}
                {inline(para)}
              </Fragment>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChangelogPage() {
  const dates = useReleaseDates();
  return (
    <>
      <PageHeader eyebrow="Changelog" title={<>What's new <em className="text-ink-soft">in zWork.</em></>}>
        Every update, in plain words. The desktop app updates itself and asks before it restarts.
      </PageHeader>
      <Section className="pb-28 sm:pb-40">
        <div>
          <div className="flex flex-col">
            {RELEASES.map((r, i) => (
              <article
                key={r.version}
                id={`v${r.version}`}
                className="grid gap-6 border-t border-line py-12 sm:py-16 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-12"
              >
                <header>
                  <h2 className="display text-[56px] leading-none text-ink sm:text-[72px]">
                    <a href={`#v${r.version}`} className="hover:text-ink-soft">
                      {r.version}
                    </a>
                  </h2>
                  <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-faint">
                    {i === 0 && <span className="rounded-full bg-ink px-2 py-0.5 text-[11.5px] font-medium text-paper">Latest</span>}
                    {dates[r.version] ?? ""}
                  </p>
                </header>
                <div className="flex flex-col gap-10">
                  {r.intro.length > 0 && (
                    <div className="max-w-[60ch] text-[18px] leading-relaxed text-ink">
                      {r.intro.map((p, j) => (
                        <p key={j} className={j ? "mt-3" : undefined}>
                          {inline(p)}
                        </p>
                      ))}
                    </div>
                  )}
                  {r.sections.map((s) => (
                    <Changes key={s.title} section={s} />
                  ))}
                </div>
              </article>
            ))}
          </div>
          <p className="border-t border-line pt-8 text-[14px] text-ink-muted">
            Earlier versions are in the{" "}
            <a
              href={`${REPO_URL}/blob/main/CHANGELOG.md`}
              className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
            >
              full changelog on GitHub
            </a>
            .
          </p>
        </div>
      </Section>
    </>
  );
}
