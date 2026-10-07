import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mockAdminApi } from "./mock/mockApi";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
// dev, the proxy below points /api at the production API. `npm run dev:mock`
// (vite --mode mock) answers /api/admin/* from mock/mockApi.ts instead.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "mock" ? [mockAdminApi()] : [])],
  resolve: {
    alias: {
      "@app": resolve(__dirname, "../app/src"),
    },
    // Files under ../app/src would otherwise be free to resolve bare imports
    // from ../app/node_modules; a second React there would break hooks.
    // Always take these from admin-web.
    dedupe: ["react", "react-dom", "recharts", "lucide-react"],
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
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Vendor code changes far less often than the dashboard; separate
        // chunks keep it cached across deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](recharts|d3-[^\\/]+|victory-vendor|internmap)[\\/]/.test(id)) return "charts";
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          return "vendor";
        },
      },
    },
  },
}));
