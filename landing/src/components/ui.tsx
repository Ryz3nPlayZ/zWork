import { useMemo, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, DownloadSimple } from "@phosphor-icons/react";
import { DEMO_URL, detectPlatform, downloadUrl } from "../lib/site";

/* Radius rule for the page: anything you press is a pill, every surface
   (screenshots, panels) is rounded-2xl. */

export function DownloadButton({ size = "md" }: { size?: "sm" | "md" }) {
  const platform = useMemo(() => detectPlatform(), []);
  const pad = size === "sm" ? "h-9 px-4 text-sm" : "h-12 px-6 text-[15px]";
  return (
    <a
      href={downloadUrl(platform)}
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-ink font-medium text-paper transition-transform duration-150 hover:-translate-y-px active:translate-y-0 active:scale-[0.98] ${pad}`}
    >
      <DownloadSimple weight="bold" className={size === "sm" ? "size-4" : "size-[18px]"} />
      {platform ? `Download for ${platform}` : "Get zWork"}
    </a>
  );
}

/** Opens the real app in the browser, no sign-in (app.tryzwork.app). */
export function TryButton() {
  return (
    <a
      href={DEMO_URL}
      className="group inline-flex h-12 items-center gap-1.5 whitespace-nowrap rounded-full border border-line-strong bg-paper px-6 text-[15px] font-medium text-ink transition-colors hover:bg-paper-raised"
    >
      Try it in your browser
      <ArrowUpRight weight="bold" className="size-4 transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
    </a>
  );
}

export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Pixel sizes of the captures in public/shots (1440x900 @2x crops), so the
 *  page reserves their space before they load. */
const SHOT_SIZE: Record<string, [number, number]> = {
  hero: [2880, 1800],
  report: [1322, 1684],
  steps: [1020, 1180],
};

/** A real app screenshot, light or dark to match the visitor's theme. */
export function Shot({ name, alt, className = "", eager = false }: { name: string; alt: string; className?: string; eager?: boolean }) {
  const [width, height] = SHOT_SIZE[name] ?? [];
  return (
    <picture>
      <source srcSet={`/shots/${name}-dark.webp`} media="(prefers-color-scheme: dark)" />
      <img
        src={`/shots/${name}-light.webp`}
        alt={alt}
        width={width}
        height={height}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        className={`block h-auto w-full rounded-2xl border border-line shadow-[0_24px_60px_-28px_rgb(var(--ink)/0.35)] ${className}`}
      />
    </picture>
  );
}

/** A desktop window around a screenshot, so it reads as an app and not a crop. */
export function AppWindow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line-strong bg-paper-raised shadow-[0_40px_100px_-40px_rgb(var(--ink)/0.45)]">
      <div className="relative flex h-9 items-center border-b border-line px-4">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
        </div>
        <span className="absolute inset-x-0 text-center text-xs text-ink-muted">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-5 font-mono text-xs uppercase tracking-[0.14em] text-ink-muted">{children}</p>;
}

export function H2({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={`text-4xl font-semibold leading-[1.05] tracking-[-0.035em] text-balance sm:text-5xl ${className}`}>
      {children}
    </h2>
  );
}

export function Section({ id, children, className = "" }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`mx-auto w-full max-w-[1200px] scroll-mt-20 px-4 sm:px-8 ${className}`}>
      {children}
    </section>
  );
}
