# Design — zWork App Pages

A locked design system for the zWork desktop app pages (Connectors, Analytics, Plan, Settings).
Every page redesign reads this file before emitting code.

## Genre
modern-minimal

## Theme

Light mode:
- `--paper`   242 240 232
- `--paper-soft` 238 236 228
- `--paper-raised` 234 232 224
- `--paper-sunken` 246 244 236
- `--paper-sidebar` 236 234 226
- `--ink`     48 46 40
- `--ink-soft` 80 76 68
- `--ink-muted` 110 106 96
- `--ink-faint` 155 150 138
- `--line`    218 214 202
- `--line-soft` 228 224 212
- `--line-strong` 200 196 184
- `--accent`  48 46 40
- `--shadow`  30 28 24
- `--border-overlay` 0 0 0
- `--success` 16 185 129
- `--success-fg` 255 255 255
- `--warning` 245 158 11
- `--warning-fg` 48 46 40
- `--error` 239 68 68
- `--error-fg` 255 255 255
- `--info` 59 130 246
- `--info-fg` 255 255 255

Dark mode:
- `--paper`   22 22 24
- `--paper-soft` 26 26 29
- `--paper-raised` 31 31 34
- `--paper-sunken` 18 18 20
- `--paper-sidebar` 20 20 22
- `--ink`     236 236 234
- `--ink-soft` 213 213 211
- `--ink-muted` 160 160 157
- `--ink-faint` 108 108 106
- `--line`    45 45 49
- `--line-soft` 40 40 44
- `--line-strong` 62 62 66
- `--accent`  236 236 234
- `--shadow`  0 0 0
- `--border-overlay` 255 255 255
- `--success` 52 211 153
- `--success-fg` 0 0 0
- `--warning` 251 191 36
- `--warning-fg` 0 0 0
- `--error` 248 113 113
- `--error-fg` 0 0 0
- `--info` 96 165 250
- `--info-fg` 0 0 0

Note: the light-mode surface hierarchy deliberately inverts the usual order
(OpenCode mirror rule in `app/src/index.css`): `paper-raised` is DARKER than
`paper`, stepping toward the foreground instead of lighter, and `paper-sunken`
is the lightest surface. The dark palette is a soft warm-neutral set, not pure
black. `app/src/index.css` is the source of truth; the values above mirror it.

### Color schemes
Parchment remains the default and locked system palette. The Settings color-scheme
picker is an allowed user preference; every scheme must still define the full token
set above so app UI stays coherent when a non-default scheme is active.

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
