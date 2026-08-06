import React from "react";
import ReactDOM from "react-dom/client";
import { PostHogProvider } from "@posthog/react";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { posthogOptions, posthogProjectToken } from "./lib/posthog";
import { isMacOS, isWindows } from "./lib/platform";
import { initTheme } from "./lib/theme";
import { applyTranslucency, loadTranslucencyPref } from "./lib/translucency";

// Platform class on <html> for the few CSS rules that must diverge per-OS
// (e.g. persistent scrollbar thumbs on Windows — see index.css).
document.documentElement.classList.add(
  isMacOS() ? "plat-mac" : isWindows() ? "plat-windows" : "plat-linux",
);

initTheme();
// Apply the saved sidebar-translucency pref before first paint so the sidebar
// doesn't flash opaque before the effect resolves.
applyTranslucency(loadTranslucencyPref());

// Overlay window transparency — applied synchronously, BEFORE first paint. The
// global `body { @apply bg-paper }` paints an opaque background; the
// `overlay-window` <html> class overrides html/body/#root to transparent (see
// index.css). Adding it here (rather than in a React useEffect inside
// OverlayChatView) eliminates the opaque "box around the pill" that flashed on
// every summon: the effect ran after first paint, so macOS showed the bg-paper
// body for at least one frame — and window.show() can retrigger that repaint.
// The window label is constant for the process lifetime (injected by Tauri
// before any app JS runs), so this synchronous read is safe at boot.
if (typeof window !== "undefined") {
  const label = (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (label === "overlay") {
    document.documentElement.classList.add("overlay-window");
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {posthogProjectToken ? (
        <PostHogProvider apiKey={posthogProjectToken} options={posthogOptions}>
          <App />
        </PostHogProvider>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
