import { useState } from "react";
import { Check, Zap, ArrowRight, Gift } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { type CloudUser, createBillingCheckoutSession, createBillingPortalSession, redeemAccessCode } from "../lib/cloud";
import { cn } from "../lib/cn";

interface PricingTier {
  id: "free" | "pro" | "max";
  name: string;
  priceMonthly: number;
  priceAnnual: number;
  description: string;
  features: string[];
  cta: string;
}

const TIERS: PricingTier[] = [
  {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    priceAnnual: 0,
    description: "For getting started with AI-powered development.",
    features: [
      "20 root requests per 5 hours",
      "100 requests per week",
      "Standard processing",
      "Local backend only",
    ],
    cta: "Current plan",
  },
  {
    id: "pro",
    name: "Pro",
    priceMonthly: 12,
    priceAnnual: 120,
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
    priceMonthly: 50,
    priceAnnual: 480,
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
  const [isAnnual, setIsAnnual] = useState(false);
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

  const handleUpgrade = async (tierId: string) => {
    if (tierId !== "pro" && tierId !== "max") return;
    setBusy(true);
    setError("");
    try {
      const session = await createBillingCheckoutSession(isAnnual);
      if (session?.url) {
        await invoke("open_external", { url: session.url });
      }
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
      if (session?.url) {
        await invoke("open_external", { url: session.url });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open billing portal");
    } finally {
      setBusy(false);
    }
  };

  const isPaid = currentTier !== "free";

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[980px] px-6 py-10">
        {/* Header */}
        <header className="mb-10 text-center">
          <h1 className="text-[32px] font-semibold tracking-tight text-ink">Pricing</h1>
          <p className="mx-auto mt-3 max-w-[480px] text-[15px] leading-relaxed text-ink-soft">
            Upgrade to zWork Membership to unlock faster models, higher concurrency, and more powerful capabilities.
          </p>
        </header>

        {error && (
          <div className="mb-8 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        )}

        {/* Monthly / Annual toggle */}
        <div className="mb-10 flex justify-center">
          <div className="inline-flex rounded-full border border-line bg-paper-raised p-0.5">
            <button
              type="button"
              onClick={() => setIsAnnual(false)}
              className={cn(
                "press rounded-full px-5 py-2 text-[13px] font-medium transition-colors",
                !isAnnual ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setIsAnnual(true)}
              className={cn(
                "press rounded-full px-5 py-2 text-[13px] font-medium transition-colors",
                isAnnual ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
              )}
            >
              Annual
              <span className="ml-1.5 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600">
                Save 17%
              </span>
            </button>
          </div>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {TIERS.map((tier) => (
            <PricingCard
              key={tier.id}
              tier={tier}
              isCurrent={currentTier === tier.id}
              isAnnual={isAnnual}
              busy={busy}
              onUpgrade={() => handleUpgrade(tier.id)}
              onManage={handleManage}
              isPaid={isPaid}
            />
          ))}
        </div>

        {/* Coupon */}
        <section className="mx-auto mt-10 max-w-[480px] rounded-2xl border border-line bg-paper-raised p-5">
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

function PricingCard({
  tier,
  isCurrent,
  isAnnual,
  busy,
  onUpgrade,
  onManage,
  isPaid,
}: {
  tier: PricingTier;
  isCurrent: boolean;
  isAnnual: boolean;
  busy: boolean;
  onUpgrade: () => void;
  onManage: () => void;
  isPaid: boolean;
}) {
  const price = isAnnual ? tier.priceAnnual : tier.priceMonthly;
  const periodLabel = isAnnual ? "/year" : "/month";
  const billingLabel = isAnnual ? "Billed annually" : "Billed monthly";
  const isFree = tier.id === "free";

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border p-6 transition-colors",
        isCurrent
          ? "border-ink/20 bg-paper-raised"
          : "border-line bg-paper-raised hover:border-line-strong"
      )}
    >
      {isCurrent && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-paper px-2.5 py-0.5 text-[11px] font-medium text-ink shadow-sm">
            <Zap className="h-3 w-3" /> Current
          </span>
        </div>
      )}

      {/* Plan name */}
      <div className="mb-4">
        <h3 className="text-[16px] font-semibold tracking-tight text-ink">{tier.name}</h3>
        <p className="mt-1 text-[13px] text-ink-muted">{tier.description}</p>
      </div>

      {/* Price */}
      <div className="mb-6">
        <div className="flex items-baseline gap-1">
          <span className="text-[36px] font-semibold tracking-tight text-ink">
            ${price}
          </span>
          <span className="text-[14px] text-ink-muted">{periodLabel}</span>
        </div>
        {!isFree && (
          <p className="mt-0.5 text-[12px] text-ink-faint">{billingLabel}</p>
        )}
      </div>

      {/* CTA */}
      {isCurrent && isPaid ? (
        <button
          type="button"
          onClick={onManage}
          disabled={busy}
          className="press ring-focus mb-6 w-full rounded-xl border border-line bg-paper px-4 py-2.5 text-[13px] font-medium text-ink hover:bg-paper-sunken disabled:opacity-40"
        >
          Manage billing
        </button>
      ) : isCurrent ? (
        <button
          type="button"
          disabled
          className="mb-6 w-full rounded-xl border border-line bg-paper px-4 py-2.5 text-[13px] font-medium text-ink-muted opacity-60 cursor-default"
        >
          {tier.cta}
        </button>
      ) : tier.id === "max" ? (
        <button
          type="button"
          disabled
          className="mb-6 w-full rounded-xl border border-line bg-paper px-4 py-2.5 text-[13px] font-medium text-ink-muted opacity-60 cursor-default"
        >
          Coming soon
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={onUpgrade}
          className="press ring-focus mb-6 w-full rounded-xl bg-ink px-4 py-2.5 text-[13px] font-medium text-paper hover:bg-ink/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "Opening…" : tier.cta}
        </button>
      )}

      {/* Features */}
      <ul className="mt-auto space-y-2.5">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-[12.5px] text-ink-soft">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" />
            {feature}
          </li>
        ))}
      </ul>
    </div>
  );
}
