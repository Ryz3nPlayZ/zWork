import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, Star } from "lucide-react";
import { cn } from "../lib/cn";
import { Link } from "../lib/router";
import { GithubIcon } from "./ui";

/**
 * The site's motion buttons. All of them are plain anchors (they go
 * somewhere), animate with CSS only, and sit still under reduced motion.
 * Shapes and timings live in index.css under "Motion buttons".
 */

type Anchor = { href: string; className?: string; children?: ReactNode; "aria-label"?: string };

/** Same-origin paths go through the router; everything else is a plain link. */
function A({ href, className, children, ...rest }: Anchor) {
  return href.startsWith("/") ? (
    <Link href={href} className={className} {...rest}>
      {children}
    </Link>
  ) : (
    <a href={href} className={className} {...rest}>
      {children}
    </a>
  );
}

/**
 * Outlined pill with a dot before the label. On hover the dot grows until it
 * fills the button, the label rolls up and out, and `reveal` with an arrow
 * rolls in from below in the paper colour.
 */
export function DotFillButton({ href, label, reveal, className }: { href: string; label: string; reveal: string; className?: string }) {
  return (
    <A href={href} className={cn("dot-fill press group", className)}>
      <span aria-hidden="true" className="dot-fill-dot" />
      <span className="dot-fill-text">
        <span className="dot-fill-label">{label}</span>
        <span aria-hidden="true" className="dot-fill-reveal">
          {reveal}
          <ArrowRight className="h-4 w-4" />
        </span>
      </span>
    </A>
  );
}

/**
 * Solid pill whose leading icon slides out to the right on hover while an
 * arrow slides in behind it.
 */
export function SlideArrowButton({
  href,
  icon,
  children,
  className,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <A href={href} className={cn("slide-arrow", className)}>
      <span aria-hidden="true" className="slide-arrow-icons">
        <span className="slide-arrow-out">{icon}</span>
        <span className="slide-arrow-in">
          <ArrowRight className="h-full w-full" />
        </span>
      </span>
      {children}
    </A>
  );
}

/** GitHub link whose mark turns into a star, with a small sparkle, on hover. */
export function SparkleButton({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <A href={href} className={cn("sparkle press", className)}>
      <span aria-hidden="true" className="sparkle-icons">
        <GithubIcon className="sparkle-gh h-4 w-4" />
        <Star className="sparkle-star h-4 w-4" />
        <svg className="sparkle-spark" viewBox="0 0 10 10" fill="currentColor">
          <path d="M5 0 6 4 10 5 6 6 5 10 4 6 0 5 4 4Z" />
        </svg>
      </span>
      {children}
    </A>
  );
}

/**
 * Pill that links to the changelog. Two soft glows, amber and blue, sit below
 * it and follow the pointer across; on hover they rise into the pill.
 */
export function WhatsNewButton({ href, version, className }: { href: string; version?: string | null; className?: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const move = useCallback((e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--glow-x", `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
  }, []);
  return (
    <Link ref={ref} href={href} onPointerMove={move} className={cn("whats-new press", className)}>
      <span aria-hidden="true" className="whats-new-glow" />
      <span className="relative">What's new</span>
      {version && <span className="relative tabular-nums text-ink-faint">v{version}</span>}
    </Link>
  );
}

/**
 * One highlight per group that slides between links instead of each one
 * lighting up on its own (the app's GlideGroup, for the site). Items opt in
 * with `data-glide`.
 */
export function Glide({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  const ref = useRef<HTMLElement>(null);
  const [box, setBox] = useState<{ x: number; w: number; h: number; y: number } | null>(null);
  const [on, setOn] = useState(false);
  const [fresh, setFresh] = useState(true);
  const onRef = useRef(false);

  const to = (t: EventTarget | null) => {
    const root = ref.current;
    if (!root || !(t instanceof Element)) return;
    const item = t.closest<HTMLElement>("[data-glide]");
    if (!item || !root.contains(item)) return;
    const r = root.getBoundingClientRect();
    const b = item.getBoundingClientRect();
    setBox({ x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height });
    setFresh(!onRef.current);
    onRef.current = true;
    setOn(true);
  };
  const off = () => {
    onRef.current = false;
    setOn(false);
  };

  const style: CSSProperties | undefined = box
    ? {
        transform: `translate(${box.x}px, ${box.y}px)`,
        width: box.w,
        height: box.h,
        transitionProperty: fresh ? "opacity" : "transform, width, height, opacity",
      }
    : undefined;

  return (
    <nav
      ref={ref}
      aria-label={label}
      className={cn("relative isolate", className)}
      onPointerOver={(e) => e.pointerType !== "touch" && to(e.target)}
      onPointerLeave={off}
      onFocus={(e) => (e.target as HTMLElement).matches(":focus-visible") && to(e.target)}
      onBlur={(e) => !ref.current?.contains(e.relatedTarget as Node) && off()}
    >
      <span aria-hidden="true" style={style} className={cn("glide-hl", on && box && "is-on")} />
      {children}
    </nav>
  );
}
