import React from "react";
import ReactDOM from "react-dom/client";
import { PostHogProvider } from "@posthog/react";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { posthogOptions, posthogProjectToken } from "./lib/posthog";
import { initTheme } from "./lib/theme";

initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PostHogProvider apiKey={posthogProjectToken} options={posthogOptions}>
        <App />
      </PostHogProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
