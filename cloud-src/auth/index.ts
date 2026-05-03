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

app.on(["POST", "GET", "PUT", "DELETE", "PATCH", "OPTIONS"], "/api/auth/**", (c) => {
  return auth.handler(c.req.raw);
});

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

app.get("/health", (c) => c.text("OK"));
app.get("/", (c) => c.text("OK"));

export default {
  port: 3000,
  fetch: app.fetch,
};
