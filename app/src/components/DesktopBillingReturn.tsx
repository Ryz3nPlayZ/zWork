import { Logo } from "./Logo";
import type { BillingReturn } from "../lib/billingReturn";

const COPY: Record<BillingReturn, { title: string; body: string }> = {
  success: {
    title: "You're all set",
    body: "Payment went through. Head back to the zWork app; your new plan shows up there within a few seconds.",
  },
  cancel: {
    title: "Checkout cancelled",
    body: "Nothing was charged. You can pick a plan again from the zWork app whenever you like.",
  },
  portal: {
    title: "Billing updated",
    body: "Any changes you made are saved. Head back to the zWork app to keep working.",
  },
};

/** The page a desktop user's browser lands on after Stripe. It isn't where
 *  they use zWork, so it needs no sign-in: it only says to go back. */
export function DesktopBillingReturn({ kind }: { kind: BillingReturn }) {
  const { title, body } = COPY[kind];
  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-paper px-6">
      <div className="flex max-w-[420px] flex-col items-center gap-5 text-center">
        <Logo size={56} className="text-ink" />
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">{title}</h1>
        <p className="text-[15px] leading-relaxed text-ink-soft">{body}</p>
        <p className="text-[13px] text-ink-muted">You can close this tab.</p>
      </div>
    </div>
  );
}
