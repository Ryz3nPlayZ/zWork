import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type HTMLAttributes,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";

/**
 * One hover highlight per group that slides from item to item instead of each
 * item lighting up on its own. Items opt in with `data-glide`; anything else
 * inside the group is ignored. The highlight follows the pointer and keyboard
 * focus, fades out when the pointer leaves, and jumps (no slide) the first time
 * it appears so it never sweeps in from a stale spot.
 *
 * Items drop their own hover background; `data-active` items keep a resting
 * tint so the selected row still reads when nothing is hovered.
 */
type Box = { x: number; y: number; w: number; h: number };

export function GlideGroup({
  children,
  className,
  highlightClassName,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; highlightClassName?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [visible, setVisible] = useState(false);
  // True for the first placement after being hidden: jump there, don't slide.
  const [fresh, setFresh] = useState(true);
  const visibleRef = useRef(false);

  const moveTo = useCallback((target: EventTarget | null) => {
    const root = ref.current;
    if (!root || !(target instanceof Element)) return;
    const item = target.closest<HTMLElement>("[data-glide]");
    if (!item || !root.contains(item) || item.closest("[data-glide-group]") !== root) return;
    if (item.matches(":disabled, [aria-disabled='true']")) return;
    const r = root.getBoundingClientRect();
    const b = item.getBoundingClientRect();
    // Scale-safe: the app zooms with a transform in the browser build.
    const sx = root.offsetWidth ? r.width / root.offsetWidth : 1;
    const sy = root.offsetHeight ? r.height / root.offsetHeight : 1;
    setBox({
      x: (b.left - r.left) / sx + root.scrollLeft,
      y: (b.top - r.top) / sy + root.scrollTop,
      w: b.width / sx,
      h: b.height / sy,
    });
    setFresh(!visibleRef.current);
    visibleRef.current = true;
    setVisible(true);
  }, []);

  const hide = useCallback(() => {
    visibleRef.current = false;
    setVisible(false);
  }, []);

  const style: CSSProperties | undefined = box
    ? {
        transform: `translate(${box.x}px, ${box.y}px)`,
        width: box.w,
        height: box.h,
        // First show: place it, then fade. After that, slide.
        transitionProperty: fresh ? "opacity" : "transform, width, height, opacity",
      }
    : undefined;

  return (
    <div
      {...rest}
      ref={ref}
      data-glide-group=""
      className={cn("relative isolate", className)}
      onPointerOver={(e: PointerEvent<HTMLDivElement>) => {
        rest.onPointerOver?.(e);
        if (e.pointerType !== "touch") moveTo(e.target);
      }}
      onPointerLeave={(e: PointerEvent<HTMLDivElement>) => {
        rest.onPointerLeave?.(e);
        hide();
      }}
      onFocus={(e: FocusEvent<HTMLDivElement>) => {
        rest.onFocus?.(e);
        if ((e.target as HTMLElement).matches(":focus-visible")) moveTo(e.target);
      }}
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        rest.onBlur?.(e);
        if (!ref.current?.contains(e.relatedTarget as Node)) hide();
      }}
    >
      <span
        aria-hidden="true"
        style={style}
        className={cn(
          "pointer-events-none absolute left-0 top-0 -z-10 rounded-lg bg-ink/[0.06] duration-300 ease-[cubic-bezier(.32,.72,0,1)] motion-reduce:duration-0",
          visible && box ? "opacity-100" : "opacity-0",
          highlightClassName,
        )}
      />
      {children}
    </div>
  );
}
