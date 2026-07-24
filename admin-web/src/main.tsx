import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminPage } from "@app/components/AdminPage";
import "./index.css";

// Admin dashboard entry. The AdminPage component (imported from the shared
// ../app/src tree) handles its own password auth, tab routing, and data
// fetching — this file just mounts it and applies the persisted theme so the
// first paint matches the user's last choice (no flash).
const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// Apply saved theme before mount to avoid a flash of the wrong palette.
const saved = localStorage.getItem("zwork:admin-theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const theme = saved ?? (prefersDark ? "dark" : "light");
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.classList.toggle("light", theme === "light");

createRoot(root).render(
  <StrictMode>
    <AdminPage />
  </StrictMode>,
);
