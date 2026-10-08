import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Tooltip } from "./Tooltip";

type Variant = "ghost" | "soft" | "solid" | "outline";
type Size = "sm" | "md" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label?: string;
  shortcut?: string;
  variant?: Variant;
  size?: Size;
  active?: boolean;
  tooltipSide?: "top" | "bottom" | "right" | "left";
  showTooltip?: boolean;
}

const sizes: Record<Size, string> = {
  sm: "h-7 w-7 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5",
  md: "h-8 w-8 rounded-lg [&_svg]:h-4 [&_svg]:w-4",
  lg: "h-9 w-9 rounded-lg [&_svg]:h-[18px] [&_svg]:w-[18px]",
};

const variants: Record<Variant, string> = {
  ghost:
    "text-ink-muted hover:text-ink hover:bg-line/50 active:bg-line/70",
  soft:
    "text-ink bg-paper-sunken hover:bg-paper hover:border-line-strong active:bg-line/60",
  solid:
    "text-ink bg-paper-sunken border border-line hover:bg-paper hover:border-line-strong disabled:bg-paper-sunken/60 disabled:text-ink-faint",
  outline:
    "text-ink border border-line hover:border-line-strong hover:bg-paper-sunken",
};

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  {
    icon,
    label,
    shortcut,
    variant = "ghost",
    size = "md",
    active,
    tooltipSide = "top",
    showTooltip = true,
    className,
    ...rest
  },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        "press ring-focus inline-flex items-center justify-center",
        sizes[size],
        variants[variant],
        active && "bg-paper-sunken text-ink border-line-strong",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
  if (!label || !showTooltip) return btn;
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      {btn}
    </Tooltip>
  );
});
