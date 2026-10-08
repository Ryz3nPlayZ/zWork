import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

export function Tooltip({
  children,
  label,
  side = "top",
  shortcut,
}: {
  children: ReactNode;
  label: string;
  side?: "top" | "bottom" | "right" | "left";
  shortcut?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const show = () => {
    setMounted(true);
    // next tick to allow transition
    requestAnimationFrame(() => setOpen(true));
  };
  const hide = () => {
    setOpen(false);
    setTimeout(() => setMounted(false), 140);
  };

  const pos = {
    top: "bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2",
    bottom: "top-[calc(100%+6px)] left-1/2 -translate-x-1/2",
    right: "left-[calc(100%+6px)] top-1/2 -translate-y-1/2",
    left: "right-[calc(100%+6px)] top-1/2 -translate-y-1/2",
  }[side];

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {mounted && (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-[90] whitespace-nowrap rounded-md border border-black/10 bg-black/90 px-2 py-1 text-[11px] font-medium text-white shadow-pop",
            "dark:border-white/20 dark:bg-white/95 dark:text-neutral-900",
            "transition duration-120 ease-out",
            open ? "opacity-100 translate-y-0" : "opacity-0 translate-y-[2px]",
            pos,
          )}
        >
          {label}
          {shortcut && (
            <span className="ml-1.5 rounded border border-white/20 bg-white/10 px-1 py-[1px] font-mono text-[10px] text-white/80">
              {shortcut}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
