import type { AnalyticsSummary } from "./cloud";

/** What the message box says about the plan allowance. */
export type Allowance =
  | { kind: "out"; refillsAt: Date | null; window: "week" | "hours"; upgradeTo: "pro" | "max" | null }
  | { kind: "near"; percent: number; window: "week" | "hours" };

export function allowanceFrom(s: AnalyticsSummary): Allowance | null {
  const hours = s.five_hour_used / Math.max(1, s.five_hour_limit);
  const week = s.weekly_used / Math.max(1, s.weekly_limit);
  if (week >= 1 || hours >= 1) {
    const tier = s.user.tier;
    return {
      kind: "out",
      refillsAt: s.refills_at ? new Date(s.refills_at) : null,
      window: week >= 1 ? "week" : "hours",
      upgradeTo: tier === "free" ? "pro" : tier === "pro" ? "max" : null,
    };
  }
  if (week >= 0.8) return { kind: "near", percent: Math.floor(week * 100), window: "week" };
  if (hours >= 0.8) return { kind: "near", percent: Math.floor(hours * 100), window: "hours" };
  return null;
}

/** "at 3:40 PM", "tomorrow at 9:10 AM", "on Thursday at 3:40 PM". */
export function refillLabel(at: Date, now = new Date()): string {
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round(
    (new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
      - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000,
  );
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `on ${at.toLocaleDateString([], { weekday: "long" })} at ${time}`;
}
