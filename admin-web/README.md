# zWork Admin Dashboard (admin-web)

Password-gated admin SPA served at **`admin.tryzwork.app`**. Covers operational health, business/revenue, product/engagement, real-time activity, users, usage, models, and an admin audit log.

This is a thin Vite shell around the dashboard components that live in [`../app/src/components/admin/`](../app/src/components/admin) and [`../app/src/components/AdminPage.tsx`](../app/src/components/AdminPage.tsx). Those are imported via the `@app/*` TypeScript alias (see `tsconfig.json` + `vite.config.ts`) so the desktop app and this web build share one source of truth — edit the dashboard once, both pick it up.

## Stack

- Vite 5 + React 18 + TypeScript 5
- Tailwind 3 with the same design tokens (CSS-variable RGB triplets) as the desktop app and `minimal-chat` demo
- `recharts` for charts
- No router — `AdminPage` handles its own tab state and password auth

## Development

```bash
npm install
npm run dev    # http://localhost:4311, proxies /api → https://api.tryzwork.app
```

The dev proxy points at the production API, so you'll be hitting real (read-only) admin endpoints. Log in with the `ADMIN_PASSWORD`.

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
- **Backend.** All endpoints are documented in [`docs/CLOUD.md`](../docs/CLOUD.md) under "Admin dashboard".
