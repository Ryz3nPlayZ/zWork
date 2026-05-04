---
name: Auth & Settings tracking
about: Internal tracking issue for auth and usage/settings pages
title: '[TRACKING] Auth flow and Usage/Settings pages'
labels: tracking, auth, ui
assignees: ''
---

## Overview

This issue tracks remaining work to complete the authentication flow and add usage/settings management pages.

## Auth Flow Issues

- [ ] **Desktop OAuth redirect URI**: Desktop app client type in Google Cloud Console does not support `response_type=token`. Need to either:
  - Switch to authorization code flow + PKCE (requires backend token exchange endpoint)
  - Or use a Web application client type for local testing
- [ ] **Email verification**: Better Auth email/password sign-up is enabled but email verification codes are not configured. Need SMTP provider (Resend/Postmark/SES) or verification flow.
- [ ] **Session refresh**: No token refresh mechanism. Sessions expire and user must re-authenticate.
- [ ] **Cross-device sync**: User sessions are stored in localStorage per-device. Better Auth sessions could enable true cross-device sync.

## Usage / Settings Pages Needed

- [ ] **Usage dashboard**: Show API usage metrics (requests, tokens, model breakdown) for the current billing period
- [ ] **Subscription management**: Display current tier (free/pro), upgrade/downgrade UI, Stripe billing portal integration
- [ ] **API key management**: Allow users to view/revoke API keys for custom integrations
- [ ] **Account deletion**: GDPR-compliant data deletion flow
- [ ] **Connected accounts**: Show linked Google account, option to disconnect

## Acceptance Criteria

- [ ] User can log in on desktop app without manual redirect URI registration
- [ ] User can sign up with email + password and receive verification code
- [ ] Settings shows a Usage tab with request/token counts
- [ ] Settings shows a Billing tab with current tier and upgrade path
- [ ] All auth flows work on macOS, Windows, and Linux

## Related

- `docs/AUTH.md` — current auth architecture documentation
- `cloud-src/auth/` — Better Auth service implementation
