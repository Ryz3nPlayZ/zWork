import { useState } from "react";
import { Check, Zap, ArrowRight, Gift } from "lucide-react";
import { type CloudUser, createBillingCheckoutSession, createBillingPortalSession, redeemAccessCode } from "../lib/cloud";
import { cn } from "../lib/cn";

interface PricingTier {
  id: "free" | "pro" | "max";
  name: string;
  priceDisplay: string;
  pricePeriod: string;
  description: string;
  features: string[];
  cta: string;
}

const TIERS: PricingTier[] = [
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
    cta: "Current plan",
  },
  {
    id: "pro",
    name: "Pro",
    priceDisplay: "$12",
    pricePeriod: "/month",
    description: "Higher limits and hosted access for serious work.",
    features: [
      "200 root requests per 5 hours",
      "2,000 requests per week",
      "Hosted AI gateway access",
      "Advanced analytics",
      "Priority support",
    ],
    cta: "Upgrade to Pro",
  },
  {
    id: "max",
    name: "Max",
    priceDisplay: "$50",
    pricePeriod: "/month",
    description: "Maximum capacity for power users and teams.",
    features: [
      "1,000 root requests per 5 hours",
      "10,000 requests per week",
      "Everything in Pro",
      "Priority processing",
      "Dedicated support",
    ],
    cta: "Upgrade to Max",
  },
];

export function PlanPage({ cloudUser }: { cloudUser: CloudUser }) {
  const currentTier = cloudUser.tier as "free" | "pro" | "max";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [showCoupon, setShowCoupon] = useState(false);

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

  const handleUpgrade = async (_tier: string) => {
    if (_tier !== "pro" && _tier !== "max") return;
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

  const current = TIERS.find((t) => t.id === currentTier)!;
  const upgradeTiers = TIERS.filter((t) => t.id !== "free" && t.id !== currentTier);
  const isPaid = currentTier !== "free";

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[720px] px-6 py-8">
        {/* Header */}
        <header className="mb-10">
          <h1 className="text-[28px] font-semibold tracking-tight text-ink">Plan</h1>
          <p className="mt-1.5 text-[14px] text-ink-muted">
            Choose the capacity that fits your workflow.
          </p>
        </header>

        {error && (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        )}

        {/* Current plan — status card */}
        <section className="mb-8">
          <div className="rounded-2xl border border-line bg-paper-raised p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-[22px] font-semibold tracking-tight text-ink">
                    {current.name}
                  </h2>
                  <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-paper px-2.5 py-0.5 text-[11px] font-medium text-ink shadow-sm">
                    <Zap className="h-3 w-3" /> Current
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-ink-muted">{current.description}</p>
              </div>
              <div className="text-right">
                <span className="text-[28px] font-semibold tracking-tight text-ink">
                  {current.priceDisplay}
                </span>
                <span className="ml-1 text-[13px] text-ink-muted">{current.pricePeriod}</span>
              </div>
            </div>

            {/* Subscription status */}
            {isPaid && cloudUser.subscription_status && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-line bg-paper px-3 py-2">
                <div className={cn(
                  "h-2 w-2 rounded-full",
                  cloudUser.subscription_status === "active" ? "bg-emerald-500" : "bg-amber-400"
                )} />
                <span className="text-[12.5px] text-ink-muted">
                  Subscription {cloudUser.subscription_status}
                  {cloudUser.subscription_current_period_end && (
                    <>
                      {" · Renews "}
                      {new Date(cloudUser.subscription_current_period_end).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </>
                  )}
                </span>
              </div>
            )}

            {/* Limits */}
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {current.features.slice(0, 3).map((feature) => (
                <div
                  key={feature}
                  className="flex items-start gap-2 rounded-xl border border-line/60 bg-paper px-3 py-2.5"
                >
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" />
                  <span className="text-[12.5px] leading-4 text-ink-soft">{feature}</span>
                </div>
              ))}
            </div>

            {isPaid && (
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={handleManage}
                  disabled={busy}
                  className="press ring-focus inline-flex items-center gap-1.5 rounded-xl border border-line bg-paper px-4 py-2 text-[13px] font-medium text-ink hover:bg-paper-sunken disabled:opacity-40"
                >
                  Manage billing
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Upgrade options */}
        {upgradeTiers.length > 0 && (
          <section className="mb-8">
            <h3 className="mb-4 text-[13px] font-semibold uppercase tracking-wider text-ink-faint">
              Upgrade
            </h3>
            <div className="flex flex-col gap-3">
              {upgradeTiers.map((tier) => (
                <UpgradeRow
                  key={tier.id}
                  tier={tier}
                  busy={busy}
                  onUpgrade={() => handleUpgrade(tier.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Downgrade / other options */}
        {currentTier === "max" && (
          <section className="mb-8">
            <h3 className="mb-4 text-[13px] font-semibold uppercase tracking-wider text-ink-faint">
              Other plans
            </h3>
            <div className="flex flex-col gap-3">
              <UpgradeRow
                tier={TIERS.find((t) => t.id === "pro")!}
                busy={busy}
                onUpgrade={() => handleUpgrade("pro")}
              />
            </div>
          </section>
        )}

        {/* Coupon */}
        <section className="rounded-2xl border border-line bg-paper-raised p-5">
          <button
            type="button"
            onClick={() => setShowCoupon((s) => !s)}
            className="press flex w-full items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <Gift className="h-4 w-4 text-ink-muted" />
              <span className="text-[13px] font-medium text-ink">Redeem access code</span>
            </div>
            <ArrowRight
              className={cn(
                "h-4 w-4 text-ink-muted transition-transform duration-200",
                showCoupon && "rotate-90"
              )}
            />
          </button>

          {showCoupon && (
            <div className="mt-4 border-t border-line pt-4">
              <p className="mb-3 text-[12.5px] text-ink-muted">
                Have a code? Enter it below to apply it to your account.
              </p>
              <div className="flex gap-2">
                <label htmlFor="coupon-code-input" className="sr-only">
                  Access code
                </label>
                <input
                  id="coupon-code-input"
                  type="text"
                  value={couponCode}
                  onChange={(e) => setCouponCode(e.target.value)}
                  placeholder="Enter code…"
                  disabled={couponBusy}
                  className="block flex-1 rounded-xl border border-line bg-paper px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-40"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRedeem();
                  }}
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
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function UpgradeRow({
  tier,
  busy,
  onUpgrade,
}: {
  tier: PricingTier;
  busy: boolean;
  onUpgrade: () => void;
}) {
  return (
    <div className="group flex flex-col gap-4 rounded-2xl border border-line bg-paper-raised p-5 transition-colors hover:border-line-strong sm:flex-row sm:items-center">
      <div className="flex-1">
        <div className="flex items-center gap-3">
          <h4 className="text-[16px] font-semibold tracking-tight text-ink">{tier.name}</h4>
          <span className="text-[20px] font-semibold tracking-tight text-ink">
            {tier.priceDisplay}
          </span>
          <span className="text-[13px] text-ink-muted">{tier.pricePeriod}</span>
        </div>
        <p className="mt-1 text-[13px] text-ink-muted">{tier.description}</p>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {tier.features.map((feature) => (
            <li key={feature} className="flex items-center gap-1.5 text-[12px] text-ink-soft">
              <Check className="h-3 w-3 shrink-0 text-ink-muted" />
              {feature}
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onUpgrade}
        className="press ring-focus inline-flex items-center justify-center gap-1.5 rounded-xl bg-ink px-5 py-2.5 text-[13px] font-medium text-paper hover:bg-ink/90 disabled:opacity-40 disabled:cursor-not-allowed sm:shrink-0"
      >
        {tier.cta}
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  );
}
