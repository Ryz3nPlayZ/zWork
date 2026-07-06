import React from "react";
import ReactDOM from "react-dom/client";
import { PostHogProvider } from "@posthog/react";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { posthogOptions, posthogProjectToken } from "./lib/posthog";
import { initTheme } from "./lib/theme";
import { applyTranslucency, loadTranslucencyPref } from "./lib/translucency";

initTheme();
// Apply the saved sidebar-translucency pref before first paint so the sidebar
// doesn't flash opaque before the effect resolves.
applyTranslucency(loadTranslucencyPref());

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
