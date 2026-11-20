import { ArrowRight } from "../lib/icons";
import { ENTRIES, GROUPS } from "../content";
import { Link } from "../lib/router";

export function Home() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 pb-28 pt-16 sm:px-8 sm:pt-24">
      <h1 className="display max-w-[16ch] text-[48px] text-ink sm:text-[80px]">Twenty components, each with a job at zWork.</h1>
      <p className="mt-6 max-w-[58ch] text-[17px] leading-relaxed text-ink-muted">
        Annnimate's starter pack, rebuilt in zWork's paper and ink. Every page shows one component doing something it would really do on our
        site or in the app, with the reason it fits.
      </p>

      <div className="mt-20 flex flex-col gap-16">
        {GROUPS.map((g) => {
          const items = ENTRIES.filter((e) => e.group === g);
          return (
            <section key={g} aria-labelledby={`g-${g}`} className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-12">
              <h2 id={`g-${g}`} className="text-[14px] font-semibold text-ink">
                {g}
                <span className="ml-2 font-normal tabular-nums text-ink-faint">{items.length}</span>
              </h2>
              <ul className="border-t border-line">
                {items.map((e) => (
                  <li key={e.slug} className="border-b border-line">
                    <Link
                      href={`/c/${e.slug}`}
                      className="row grid grid-cols-[minmax(0,1fr)_20px] items-baseline gap-x-6 gap-y-1 py-5 sm:grid-cols-[260px_minmax(0,1fr)_20px]"
                    >
                      <span className="display text-[28px] text-ink">{e.name}</span>
                      <span className="col-span-1 row-start-2 text-[15px] leading-relaxed text-ink-muted sm:col-start-2 sm:row-start-1">
                        {e.does}
                      </span>
                      <ArrowRight className="row-go col-start-2 row-start-1 h-4 w-4 self-center text-ink sm:col-start-3" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
