import { invoke } from "@tauri-apps/api/core";

const CLOUD_BASE = "https://api.tryzwork.app";
const TOKEN_KEY = "zwork:cloud-token";
const AUTH_CHANGED_EVENT = "zwork:cloud-auth-changed";

class CloudFetchError extends Error {
  status: number;

  constructor(status: number, statusText: string, body: string) {
    super(friendlyCloudError(status, statusText, body));
    this.name = "CloudFetchError";
    this.status = status;
  }
}

export interface CloudUser {
  user_id: string;
  email: string;
  name: string;
  tier: "free" | "pro" | "max";
  access_code?: string | null;
  coupon_code?: string | null;
  stripe_customer_id?: string | null;
  subscription_id?: string | null;
  subscription_status?: string | null;
  subscription_price_id?: string | null;
  subscription_current_period_end?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalyticsDay {
  day: string;
  roots: number;
  continuations: number;
}

export interface ProviderOverview {
  provider_name: string;
  requests_7d: number;
  roots_7d: number;
  continuations_7d: number;
  total_tokens_7d: number;
  prompt_tokens_7d: number;
  completion_tokens_7d: number;
  last_model_id?: string | null;
  last_status?: number | null;
  last_observed_at?: string | null;
  requests_limit_day?: number | null;
  requests_remaining_day?: number | null;
  requests_reset_day_seconds?: number | null;
  tokens_limit_minute?: number | null;
  tokens_remaining_minute?: number | null;
  tokens_reset_minute_seconds?: number | null;
}

export interface AnalyticsSummary {
  user: CloudUser;
  router_label: string;
  root_requests_today: number;
  continuation_requests_today: number;
  active_runs: number;
  root_requests_total: number;
  continuation_requests_total: number;
  five_hour_limit: number;
  five_hour_used: number;
  weekly_limit: number;
  weekly_used: number;
  past_week: AnalyticsDay[];
  past_month: AnalyticsDay[];
  managed_gateway_ready: boolean;
  managed_gateway_status: string;
  billing_enabled: boolean;
  billing_status: string;
  owner_provider_overview: ProviderOverview[];
  api_url: string;
  analytics_url: string;
  db_url: string;
}

export interface BillingSession {
  url: string;
}

function friendlyCloudError(status: number, statusText: string, body: string) {
  const message = body.trim();
  const normalized = message.replace(/^"+|"+$/g, "");
  const mapped =
    normalized === "missing_access_code"
      ? "Enter an access code first."
      : normalized === "email_and_password_required"
        ? "Enter both your email and password."
        : normalized === "name_email_password_required"
          ? "Enter your name, email, and password."
          : normalized.includes("verify your email")
            ? "Verify your email before signing in."
      : normalized === "invalid_access_code"
        ? "That access code is not valid on this server."
        : normalized === "not_signed_in"
          ? "Your session expired. Sign in again."
          : normalized === "access_denied"
            ? "Your account does not have access to this route yet."
            : normalized === "user_lookup_failed"
              ? "The server could not load your account. Try signing in again."
              : normalized === "access_code_update_failed"
                ? "The server could not apply this access code right now."
                : normalized === "root_request_quota_exceeded"
                  ? "You have reached the current five-hour quota. Wait for quota to roll forward or upgrade your plan."
                  : normalized === "too_many_active_runs"
                    ? "You already have too many active runs. Wait for one to finish before starting another."
                    : normalized === "hosted_gateway_not_configured"
                      ? "zWork Router is not configured on the server right now."
                      : normalized === "stripe_billing_not_configured"
                        ? "Stripe billing is not configured on this server yet."
                        : normalized === "stripe_price_not_configured"
                          ? "The Pro Stripe price is not configured on this server."
                      : normalized.startsWith("router_upstreams_failed:")
                        ? "zWork Router could not get a healthy response from any upstream provider."
                        : normalized;
  if (mapped) return `${status} ${statusText}: ${mapped}`;
  return `${status} ${statusText}`;
}

function getToken() {
  return window.localStorage.getItem(TOKEN_KEY) || "";
}

export function getCloudToken() {
  return getToken();
}

function setToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT));
}

export function clearCloudToken() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT));
}

export function onCloudAuthChanged(listener: () => void) {
  window.addEventListener(AUTH_CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener(AUTH_CHANGED_EVENT, listener);
  };
}

async function cloudFetch<T>(path: string, init?: RequestInit, token = getToken()): Promise<T> {
  const headers = new Headers(init?.headers || {});
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${CLOUD_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new CloudFetchError(response.status, response.statusText, text);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function startDesktopGoogleSignIn(): Promise<CloudUser> {
  const code = await invoke<string>("begin_desktop_auth", {
    startUrl: `${CLOUD_BASE}/api/desktop/auth/start`,
  });
  const result = await cloudFetch<{ token: string; user: CloudUser }>("/api/desktop/auth/exchange", {
    method: "POST",
    body: JSON.stringify({ code }),
  }, "");
  setToken(result.token);
  return result.user;
}

export async function startDesktopEmailSignIn(email: string, password: string): Promise<CloudUser> {
  const result = await cloudFetch<{ token: string; user: CloudUser }>("/api/desktop/auth/email/sign-in", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  }, "");
  setToken(result.token);
  return result.user;
}

export async function startDesktopEmailSignUp(name: string, email: string, password: string, callbackUrl?: string) {
  return cloudFetch<{ ok: boolean; verification_required: boolean; message: string }>(
    "/api/desktop/auth/email/sign-up",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        email,
        password,
        callback_url: callbackUrl || `${window.location.origin}/auth/verified`,
      }),
    },
    "",
  );
}

export async function fetchCloudSession(): Promise<CloudUser | null> {
  const token = getToken();
  if (!token) return null;
  try {
    return await cloudFetch<CloudUser>("/api/session");
  } catch (error) {
    if (error instanceof CloudFetchError && (error.status === 401 || error.status === 403)) {
      clearCloudToken();
    }
    return null;
  }
}

export async function logoutCloudSession() {
  const token = getToken();
  if (!token) return;
  try {
    await cloudFetch("/api/desktop/auth/logout", { method: "POST" });
  } finally {
    clearCloudToken();
  }
}

export async function redeemAccessCode(code: string) {
  return cloudFetch<CloudUser>("/api/dev/redeem-coupon", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function fetchAnalyticsSummary() {
  return cloudFetch<AnalyticsSummary>("/api/analytics/summary");
}

export async function createBillingCheckoutSession(annual = false) {
  return cloudFetch<BillingSession>("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({
      annual,
      success_url: `${window.location.origin}/billing/success`,
      cancel_url: `${window.location.origin}/billing/cancel`,
    }),
  });
}

export async function createBillingPortalSession() {
  return cloudFetch<BillingSession>("/api/billing/portal", {
    method: "POST",
    body: JSON.stringify({
      return_url: `${window.location.origin}/settings/billing`,
    }),
  });
}

