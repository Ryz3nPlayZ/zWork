import { ENTRIES } from "../content";
import { ArrowLeft, ArrowRight } from "../lib/icons";
import { Link } from "../lib/router";

export function ComponentPage({ index }: { index: number }) {
  const e = ENTRIES[index];
  const prev = ENTRIES[(index - 1 + ENTRIES.length) % ENTRIES.length];
  const next = ENTRIES[(index + 1) % ENTRIES.length];
  const { Demo } = e;

  return (
    <>
      <div className="mx-auto max-w-[1200px] px-4 pb-14 pt-10 sm:px-8 sm:pb-20 sm:pt-14">
        <Link href="/" className="inline-flex items-center gap-2 text-[14px] text-ink-muted hover:text-ink">
          <ArrowLeft className="h-4 w-4" />
          All components
        </Link>
        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-16">
          <div>
            <p className="text-[14px] text-ink-faint">
              {e.group} · {index + 1} of {ENTRIES.length}
            </p>
            <h1 className="display mt-3 text-[52px] text-ink sm:text-[76px]">{e.name}</h1>
          </div>
          <dl className="flex flex-col gap-6 self-end">
            <div>
              <dt className="text-[14px] font-semibold text-ink">What it does</dt>
              <dd className="mt-1.5 max-w-[60ch] text-[16px] leading-relaxed text-ink-muted">{e.does}</dd>
            </div>
            <div>
              <dt className="text-[14px] font-semibold text-ink">Where zWork uses it</dt>
              <dd className="mt-1.5 max-w-[60ch] text-[16px] leading-relaxed text-ink-muted">{e.use}</dd>
            </div>
          </dl>
        </div>
      </div>

      <section aria-label={`${e.name} demo`} className={e.fit ? "stage stage-fit border-y border-line" : "stage border-y border-line"}>
        <Demo />
      </section>

      <nav aria-label="More components" className="mx-auto grid max-w-[1200px] grid-cols-2 gap-4 px-4 py-14 sm:px-8 sm:py-20">
        <Link href={`/c/${prev.slug}`} className="row flex flex-col gap-1">
          <span className="inline-flex items-center gap-2 text-[14px] text-ink-faint">
            <ArrowLeft className="h-4 w-4" />
            Previous
          </span>
          <span className="display text-[26px] text-ink sm:text-[34px]">{prev.name}</span>
        </Link>
        <Link href={`/c/${next.slug}`} className="row flex flex-col items-end gap-1 text-right">
          <span className="inline-flex items-center gap-2 text-[14px] text-ink-faint">
            Next
            <ArrowRight className="h-4 w-4" />
          </span>
          <span className="display text-[26px] text-ink sm:text-[34px]">{next.name}</span>
        </Link>
      </nav>
    </>
  );
}
