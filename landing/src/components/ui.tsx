import { useMemo, type ReactNode } from "react";
import { motion } from "motion/react";
import { DownloadSimple } from "@phosphor-icons/react";
import { DOWNLOAD_URL, detectPlatform } from "../lib/site";

/* Radius rule for the page: anything you press is a pill, every surface
   (screenshots, panels) is rounded-2xl. */

export function DownloadButton({ size = "md" }: { size?: "sm" | "md" }) {
  const platform = useMemo(detectPlatform, []);
  const pad = size === "sm" ? "h-9 px-4 text-sm" : "h-12 px-6 text-[15px]";
  return (
    <a
      href={DOWNLOAD_URL}
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-ink font-medium text-paper transition-transform duration-150 hover:-translate-y-px active:translate-y-0 active:scale-[0.98] ${pad}`}
    >
      <DownloadSimple weight="bold" className={size === "sm" ? "size-4" : "size-[18px]"} />
      {platform ? `Download for ${platform}` : "Get zWork"}
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

/** A real app screenshot, light or dark to match the visitor's theme. */
export function Shot({ name, alt, className = "", eager = false }: { name: string; alt: string; className?: string; eager?: boolean }) {
  return (
    <picture>
      <source srcSet={`/shots/${name}-dark.webp`} media="(prefers-color-scheme: dark)" />
      <img
        src={`/shots/${name}-light.webp`}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        className={`block w-full rounded-2xl border border-line shadow-[0_24px_60px_-28px_rgb(var(--ink)/0.35)] ${className}`}
      />
    </picture>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-5 font-mono text-xs uppercase tracking-[0.14em] text-ink-muted">{children}</p>;
}

export function Section({ id, children, className = "" }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`mx-auto w-full max-w-[1200px] px-4 sm:px-8 ${className}`}>
      {children}
    </section>
  );
}
