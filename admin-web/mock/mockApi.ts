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

// The real hosted lineup (resolve_upstream_model) with estimate_cost's
// per-1M-token prices. "mystery-model" stands in for an unpriced model.
const MODELS = [
  ["OpenRouter", "deepseek/deepseek-v4-flash-0731", 0.04, 0.08],
  ["OpenRouter", "z-ai/glm-5.3-flash", 0.09, 0.3],
  ["OpenRouter", "deepseek/deepseek-v4.1-flash", 0.15, 0.6],
  ["DeepSeek", "deepseek-flash", 0.14, 0.28],
  ["Groq", "meta-llama/llama-4-scout-17b-16e-instruct", 0.15, 0.3],
  ["OllamaCloud_1", "gemma4:31b", 0, 0],
  ["OllamaCloud_2", "gemma4:31b", 0, 0],
  ["OpenRouter", "mystery-model", null, null],
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
    // A few paid-tier users came in on a coupon and pay nothing.
    const coupon = tier !== "free" && r() < 0.15;
    const requests = Math.floor(r() ** 2 * 4000);
    const prompt = requests * Math.floor(2000 + r() * 9000);
    const completion = Math.floor(prompt * (0.05 + r() * 0.1));
    const created = Date.now() - Math.floor(r() * 180) * DAY;
    const paid = tier !== "free" && !coupon;
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
      estimated_cost_usd: round((prompt * 0.09 + completion * 0.3) / 1e6, 4),
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
      { model_id: "meta-llama/llama-4-scout-17b-16e-instruct", provider_name: "Groq", total_requests: 1840, failed_requests: 162, failure_rate: 0.088 },
      { model_id: "gemma4:31b", provider_name: "OllamaCloud_2", total_requests: 4210, failed_requests: 131, failure_rate: 0.031 },
      { model_id: "z-ai/glm-5.3-flash", provider_name: "OpenRouter", total_requests: 6620, failed_requests: 89, failure_rate: 0.013 },
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

function finance(days: number) {
  const r = rng(31 + days);
  const all = users().map((u) => ({ ...u, tier: tierOverrides.get(u.user_id) ?? u.tier }));
  const price = (u: { tier: string; stripe_customer_id: string | null }) =>
    !u.stripe_customer_id ? 0 : u.tier === "pro" ? 12 : u.tier === "max" ? 50 : 0;
  // Scale each user's lifetime cost to the window; heavy users dominate.
  const scale = Math.min(days, 90) / 120;
  // Two Pro subscribers running long agent loops cost more than they pay,
  // so the "unprofitable" list has something in it.
  const heavy = new Set(all.filter((u) => u.tier === "pro" && u.stripe_customer_id).slice(0, 2).map((u) => u.user_id));
  const spenders = all
    .map((u) => {
      const boost = heavy.has(u.user_id) ? 14 : u.tier === "max" ? 9 : u.tier === "pro" ? 3 : 1;
      const cost = round(u.estimated_cost_usd * scale * boost + (heavy.has(u.user_id) ? (12 * days) / 30 : 0), 4);
      const cost30 = round((cost * 30) / days, 4);
      return {
        user_id: u.user_id,
        email: u.email,
        name: u.name,
        tier: u.tier,
        paying: !!u.stripe_customer_id,
        requests: Math.floor(u.total_requests * scale),
        tokens: Math.floor((u.total_prompt_tokens + u.total_completion_tokens) * scale),
        cost_usd: cost,
        cost_30d_usd: cost30,
        monthly_price_usd: price(u),
        margin_30d_usd: round(price(u) - cost30),
      };
    })
    .filter((s) => s.cost_usd > 0)
    .sort((a, b) => b.cost_usd - a.cost_usd);
  const spend = spenders.reduce((a, s) => a + s.cost_usd, 0);
  const paidSpend = spenders.filter((s) => s.paying).reduce((a, s) => a + s.cost_usd, 0);
  const mrr = 1240;
  const revenueUsd = (mrr * days) / 30;
  const by_tier = (["free", "pro", "max"] as const).map((tier) => {
    const us = all.filter((u) => u.tier === tier);
    const sp = spenders.filter((s) => s.tier === tier);
    const cost = sp.reduce((a, s) => a + s.cost_usd, 0);
    const revenueT = (us.reduce((a, u) => a + price(u), 0) * days) / 30;
    return {
      tier,
      users: us.length,
      paying_users: us.filter((u) => u.stripe_customer_id).length,
      active_users: sp.length,
      requests: sp.reduce((a, s) => a + s.requests, 0),
      tokens: sp.reduce((a, s) => a + s.tokens, 0),
      cost_usd: round(cost, 4),
      revenue_usd: round(revenueT),
      margin_usd: round(revenueT - cost),
      cost_per_active_user: sp.length ? round(cost / sp.length, 4) : 0,
    };
  });
  const tierCost = Object.fromEntries(by_tier.map((t) => [t.tier, t.cost_usd]));
  const daily = series(days, 37).map(({ date, base }, i, arr) => {
    const w = base / arr.reduce((a, d) => a + d.base, 0);
    const free = round(tierCost.free * w, 4);
    const pro = round(tierCost.pro * w, 4);
    const max = round(tierCost.max * w, 4);
    return { date, free, pro, max, total: round(free + pro + max, 4), _i: i };
  }).map(({ _i, ...d }) => d);
  const by_model = MODELS.map(([provider, model, pin, pout], i) => {
    const requests = Math.floor((days * 400) / (i + 1.2) * (0.7 + r() * 0.6));
    const prompt_tokens = requests * Math.floor(5000 + r() * 6000);
    const completion_tokens = Math.floor(prompt_tokens * (0.05 + r() * 0.08));
    const priced = pin !== null && pout !== null;
    return {
      provider,
      model,
      requests,
      prompt_tokens,
      completion_tokens,
      cost_usd: priced ? round((prompt_tokens * pin + completion_tokens * pout) / 1e6, 4) : 0,
      unpriced_requests: priced ? 0 : requests,
    };
  }).sort((a, b) => b.cost_usd - a.cost_usd);
  const requests = by_model.reduce((a, m) => a + m.requests, 0);
  const tokens = by_model.reduce((a, m) => a + m.prompt_tokens + m.completion_tokens, 0);
  const unpriced = by_model.filter((m) => m.unpriced_requests > 0);
  const unprofitable = spenders.filter((s) => s.paying && s.margin_30d_usd < 0);
  const now = new Date();
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = now.getUTCDate() - 1 + now.getUTCHours() / 24;
  const mtd = round((spend / days) * elapsed, 4);
  const projected = elapsed > 0.25 ? round((mtd / elapsed) * dim) : mtd;
  return {
    window_days: days,
    spend_usd: round(spend, 4),
    prev_spend_usd: round(spend * 0.82, 4),
    revenue_usd: round(revenueUsd),
    margin_usd: round(revenueUsd - spend),
    margin_pct: ((revenueUsd - spend) / revenueUsd) * 100,
    mrr,
    paid_users: 58,
    mtd_spend_usd: mtd,
    projected_month_spend_usd: projected,
    last_month_spend_usd: round((spend / days) * 30 * 0.88, 4),
    projected_month_margin_usd: round(mrr - projected),
    free_spend_usd: round(spend - paidSpend, 4),
    paid_spend_usd: round(paidSpend, 4),
    cost_per_request_usd: requests ? spend / requests : 0,
    cost_per_1k_tokens_usd: tokens ? (spend / tokens) * 1000 : 0,
    requests,
    unpriced_requests: unpriced.reduce((a, m) => a + m.unpriced_requests, 0),
    unpriced_tokens: unpriced.reduce((a, m) => a + m.prompt_tokens + m.completion_tokens, 0),
    priced_coverage_pct: (1 - unpriced.reduce((a, m) => a + m.unpriced_requests, 0) / requests) * 100,
    unprofitable_users: unprofitable.length,
    by_tier,
    daily,
    by_model,
    top_spenders: spenders.slice(0, 25),
    unprofitable: unprofitable.slice(0, 25),
  };
}

function downloads() {
  const r = rng(41);
  const releases = Array.from({ length: 12 }, (_, i) => {
    const minor = 5 - Math.floor(i / 4);
    const patch = 3 - (i % 4);
    const tag = `v0.${minor}.${Math.max(patch, 0)}${patch < 0 ? "-beta" : ""}`;
    const age = i * 9 + Math.floor(r() * 4);
    const mac = Math.floor((30 - i * 2) * (0.6 + r()));
    const win = Math.floor((22 - i * 1.5) * (0.6 + r()));
    const lin = Math.floor((6 - i * 0.4) * (0.4 + r()));
    const assets = [
      { name: `zWork_${tag.slice(1)}_aarch64.dmg`, platform: "macOS", kind: "installer", downloads: Math.max(mac, 0) },
      { name: `zWork_${tag.slice(1)}_x64-setup.exe`, platform: "Windows", kind: "installer", downloads: Math.max(win, 0) },
      { name: `zWork_${tag.slice(1)}_amd64.AppImage`, platform: "Linux", kind: "installer", downloads: Math.max(lin, 0) },
      { name: "zWork_aarch64.app.tar.gz", platform: "macOS", kind: "update", downloads: Math.floor(r() * 25) },
      { name: `zWork_${tag.slice(1)}_x64-setup.nsis.zip`, platform: "Windows", kind: "update", downloads: Math.floor(r() * 18) },
      { name: "latest.json", platform: "any", kind: "update_check", downloads: Math.floor(40 + r() * 400) },
    ];
    const sum = (k: string) => assets.filter((a) => a.kind === k).reduce((a, x) => a + x.downloads, 0);
    return {
      tag,
      name: `zWork ${tag}`,
      published_at: iso(Date.now() - age * DAY),
      prerelease: false,
      installers: sum("installer"),
      updates: sum("update"),
      update_checks: sum("update_check"),
      assets,
    };
  });
  const plat: Record<string, number> = {};
  for (const rel of releases) for (const a of rel.assets) if (a.kind === "installer") plat[a.platform] = (plat[a.platform] ?? 0) + a.downloads;
  return {
    repo: "Ryz3nPlayZ/zWork",
    stars: 11,
    forks: 2,
    open_issues: 15,
    watchers: 3,
    total_installers: releases.reduce((a, x) => a + x.installers, 0),
    total_updates: releases.reduce((a, x) => a + x.updates, 0),
    total_update_checks: releases.reduce((a, x) => a + x.update_checks, 0),
    by_platform: Object.entries(plat).map(([platform, downloads]) => ({ platform, downloads })).sort((a, b) => b.downloads - a.downloads),
    releases,
    fetched_at: iso(Date.now() - 4 * 60_000),
    source_error: null,
    daily: series(30, 43).map(({ date, r: rr, base }) => ({
      date,
      installers: Math.floor(base / 60 + rr() * 4),
      updates: Math.floor(base / 90 + rr() * 3),
      update_checks: Math.floor(base / 6),
    })),
    versions_in_use: [
      { version: "0.5.3", users: 39, requests: 4870 },
      { version: "0.5.2", users: 44, requests: 5210 },
      { version: "0.5.1", users: 16, requests: 1061 },
      { version: "0.5.0", users: 11, requests: 870 },
      { version: "0.4.9", users: 6, requests: 402 },
      { version: "unknown", users: 2, requests: 55 },
    ],
    os_split: [
      { os: "macos", users: 74 },
      { os: "windows", users: 37 },
      { os: "linux", users: 7 },
    ],
  };
}

function funnel(days: number) {
  const r = rng(53);
  const signups = Math.floor(days * 2.4);
  const activated = Math.floor(signups * 0.68);
  const engaged = Math.floor(activated * 0.41);
  const paid = Math.floor(signups * 0.07);
  const cohorts = Array.from({ length: 8 }, (_, i) => {
    const weeksAgo = 7 - i;
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - weeksAgo * 7);
    let v = 62 + r() * 12;
    const retention = Array.from({ length: weeksAgo + 1 }, (_, k) => {
      if (k > 0) v *= 0.55 + r() * 0.2;
      return round(v, 1);
    });
    return { week_start: day(monday.getTime()), users: Math.floor(10 + r() * 20), retention };
  });
  return {
    window_days: days,
    steps: [
      { step: "Signed up", users: signups },
      { step: "Sent a request", users: activated },
      { step: "Active on 3+ days", users: engaged },
      { step: "Subscribed", users: paid },
    ],
    median_hours_to_first_request: 0.4,
    cohorts,
  };
}

function status() {
  const r = rng(Math.floor(Date.now() / 30_000));
  const probe = (name: string, url: string, host: string, role: string, expect: string, code: number, detail: string | null = null) => ({
    name, url, host, role, expect, status: code,
    ok: expect === "2xx" ? code >= 200 && code < 300 : expect === "3xx" ? code >= 300 && code < 400 : Number(expect) === code,
    latency_ms: Math.floor(40 + r() * 300),
    detail,
  });
  const started = Date.now() - 6 * DAY - 3 * 3600_000;
  return {
    api_version: "0.1.0",
    started_at: iso(started),
    uptime_secs: Math.floor((Date.now() - started) / 1000),
    surfaces: [
      probe("Landing", "https://tryzwork.app", "Vercel", "Marketing site (landing/)", "2xx", 200),
      probe("Web app", "https://app.tryzwork.app", "Caddy", "Browser demo of the app", "2xx", 200),
      probe("Admin", "https://admin.tryzwork.app", "Caddy", "This dashboard (admin-web/)", "2xx", 200),
      probe("API", "https://api.tryzwork.app/api/health", "Caddy → api", "Gateway, auth, billing, admin API", "2xx", 200),
      probe("Analytics", "https://analytics.tryzwork.app", "Caddy", "Redirect to PostHog", "3xx", 302, "→ https://us.posthog.com/project/397748"),
      probe("DB host", "https://db.tryzwork.app", "Caddy", "Must stay blocked", "403", 403),
    ],
    database: {
      ok: true,
      latency_ms: 2,
      size_bytes: 412_000_000,
      tables: [
        { name: "gateway_requests", rows: 182_331, bytes: 301_000_000 },
        { name: "gateway_attempts", rows: 190_870, bytes: 61_000_000 },
        { name: "provider_snapshots", rows: 88_120, bytes: 24_000_000 },
        { name: "web_chat_messages", rows: 9_412, bytes: 9_800_000 },
        { name: "app_users", rows: 470, bytes: 320_000 },
        { name: "admin_audit_log", rows: 211, bytes: 96_000 },
      ],
    },
    integrations: [
      { name: "Stripe", configured: true, detail: "billing + webhook" },
      { name: "PostHog", configured: true, detail: "https://us.i.posthog.com" },
      { name: "Google sign-in", configured: true, detail: "desktop OAuth" },
      { name: "Composio", configured: true, detail: "connector proxy" },
      { name: "GitHub token", configured: false, detail: "optional; raises the releases API rate limit" },
      { name: "Web demo", configured: true, detail: "30 messages / IP / day" },
      { name: "Provider: OpenRouter", configured: true, detail: "deepseek/deepseek-v4-flash-0731" },
      { name: "Provider: DeepSeek", configured: true, detail: "deepseek-flash" },
      { name: "Provider: Groq", configured: true, detail: "meta-llama/llama-4-scout-17b-16e-instruct" },
      { name: "Provider: OllamaCloud_1", configured: true, detail: "gemma4:31b" },
      { name: "Provider: OllamaCloud_2", configured: false, detail: "gemma4:31b" },
    ],
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
        if (path === "/api/admin/metrics/finance") return send(res, 200, finance(Math.min(days, 365)));
        if (path === "/api/admin/metrics/downloads") return send(res, 200, downloads());
        if (path === "/api/admin/metrics/funnel") return send(res, 200, funnel(Math.min(Math.max(days, 7), 365)));
        if (path === "/api/admin/metrics/status") return send(res, 200, status());
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
