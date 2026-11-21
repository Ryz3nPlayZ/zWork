import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Loader2, LogIn } from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import {
  CloudFetchError,
  fetchAnalyticsSummary,
  isWebAuthClient,
  startWebGoogleSignIn,
  type AnalyticsDay,
  type AnalyticsSummary,
} from "../lib/cloud";
import { Badge, Button, EmptyState, PageShell, Segmented } from "./page/Page";

const DAY_MS = 86_400_000;
const number = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** The gateway buckets by UTC day, so every date on this page is a UTC day. */
function utcToday(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayLabel(ms: number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}

function plural(n: number, one: string, many: string): string {
  return `${number.format(n)} ${n === 1 ? one : many}`;
}

interface Day {
  ms: number;
  /** Messages: each new request, from you or a scheduled task. */
  messages: number;
  /** Steps zWork took while working on them. */
  steps: number;
}

/** One entry per day for the last `days` days, oldest first; missing days are zero. */
function lastDays(days: number, rows: AnalyticsDay[]): Day[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const today = utcToday();
  return Array.from({ length: days }, (_, i) => {
    const ms = today - (days - 1 - i) * DAY_MS;
    const row = byDay.get(dayKey(ms));
    return { ms, messages: row?.roots ?? 0, steps: row?.continuations ?? 0 };
  });
}

type Load =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "failed" }
  | { state: "ready"; summary: AnalyticsSummary };

export function AnalyticsPage() {
  const userId = useApp((s) => s.user?.id ?? null);
  const signingIn = useApp((s) => s.isLoadingAuth);
  const signInWithGoogle = useApp((s) => s.signInWithGoogle);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [range, setRange] = useState<"7" | "30">("7");
  const [signInError, setSignInError] = useState(false);

  const fetchSummary = useCallback(() => {
    // Usage lives with the account, so there is nothing to fetch until you sign in.
    if (!userId) {
      setLoad({ state: "signed-out" });
      return;
    }
    let alive = true;
    setLoad({ state: "loading" });
    fetchAnalyticsSummary()
      .then((summary) => alive && setLoad({ state: "ready", summary }))
      .catch((err) => {
        if (!alive) return;
        const signedOut = err instanceof CloudFetchError && (err.status === 401 || err.status === 403);
        setLoad({ state: signedOut ? "signed-out" : "failed" });
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  // Runs again after signing in, when the user changes.
  useEffect(() => fetchSummary(), [fetchSummary]);

  const signIn = () => {
    setSignInError(false);
    if (isWebAuthClient()) return startWebGoogleSignIn();
    signInWithGoogle().catch(() => setSignInError(true));
  };

  return (
    <PageShell
      title="Analytics"
      subtitle="How much of your plan you've used, and when you've worked with zWork."
    >
      {load.state === "loading" ? (
        <div className="flex flex-1 items-center justify-center py-20 text-[13px] text-ink-muted">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading your usage…
        </div>
      ) : load.state === "signed-out" ? (
        <EmptyState
          icon={<LogIn />}
          title="Sign in to see your usage"
          body={
            signInError ? (
              <span className="text-error">That didn&rsquo;t work. Try again.</span>
            ) : (
              "Your usage is kept with your zWork account."
            )
          }
          action={
            <Button variant="primary" icon={<LogIn />} disabled={signingIn} onClick={signIn}>
              {signingIn ? "Signing in…" : "Sign in with Google"}
            </Button>
          }
        />
      ) : load.state === "failed" ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Your usage didn't load"
          body="Check your internet connection and try again."
          action={<Button onClick={() => fetchSummary()}>Try again</Button>}
        />
      ) : (
        <Overview summary={load.summary} range={range} onRange={setRange} />
      )}
    </PageShell>
  );
}

function Overview({
  summary,
  range,
  onRange,
}: {
  summary: AnalyticsSummary;
  range: "7" | "30";
  onRange: (r: "7" | "30") => void;
}) {
  const setView = useApp((s) => s.setView);
  const week = useMemo(() => lastDays(7, summary.past_week), [summary.past_week]);
  const month = useMemo(() => lastDays(30, summary.past_month), [summary.past_month]);
  const series = range === "7" ? week : month;
  const weekTotal = week.reduce((n, d) => n + d.messages, 0);
  // The 7 days before this week, from the 30-day series.
  const prevWeekTotal = month.slice(16, 23).reduce((n, d) => n + d.messages, 0);
  const tier = summary.user?.tier ?? "free";
  const isFree = tier === "free";
  const harder =
    isFree && summary.free_escalations_left != null
      ? { left: summary.free_escalations_left, limit: summary.free_escalations_limit ?? 3 }
      : null;

  const diff = weekTotal - prevWeekTotal;
  const trend =
    prevWeekTotal === 0 && weekTotal === 0
      ? "Nothing yet this week."
      : prevWeekTotal === 0
        ? "None the week before."
        : diff === 0
          ? "Same as the week before."
          : `${number.format(Math.abs(diff))} ${diff > 0 ? "more" : "fewer"} than the week before.`;

  return (
    <div className="flex flex-col gap-4">
      {/* Activity: the headline number, then the days behind it. */}
      <section className="rounded-2xl border border-line bg-paper-raised">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 px-5 pb-4 pt-5">
          <div>
            <div className="text-[12.5px] text-ink-muted">Messages in the last 7 days</div>
            <div className="mt-1 text-[40px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">
              {formatCount(weekTotal)}
            </div>
            <div className="mt-2 text-[12.5px] text-ink-muted">{trend}</div>
          </div>
          <dl className="flex gap-8">
            <Figure label="Today" value={summary.root_requests_today} />
            <Figure label="All time" value={summary.root_requests_total} />
          </dl>
        </div>
        <div className="border-t border-line px-5 pb-4 pt-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[13px] font-semibold text-ink">Activity</h2>
            <Segmented
              label="Time range"
              value={range}
              onChange={onRange}
              options={[
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
              ]}
            />
          </div>
          <ActivityChart key={range} days={series} />
        </div>
      </section>

      {/* Plan: what's left, with the plan it belongs to. */}
      <section className="rounded-2xl border border-line bg-paper-raised">
        <div className="flex items-center justify-between gap-3 px-5 pt-4">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-ink">
              {tier === "max" ? "Max plan" : tier === "pro" ? "Pro plan" : "Free plan"}
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-muted">
              If a limit runs out, zWork waits until it frees up. Each frees up bit by bit as older use drops off.
            </p>
          </div>
          <Button variant={isFree ? "primary" : "secondary"} onClick={() => setView("plan")}>
            {isFree ? "Upgrade" : "Manage plan"}
          </Button>
        </div>
        <div className={cn("grid grid-cols-1 gap-x-8 gap-y-5 px-5 pb-5 pt-5", harder ? "md:grid-cols-3" : "md:grid-cols-2")}>
          <Meter label="Last 5 hours" used={summary.five_hour_used} limit={summary.five_hour_limit} />
          <Meter label="Last 7 days" used={summary.weekly_used} limit={summary.weekly_limit} />
          {harder && (
            <Meter
              label="Hard tasks, 30 days"
              hint={`${plural(harder.left, "more goes", "more go")} to the stronger model.`}
              used={Math.max(0, harder.limit - harder.left)}
              limit={harder.limit}
              valueText={`${Math.max(0, harder.limit - harder.left)} of ${harder.limit}`}
            />
          )}
        </div>
      </section>

      {summary.past_year && (
        <section className="rounded-2xl border border-line bg-paper-raised px-5 pb-4 pt-4">
          <YearHeatmap rows={summary.past_year} />
        </section>
      )}
    </div>
  );
}

function formatCount(n: number): string {
  return n >= 10_000 ? compact.format(n) : number.format(n);
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[12px] text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-[20px] font-semibold tracking-tight tabular-nums text-ink">{formatCount(value)}</dd>
    </div>
  );
}

/** A plan limit. The numbers are internal cost units, so only the share is shown. */
function Meter({
  label,
  hint,
  used,
  limit,
  valueText,
}: {
  label: string;
  hint?: string;
  used: number;
  limit: number;
  valueText?: string;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const status: { tone: "warning" | "error"; text: string } | null =
    pct >= 100 ? { tone: "error", text: "Used up" } : pct >= 80 ? { tone: "warning", text: "Almost used up" } : null;

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-ink-muted">{label}</span>
        {status && <Badge tone={status.tone}>{status.text}</Badge>}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-[22px] font-semibold tracking-tight tabular-nums text-ink">
          {valueText ?? `${pct}%`}
        </span>
        <span className="text-[12px] text-ink-faint">used</span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/[0.08]"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${valueText ?? `${pct}%`} used`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none",
            status?.tone === "error" ? "bg-error" : status?.tone === "warning" ? "bg-warning" : "bg-ink/70",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {hint && <p className="mt-1.5 text-[12px] text-ink-faint">{hint}</p>}
    </div>
  );
}

/** Clean axis steps: the smallest 1/2/5 × 10ⁿ step that fits the data in 4 ticks. */
function niceTicks(max: number): number[] {
  if (max <= 4) return [0, 1, 2, 3, 4].slice(0, Math.max(2, max + 1));
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

function Tip({ children, style }: { children: ReactNode; style: React.CSSProperties }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[12px] shadow-md"
      style={style}
    >
      {children}
    </div>
  );
}

const CHART_H = 180;

function ActivityChart({ days }: { days: Day[] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...days.map((d) => d.messages));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const short = days.length <= 7;

  if (max === 0) {
    return (
      <div className="flex items-center justify-center text-[13px] text-ink-muted" style={{ height: CHART_H + 28 }}>
        No messages in these {days.length} days.
      </div>
    );
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const from = active ?? days.length;
    setActive(Math.min(days.length - 1, Math.max(0, from + (e.key === "ArrowLeft" ? -1 : 1))));
  };

  // Label every day for a week; for a month, every 7th day counting back from today.
  const labelled = (i: number) => short || (days.length - 1 - i) % 7 === 0;
  const tipDay = active !== null ? days[active] : null;

  return (
    <div>
      <div className="flex">
        {/* Y axis */}
        <div className="relative w-9 shrink-0 text-[11px] tabular-nums text-ink-faint" style={{ height: CHART_H }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 -translate-y-1/2" style={{ top: `${(1 - t / top) * 100}%` }}>
              {t >= 10_000 ? compact.format(t) : number.format(t)}
            </span>
          ))}
        </div>

        <div
          className="ring-focus relative min-w-0 flex-1 rounded-sm"
          style={{ height: CHART_H }}
          tabIndex={0}
          role="group"
          aria-label={`Messages per day. Use the left and right arrow keys to read each day.`}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          onMouseLeave={() => setActive(null)}
        >
          {/* Gridlines; the 0 line is the baseline. */}
          {ticks.map((t) => (
            <div
              key={t}
              className={cn("absolute inset-x-0 border-t", t === 0 ? "border-line-strong" : "border-dashed border-line/70")}
              style={{ top: `${(1 - t / top) * 100}%` }}
            />
          ))}

          <div className="absolute inset-0 flex">
            {days.map((d, i) => {
              const h = d.messages > 0 ? Math.max(2, (d.messages / top) * CHART_H) : 0;
              return (
                // The whole column is the hover target, not just the bar.
                <div key={d.ms} className="flex flex-1 items-end justify-center px-px" onMouseEnter={() => setActive(i)}>
                  <div
                    className={cn(
                      "w-[72%] max-w-[28px] rounded-[4px] transition-colors",
                      active === i ? "bg-ink/80" : i === days.length - 1 ? "bg-ink/55" : "bg-ink/20",
                    )}
                    style={{ height: h }}
                  />
                </div>
              );
            })}
          </div>

          {tipDay && active !== null && (
            <Tip
              style={{
                left: `${((active + 0.5) / days.length) * 100}%`,
                bottom: Math.min(CHART_H - 46, Math.max(2, (tipDay.messages / top) * CHART_H) + 8),
                // Keep the tip inside the chart at both ends.
                transform:
                  active < days.length * 0.2
                    ? "translateX(-12px)"
                    : active > days.length * 0.8
                      ? "translateX(calc(-100% + 12px))"
                      : "translateX(-50%)",
              }}
            >
              <div className="font-medium text-ink">
                {dayLabel(tipDay.ms, { weekday: "short", month: "short", day: "numeric" })}
              </div>
              <div className="text-ink-muted">
                {plural(tipDay.messages, "message", "messages")}
                {tipDay.steps > 0 && ` · ${plural(tipDay.steps, "step", "steps")}`}
              </div>
            </Tip>
          )}
        </div>
      </div>

      {/* X axis */}
      <div className="ml-9 mt-2 flex h-4 text-[11px] text-ink-faint" aria-hidden>
        {days.map((d, i) => (
          <span key={d.ms} className="relative min-w-0 flex-1">
            {labelled(i) && (
              <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">
                {dayLabel(d.ms, short ? { weekday: "short" } : { month: "short", day: "numeric" })}
              </span>
            )}
          </span>
        ))}
      </div>

      <table className="sr-only">
        <caption>Messages per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Messages</th>
            <th scope="col">Steps</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.ms}>
              <td>{dayLabel(d.ms, { weekday: "long", month: "long", day: "numeric" })}</td>
              <td>{d.messages}</td>
              <td>{d.steps}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One cell per day, a column per week (Sunday first), one hue from light to dark. */
const HEAT_LEVELS = ["bg-state-hover", "bg-ink/20", "bg-ink/35", "bg-ink/55", "bg-ink/80"];
const WEEKS = 53;

function YearHeatmap({ rows }: { rows: AnalyticsDay[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; ms: number; value: number } | null>(null);

  const { cells, months, max } = useMemo(() => {
    const counts = new Map(rows.map((r) => [r.day, r.roots]));
    const today = utcToday();
    // Start on the Sunday 52 weeks before this week's Sunday.
    const start = today - (new Date(today).getUTCDay() + (WEEKS - 1) * 7) * DAY_MS;
    const cells = Array.from({ length: WEEKS * 7 }, (_, i) => {
      const ms = start + i * DAY_MS;
      return { ms, value: counts.get(dayKey(ms)) ?? 0, future: ms > today };
    });
    // A month name over the first week that starts in that month.
    const months: { col: number; label: string }[] = [];
    for (let w = 0; w < WEEKS; w++) {
      const d = new Date(start + w * 7 * DAY_MS);
      const prev = w === 0 ? null : new Date(start + (w - 1) * 7 * DAY_MS);
      if ((!prev || prev.getUTCMonth() !== d.getUTCMonth()) && !(w > WEEKS - 3 && months.length)) {
        months.push({ col: w, label: dayLabel(d.getTime(), { month: "short" }) });
      }
    }
    return { cells, months, max: Math.max(0, ...cells.map((c) => c.value)) };
  }, [rows]);

  const level = (v: number) => (v <= 0 || max === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  const grid = { gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` };
  const busiest = cells.reduce((b, c) => (c.value > b.value ? c : b), cells[0]);
  const total = cells.reduce((n, c) => n + c.value, 0);
  const activeDays = cells.filter((c) => c.value > 0).length;

  return (
    <>
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-[13px] font-semibold text-ink">Past year</h2>
      <p className="text-[12px] text-ink-muted">
        {max === 0
          ? "No messages in the last 12 months."
          : `${plural(total, "message", "messages")} on ${plural(activeDays, "day", "days")}. Busiest was ${dayLabel(
              busiest.ms,
              { month: "long", day: "numeric" },
            )}, with ${number.format(busiest.value)}.`}
      </p>
    </div>
    <div
      ref={wrapRef}
      className="relative"
      role="img"
      aria-label={
        max === 0
          ? "No messages in the past year."
          : `Messages per day over the past year. The busiest day was ${dayLabel(busiest.ms, {
              month: "long",
              day: "numeric",
            })} with ${plural(busiest.value, "message", "messages")}.`
      }
      onMouseLeave={() => setTip(null)}
    >
      <div className="grid gap-[3px] pb-1.5 text-[10.5px] text-ink-faint" style={grid}>
        {months.map((m) => (
          <span key={`${m.col}-${m.label}`} className="whitespace-nowrap" style={{ gridColumnStart: m.col + 1 }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="grid grid-flow-col grid-rows-7 gap-[3px]" style={grid}>
        {cells.map((c) => (
          <div
            key={c.ms}
            className={cn(
              "aspect-square rounded-[3px]",
              c.future ? "bg-transparent" : HEAT_LEVELS[level(c.value)],
              tip?.ms === c.ms && "ring-1 ring-ink",
            )}
            onMouseEnter={(e) => {
              if (c.future || !wrapRef.current) return setTip(null);
              const box = wrapRef.current.getBoundingClientRect();
              const cell = e.currentTarget.getBoundingClientRect();
              setTip({ x: cell.left + cell.width / 2 - box.left, y: cell.top - box.top, ms: c.ms, value: c.value });
            }}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-ink-faint">
        <span>Fewer</span>
        {HEAT_LEVELS.map((cls) => (
          <span key={cls} className={cn("h-2.5 w-2.5 rounded-[3px]", cls)} />
        ))}
        <span>More</span>
      </div>

      {tip && wrapRef.current && (
        <Tip
          style={{
            left: tip.x,
            top: tip.y - 6,
            transform:
              tip.x < 90
                ? "translate(-12px, -100%)"
                : tip.x > wrapRef.current.clientWidth - 90
                  ? "translate(calc(-100% + 12px), -100%)"
                  : "translate(-50%, -100%)",
          }}
        >
          <span className="font-medium text-ink">
            {dayLabel(tip.ms, { weekday: "short", month: "short", day: "numeric" })}
          </span>
          <span className="text-ink-muted"> · {plural(tip.value, "message", "messages")}</span>
        </Tip>
      )}
    </div>
    </>
  );
}
