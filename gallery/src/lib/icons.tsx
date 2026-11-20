/** The two arrows the gallery needs, so it doesn't pull in an icon set. */
type P = { className?: string };
const base = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const ArrowRight = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);
export const ArrowLeft = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M13 8H3M7 4 3 8l4 4" />
  </svg>
);
