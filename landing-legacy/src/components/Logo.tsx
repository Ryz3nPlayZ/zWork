interface LogoProps {
  size?: number;
  className?: string;
  fill?: string;
}

export function Logo({ size = 28, className = "", fill = "currentColor" }: LogoProps) {
  const slats = 6;
  const radius = 12.5;
  const w = 4.2;
  const h = 11;
  const skew = -18;
  const rx = 1.6;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <g fill={fill} transform="translate(20 20)">
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
