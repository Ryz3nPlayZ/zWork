import posthog from "posthog-js";
import type { CloudUser } from "./cloud";

export const posthogProjectToken = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN || "";

export const posthogOptions = {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
  defaults: "2026-01-30",
  person_profiles: "identified_only",
} as const;

export function posthogEnabled() {
  return !!posthogProjectToken;
}

export function setPostHogTelemetryEnabled(next: boolean) {
  if (!posthogEnabled()) return;
  if (next) {
    posthog.opt_in_capturing();
    return;
  }
  posthog.opt_out_capturing();
}

export function identifyPostHogUser(user: CloudUser) {
  if (!posthogEnabled()) return;
  posthog.identify(user.user_id, {
    email: user.email,
    name: user.name,
    tier: user.tier,
    access_code: user.access_code ?? user.coupon_code ?? null,
  });
}

export function resetPostHogUser() {
  if (!posthogEnabled()) return;
  posthog.reset();
}

export function capturePostHogEvent(event: string, properties: Record<string, unknown> = {}) {
  if (!posthogEnabled()) return;
  posthog.capture(event, properties);
}

export function registerPostHogProperties(properties: Record<string, unknown>) {
  if (!posthogEnabled()) return;
  posthog.register(properties);
}
