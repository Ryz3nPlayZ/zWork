# zWork Admin Dashboard (admin-web)

Password-gated admin SPA served at **`admin.tryzwork.app`**. Covers operational health, business/revenue, product/engagement, real-time activity, users, usage, models, and an admin audit log.

This is a thin Vite shell around the dashboard components that live in [`../app/src/components/admin/`](../app/src/components/admin) and [`../app/src/components/AdminPage.tsx`](../app/src/components/AdminPage.tsx). Those are imported via the `@app/*` TypeScript alias (see `tsconfig.json` + `vite.config.ts`) so the desktop app and this web build share one source of truth — edit the dashboard once, both pick it up.

## Stack

- Vite 5 + React 18 + TypeScript 5
- Tailwind 3 with the same design tokens (CSS-variable RGB triplets) as the desktop app and `minimal-chat` demo
- `recharts` for charts
- No router. `AdminPage` keeps the current tab in the URL hash (`#users`, `#health`, …), so reloads and shared links land on the same tab.

## Development

```bash
npm install
npm run dev:mock   # http://localhost:4311 with a fake API; any password signs in
npm run dev        # http://localhost:4311, proxies /api → https://api.tryzwork.app
```

`dev:mock` serves every `/api/admin/*` endpoint from [`mock/mockApi.ts`](mock/mockApi.ts): seeded data (the same on every reload), a little latency so loading states show, and tier changes that stick and land in the audit log until you restart. Use it for UI work. It needs no password and no database. When you change an `Admin*` response struct in `cloud-src/api/src/main.rs`, change the mock to match.

`dev` hits the real production admin endpoints, so you sign in with `ADMIN_PASSWORD`. Everything is read-only except **Users → Set tier**, which changes a real user's tier. It asks first and is written to the audit log.

Keyboard shortcuts: `1`–`9` switch tabs and `r` refreshes. Both are ignored while you're typing in a field.

## Build

```bash
npm run build  # outputs dist/
```

`VITE_ADMIN_API_BASE` defaults to empty, so the built bundle uses relative `/api/*` URLs. In production these are proxied to `axum_api:8080` by Caddy (see `cloud-src/Caddyfile`).

## Deploy

```bash
./scripts/deploy-admin-web.sh
```

On first deploy, also:

1. Add a DNS A record for `admin.tryzwork.app` pointing at the VM (Caddy auto-provisions TLS once DNS resolves).
2. Reload Caddy: `./ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build caddy'`
3. If admin endpoint code in `cloud-src/api/` changed, rebuild the API too: `./ssh-connect.sh 'cd ~/cloud && sudo docker compose up -d --build axum_api'`

## Architecture notes

- **Shared source.** The `@app/*` alias points at `../app/src`. If you move or rename admin components there, update `tsconfig.json` `paths`, `vite.config.ts` `resolve.alias`, and `tailwind.config.js` `content` globs.
- **Auth.** The SPA posts the admin password to `/api/admin/verify-password`, which returns an HMAC-signed token (see `cloud-src/api/src/main.rs`). The token is stored in `sessionStorage` and sent as a `Bearer` header on every admin request. Closing the tab logs you out.
- **Backend.** All endpoints are documented in [`docs/CLOUD.md`](../docs/CLOUD.md) under "Admin dashboard". The time-series endpoints take `?days=N`, and each tab's window picker only offers values the server accepts: health, providers and engagement allow up to 90 days; revenue and usage allow up to 365.
- **Shared components.** The tabs are built from `app/src/components/admin/shared.tsx` (`useAdminData`, `StatCard`, `DataTable` with sort, CSV export and expandable rows, and the chart cards) and from the app-wide `app/src/components/page/Page.tsx` (`Badge`, `Segmented`, `useConfirm`, …). Follow [`design.md`](../design.md): token colors only, no raw Tailwind palette.
- **Money.** Costs are estimates from token counts × list prices. Margins compare like with like: the daily margin is MRR ÷ 30 minus that day's cost, and the window margin prorates MRR to the window.
- **One React.** `vite.config.ts` dedupes `react`, `react-dom`, `recharts` and `lucide-react`. Without that, files under `../app/src` could resolve their own copies from `../app/node_modules`.
