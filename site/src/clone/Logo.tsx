/** One slat, centred on the origin. */
export function LogoSlat() {
  return <rect x={-2.1} y={-5.5} width={4.2} height={11} rx={1.6} transform="skewX(-18)" />;
}

/** The six slats, centred on the origin in a 40-unit box. */
export function LogoSlats() {
  return (
    <>
      {Array.from({ length: 6 }, (_, i) => (
        <g key={i} transform={`rotate(${i * 60}) translate(0 -12.5)`}>
          <LogoSlat />
        </g>
      ))}
    </>
  );
}

/** zWork mark: six skewed slats on a ring. Same geometry as app/src/components/Logo.tsx. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} aria-hidden="true">
      <g transform="translate(20 20)" fill="currentColor">
        <LogoSlats />
      </g>
    </svg>
  );
}
