// Netlify function to proxy zWork telemetry to PostHog
// Place at: netlify/functions/api/telemetry.ts

export async function onRequestPost(context) {
  const { request } = context;

  try {
    const payload = await request.json();

    // Forward to PostHog
    const response = await fetch('https://app.posthog.com/capture/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: context.env.POSTHOG_KEY || 'phc_YOUR_KEY_HERE',
        event: payload.event,
        distinct_id: payload.install_id || 'unknown',
        properties: {
          ...payload.properties,
          session_id: payload.session_id,
          os: payload.os,
          $set_once: {
            os: payload.os,
            first_seen: payload.ts,
          },
        },
        timestamp: new Date(payload.ts).toISOString(),
      }),
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
