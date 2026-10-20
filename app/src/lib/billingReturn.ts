/** Where Stripe hands the browser back after checkout or the billing portal.
 *  Both the web app and the desktop app send it to app.tryzwork.app/billing/…;
 *  desktop return URLs carry `?from=desktop`, since that browser tab isn't
 *  where the user is using zWork. */
export type BillingReturn = "success" | "cancel" | "portal";

const PATHS: Record<string, BillingReturn> = {
  "/billing/success": "success",
  "/billing/cancel": "cancel",
  "/billing/portal-return": "portal",
  // Older web builds sent the portal back here.
  "/settings/billing": "portal",
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__;
}

/** The return this page load is, if any. */
export function readBillingReturn(): BillingReturn | null {
  if (!isBrowser()) return null;
  return PATHS[window.location.pathname.replace(/\/+$/, "")] ?? null;
}

/** True for a desktop user's return, which gets a standalone page. */
export function isDesktopBillingReturn(): boolean {
  if (!readBillingReturn()) return false;
  return new URLSearchParams(window.location.search).get("from") === "desktop";
}

/** True when the page was opened on a path that shows the Plan page. */
export function opensPlanPage(): boolean {
  if (!isBrowser()) return false;
  const path = window.location.pathname.replace(/\/+$/, "");
  return path === "/plan" || path === "/billing" || !!readBillingReturn();
}
