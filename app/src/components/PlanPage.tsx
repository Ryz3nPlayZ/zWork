import { type CloudUser } from "../lib/cloud";

export function PlanPage({
  cloudUser,
}: {
  cloudUser: CloudUser;
}) {
  const isPro = cloudUser.tier === "pro";

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[600px] px-6 py-8">

        {/* Header */}
        <header className="mb-8 border-b border-line/50 pb-6">
          <h1 className="text-[36px] font-light tracking-tight text-ink">
            Plan
          </h1>
          <p className="mt-2 text-[14px] text-ink-muted">
            Manage your subscription
          </p>
        </header>

        {/* Current Plan Card */}
        <section className="rounded-2xl border border-line bg-paper p-6">
          <div className="mb-6">
            <p className="text-[13px] uppercase tracking-wide text-ink-faint">Current plan</p>
          </div>

          <div className="mb-6">
            <h2 className="text-[32px] font-light tracking-tight text-ink">
              zWork {isPro ? "Pro" : "Free"}
            </h2>
          </div>

          {/* Features list */}
          <div className="space-y-3">
            {isPro ? (
              <>
                <div className="flex items-center gap-3 text-[14px] text-ink">
                  <div className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                  <span>Priority processing</span>
                </div>
                <div className="flex items-center gap-3 text-[14px] text-ink">
                  <div className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                  <span>Hosted AI gateway access</span>
                </div>
                <div className="flex items-center gap-3 text-[14px] text-ink">
                  <div className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                  <span>Advanced analytics</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 text-[14px] text-ink">
                  <div className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                  <span>5-hour rolling usage limit</span>
                </div>
                <div className="flex items-center gap-3 text-[14px] text-ink">
                  <div className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                  <span>Weekly budget quota</span>
                </div>
                <div className="flex items-center gap-3 text-[14px] text-ink">
                  <div className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                  <span>Standard processing</span>
                </div>
              </>
            )}
          </div>

          {/* Action button */}
          <div className="mt-8">
            {isPro ? (
              <button
                type="button"
                className="press ring-focus w-full rounded-xl border border-line/60 bg-paper-raised px-4 py-3 text-[14px] font-medium text-ink hover:bg-paper-sunken transition-colors"
              >
                Manage subscription
              </button>
            ) : (
              <button
                type="button"
                className="press ring-focus w-full rounded-xl bg-ink px-4 py-3 text-[14px] font-medium text-paper hover:bg-ink/90 transition-colors"
              >
                Upgrade to Pro
              </button>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}
