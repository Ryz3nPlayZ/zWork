# zWork — Landing Page Design Dossier

Canonical design context for **marketing surfaces** (landing page, and anything
public-facing that isn't the app itself). This file exists because the design
context for a landing page was scattered across four documents that disagree
with each other.

**Read order for any landing work:** this file → `design.md` (locked app system)
→ `app/src/index.css` (token source of truth) → `LANDING_PAGE_BRIEF.md` (May
copy/brief, partly superseded).

> **Status:** direction not yet chosen. Section 9 holds the open decisions.
> Nothing here is a commitment to build yet — it's the organized ground we
> choose from.

---

## 1. Surface map — where a landing page actually goes

| Host | Served from | Current posture | Source |
|------|-------------|-----------------|--------|
| `api.tryzwork.app` | Caddy → `axum_api:8080` | public | `docs/CLOUD.md` |
| `app.tryzwork.app` | `/var/www/app.tryzwork.app` | **the real desktop app in demo mode** — no-login chat | `docs/CLOUD.md` §Web demo |
| `admin.tryzwork.app` | `/var/www/admin.tryzwork.app` | password-gated admin SPA | `admin-web/README.md` |
| `analytics.tryzwork.app` | PostHog shortcut | public | `docs/CLOUD.md` |
| `tryzwork.app` / `www.tryzwork.app` | **not documented in-repo** | listed as demo origins; cert list includes them | `app/src/lib/preview.ts`, `docs/CLOUD.md` |

**The important consequence.** `app/src/lib/preview.ts` → `isDemoMode()` returns
`true` for `tryzwork.app` **and** `www.tryzwork.app` as well as
`app.tryzwork.app`. So if a marketing landing page takes the root domain, it must
also be removed from that origin list — otherwise the desktop app source, built
for web and deployed to the root, would self-identify as the demo.

**Assumption to verify server-side (not checkable from this repo):** what Caddy
currently serves at `/var/www/tryzwork.app`. Confirm before planning a deploy.

**Recommended shape:** landing page at `tryzwork.app` (+ `www`), demo stays at
`app.tryzwork.app`. That gives the landing a real "Try it" CTA that deep-links to
a *different* host, keeps the demo's no-login promise intact, and removes the
need for a `/try` route on the marketing bundle.

---

## 2. The positioning fork — resolve this before any visual work

Three documents in this repo sell three different products to three different
people. This is the single biggest blocker to a design direction, because
audience determines headline, hero, section order, and CTA.

| Source | Date | Audience | Core promise | Tagline |
|--------|------|----------|--------------|---------|
| `LANDING_PAGE_BRIEF.md` | May 28 | **Non-technical knowledge workers** — small business owners, ops/marketing, students, writers, admin staff | Does your work: organizes files, writes docs, fills forms | "The AI assistant that does jobs, not just answers questions." |
| `assets/banner/README.md` + `minimal-chat/index.html` meta | Jul 24 | **Non-devs** | Brings agent power to non-developers | "Bringing the agentic era to non-devs" |
| `README.md` | **Aug 25** | Implied: someone with *recurring* work; install steps are developer-grade (`brew`, `curl \| bash`, `./run.sh`) | **Scheduled jobs**, runs inside your apps (Gmail, Calendar, Slack), controls desktop + browser, saves reusable workflows | "Does the work **on a schedule, inside your apps**. It does things. It doesn't just talk." |
| `docs/PRODUCT.md` | stale | Technical professionals | "Pair programmer and creative partner" | — |

**Read:** the May brief sells *"AI that does chores for normal people."* The
Aug 25 README sells *"AI that runs your recurring work inside your tools."* Those
are different products with different proof, different screenshots, and different
buyers. The Aug README is the newest signal and matches what actually shipped
(scheduled jobs, Composio integrations, workers, Postgres cloud).

`docs/PRODUCT.md` is older than both and describes a pre-pivot "pair programmer"
— treat it as historical, not as a brief.

**Unresolved:** does the landing page target the **non-dev knowledge worker**
(May brief, differentiation angle: "the agentic gap") or the **person with
recurring work** (Aug README, differentiation angle: "it runs without you")?
The shared spine either way is *it does things instead of talking*. The
difference is what the hero shows.

---

## 3. Locked design tokens

`app/src/index.css` is the **source of truth**. `app/tailwind.config.js` maps
every token to a Tailwind color name. `design.md` (root) documents them.
`docs/DESIGN.md` does *not* — it claims Primary Blue `#4285F4`, which appears
nowhere in the live code. Ignore `docs/DESIGN.md` for color.

### Palette — light (`:root`, `:root.light`)

| Token | RGB | Hex | Role |
|-------|-----|-----|------|
| `--paper` | `242 240 232` | `#F2F0E8` | base surface |
| `--paper-soft` | `238 236 228` | `#EEECE4` | |
| `--paper-raised` | `234 232 224` | `#EAE8E0` | cards, panels |
| `--paper-sunken` | `246 244 236` | `#F6F4EC` | wells, insets |
| `--paper-sidebar` | `236 234 226` | `#ECE8E2` | |
| `--ink` | `48 46 40` | `#302E28` | primary text |
| `--ink-soft` | `80 76 68` | `#504C44` | |
| `--ink-muted` | `110 106 96` | `#6E6A60` | secondary text |
| `--ink-faint` | `155 150 138` | `#9B968A` | **decorative only** (see below) |
| `--line` | `218 214 202` | `#DAD6CA` | borders |
| `--line-soft` | `228 224 212` | `#E4E0D4` | |
| `--line-strong` | `200 196 184` | `#C8C4B8` | |
| `--accent` | `48 46 40` | `#302E28` | **identical to ink — monochrome** |
| `--success` | `16 185 129` | `#10B981` | |
| `--warning` | `245 158 11` | `#F59E0B` | |
| `--error` | `239 68 68` | `#EF4444` | |
| `--info` | `59 130 246` | `#3B82F6` | |

### Palette — dark (`:root.dark`)

| Token | RGB | Hex | Role |
|-------|-----|-----|------|
| `--paper` | `22 22 24` | `#161618` | base (soft warm-neutral, **not** black) |
| `--paper-soft` | `26 26 29` | `#1A1A1D` | |
| `--paper-raised` | `31 31 34` | `#1F1F22` | |
| `--paper-sunken` | `18 18 20` | `#121214` | |
| `--paper-sidebar` | `20 20 22` | `#141416` | |
| `--ink` | `236 236 234` | `#ECECEA` | |
| `--ink-soft` | `213 213 211` | `#D5D5D3` | |
| `--ink-muted` | `160 160 157` | `#A0A09D` | |
| `--ink-faint` | `108 108 106` | `#6C6C6A` | decorative only |
| `--line` | `45 45 49` | `#2D2D31` | |
| `--line-strong` | `62 62 66` | `#3E3E42` | |
| `--accent` | `236 236 234` | `#ECECEA` | monochrome |

Status colors flip `-fg` to black in dark mode.

### Contrast audit (WCAG 2.1, computed against `--paper`)

A landing page carries far more body copy than app UI, so this matters more here.

| Pair | Ratio | Verdict |
|------|-------|---------|
| light: `ink` on `paper` | **11.90:1** | ✅ AAA |
| light: `ink-muted` on `paper` | **4.73:1** | ✅ AA normal text — safe for body copy |
| light: `ink-faint` on `paper` | **2.59:1** | ❌ **fails AA.** Large text / decorative only. Do not use for captions on the landing page. |
| dark: `ink-muted` on `paper` | **6.90:1** | ✅ AA+ — roomier than light |

**Rule for the landing page:** long-form copy uses `ink` or `ink-muted`. If a
design calls for `ink-faint` at a readable size, that's a token violation — mint a
landing-specific muted step instead of reaching for `ink-faint`.

### The OpenCode mirror rule (do not break)

In **light** mode the surface hierarchy steps *darker* as it comes forward:
`paper-sunken` (#F6F4EC, lightest) → `paper` (#F2F0E8) → `paper-soft` →
`paper-raised` (#EAE8E0, darkest). This is the inverse of the usual "raised =
lighter" convention. Documented in `app/src/index.css` as deliberate. Any card,
panel, or inset on the landing page must follow it, or the page will read as a
different product from the app.

### Typography

| Role | Stack | Notes |
|------|-------|-------|
| Sans | `'Inter Variable'` → `Inter` → system | **Bundled** via `@fontsource-variable/inter`. Identical metrics on macOS/Windows/Linux. |
| Serif | `'Instrument Serif'` → `ui-serif` → Georgia | **Bundled** as `app/public/fonts/instrument-serif-{regular,italic}.woff2`, `font-display: swap` |

App type scale (from `design.md`): page title `28px/600/tracking-tight`, section
heading `15px/600`, body `13px text-ink-muted`, caption `12px`/`11px`.

**That scale is sized for a 760–900px app window — it is too small for a landing
page.** A landing page needs its own display scale (a 28px "page title" is a
section label at marketing width). This is an *addition* to the locked system,
not a contradiction of it, but it must be written down rather than improvised.

**Serif amendment needed.** `design.md` says Instrument Serif is "used sparingly
for onboarding only." Using it as a landing display face is a real expansion of
that rule — and the strongest available differentiator, since the font is already
bundled and licensed. Decide it explicitly and record it here.

### Motion

From `design.md`: press effect `scale(0.97)` / 120ms; hover color transitions
140ms ease; focus ring `ring-focus` (2px offset, paper + accent).

`design.md` also states: **"No scroll-triggered animations (app UI, not
marketing)."** That clause is a carve-out — scroll-triggered motion is *available*
to the landing page and does not violate the locked system. It has simply never
been used, because nothing marketing-facing exists yet.

### CTA voice (locked, carry over verbatim)

- Primary: `bg-ink text-paper hover:bg-ink/90`, rounded-lg / rounded-xl
- Secondary: `border border-line bg-paper text-ink hover:bg-paper-sunken`
- **Never** `text-white` with `bg-ink` — always `text-paper`
- Icon-only buttons need `aria-label`; all interactive elements need visible focus

---

## 4. Brand asset inventory

### Exists and is reusable

| Asset | Path | Notes |
|-------|------|-------|
| Logo mark (SVG) | `app/public/zwork.svg` | monochrome black fill, `viewBox="0 0 40 40"`, **6 rounded parallelograms** around center |
| Logo mark (React) | `app/src/components/Logo.tsx` | `fill-ink`, `muted` prop → `fill-ink-muted`, `aria-hidden` |
| Wordmark | `app/src/components/Logo.tsx` | `Logo size={20}` + `text-[13px] font-semibold tracking-tight` |
| OG card | `assets/banner/banner-og-{light,dark}.svg` + `.png` | 1200×630, tagline baked in |
| Wide cover | `assets/banner/banner-wide-{light,dark}.svg` + `.png` | 1500×500 |
| Instrument Serif | `app/public/fonts/instrument-serif-{regular,italic}.woff2` | regular 15,040 B, italic 15,684 B |
| OG/twitter meta pattern | `minimal-chat/index.html` | copy the block, swap title/description/image |
| Light rays | `app/src/components/LightRays.tsx` | **CSS gradient only** — see perf note |
| Logo particles | `app/src/components/LogoParticles.tsx` | 13.6 KB; exists but is **not** wired into `Landing.tsx` |

**Logo geometry:** 6 slats, `radius 12.5`, slat `4.2 × 11`, `skewX(-18°)`, `rx 1.6`
— "evoking motion / a gear in soft form" (component comment). Any animated or
derived mark must keep the 6-slat silhouette; don't redraw it as a 5- or 8-point
star.

**`LightRays` is dark-surface only.** It hardcodes `DEFAULT_COLOR = "#ffffff"` at
very low alpha (`0d` = 5%, `08` = 3%), so it is a *white* glow. On parchment it
does effectively nothing.

**Perf constraint (documented, do not regress):** `LightRays.tsx` carries the
comment *"WebGL path removed to eliminate CPU spikes from software-rendered
WebKit webviews."* `app/package.json` still ships `three`, `ogl`,
`@react-three/fiber`, `@react-three/postprocessing` — but a marketing hero should
**not** reintroduce a WebGL/canvas effect. Prefer CSS transforms, `framer-motion`,
or pre-rendered video.

### Missing — must be produced before build

| Need | Why it's a problem |
|------|--------------------|
| **App screenshots at marketing resolution** | The app is designed for a 760–900px window (`design.md`). Native screenshots will be small and low-DPI at landing widths. Capture at 2× and place inside a designed frame, or it will look like a screenshot of a toy. |
| **Real task artifacts** | "It does things" needs *proof objects* — a generated spreadsheet, a research doc, a before/after folder tree, a sent email. None exist in the repo. Highest-value new assets. |
| **Hero video / screen recording** | `LANDING_PAGE_BRIEF.md` open question #1. Nothing recorded. |
| **Favicon set / apple-touch-icon** | Only `zwork.svg`. No PNG fallbacks, no `manifest`. |
| **Social proof** | Brief open question #3 — no testimonials exist. |

---

## 5. Build & deploy convention

Follow the **standalone web-surface pattern** already used twice
(`admin-web/`, `minimal-chat/`) rather than bolting onto `app/`.

**Shape:** standalone Vite + React 18 + TypeScript + Tailwind 3 SPA.
`darkMode: "class"`. Tokens copied into `src/index.css`.

**Dev port:** `1420` = app, `4310` = minimal-chat, `4311` = admin-web →
**use `4312`** for a landing app.

**Two precedents for sharing code with the app — pick deliberately:**

| Precedent | How |
|-----------|-----|
| `admin-web` | **Imports** from `../app/src/components/admin/` |
| `minimal-chat` | **Copies** tokens + components, commented *"ported verbatim from app/src/index.css so the demo reads as the same product"* |

**Known duplication cost:** the palette now lives in 4 places
(`app/src/index.css`, `minimal-chat/src/index.css`, its own `tailwind.config.js`,
plus whatever the landing adds). Copying a 5th time matches convention and keeps
the landing independently deployable; extracting a shared token file is cleaner
but is a refactor touching live surfaces. **Recommendation:** copy for v1 (matches
`minimal-chat`) and record the debt here.

**Deploy:** `scripts/deploy-<name>.sh` → `npm run build` → `rsync -avz --delete`
to `/var/www/<host>` → Caddy serves it. SSH via `~/.ssh/zwork-server`, overridable
with `ZWORK_SERVER_HOST` / `ZWORK_SERVER_USER` / `ZWORK_SERVER_KEY`. First deploy
also needs a DNS A record + Caddy reload (`sudo docker compose up -d --build caddy`).
Model the script on `scripts/deploy-admin-web.sh` — cleanest of the three.

---

## 6. Conflicts to resolve (found during this audit)

| # | Conflict | Severity | Action |
|---|----------|----------|--------|
| 1 | **`docs/DESIGN.md` claims Primary `#4285F4` blue.** The live palette is monochrome parchment; no blue exists in any token. | High — following it produces a blue page for a monochrome product | Fix or delete `docs/DESIGN.md`. |
| 2 | **Two files named like the design system:** root `design.md` (live, locked, app pages) vs `docs/DESIGN.md` (stale, contradicts #1). | High | Keep root `design.md`; fold in whatever in `docs/DESIGN.md` is still true; drop the rest. |
| 3 | **The shipped tagline violates the brand's own tone rules.** `assets/banner/README.md` and `minimal-chat/index.html` use **"Bringing the agentic era to non-devs"**, but `LANDING_PAGE_BRIEF.md` §Tone of Voice bans the word outright: *"No: 'AI-native,' 'agentic,' 'synergy,' 'paradigm shift'."* | High — it is live on the OG card today | Pick one: relax the tone rule, or change the tagline. |
| 4 | **Positioning fork** — non-dev file-chores (May brief) vs scheduled work inside your apps (Aug README). See §2. | **Highest — blocks the hero** | Decide before designing. |
| 5 | **Banner dark background drift.** Banners use `#2A2A2E`; app dark `--paper` is `#161618`. Banners predate the current dark palette. | Low | Re-rasterize, or accept as a one-off. |
| 6 | `docs/PRODUCT.md` describes a pre-pivot "pair programmer / creative partner". | Low | Mark historical. |
| 7 | **Name collision:** `app/src/components/Landing.tsx` is not a marketing page — it's the in-app post-launch home (time-aware greeting + chat composer). | Medium — will cause confusion | Call that **"the in-app home"**; call the new work **"the marketing landing page"**. |

---

## 7. Open decisions

Cheap to answer; each unlocks work downstream.

1. **Positioning** — non-dev knowledge worker, or person with recurring work? (§2)
2. **Root domain** — does the marketing page take `tryzwork.app`, requiring removal
   of `tryzwork.app` + `www.tryzwork.app` from `isDemoMode()` in
   `app/src/lib/preview.ts`? Or does it live elsewhere?
3. **Serif display** — promote Instrument Serif from "onboarding only" to a landing
   display face? (Amends `design.md`.)
4. **Theme priority** — the brief says light-primary with a dark variant; the app's
   dark theme is arguably the more distinctive surface. Which is the *designed* one?
5. **CTA** — download binaries only, or download + "try in browser" deep-link to
   `app.tryzwork.app`?
6. **Hero media** — video, animated product frame, or static plate?
7. **Motion budget** — ambient-only, or scroll-driven reveals too?
8. **Landing display type scale** — must be defined and added to `design.md`.

---

## 8. Direction candidates (to be chosen)

Three internally-consistent packages. Each bundles audience + tone + visual
register + hero, because those are not independently selectable.

See the conversation / decisions log below for the chosen direction. **Nothing is
chosen yet.**

### A — "The Quiet Operator"
Warm craft, editorial, non-dev audience (May brief). Parchment page, Instrument
Serif display headlines, ink monochrome, hairline rules, print-set feel. Motion is
near-zero; restraint *is* the signal, and it stands out precisely because every
other AI landing page is dark with neon gradients. Risk: reads as low-tech-cred
and possibly dated to a younger buyer.

### B — "The Receipt"
Proof rather than promise. The page is structured as **evidence**: real artifacts
zWork produced — a spreadsheet, a research doc, a sorted folder, a sent email —
shown as objects with timestamps. Monospace for artifacts/logs, serif for
headlines. Scroll-driven assembly motion (permitted; see §3 Motion carve-out).
Attacks the #1 objection ("AI just talks") directly. Risk: heaviest to produce —
requires real artifacts and marketing-resolution screenshots that do not exist yet.

### C — "The Colleague"
Scheduled, always-on work (Aug README). Dark-first, status-forward: a "today" rail
of jobs that already ran. Hero = "zWork ran 4 jobs while you were away." Accent =
`--success` used sparingly for "done". Ambient continuous motion. Risk: dark-first
contradicts the brief's light-primary stance, and a green-accented dark UI can read
as devtool/monitoring (Grafana) rather than a consumer product.
