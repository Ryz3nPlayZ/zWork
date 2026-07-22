export type PreviewMode = "auth" | "app" | "demo" | null;

function readPreviewParam(): string {
  if (typeof window === "undefined") return "";
  try {
    return new URLSearchParams(window.location.search).get("preview") || "";
  } catch {
    return "";
  }
}

/**
 * Production origins where the bundle runs as a public, no-login chat demo.
 * On these origins the app boots into demo mode automatically: a stub user
 * is seeded (no LoginScreen), chat sends route to the public /api/demo/chat
 * endpoint, and desktop-only nav (Scheduled/Inbox/Connectors/etc.) is hidden.
 *
 * Override at build time with VITE_ZWORK_DEMO_ORIGIN (comma-separated) for
 * staging environments. The desktop app (tauri://localhost) and the vite dev
 * server (localhost:1420) never match, so their behavior is unchanged.
 */
const DEMO_ORIGINS: string[] = (() => {
  const env = (import.meta.env.VITE_ZWORK_DEMO_ORIGIN as string | undefined)?.trim();
  if (env) return env.split(",").map((o) => o.trim()).filter(Boolean);
  return [
    "https://app.tryzwork.app",
    "https://tryzwork.app",
    "https://www.tryzwork.app",
  ];
})();

function isDemoOrigin(): boolean {
  if (typeof window === "undefined") return false;
  return DEMO_ORIGINS.includes(window.location.origin);
}

export function getPreviewMode(): PreviewMode {
  // Demo origin always wins — even if a ?preview= param is present, because
  // the demo bundle is purpose-built for this origin.
  if (isDemoOrigin()) return "demo";
  const envPreview = (import.meta.env.VITE_ZWORK_PREVIEW as string | undefined)?.trim() || "";
  const raw = envPreview || readPreviewParam();
  if (raw === "auth" || raw === "app" || raw === "demo") return raw;
  return null;
}

/** True when the app is running as the public web demo (origin-based).
 *  Safe to call from non-React modules (api.ts, Sidebar.tsx) that can't read
 *  the React-level previewMode value. Desktop and dev server return false. */
export function isDemoMode(): boolean {
  return getPreviewMode() === "demo";
}
