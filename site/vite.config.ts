import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The changelog page reads ../CHANGELOG.md at build time.
  server: { fs: { allow: [".."] } },
});
