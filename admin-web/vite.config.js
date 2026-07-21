import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
var __dirname = dirname(fileURLToPath(import.meta.url));
// Admin dashboard SPA for admin.tryzwork.app.
//
// Shares its dashboard source with the desktop app: components under
// ../app/src/components/admin/ and ../app/src/components/AdminPage.tsx are
// imported directly via the "@app/*" alias (see tsconfig.json + resolve.alias
// below). This keeps a single source of truth — edit the dashboard once and
// both the desktop app and this web build pick it up.
//
// In production, Caddy serves this dist/ at admin.tryzwork.app and proxies
// /api/* to axum_api:8080 (same pattern as app.tryzwork.app). During local
// dev, the proxy below points /api at the production API.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@app": resolve(__dirname, "../app/src"),
        },
    },
    server: {
        port: 4311,
        proxy: {
            "/api": {
                target: "https://api.tryzwork.app",
                changeOrigin: true,
                secure: true,
            },
        },
    },
    build: {
        target: "es2021",
        sourcemap: false,
        // relative ../app path so the chunk-graph output is self-contained
        chunkSizeWarningLimit: 600,
    },
});
