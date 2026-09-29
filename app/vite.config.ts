import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config tuned for Tauri (fixed port, no clear-screen, env passthrough).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        // Browser dev against a sidecar started with the same
        // ZWORK_SIDECAR_TOKEN (the Tauri host injects it in the app).
        headers: process.env.ZWORK_SIDECAR_TOKEN
          ? { "x-zwork-token": process.env.ZWORK_SIDECAR_TOKEN }
          : undefined,
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    sourcemap: true,
  },
});
