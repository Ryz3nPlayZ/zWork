/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // All colors resolve to CSS variables so we can swap them per-theme.
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          soft: "rgb(var(--ink-soft) / <alpha-value>)",
          muted: "rgb(var(--ink-muted) / <alpha-value>)",
          faint: "rgb(var(--ink-faint) / <alpha-value>)",
        },
        paper: {
          DEFAULT: "rgb(var(--paper) / <alpha-value>)",
          soft: "rgb(var(--paper-soft) / <alpha-value>)",
          raised: "rgb(var(--paper-raised) / <alpha-value>)",
          sunken: "rgb(var(--paper-sunken) / <alpha-value>)",
          sidebar: "rgb(var(--paper-sidebar) / <alpha-value>)",
        },
        line: {
          DEFAULT: "rgb(var(--line) / <alpha-value>)",
          soft: "rgb(var(--line-soft) / <alpha-value>)",
          strong: "rgb(var(--line-strong) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
        },
        // Alpha-overlay border colors (OpenCode v2 pattern). The RGB is black
        // in light mode / white in dark (see --border-overlay in index.css);
        // alpha is applied per-class. Use via border-edge / border-edge-strong
        // / border-edge-muted instead of border-line for surfaces that should
        // feel soft rather than rigid.
        edge: {
          DEFAULT: "rgb(var(--border-overlay) / 0.10)",
          strong: "rgb(var(--border-overlay) / 0.20)",
          muted: "rgb(var(--border-overlay) / 0.06)",
        },
        success: {
          DEFAULT: "rgb(var(--success) / <alpha-value>)",
          fg: "rgb(var(--success-fg) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--warning) / <alpha-value>)",
          fg: "rgb(var(--warning-fg) / <alpha-value>)",
        },
        error: {
          DEFAULT: "rgb(var(--error) / <alpha-value>)",
          fg: "rgb(var(--error-fg) / <alpha-value>)",
        },
        info: {
          DEFAULT: "rgb(var(--info) / <alpha-value>)",
          fg: "rgb(var(--info-fg) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
        serif: [
          "'Instrument Serif'",
          "ui-serif",
          "Georgia",
          "Iowan Old Style",
          "Times New Roman",
          "serif",
        ],
      },
      boxShadow: {
        chat: "0 1px 2px rgb(var(--shadow) / 0.04), 0 8px 24px rgb(var(--shadow) / 0.06)",
        pop:  "0 1px 2px rgb(var(--shadow) / 0.05), 0 12px 32px rgb(var(--shadow) / 0.10)",
        // Soft floating elevation — layered (contact → ambient), pools below.
        // Pairs with the .hairline class on borderless surfaces.
        lift: "var(--shadow-lift)",
      },
      borderRadius: {
        xxl: "1.25rem",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%":   { "background-position": "200% 0" },
          "100%": { "background-position": "-200% 0" },
        },
        "logo-spin": {
          "0%":   { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "logo-spin-hover": {
          "0%":   { transform: "rotate(0deg) scale(1)" },
          "100%": { transform: "rotate(360deg) scale(1.08)" },
        },
      },
      animation: {
        "fade-in": "fade-in 180ms ease-out both",
        shimmer:   "shimmer 2.2s linear infinite",
        "logo-spin": "logo-spin 60s linear infinite",
      },
    },
  },
  plugins: [],
};
