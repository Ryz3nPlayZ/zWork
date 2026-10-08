import { useState } from "react";
import { Check, Sparkles, Zap } from "lucide-react";
import { type CloudUser, createBillingCheckoutSession, createBillingPortalSession, redeemAccessCode } from "../lib/cloud";
import { cn } from "../lib/cn";

interface PricingTier {
  id: "free" | "pro" | "max";
  name: string;
  priceDisplay: string;
  pricePeriod: string;
  description: string;
  features: string[];
  highlight?: boolean;
}

const PRICING_TIERS: PricingTier[] = [
  {
    id: "free",
    name: "Free",
    priceDisplay: "$0",
    pricePeriod: "forever",
    description: "For getting started with AI-powered development.",
    features: [
      "20 root requests per 5 hours",
      "100 requests per week",
      "Standard processing",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    priceDisplay: "$12",
    pricePeriod: "per month",
    description: "For serious work with higher limits and hosted access.",
    features: [
      "200 root requests per 5 hours",
      "2,000 requests per week",
      "Hosted AI gateway access",
      "Advanced analytics",
      "Priority support",
    ],
    highlight: true,
  },
  {
    id: "max",
    name: "Max",
    priceDisplay: "$50",
    pricePeriod: "per month",
    description: "For power users who need the most capacity.",
    features: [
      "1,000 root requests per 5 hours",
      "10,000 requests per week",
      "Everything in Pro",
      "Priority processing",
      "Dedicated support",
    ],
  },
];

export function PlanPage({ cloudUser }: { cloudUser: CloudUser }) {
  const currentTier = cloudUser.tier as "free" | "pro" | "max";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);

  const handleRedeem = async () => {
    const code = couponCode.trim();
    if (!code) return;
    setCouponBusy(true);
    setError("");
    try {
      await redeemAccessCode(code);
      setCouponCode("");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setCouponBusy(false);
    }
  };

  const handleUpgrade = async (_tier: "pro" | "max") => {
    setBusy(true);
    setError("");
    try {
      const session = await createBillingCheckoutSession(false);
      window.open(session.url, "_blank");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start checkout");
    } finally {
      setBusy(false);
    }
  };

  const handleManage = async () => {
    setBusy(true);
    setError("");
    try {
      const session = await createBillingPortalSession();
      window.open(session.url, "_blank");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open billing portal");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[900px] px-6 py-8">
        <header className="mb-8">
          <h1 className="text-[36px] font-light tracking-tight text-ink">Plan</h1>
          <p className="mt-2 text-[14px] text-ink-muted">
            You're on the <span className="font-medium text-ink">{currentTier === "free" ? "Free" : currentTier === "pro" ? "Pro" : "Max"}</span> plan
          </p>
        </header>

        {error && (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        )}

        {/* Pricing cards */}
        <div className="grid gap-4 sm:grid-cols-3 mb-8">
          {PRICING_TIERS.map((tier) => {
            const isCurrent = tier.id === currentTier;

            return (
              <div
                key={tier.id}
                className={cn(
                  "relative rounded-2xl border bg-paper p-6 transition-shadow",
                  isCurrent
                    ? "border-line-strong shadow-[0_0_0_1px_rgb(var(--ink)/0.15)]"
                    : tier.highlight
                      ? "border-line bg-paper-raised hover:shadow-md"
                      : "border-line hover:shadow-sm",
                )}
              >
                {isCurrent && (
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                    <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-paper px-2.5 py-0.5 text-[11px] font-medium text-ink shadow-sm">
                      <Zap className="h-3 w-3" /> Current
                    </span>
                  </div>
                )}

                <div className="mb-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[18px] font-semibold tracking-tight text-ink">
                      {tier.name}
                    </h3>
                    {tier.highlight && !isCurrent && (
                      <Sparkles className="h-4 w-4 text-ink-muted" />
                    )}
                  </div>
                  <p className="mt-1 text-[13px] text-ink-muted">{tier.description}</p>
                </div>

                <div className="mb-6">
                  <span className="text-[36px] font-light tracking-tight text-ink">
                    {tier.priceDisplay}
                  </span>
                  <span className="ml-1 text-[14px] text-ink-muted">{tier.pricePeriod}</span>
                </div>

                <ul className="space-y-3 mb-6">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 text-[13px] text-ink">
                      <Check className="h-4 w-4 shrink-0 mt-0.5 text-ink-muted" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {isCurrent ? (
                  <button
                    type="button"
                    onClick={handleManage}
                    disabled={busy}
                    className="press ring-focus w-full rounded-xl border border-line bg-paper-raised px-4 py-2.5 text-[13px] font-medium text-ink hover:bg-paper-sunken transition-colors disabled:opacity-40"
                  >
                    Manage billing
                  </button>
                ) : tier.id === "free" ? null : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleUpgrade(tier.id as "pro" | "max")}
                    className={cn(
                      "press ring-focus w-full rounded-xl px-4 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-40",
                      tier.highlight
                        ? "bg-ink text-paper hover:bg-ink/90"
                        : "border border-line bg-paper text-ink hover:bg-paper-sunken",
                    )}
                  >
                    Upgrade to {tier.name}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Coupon */}
        <section className="rounded-2xl border border-line bg-paper-raised p-5">
          <h3 className="text-[15px] font-semibold text-ink">Redeem access code</h3>
          <p className="mt-1 text-[13px] text-ink-muted">
            Have a code? Enter it below.
          </p>
          <div className="mt-3 flex gap-2">
            <label htmlFor="coupon-code-input" className="sr-only">Access code</label>
            <input
              id="coupon-code-input"
              type="text"
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value)}
              placeholder="Enter code…"
              disabled={couponBusy}
              className="block flex-1 rounded-lg border border-line bg-paper px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-40"
              onKeyDown={(e) => { if (e.key === "Enter") handleRedeem(); }}
            />
            <button
              type="button"
              disabled={couponBusy || !couponCode.trim()}
              onClick={handleRedeem}
              className="press ring-focus rounded-xl bg-ink px-5 py-2.5 text-[13px] font-medium text-paper hover:bg-ink/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {couponBusy ? "Redeeming…" : "Redeem"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
