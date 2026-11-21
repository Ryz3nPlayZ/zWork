import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

type Side = "top" | "bottom" | "right" | "left";
const GAP = 6;
const ROOM = 32; // about one tooltip; less room than this flips to the other side

export function Tooltip({
  children,
  label,
  side = "top",
  shortcut,
}: {
  children: ReactNode;
  label: string;
  side?: Side;
  shortcut?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ side: Side; x: number; y: number } | null>(null);

  const show = () => {
    const b = ref.current?.getBoundingClientRect();
    if (!b) return;
    // Rendered into <body> so a panel's overflow or the window edge can't cut it off.
    let s = side;
    if (s === "top" && b.top < ROOM) s = "bottom";
    else if (s === "bottom" && window.innerHeight - b.bottom < ROOM) s = "top";
    else if (s === "left" && b.left < 160) s = "right";
    else if (s === "right" && window.innerWidth - b.right < 160) s = "left";
    const x = s === "left" ? b.left - GAP : s === "right" ? b.right + GAP : b.left + b.width / 2;
    const y = s === "top" ? b.top - GAP : s === "bottom" ? b.bottom + GAP : b.top + b.height / 2;
    setAt({ side: s, x, y });
    requestAnimationFrame(() => setOpen(true));
  };
  const hide = () => {
    setOpen(false);
    setTimeout(() => setAt((a) => (a && !ref.current?.matches(":hover, :focus-within") ? null : a)), 140);
  };

  const anchor = at && {
    top: "-translate-x-1/2 -translate-y-full",
    bottom: "-translate-x-1/2",
    right: "-translate-y-1/2",
    left: "-translate-x-full -translate-y-1/2",
  }[at.side];

  return (
    <span ref={ref} className="inline-flex" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {at &&
        createPortal(
          <span
            role="tooltip"
            style={{ left: at.x, top: at.y }}
            className={cn("pointer-events-none fixed z-[200]", anchor)}
          >
            <span
              className={cn(
                "block whitespace-nowrap rounded-md border border-black/10 bg-black/90 px-2 py-1 text-[11px] font-medium text-white shadow-pop",
                "dark:border-white/20 dark:bg-white/95 dark:text-neutral-900",
                "transition duration-120 ease-out",
                open ? "opacity-100 translate-y-0" : "opacity-0 translate-y-[2px]",
              )}
            >
              {label}
              {shortcut && (
                <span className="ml-1.5 rounded border border-white/20 bg-white/10 px-1 py-[1px] font-mono text-[10px] text-white/80 dark:border-black/15 dark:bg-black/5 dark:text-neutral-600">
                  {shortcut}
                </span>
              )}
            </span>
          </span>,
          document.body,
        )}
    </span>
  );
}
