# Design — zWork App Pages

A locked design system for the zWork desktop app pages (Connectors, Analytics, Plan, Settings).
Every page redesign reads this file before emitting code.

## Genre
modern-minimal

## Theme

Light mode:
- `--paper`   242 240 232
- `--paper-soft` 248 246 238
- `--paper-raised` 252 250 242
- `--paper-sunken` 234 232 224
- `--paper-sidebar` 236 234 226
- `--ink`     48 46 40
- `--ink-soft` 80 76 68
- `--ink-muted` 130 126 115
- `--ink-faint` 175 170 158
- `--line`    218 214 202
- `--line-soft` 228 224 212
- `--line-strong` 200 196 184
- `--accent`  48 46 40
- `--bubble`  232 230 222
- `--bubble-fg` 48 46 40
- `--shadow`  30 28 24

Dark mode:
- `--paper`   42 42 46
- `--paper-soft` 48 48 52
- `--paper-raised` 56 56 60
- `--paper-sunken` 36 36 40
- `--paper-sidebar` 38 38 42
- `--ink`     220 218 210
- `--ink-soft` 190 188 180
- `--ink-muted` 140 138 130
- `--ink-faint` 100 98 90
- `--line`    60 60 65
- `--line-soft` 54 54 58
- `--line-strong` 72 72 78
- `--accent`  220 218 210
- `--bubble`  72 72 76
- `--bubble-fg` 232 230 222

## Typography

- Body: system sans-serif (Inter, -apple-system, BlinkMacSystemFont, Segoe UI)
- Editorial: Instrument Serif (used sparingly for onboarding only)
- Type scale:
  - Page title: `text-[28px] font-semibold tracking-tight text-ink`
  - Page subtitle: `text-[14px] text-ink-muted`
  - Section heading: `text-[15px] font-semibold text-ink`
  - Card title: `text-[14px] font-semibold text-ink`
  - Body: `text-[13px] text-ink-muted`
  - Caption/label: `text-[12px] text-ink-faint` or `text-[11px]`

## Spacing

- Page max-width: 760–900px depending on content
- Page padding: `px-6 py-8`
- Card padding: `p-5` or `p-6`
- Card gap: `gap-3` or `gap-4`
- Section gap: `mb-8`

## Motion

- Press effect: `press` class (scale 0.97 on active, 120ms transition)
- Hover transitions: 140ms ease on colors
- Focus ring: `ring-focus` (2px offset, uses paper + accent)
- No scroll-triggered animations (app UI, not marketing)

## Microinteractions

- Silent success (no toasts for routine actions)
- Loading states with spinners, not skeletons
- Disabled states at opacity-40 with cursor-not-allowed

## CTA Voice

- Primary: `bg-ink text-paper hover:bg-ink/90` (solid, rounded-lg or rounded-xl)
- Secondary: `border border-line bg-paper text-ink hover:bg-paper-sunken`
- Destructive: `text-ink-muted hover:text-red-500 hover:border-red-300`
- NEVER use `text-white` with `bg-ink` — always use `text-paper`

## App Page Rules

- Function carries the page — no decorative enrichment
- Cards use `rounded-2xl border border-line bg-paper-raised`
- Grid layouts use `grid-cols-1 sm:grid-cols-2` or `sm:grid-cols-3`
- All interactive elements need visible focus states
- All buttons need aria-labels when icon-only
