import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

// Fake /api/admin/* for `npm run dev:mock`: lets you work on the dashboard
// without the production admin password or a local Postgres. Any password
// signs in. Numbers are random but seeded, so a reload shows the same data;
// shapes mirror the Admin* structs in cloud-src/api/src/main.rs — update both
// together.

const DAY = 86_400_000;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = [
  ["anthropic", "claude-sonnet-5-5"],
  ["anthropic", "claude-haiku-4-5"],
  ["openai", "gpt-5.1"],
  ["deepseek", "deepseek-v4"],
  ["google", "gemini-3-pro"],
  ["openrouter", "qwen3-coder"],
  ["openrouter", "kimi-k2"],
  ["groq", "llama-4-maverick"],
] as const;

const FIRST = ["Ada", "Grace", "Linus", "Margaret", "Ken", "Barbara", "Dennis", "Frances", "Alan", "Radia", "Edsger", "Hedy"];
const LAST = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Thompson", "Liskov", "Ritchie", "Allen", "Kay", "Perlman", "Dijkstra", "Lamarr"];

const iso = (t: number) => new Date(t).toISOString();
const day = (t: number) => iso(t).slice(0, 10);
const round = (n: number, d = 2) => Number(n.toFixed(d));

function users() {
  const r = rng(7);
  return Array.from({ length: 64 }, (_, i) => {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 5) % LAST.length];
    const tier = r() < 0.72 ? "free" : r() < 0.75 ? "pro" : "max";
    const requests = Math.floor(r() ** 2 * 4000);
    const prompt = requests * Math.floor(2000 + r() * 9000);
    const completion = Math.floor(prompt * (0.05 + r() * 0.1));
    const created = Date.now() - Math.floor(r() * 180) * DAY;
    const paid = tier !== "free";
    return {
      user_id: `usr_${(i * 2654435761).toString(36).padStart(10, "0").slice(0, 12)}`,
      email: `${first}.${last}${i}@example.com`.toLowerCase(),
      name: `${first} ${last}`,
      tier,
      created_at: iso(created),
      last_activity: requests ? iso(Date.now() - Math.floor(r() * 20 * DAY)) : null,
      total_requests: requests,
      total_prompt_tokens: prompt,
      total_completion_tokens: completion,
      estimated_cost_usd: round((prompt * 1.5 + completion * 7) / 1e6),
      stripe_customer_id: paid ? `cus_${(i * 99991).toString(36)}` : null,
      subscription_status: paid ? (r() < 0.9 ? "active" : "past_due") : null,
    };
  });
}

function series(days: number, seed: number) {
  const r = rng(seed);
  return Array.from({ length: days }, (_, i) => {
    const t = Date.now() - (days - 1 - i) * DAY;
    const weekday = new Date(t).getUTCDay();
    const base = (300 + i * (600 / Math.max(days, 1))) * (weekday === 0 || weekday === 6 ? 0.55 : 1);
    return { t, date: day(t), r, base: Math.floor(base * (0.8 + r() * 0.4)) };
  });
}

function usageByTime(days: number) {
  return series(days, 11)
    .map(({ date, r, base }) => {
      const roots = Math.floor(base / (3 + r() * 3));
      const prompt = base * Math.floor(6000 + r() * 4000);
      const completion = Math.floor(prompt * 0.08);
      return {
        date,
        requests: base,
        roots,
        continuations: base - roots,
        prompt_tokens: prompt,
        completion_tokens: completion,
        tokens: prompt + completion,
      };
    })
    .reverse();
}

function usageByModel(days: number) {
  const r = rng(13 + days);
  const rows = MODELS.map(([provider_name, model_id], i) => {
    const requests = Math.floor((days * 900) / (i + 1.3) * (0.7 + r() * 0.6));
    const prompt_tokens = requests * Math.floor(5000 + r() * 6000);
    const completion_tokens = Math.floor(prompt_tokens * (0.05 + r() * 0.08));
    return { provider_name, model_id, requests, prompt_tokens, completion_tokens, tokens: prompt_tokens + completion_tokens, percentage: 0 };
  });
  const total = rows.reduce((a, m) => a + m.tokens, 0);
  for (const m of rows) m.percentage = round((m.tokens / total) * 100);
  return rows;
}

function health(days: number) {
  const daily = series(days, 17).map(({ date, r, base }) => {
    const errors = Math.floor(base * (0.004 + r() * 0.03));
    return {
      date,
      requests: base,
      errors,
      error_rate: errors / base,
      p50_latency_ms: 2200 + r() * 800,
      p95_latency_ms: 9000 + r() * 6000,
      p99_latency_ms: 20000 + r() * 15000,
      p50_ttft_ms: 600 + r() * 300,
      p95_ttft_ms: 2400 + r() * 1500,
    };
  });
  const total = daily.reduce((a, d) => a + d.requests, 0);
  const failed = daily.reduce((a, d) => a + d.errors, 0);
  return {
    window_days: days,
    total_requests: total,
    failed_requests: failed,
    error_rate: failed / total,
    retried_requests: Math.floor(failed * 0.6),
    status_breakdown: [
      { bucket: "2xx", count: total - failed },
      { bucket: "429", count: Math.floor(failed * 0.5) },
      { bucket: "5xx", count: Math.floor(failed * 0.35) },
      { bucket: "4xx", count: Math.floor(failed * 0.1) },
      { bucket: "no response", count: failed - Math.floor(failed * 0.5) - Math.floor(failed * 0.35) - Math.floor(failed * 0.1) },
    ],
    latency_p50_ms: 2500,
    latency_p95_ms: 11800,
    latency_p99_ms: 27400,
    ttft_p50_ms: 720,
    ttft_p95_ms: 3100,
    daily,
    top_failing_models: [
      { model_id: "kimi-k2", provider_name: "openrouter", total_requests: 1840, failed_requests: 162, failure_rate: 0.088 },
      { model_id: "gemini-3-pro", provider_name: "google", total_requests: 4210, failed_requests: 131, failure_rate: 0.031 },
      { model_id: "deepseek-v4", provider_name: "deepseek", total_requests: 6620, failed_requests: 89, failure_rate: 0.013 },
    ],
  };
}

function providers() {
  const r = rng(19);
  const names = [...new Set(MODELS.map(([p]) => p))];
  return names.map((provider_name, i) => {
    const total = Math.floor(20000 / (i + 1));
    const rate = [0.004, 0.012, 0.009, 0.031, 0.088, 0.002][i] ?? 0.01;
    const limit = i === 3 ? 10000 : i === 5 ? 14400 : null;
    const remaining = limit ? Math.floor(limit * (i === 5 ? 0.08 : 0.55)) : null;
    return {
      provider_name,
      total_requests: total,
      failed_requests: Math.floor(total * rate),
      failure_rate: rate,
      avg_latency_ms: 2000 + r() * 3000,
      p95_latency_ms: 8000 + r() * 9000,
      requests_limit_day: limit,
      requests_remaining_day: remaining,
      saturation_pct: limit && remaining !== null ? ((limit - remaining) / limit) * 100 : null,
      last_status: rate > 0.05 ? 429 : 200,
      last_model_id: MODELS.find(([p]) => p === provider_name)?.[1] ?? null,
      observed_at: iso(Date.now() - Math.floor(r() * 600_000)),
    };
  });
}

function revenue(days: number) {
  const mrr = 1240;
  const daily = series(days, 23).map(({ date, r, base }, i) => {
    const m = round(mrr - (days - i) * 3.1);
    const cost = round((base * 8000 * 1.6) / 1e6);
    return {
      date,
      mrr: m,
      new_subs: r() < 0.3 ? Math.ceil(r() * 3) : 0,
      cancellations: r() < 0.12 ? 1 : 0,
      est_cost_usd: cost,
      margin: round(m / 30 - cost),
    };
  });
  const cost = round(daily.reduce((a, d) => a + d.est_cost_usd, 0));
  const revenueInWindow = (mrr / 30) * days;
  return {
    window_days: days,
    current_mrr: mrr,
    arpu: round(mrr / 64),
    paid_users: 58,
    churned_in_window: daily.reduce((a, d) => a + d.cancellations, 0),
    new_subs_in_window: daily.reduce((a, d) => a + d.new_subs, 0),
    est_cost_usd: cost,
    gross_margin_pct: ((revenueInWindow - cost) / revenueInWindow) * 100,
    daily,
    tier_split: [
      { tier: "free", users: 412, mrr: 0 },
      { tier: "pro", users: 46, mrr: 920 },
      { tier: "max", users: 12, mrr: 320 },
    ],
  };
}

function engagement(days: number) {
  const daily = series(days, 29).map(({ date, r, base }) => {
    const dau = Math.floor(base / 9);
    const newUsers = Math.floor(r() * 6);
    return { date, dau, new_users: newUsers, returning: dau - newUsers, requests: base, tokens: base * 8200 };
  });
  const top = users()
    .sort((a, b) => b.total_requests - a.total_requests)
    .slice(0, 10)
    .map(({ created_at: _c, stripe_customer_id: _s, subscription_status: _ss, ...u }) => u);
  const dau = daily[daily.length - 1]?.dau ?? 0;
  return {
    window_days: days,
    dau_today: dau,
    wau: 118,
    mau: 203,
    stickiness_pct: (dau / 203) * 100,
    new_users_in_window: daily.reduce((a, d) => a + d.new_users, 0),
    daily,
    top_active_users: top,
  };
}

function live() {
  const r = rng(Math.floor(Date.now() / 10_000));
  const all = users();
  const recent = Array.from({ length: 25 }, (_, i) => {
    const u = all[Math.floor(r() * all.length)];
    const [provider_name, model_id] = MODELS[Math.floor(r() * MODELS.length)];
    const roll = r();
    return {
      id: `req_${Date.now().toString(36)}_${i}`,
      user_email: u.email,
      user_name: u.name,
      provider_name,
      model_id,
      upstream_status: roll < 0.9 ? 200 : roll < 0.95 ? 429 : roll < 0.98 ? 502 : null,
      total_duration_ms: Math.floor(800 + r() * 14000),
      total_tokens: Math.floor(3000 + r() * 40000),
      created_at: iso(Date.now() - i * Math.floor(4000 + r() * 9000)),
    };
  });
  const rpm = 8 + r() * 10;
  return {
    active_users_5m: 4 + Math.floor(r() * 6),
    requests_5m: Math.floor(rpm * 5),
    tokens_5m: Math.floor(rpm * 5 * 14000),
    requests_per_min: rpm,
    recent,
  };
}

function overview() {
  const all = users();
  return {
    total_users: 470,
    active_users_30d: 203,
    active_users_7d: 118,
    new_users_this_week: 19,
    new_users_this_month: 71,
    churn_rate: (203 - 118) / 203,
    paid_users: 58,
    mrr: 1240,
    arpu: 1240 / 470,
    free_to_paid_conversion: 58 / 470,
    total_prompt_tokens: all.reduce((a, u) => a + u.total_prompt_tokens, 0),
    total_completion_tokens: all.reduce((a, u) => a + u.total_completion_tokens, 0),
    estimated_cost_usd: all.reduce((a, u) => a + u.estimated_cost_usd, 0),
  };
}

const tierOverrides = new Map<string, string>();
const audit: Record<string, unknown>[] = [
  { id: "a1", actor_email: "owner@example.com", action: "admin_login", target_user_id: null, metadata: { ip: "203.0.113.7" }, created_at: iso(Date.now() - 3 * 3600_000) },
  { id: "a2", actor_email: "owner@example.com", action: "tier_change", target_user_id: "usr_0000000000", metadata: { from: "free", to: "pro" }, created_at: iso(Date.now() - 2 * DAY) },
  { id: "a3", actor_email: "owner@example.com", action: "admin_logout", target_user_id: null, metadata: null, created_at: iso(Date.now() - 2 * DAY + 600_000) },
];

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function mockAdminApi(): Plugin {
  return {
    name: "zwork-mock-admin-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://mock");
        const path = url.pathname;
        if (!path.startsWith("/api/admin/")) return next();
        const days = Number(url.searchParams.get("days") ?? 7) || 7;
        // A little latency so loading states are visible.
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));

        if (path === "/api/admin/verify-password" && req.method === "POST") return send(res, 200, { token: "mock-admin-token" });
        if (req.headers.authorization !== "Bearer mock-admin-token") return send(res, 401, { error: "unauthorized" });
        if (path === "/api/admin/logout") return send(res, 200, { ok: true });
        if (path === "/api/admin/metrics/overview") return send(res, 200, overview());
        if (path === "/api/admin/metrics/health") return send(res, 200, health(Math.min(days, 90)));
        if (path === "/api/admin/metrics/providers") return send(res, 200, providers());
        if (path === "/api/admin/metrics/revenue") return send(res, 200, revenue(Math.min(days, 365)));
        if (path === "/api/admin/metrics/engagement") return send(res, 200, engagement(Math.min(days, 90)));
        if (path === "/api/admin/metrics/live") return send(res, 200, live());
        if (path === "/api/admin/usage/by-time") return send(res, 200, usageByTime(Math.min(days, 365)));
        if (path === "/api/admin/usage/by-model") return send(res, 200, usageByModel(Math.min(days, 365)));
        if (path === "/api/admin/audit") return send(res, 200, audit);
        if (path === "/api/admin/users") {
          return send(res, 200, users().map((u) => ({ ...u, tier: tierOverrides.get(u.user_id) ?? u.tier })));
        }
        const tier = path.match(/^\/api\/admin\/users\/([^/]+)\/tier$/);
        if (tier && req.method === "PUT") {
          const { tier: next } = await readJson(req);
          if (next !== "free" && next !== "pro" && next !== "max") return send(res, 400, { error: "tier must be free, pro or max" });
          const id = decodeURIComponent(tier[1]);
          const from = tierOverrides.get(id) ?? users().find((u) => u.user_id === id)?.tier;
          tierOverrides.set(id, next);
          audit.unshift({ id: `a${Date.now()}`, actor_email: "owner@example.com", action: "tier_change", target_user_id: id, metadata: { from, to: next }, created_at: iso(Date.now()) });
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: `mock has no ${req.method} ${path}` });
      });
    },
  };
}
