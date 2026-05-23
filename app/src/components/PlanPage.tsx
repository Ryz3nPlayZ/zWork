import { useState } from "react";
import { Check, ArrowUpRight } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { type CloudUser, createBillingCheckoutSession, createBillingPortalSession, redeemAccessCode } from "../lib/cloud";
import { cn } from "../lib/cn";

interface PricingTier {
  id: "free" | "pro" | "max";
  name: string;
  priceMonthly: number;
  priceAnnual: number;
  annualPerMonth: number;
  description: string;
  features: string[];
  cta: string;
  highlight?: boolean;
}

const TIERS: PricingTier[] = [
  {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    priceAnnual: 0,
    annualPerMonth: 0,
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
    annualPerMonth: 10,
    description: "Higher limits and hosted access for serious work.",
    features: [
      "200 root requests per 5 hours",
      "2,000 requests per week",
      "Hosted AI gateway access",
      "Advanced analytics",
      "Priority support",
    ],
    cta: "Upgrade to Pro",
    highlight: true,
  },
  {
    id: "max",
    name: "Max",
    priceMonthly: 50,
    priceAnnual: 500,
    annualPerMonth: 41.67,
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
      const session = await createBillingCheckoutSession(isAnnual, tierId);
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
      <div className="mx-auto w-full max-w-[1060px] px-8 py-14">
        {/* Header */}
        <header className="mb-14 text-center">
          <h1 className="font-serif text-[40px] tracking-tight text-ink">Pricing</h1>
          <p className="mx-auto mt-4 max-w-[500px] text-[15px] leading-relaxed text-ink-soft">
            Upgrade to unlock faster models, higher concurrency, and more powerful capabilities.
          </p>
        </header>

        {error && (
          <div className="mb-8 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        )}

        {/* Monthly / Annual toggle */}
        <div className="mb-12 flex justify-center">
          <div className="inline-flex rounded-full border border-line bg-paper-raised p-1">
            <button
              type="button"
              onClick={() => setIsAnnual(false)}
              className={cn(
                "press rounded-full px-6 py-2.5 text-[13px] font-semibold transition-colors",
                !isAnnual ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setIsAnnual(true)}
              className={cn(
                "press rounded-full px-6 py-2.5 text-[13px] font-semibold transition-colors",
                isAnnual ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
              )}
            >
              Annual
              <span className="ml-1.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">
                Save 17%
              </span>
            </button>
          </div>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3 items-start">
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

        {/* Coupon — small text link */}
        <div className="mt-10 text-center">
          {!showCoupon ? (
            <button
              type="button"
              onClick={() => setShowCoupon(true)}
              className="text-[12px] text-ink-faint hover:text-ink-muted underline underline-offset-2 transition-colors"
            >
              Redeem access code
            </button>
          ) : (
            <div className="mx-auto inline-flex flex-col items-center gap-2">
              <div className="flex items-center gap-2">
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
                  className="block w-[200px] rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-40"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRedeem();
                  }}
                />
                <button
                  type="button"
                  disabled={couponBusy || !couponCode.trim()}
                  onClick={handleRedeem}
                  className="press ring-focus rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink/90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {couponBusy ? "Redeeming…" : "Redeem"}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCoupon(false); setCouponCode(""); }}
                  className="text-[12px] text-ink-faint hover:text-ink-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
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
  const isFree = tier.id === "free";

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border p-7 transition-colors",
        isCurrent
          ? "border-ink/20 bg-paper-raised"
          : tier.highlight
            ? "border-ink/30 bg-paper-raised shadow-sm"
            : "border-line bg-paper-raised hover:border-line-strong"
      )}
    >
      {isCurrent && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="inline-flex items-center rounded-full border border-line-strong bg-paper px-3 py-0.5 text-[11px] font-semibold text-ink shadow-sm">
            Current
          </span>
        </div>
      )}

      {/* Plan name */}
      <div className="mb-5">
        <h3 className="text-[18px] font-bold tracking-tight text-ink">{tier.name}</h3>
        <p className="mt-1.5 text-[13px] text-ink-muted">{tier.description}</p>
      </div>

      {/* Price */}
      <div className="mb-6">
        <div className="flex items-baseline gap-1">
          <span className="text-[44px] font-bold tracking-tight text-ink">
            ${price}
          </span>
          <span className="text-[15px] text-ink-muted">{periodLabel}</span>
        </div>
        {/* Always render the billing line so cards align, even for Free */}
        <p className={cn("mt-1 text-[12px]", isFree ? "text-transparent" : "text-ink-faint")}>
          {isAnnual ? "Billed annually" : "Billed monthly"}
        </p>
      </div>

      {/* CTA */}
      {isCurrent && isPaid ? (
        <button
          type="button"
          onClick={onManage}
          disabled={busy}
          className="press ring-focus mb-6 w-full rounded-xl border border-line bg-paper px-4 py-3 text-[13px] font-semibold text-ink hover:bg-paper-sunken disabled:opacity-40"
        >
          Manage billing
        </button>
      ) : isCurrent ? (
        <button
          type="button"
          disabled
          className="mb-6 w-full rounded-xl border border-line bg-paper px-4 py-3 text-[13px] font-semibold text-ink-muted opacity-60 cursor-default"
        >
          {tier.cta}
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={onUpgrade}
          className={cn(
            "press ring-focus mb-6 w-full rounded-xl px-4 py-3 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
            tier.highlight
              ? "bg-ink text-paper hover:bg-ink/90"
              : "border border-line bg-paper text-ink hover:bg-paper-sunken"
          )}
        >
          {busy ? "Opening…" : (
            <span className="inline-flex items-center justify-center gap-1.5">
              {tier.cta}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </span>
          )}
        </button>
      )}

      {/* Features */}
      <ul className="mt-auto space-y-3">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5 text-[13px] text-ink-soft">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
            {feature}
          </li>
        ))}
      </ul>
    </div>
  );
}
