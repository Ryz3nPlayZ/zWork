import type { ScheduledTask } from "../../lib/api";

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = [1, 2, 3, 4, 5];

export function sameDays(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((d) => s.has(d));
}

/** "09:00" → "9:00 AM" in the user's locale. */
export function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function describeInterval(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} minutes`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return h === 1 ? "Every hour" : `Every ${h} hours`;
  return `Every ${h} h ${m} min`;
}

export function describeDays(days: readonly number[] | null | undefined): string {
  const d = [...(days ?? [])].sort((a, b) => a - b);
  if (d.length === 0 || d.length === 7) return "Every day";
  if (sameDays(d, WEEKDAYS)) return "Weekdays";
  if (sameDays(d, [0, 6])) return "Weekends";
  if (d.length === 1) return `${DAY_LONG[d[0]]}s`;
  return d.map((i) => DAY_SHORT[i] ?? "?").join(", ");
}

/** Plain-language schedule: "Weekdays at 9:00 AM", "Every 2 hours". */
export function describeSchedule(t: Pick<ScheduledTask, "interval_minutes" | "daily_time" | "daily_weekdays">): string {
  if (t.interval_minutes) return describeInterval(t.interval_minutes);
  if (t.daily_time) return `${describeDays(t.daily_weekdays)} at ${formatClock(t.daily_time)}`;
  return "On a schedule";
}

function clockOf(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** When the next run is: "in 12 min", "today at 3:00 PM", "tomorrow at 9:00 AM", "Monday at 9:00 AM". */
export function formatNext(ms: number | null, now = Date.now()): string {
  if (!ms) return "not set";
  const diff = ms - now;
  if (diff < 60_000) return "any moment now";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)} min`;
  const d = new Date(ms);
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `today at ${clockOf(d)}`;
  if (days === 1) return `tomorrow at ${clockOf(d)}`;
  if (days < 7) return `${DAY_LONG[d.getDay()]} at ${clockOf(d)}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${clockOf(d)}`;
}

/** How long ago something happened: "just now", "5 min ago", "yesterday", "Nov 3". */
export function formatAgo(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days === 0) {
    const h = Math.floor(diff / 3_600_000);
    return h === 1 ? "an hour ago" : `${h} hours ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}
