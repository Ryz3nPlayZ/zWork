import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn";

export function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={cn("relative mx-auto w-full max-w-[1240px] px-4 sm:px-8", className)}>
      {children}
    </section>
  );
}

export function H2({ className, children }: { className?: string; children: ReactNode }) {
  return <h2 className={cn("display text-[44px] text-ink sm:text-[64px]", className)}>{children}</h2>;
}

export function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-xl border border-line bg-paper-sunken py-1.5 pl-3.5 pr-1.5", className)}>
      <span className="select-none font-mono text-[13px] text-ink-faint">$</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{command}</code>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy install command"}
        onClick={() => {
          navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => {},
          );
        }}
        className="press inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-line/50 hover:text-ink"
      >
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

/** Numbered list that lights up the item matching the demo's current chapter. */
export function ChapterList({
  items,
  active,
}: {
  items: { id: string; title: string; body: string }[];
  active: string | null;
}) {
  const idx = items.findIndex((i) => i.id === active);
  return (
    <ol className="flex flex-col gap-1">
      {items.map((it, i) => {
        const on = i === idx;
        const past = idx > i;
        return (
          <li
            key={it.id}
            className={cn(
              "relative rounded-2xl border px-5 py-4 transition-[background-color,border-color,opacity] duration-500",
              on ? "border-line bg-paper-raised" : "border-transparent",
              !on && !past && idx !== -1 && "opacity-55",
            )}
          >
            <div className="flex items-baseline gap-3">
              <span
                className={cn(
                  "font-mono text-[12px] tabular-nums transition-colors duration-500",
                  on ? "text-ink" : "text-ink-faint",
                )}
              >
                0{i + 1}
              </span>
              <div>
                <h3 className="text-[16px] font-semibold tracking-tight text-ink">{it.title}</h3>
                <p className="mt-1 text-[14.5px] leading-relaxed text-ink-muted">{it.body}</p>
              </div>
            </div>
            {on && (
              <span className="absolute bottom-3 left-0 top-3 w-[2px] rounded-full bg-ink" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Frame around a clone on the page: soft shadow, rounded, a little paper margin. */
export function DemoFrame({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <figure className={cn("relative", className)}>
      <div className="overflow-hidden rounded-[14px] shadow-[0_0_0_1px_rgb(var(--shadow)/.08),0_30px_60px_-20px_rgb(var(--shadow)/.35),0_12px_24px_-12px_rgb(var(--shadow)/.2)]">
        {children}
      </div>
      {label && (
        <figcaption className="mt-3 flex items-center justify-center gap-2 text-[12px] text-ink-faint">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          {label}
        </figcaption>
      )}
    </figure>
  );
}
