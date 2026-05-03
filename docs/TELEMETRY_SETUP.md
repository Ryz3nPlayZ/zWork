# Setting up zWork Telemetry with PostHog

## Step 1: Create PostHog Account

1. Go to https://app.posthog.com/signup
2. Create a new project
3. Get your API Key from Project Settings → API Keys

## Step 2: Set up the proxy endpoint on zwork.ai

The zWork desktop app sends telemetry to an endpoint. We'll use your landing page
as a proxy that forwards to PostHog.

### If using Netlify (zwork.ai):

```bash
# Create the function
mkdir -p netlify/functions/api/telemetry
```

Create `netlify/functions/api/telemetry.ts` with the PostHog proxy code.

### Add environment variable to Netlify:

In Netlify dashboard → Site Settings → Environment Variables:
```
POSTHOG_KEY = phc_YOUR_ACTUAL_KEY_HERE
```

Deploy Netlify site.

## Step 3: Update zWork to send telemetry to zwork.ai

In `app/src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "environment": {
      "ZW_TELEMETRY_ENDPOINT": "https://zwork.ai/api/telemetry"
    }
  }
}
```

## Step 4: Build and release a new version

```bash
# Bump version
npm run build
tauri build

# Tag and push
git tag v0.3.14
git push --tags
```

## What you'll see in PostHog

- **Live users**: See active users right now
- **Events dashboard**: All telemetry events charted over time
- **Funnels**: e.g., onboarding → first chat → second chat
- **Retention**: Do users come back?
- **Properties**: OS breakdown, version distribution
- **Models**: Which LLMs are most popular

## Privacy Note

Your telemetry collects:
- Anonymous install_id (random UUID per install)
- App version
- OS platform
- Event types (chat_turn_started, update_finished, etc.)
- Session duration

It does NOT collect:
- User names or emails
- Chat message content
- API keys
- File contents
