# Integrations (Composio Connectors)

zWork integrates third-party apps (Linear, GitHub, Gmail, etc.) through [Composio](https://composio.dev). This doc covers how connectors are wired end-to-end and how to enable a new one.

## Architecture (data flow)

```
Frontend (ConnectorsPage)
  → store.connectComposioApp(app)
  → api.composioConnect(app)              POST /api/composio/connect   (sidecar)
  → composio::connect(app)                proxy to cloud w/ user bearer
  → cloud composio_connect                POST /api/composio/connect   (cloud)
      → Composio GET /auth_configs?toolkit_slug=<app>
      → Composio POST /connected_accounts/link
  ← { url }  (OAuth redirect)
Browser opens the OAuth URL → user consents → Composio redirects to
  https://api.tryzwork.app/api/composio/callback
Frontend polls GET /api/composio/accounts until status === "ACTIVE".
```

There is **no per-app code path** — every connector follows the same route. The only per-app things are catalogue entries, the frontend allow-list, and brand logos.

### Key files

| Layer | File | Notes |
|---|---|---|
| Frontend UI | `app/src/components/ConnectorsPage.tsx` | `ALLOWED_APPS` (line ~43) gates the grid |
| Brand logos | `app/src/components/BrandLogos.tsx` | inline SVG path map; add new brands here |
| Frontend state | `app/src/lib/store.ts` | `STATIC_APPS` seed (~line 1442), `connectComposioApp` |
| Frontend HTTP | `app/src/lib/api.ts` | `composioConnect` / `composioAccounts` |
| Sidecar proxy | `sidecar-rust/src/composio.rs` | `connect()` (line ~109); error translation (line ~123) |
| Sidecar routes | `sidecar-rust/src/server.rs` | `composio_connect` (~line 2490) |
| Cloud handler | `cloud-src/api/src/main.rs` | `composio_connect` (~line 4084); 404 branch (~line 4138) |
| Composio base URL | `cloud-src/api/src/main.rs:47` | `https://backend.composio.dev/api/v3` |
| OAuth callback | `cloud-src/api/src/main.rs` | hardcoded `https://api.tryzwork.app/api/composio/callback` (~line 4147) |

## Enabling a new connector (e.g. Linear)

The "linear is not yet configured. Please contact support to enable this integration." error means the Composio workspace has **no auth config for that toolkit**. The code is complete; this is a dashboard + OAuth-app configuration task. Steps:

### 1. Create the OAuth application on the provider

For Linear: Linear → Workspace → Settings → API → **OAuth applications** (or the equivalent for the provider). Capture the **client ID** and **client secret**.

### 2. Register the redirect URL on the OAuth app

Add this exact URL to the provider's allowed redirect/consent URLs:

```
https://api.tryzwork.app/api/composio/callback
```

This is the value hardcoded at `cloud-src/api/src/main.rs` (~line 4147). It must match exactly or Composio's `connected_accounts/link` call will fail.

### 3. Create the auth config in Composio

In the Composio dashboard for the workspace tied to the deployed `COMPOSIO_API_KEY`:

1. Go to **AuthConfigs** → **New AuthConfig**.
2. Select the toolkit (e.g. `linear`).
3. Paste the OAuth client ID + secret from step 1.
4. Save. The auth config's `id` is what `GET /auth_configs?toolkit_slug=linear` will now return.

### 4. Verify

```sh
curl "https://backend.composio.dev/api/v3/auth_configs?toolkit_slug=linear" \
  -H "x-api-key: $COMPOSIO_API_KEY"
```

A **non-empty `items` array** confirms the auth config exists. The next desktop client connect attempt will then resolve an OAuth URL instead of returning the 404 → "not yet configured" message.

### 5. Sanity-check `COMPOSIO_API_KEY`

If `COMPOSIO_API_KEY` were unset/empty in the deployed cloud environment, the cloud returns **503 `composio_not_configured`** (a *different* error path than the 404 you see). So if you see the "not yet configured" 404, the key is set — only the per-toolkit auth config is missing. Verify in `cloud-src/.env.example` (template) and the deployed environment.

## Adding a brand-new connector to the catalogue

If the app isn't already in the catalogues (i.e. not in `ALLOWED_APPS`), also update:

1. **Frontend allow-list** — `app/src/components/ConnectorsPage.tsx` `ALLOWED_APPS`.
2. **Static seed** — `app/src/lib/store.ts` `STATIC_APPS` (id, name, brand color, `icon: null`).
3. **Brand logo** — `app/src/components/BrandLogos.tsx` `APP_PATHS` (inline SVG path; source from [Simple Icons](https://github.com/simple-icons/simple-icons), `viewBox="0 0 24 24"`).
4. **Descriptions** — `ConnectorsPage.tsx` `APP_DESCRIPTIONS` / `APP_DETAILED_DESCRIPTIONS`.
5. **Backend catalogues** — `sidecar-rust/src/composio.rs` (~line 179) and `cloud-src/api/src/main.rs` `composio_app_display_map` (~line 690), if you want the agent to advertise its tools.
6. **Auth config** — follow steps 1–4 above for the new toolkit.

## Why logos were rendering as solid squares (historical note)

Previously, brand logos were fetched at runtime from the Simple Icons CDN via CSS `mask-image`. The Tauri CSP whitelisted the CDN host under `img-src`, but on macOS WKWebView / Windows WebView2 `-webkit-mask-image` is enforced against `default-src 'self'`, which blocked the remote mask. The result: `backgroundColor: currentColor` filled the whole box, so every connector appeared as a solid coloured square. Fixed by inlining the SVG paths in `BrandLogos.tsx`, removing the network fetch and CSP interaction entirely.
