import { cn } from "../lib/cn";

/**
 * zWork mark: ring of rounded-corner parallelograms arranged around a center.
 * Six slats tilted at their placement angle, evoking motion / a gear in soft form.
 */
export function Logo({
  size = 28,
  className,
  muted = false,
}: {
  size?: number;
  className?: string;
  muted?: boolean;
}) {
  const slats = 6;
  const radius = 12.5;
  const w = 4.2;
  const h = 11;
  const skew = -18; // px shift for parallelogram slant
  const rx = 1.6;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <g
        className={muted ? "fill-ink-muted" : "fill-ink"}
        transform="translate(20 20)"
      >
        {Array.from({ length: slats }).map((_, i) => {
          const angle = (360 / slats) * i;
          return (
            <g key={i} transform={`rotate(${angle}) translate(0 -${radius})`}>
              <rect
                x={-w / 2}
                y={-h / 2}
                width={w}
                height={h}
                rx={rx}
                transform={`skewX(${skew})`}
              />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Logo size={20} />
      <span className="text-[13px] font-semibold tracking-tight text-ink">
        zWork
      </span>
    </div>
  );
}
