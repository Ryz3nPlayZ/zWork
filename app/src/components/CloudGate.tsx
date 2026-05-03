import { ArrowRight, ShieldCheck, Sparkles } from "lucide-react";
import { cn } from "../lib/cn";

export function CloudGate({
  busy,
  error,
  onContinue,
}: {
  busy: boolean;
  error?: string | null;
  onContinue: () => void | Promise<void>;
}) {
  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-[#f6efe5] px-6 text-[#151313]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(15,118,110,0.18),transparent_34%),linear-gradient(180deg,#fbf6ec_0%,#f6efe5_100%)]" />
      <div className="absolute -left-12 top-10 h-44 w-44 rounded-full bg-[#0f766e]/10 blur-3xl" />
      <div className="absolute bottom-[-60px] right-[-30px] h-64 w-64 rounded-full bg-[#111111]/6 blur-3xl" />

      <section className="relative z-10 w-full max-w-[980px] overflow-hidden rounded-[32px] border border-[#151313]/8 bg-white/70 shadow-[0_30px_120px_rgba(21,19,19,0.12)] backdrop-blur-xl">
        <div className="grid gap-0 md:grid-cols-[1.15fr_0.85fr]">
          <div className="border-b border-[#151313]/8 p-8 md:border-r md:border-b-0 md:p-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#151313]/8 bg-white/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6a615b]">
              <ShieldCheck className="h-3.5 w-3.5 text-[#0f766e]" />
              Managed access
            </div>
            <h1 className="mt-5 max-w-[10ch] text-[46px] font-light leading-[0.95] tracking-tight text-[#151313] md:text-[58px]">
              Sign in before anything else.
            </h1>
            <p className="mt-4 max-w-[48ch] text-[15px] leading-7 text-[#6a615b]">
              zWork now requires an account so usage, telemetry, plans, and cross-device state all map to a real user. Your local harness stays local unless you switch into the managed hosted path.
            </p>

            <button
              type="button"
              disabled={busy}
              onClick={() => void onContinue()}
              className={cn(
                "mt-8 inline-flex items-center gap-2 rounded-full bg-[#151313] px-5 py-3 text-[14px] font-medium text-[#f6efe5] transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-60",
                busy && "animate-pulse",
              )}
            >
              <Sparkles className="h-4 w-4" />
              {busy ? "Opening Google sign-in…" : "Continue with Google"}
              <ArrowRight className="h-4 w-4" />
            </button>

            {error && (
              <div className="mt-4 max-w-[44ch] rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] leading-6 text-rose-700">
                {error}
              </div>
            )}
          </div>

          <div className="relative bg-[#eee4d1] p-8 md:p-12">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#151313]/15 to-transparent md:hidden" />
            <div className="rounded-[28px] border border-[#151313]/10 bg-[#fcf8ef] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a7d73]">
                What unlocks
              </div>
              <div className="mt-4 space-y-3">
                {[
                  "Account-backed sessions and device identity",
                  "Anonymous-but-account-linked telemetry and usage stats",
                  "Managed model access with rate limits on user requests, not tool turns",
                  "Pro access through Stripe billing or server-issued access codes",
                ].map((line) => (
                  <div key={line} className="rounded-2xl border border-[#151313]/8 bg-white/70 px-4 py-3 text-[13px] leading-6 text-[#3d3733]">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
