# zWork Authentication

This document describes the current auth model that is actually wired into the desktop app and cloud services.

## Summary

zWork uses a **server-backed desktop auth flow**:

- Google OAuth happens on the server through **Better Auth**
- email/password auth is also hosted by **Better Auth**
- the desktop app opens that flow in a browser
- the cloud API returns a short-lived desktop auth code
- the desktop app exchanges that code for a bearer token used by cloud endpoints

This is not the old browser-popup implicit-token flow. If you see docs mentioning `oauth-callback.html` or `response_type=token`, those are stale.

## Components

| Component | Path | Role |
|-----------|------|------|
| Desktop auth UI | `app/src/components/LoginScreen.tsx` | blocks app entry until account auth is complete |
| Desktop auth client | `app/src/lib/cloud.ts` | starts auth, exchanges code, stores bearer token |
| Native auth helper | `app/src-tauri/src/main.rs` | opens browser and listens on localhost callback |
| Cloud API | `cloud-src/api/src/main.rs` | desktop auth start/complete/exchange/logout endpoints |
| Better Auth service | `cloud-src/auth/index.ts` | Google OAuth, email/password auth, email verification, password reset delivery |

## Current desktop flow

```text
desktop app
  -> /api/desktop/auth/start?port=<localhost-port>
  -> server returns HTML that posts into Better Auth social sign-in
  -> user completes Google OAuth in browser
  -> Better Auth session is created on the server
  -> cloud API redirects to http://127.0.0.1:<port>/callback?code=<one-time-code>
  -> desktop app exchanges code at /api/desktop/auth/exchange
  -> desktop stores bearer token in localStorage
```

## Required Google setup

Use a **Web application** OAuth client in Google Cloud Console, not a Desktop client, because the callback is server-hosted.

Required redirect URI:

```text
https://api.tryzwork.app/api/auth/callback/google
```

Recommended authorized origins:

```text
https://tryzwork.app
https://www.tryzwork.app
https://api.tryzwork.app
```

If the app is still in Google testing mode, every test account must be added under OAuth consent screen test users.

## Better Auth routes

Better Auth is reverse-proxied under:

```text
https://api.tryzwork.app/api/auth/*
```

Examples:

- `/api/auth/sign-in/social`
- `/api/auth/sign-in/email`
- `/api/auth/sign-up/email`
- `/api/auth/sign-out`
- `/api/auth/get-session`
- `/api/auth/callback/google`

## Email/password behavior

The auth service now supports:

- email/password sign-up
- email/password sign-in
- email verification emails
- password reset emails

Important detail:

- zWork currently sends a **verification email link**, not a numeric verification code
- this is Better Auth's standard email verification flow
- if you want a 6-digit code UX later, that is a different auth mode and should be implemented explicitly

Desktop-specific cloud routes now also exist for direct desktop auth:

- `POST /api/desktop/auth/email/sign-up`
- `POST /api/desktop/auth/email/sign-in`

Sign-up returns a verification-required response. Sign-in only succeeds after the email has been verified.

## Desktop token model

The desktop app does not reuse browser cookies directly after sign-in. Instead:

1. Better Auth creates the server session.
2. zWork creates a one-time desktop auth code.
3. The desktop exchanges it for a bearer token.
4. That bearer token is used against:
   - `/api/session`
   - `/api/analytics/summary`
   - `/api/dev/redeem-coupon`
   - managed hosted model routes

The bearer token is intended for the desktop app, not for general public API access.

## Session storage

## Server-side

Better Auth maintains its own auth/session tables. zWork also maintains:

- `app_users`
- `desktop_auth_codes`
- `desktop_access_tokens`
- `gateway_requests`

## Desktop-side

The desktop token is currently stored in:

```text
localStorage["zwork:cloud-token"]
```

The desktop app clears it on logout or when session fetch fails.

## Verification checklist

From a signed-out state:

1. Launch the desktop app.
2. Confirm the auth gate appears.
3. Click Google sign-in.
4. Complete OAuth in the browser.
5. Confirm the desktop app returns with a signed-in session.
6. Open Analytics and confirm `/api/analytics/summary` succeeds.

Email/password checks:

1. Sign up with email/password.
2. Confirm a verification email is delivered.
3. Open the verification link.
4. Sign in with the same email/password.
5. Confirm the desktop app receives a bearer token and `/api/session` succeeds.

Server-side spot checks:

```bash
curl -i https://api.tryzwork.app/api/session
curl -i "https://api.tryzwork.app/api/desktop/auth/start?port=43123"
```

Expected:

- unauthenticated `/api/session` returns `401`
- `/api/desktop/auth/start` returns `200`

## Common failure modes

## `redirect_uri_mismatch`

Usually means the Google Web OAuth client is missing the exact redirect URI:

```text
https://api.tryzwork.app/api/auth/callback/google
```

## “New user can’t sign in”

If Google OAuth is still in testing mode, that user is probably not listed as a test user.

## “Email sign-up works but no verification email arrives”

Check the auth service mailer env:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

If those are missing, email/password signup cannot complete the verification loop.

## Desktop auth appears signed out after logout

The desktop app must clear both the stored bearer token and the in-memory store user. This has been fixed in the current app state sync.
