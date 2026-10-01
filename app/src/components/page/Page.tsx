/**
 * Shared building blocks for the collection pages (Scheduled, Inbox,
 * Projects, Connectors). Wireframe: docs/wireframes/list-pages.html.
 *
 * Rules the pages rely on:
 *  - one width (960px), one header, one empty state
 *  - time-ordered things use ListGroup/ListRow, things you open use CardGrid/Card
 *  - status is a text Badge, never a colored dot
 *  - destructive actions go through useConfirm, never window.confirm
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/cn";

// ---- Page shell ----

export function PageShell({
  title,
  subtitle,
  actions,
  toolbar,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[960px] px-6 pb-16 pt-8">
          <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
              {subtitle && <p className="mt-0.5 text-[13px] text-ink-muted">{subtitle}</p>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
          </header>
          {toolbar && <div className="mb-4 flex flex-wrap items-center justify-between gap-2">{toolbar}</div>}
          {children}
        </div>
      </div>
    </div>
  );
}

export function SectionHeading({
  title,
  count,
  description,
  action,
  className,
}: {
  title: string;
  count?: number;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-2.5 mt-8", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink">
          {title}
          {count !== undefined && <span className="ml-1.5 font-normal text-ink-faint">{count}</span>}
        </h2>
        {action}
      </div>
      {description && (
        <p className="mt-0.5 max-w-[60ch] text-[12.5px] leading-relaxed text-ink-muted">{description}</p>
      )}
    </div>
  );
}

// ---- Buttons ----

export function Button({
  variant = "secondary",
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "press ring-focus inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5",
        variant === "primary" && "bg-ink text-paper hover:bg-ink/90",
        variant === "secondary" && "border border-line bg-paper text-ink hover:bg-paper-sunken",
        variant === "danger" && "border border-error/30 bg-error/10 text-error hover:bg-error/15",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/** Small square icon-only button used inside rows and cards. */
export function RowIconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "press ring-focus inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-line/50 hover:text-ink disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---- Small pieces ----

export type Tone = "neutral" | "success" | "warning" | "error" | "info";

const TILE_TONE: Record<Tone, string> = {
  neutral: "border-line bg-paper text-ink-muted",
  success: "border-success/20 bg-success/10 text-success",
  warning: "border-warning/25 bg-warning/10 text-warning",
  error: "border-error/20 bg-error/10 text-error",
  info: "border-info/20 bg-info/10 text-info",
};

export function IconTile({
  tone = "neutral",
  size = "md",
  style,
  className,
  children,
}: {
  tone?: Tone;
  size?: "md" | "lg";
  style?: React.CSSProperties;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={style}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border",
        size === "md" ? "h-8 w-8 rounded-[9px] [&_svg]:h-4 [&_svg]:w-4" : "h-10 w-10 rounded-xl [&_svg]:h-[18px] [&_svg]:w-[18px]",
        TILE_TONE[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

const BADGE_TONE: Record<Tone, string> = {
  neutral: "border-line bg-paper text-ink-muted",
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  error: "border-error/25 bg-error/10 text-error",
  info: "border-info/25 bg-info/10 text-info",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-px text-[10.5px] font-medium leading-4",
        BADGE_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "press ring-focus relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
        checked ? "border-transparent bg-accent" : "border-line bg-paper-sunken",
      )}
    >
      <span
        className={cn(
          "pointer-events-none h-3 w-3 rounded-full shadow-sm transition-transform",
          checked ? "translate-x-[15px] bg-paper" : "translate-x-[2px] bg-ink-faint",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg bg-paper-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "press ring-focus rounded-md px-2.5 py-1 text-[12px] transition-colors",
            value === o.value
              ? "bg-paper font-medium text-ink shadow-sm"
              : "text-ink-muted hover:text-ink",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1 text-ink-faint">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="h-8 w-full max-w-[240px] rounded-lg border border-line bg-paper px-3 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
    />
  );
}

// ---- List pattern ----

export function ListGroup({ children }: { children: ReactNode }) {
  return (
    // No overflow-hidden: row menus must be able to hang outside the group.
    <ul className="divide-y divide-line rounded-2xl border border-line bg-paper-raised [&>li:first-child]:rounded-t-2xl [&>li:last-child]:rounded-b-2xl">
      {children}
    </ul>
  );
}

/**
 * One row. The main area (icon, title, meta) is a single button; `actions`
 * show on hover/focus, `trailing` is always visible. `children` render under
 * the row when `expanded` is true.
 */
export function ListRow({
  icon,
  title,
  meta,
  trailing,
  actions,
  onClick,
  muted,
  expanded,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  muted?: boolean;
  expanded?: boolean;
  children?: ReactNode;
}) {
  const main = (
    <>
      {icon}
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-[13px]", muted ? "text-ink-muted" : "font-semibold text-ink")}>{title}</div>
        {meta && <div className="truncate text-[12px] text-ink-muted">{meta}</div>}
      </div>
    </>
  );
  return (
    <li className={cn("group transition-colors", !expanded && "hover:bg-line/25", expanded && "bg-line/20")}>
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        {onClick ? (
          <button
            type="button"
            onClick={onClick}
            aria-expanded={children !== undefined ? !!expanded : undefined}
            className="ring-focus flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
          >
            {main}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{main}</div>
        )}
        {actions && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {actions}
          </div>
        )}
        {trailing && (
          <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-ink-faint">{trailing}</div>
        )}
      </div>
      {expanded && children && <div className="px-3.5 pb-3.5 pl-[58px]">{children}</div>}
    </li>
  );
}

// ---- Card grid pattern ----

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

/**
 * A card you open. `corner` (badge or star) sits top-right and `menu` shows
 * there on hover; both live outside the main button so they can be clickable.
 */
export function Card({
  icon,
  title,
  description,
  footer,
  corner,
  menu,
  onClick,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  corner?: ReactNode;
  menu?: ReactNode;
  onClick: () => void;
}) {
  return (
    <div className="group relative rounded-2xl border border-line bg-paper-raised transition-colors hover:border-line-strong">
      <button
        type="button"
        onClick={onClick}
        className="ring-focus flex h-full min-h-[136px] w-full flex-col gap-2 rounded-2xl p-4 text-left"
      >
        {icon}
        <div className="mt-1 truncate pr-2 text-[14px] font-semibold text-ink">{title}</div>
        {description && (
          <p className="line-clamp-2 text-[12.5px] leading-[18px] text-ink-muted">{description}</p>
        )}
        {footer && (
          <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-[11.5px] text-ink-faint">
            {footer}
          </div>
        )}
      </button>
      {(corner || menu) && (
        <div className="absolute right-3 top-3 flex items-center gap-1">
          {menu && <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">{menu}</div>}
          {corner}
        </div>
      )}
    </div>
  );
}

// ---- Empty state ----

export function EmptyState({
  icon,
  title,
  body,
  action,
  compact,
}: {
  icon: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-2xl border border-dashed border-line-strong text-center",
        compact ? "px-6 py-8" : "px-6 py-14",
      )}
    >
      <IconTile size="lg">{icon}</IconTile>
      <h3 className="mt-3 text-[13.5px] font-semibold text-ink">{title}</h3>
      {body && <p className="mt-1 max-w-[42ch] text-[12.5px] leading-relaxed text-ink-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---- Overflow menu ----

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}

export function OverflowMenu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <RowIconButton
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <MoreHorizontal />
      </RowIconButton>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-40 animate-fade-in rounded-xl border border-line-strong bg-paper-raised p-1 shadow-pop"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.onSelect();
              }}
              className={cn(
                "press flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] [&_svg]:h-3.5 [&_svg]:w-3.5",
                it.danger ? "text-error hover:bg-error/10" : "text-ink hover:bg-line/40",
              )}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Confirm dialog ----

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  /** "danger" (default) for removals; "primary" for consequential but non-destructive changes. */
  variant?: "danger" | "primary";
}

/**
 * Promise-based replacement for window.confirm:
 *   const [confirmDialog, confirm] = useConfirm();
 *   if (await confirm({ title, confirmLabel })) ...
 *   return <>{...}{confirmDialog}</>
 */
export function useConfirm(): [ReactNode, (o: ConfirmOptions) => Promise<boolean>] {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  const ask = useCallback(
    (o: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })),
    [],
  );

  const close = useCallback(
    (v: boolean) => {
      pending?.resolve(v);
      setPending(null);
    },
    [pending],
  );

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, close]);

  const node = pending ? (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm animate-fade-in"
      onClick={() => close(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={pending.title}
        className="w-full max-w-[380px] rounded-2xl border border-line bg-paper-raised p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[14.5px] font-semibold text-ink">{pending.title}</h2>
        {pending.body && <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">{pending.body}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={pending.variant ?? "danger"} autoFocus onClick={() => close(true)}>
            {pending.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return [node, ask];
}
