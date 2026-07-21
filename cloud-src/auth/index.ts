import { Hono } from "hono";
import { cors } from "hono/cors";
import { betterAuth } from "better-auth";
import nodemailer from "nodemailer";
import { Pool } from "pg";

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || "https://api.tryzwork.app";
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || "https://tryzwork.app";
const TRUSTED_ORIGINS = [
  "https://tryzwork.app",
  "https://www.tryzwork.app",
  "https://app.tryzwork.app",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://localhost:5173",
  "tauri://localhost",
  "https://tauri.localhost",
  "http://tauri.localhost",
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "zWork <no-reply@tryzwork.app>";

const mailTransport =
  SMTP_HOST && SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASS,
        },
      })
    : null;

// Startup sanity check: requireEmailVerification is true, so every
// email/password sign-up (and sign-in) depends on verification emails going
// out. If SMTP is only partially configured, mailTransport is null and
// sendTransactionalEmail throws — making email auth fail with no obvious
// cause in the logs. Warn loudly at boot so this is caught at deploy time.
if (!mailTransport) {
  console.warn(
    "[zwork-auth] WARNING: SMTP is not fully configured — SMTP_HOST, SMTP_USER, and SMTP_PASS are all required. " +
      "requireEmailVerification is enabled, so email/password auth will fail verification: " +
      "verification and password-reset emails cannot be sent. " +
      "Set the SMTP_* environment variables to enable email delivery."
  );
}

function verificationCallbackUrl(url?: string) {
  const base = APP_PUBLIC_URL.replace(/\/$/, "");
  if (!url) return `${base}/auth/verified`;
  if (/^https?:\/\//i.test(url)) return url;
  return `${base}${url.startsWith("/") ? url : `/${url}`}`;
}

async function sendTransactionalEmail({
  to,
  subject,
  text,
  html,
}: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  if (!mailTransport) {
    throw new Error("SMTP is not configured for Better Auth email delivery.");
  }

  await mailTransport.sendMail({
    from: SMTP_FROM,
    to,
    subject,
    text,
    html,
  });
}

export const auth = betterAuth({
  appName: "zWork",
  baseURL: BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: process.env.BETTER_AUTH_SECRET,
  database: pool,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    autoSignIn: true,
    sendResetPassword: async ({ user, url }) => {
      void sendTransactionalEmail({
        to: user.email,
        subject: "Reset your zWork password",
        text: `Reset your password: ${url}`,
        html: `<p>Reset your zWork password by opening this link:</p><p><a href="${url}">${url}</a></p>`,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      const callbackUrl = verificationCallbackUrl(user.emailVerified ? undefined : "/auth/verified");
      const finalUrl = url.includes("callbackURL=")
        ? url
        : `${url}${url.includes("?") ? "&" : "?"}callbackURL=${encodeURIComponent(callbackUrl)}`;
      void sendTransactionalEmail({
        to: user.email,
        subject: "Verify your zWork email",
        text: `Verify your email by opening this link: ${finalUrl}`,
        html: `<p>Verify your zWork email by opening this link:</p><p><a href="${finalUrl}">${finalUrl}</a></p>`,
      });
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirectURI: "https://api.tryzwork.app/api/auth/callback/google",
    },
  },
  trustedOrigins: TRUSTED_ORIGINS,
  // The web app (app.tryzwork.app) and the auth API (api.tryzwork.app) are on
  // different subdomains. The OAuth state cookie must therefore be readable
  // across both AND survive the cross-site redirect from Google back to the
  // callback. With the default `SameSite=Lax` + host-scoped cookie, the state
  // cookie set by a cross-origin fetch from the app either isn't stored or
  // doesn't round-trip, producing `state_mismatch` / `please_restart_the_process`.
  // Share cookies across *.tryzwork.app and loosen SameSite to None (Secure).
  crossSubDomainCookies: {
    enabled: true,
    domain: ".tryzwork.app",
  },
  advanced: {
    cookies: {
      // The transient OAuth/PKCE state cookie. Must be SameSite=None so the
      // browser sends it on the top-level cross-site redirect from Google.
      state: {
        attributes: {
          sameSite: "none",
          secure: true,
        },
      },
    },
  },
});

const app = new Hono();

type DesktopGoogleQuery = {
  callbackURL?: string;
  errorCallbackURL?: string;
};

app.use("*", cors({
  origin: (origin) => {
    const allowed = TRUSTED_ORIGINS;
    if (!origin || allowed.includes(origin)) return origin;
    return allowed[0];
  },
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-csrf-token"],
}));

// Specific GET handlers for Google sign-in start. These MUST be registered
// BEFORE the `/api/auth/*` catch-all below, otherwise the catch-all matches
// first and hands the request to auth.handler (which 404s on these custom
// paths). See honojs/hono#4623 for the TrieRouter wildcard-matching behavior.

// Desktop Google sign-in start. (Caddy routes /api/auth/desktop/google* to
// Axum in production, but this handler exists for direct/local invocation.)
app.get("/api/auth/desktop/google", async (c) => {
  const query = c.req.query() as DesktopGoogleQuery;
  const callbackURL = query.callbackURL;
  const errorCallbackURL = query.errorCallbackURL || callbackURL;

  if (!callbackURL) {
    return c.text("Missing callbackURL", 400);
  }

  const response = await auth.api.signInSocial({
    body: {
      provider: "google",
      callbackURL,
      errorCallbackURL,
    },
    headers: c.req.raw.headers,
    asResponse: true,
  });

  return response;
});

// Web (non-desktop) Google sign-in start. The browser navigates here as a
// TOP-LEVEL GET (window.location = ...), so the OAuth state cookie Better Auth
// sets in the response is stored FIRST-PARTY on api.tryzwork.app — avoiding
// the cross-origin fetch + SameSite cookie storage problems that broke the
// previous fetch-based start. signInSocial (the .api method) returns the
// Google OAuth URL as JSON and sets the state cookie via headers; we convert
// that into a real 302 redirect so the browser goes to Google.
app.get("/api/auth/web/google", async (c) => {
  const query = c.req.query() as DesktopGoogleQuery;
  const callbackURL = query.callbackURL;
  const errorCallbackURL = query.errorCallbackURL || callbackURL;

  if (!callbackURL) {
    return c.text("Missing callbackURL", 400);
  }

  const response = await auth.api.signInSocial({
    body: {
      provider: "google",
      callbackURL,
      errorCallbackURL,
    },
    headers: c.req.raw.headers,
    asResponse: true,
  });

  // asResponse returns a standard Response: it sets the state cookie via
  // Set-Cookie headers and (in newer versions) 302s to Google. If the body is
  // JSON {url, redirect}, extract the URL and redirect ourselves.
  if (response.status === 200 || response.status === 201) {
    try {
      const data = (await response.json()) as { url?: string; redirect?: boolean };
      if (data.url) {
        // Preserve the Set-Cookie headers from the signInSocial response so
        // the state cookie lands in the browser.
        const headers = new Headers();
        response.headers.forEach((v, k) => headers.append(k, v));
        headers.set("Location", data.url);
        return new Response(null, { status: 302, headers });
      }
    } catch {
      // body wasn't JSON — fall through to return response as-is
    }
  }
  return response;
});

// Match Better Auth's official Hono integration: a single `*` segment wildcard.
// The TrieRouter (Hono's default) does not match the `/api/auth/**` double-wildcard
// pattern — it 404s every endpoint. See honojs/hono#4623. Registered AFTER the
// specific GET handlers above so they take precedence.
app.on(["POST", "GET", "PUT", "DELETE", "PATCH", "OPTIONS"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

app.get("/health", (c) => c.text("OK"));
app.get("/", (c) => c.text("OK"));

export default {
  port: 3000,
  fetch: app.fetch,
};
