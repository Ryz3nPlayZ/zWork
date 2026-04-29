import { useApp } from "../lib/store";

export function UsagePage() {
  const user = useApp((s) => s.user);

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-ink mb-4">Usage</h1>

      {!user ? (
        <div className="rounded-lg border border-line bg-paper p-4 text-ink-muted text-sm">
          Sign in to view usage statistics.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Tier Card */}
          <div className="rounded-lg border border-line bg-paper p-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium text-ink">Current Plan</h2>
                <p className="text-xs text-ink-muted mt-1">
                  {user.tier === "pro" ? "zWork Pro" : "zWork Free"}
                </p>
              </div>
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                user.tier === "pro"
                  ? "bg-amber-100 text-amber-800"
                  : "bg-line text-ink-muted"
              }`}>
                {user.tier === "pro" ? "Pro" : "Free"}
              </span>
            </div>
          </div>

          {/* Usage Stats Placeholder */}
          <div className="rounded-lg border border-line bg-paper p-4">
            <h2 className="text-sm font-medium text-ink mb-3">This Period</h2>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-2xl font-semibold text-ink">0</p>
                <p className="text-xs text-ink-muted">Requests</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-ink">0</p>
                <p className="text-xs text-ink-muted">Tokens</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-ink">0m</p>
                <p className="text-xs text-ink-muted">Session Time</p>
              </div>
            </div>
          </div>

          {/* Model Usage */}
          <div className="rounded-lg border border-line bg-paper p-4">
            <h2 className="text-sm font-medium text-ink mb-3">Model Breakdown</h2>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-muted">minimax-m2.7:cloud</span>
                <span className="text-ink">0 requests</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
