import { useState, useEffect } from "react";
import { ArrowRight, Sparkles, Check, Zap, Shield } from "lucide-react";
import { Logo } from "./Logo";
import LightRays from "./LightRays";
import { useResolvedTheme } from "../lib/theme";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

const ROTATING_WORDS = [
  "write better",
  "think clearly",
  "ship faster",
  "brainstorm ideas",
  "solve problems",
  "stay organized",
];

export function LoginScreen() {
  const isLoadingAuth = useApp((s) => s.isLoadingAuth);
  const signInWithGoogle = useApp((s) => s.signInWithGoogle);
  const theme = useResolvedTheme();
  const [rotatingIndex, setRotatingIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setRotatingIndex((i) => (i + 1) % ROTATING_WORDS.length);
    }, 2800);
    return () => clearInterval(timer);
  }, []);

  const handleSignIn = async () => {
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error("Sign in failed:", err);
      setError(err instanceof Error ? err.message : "Sign in failed. Please try again.");
    }
  };

  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-paper">
      {/* Ambient light rays background */}
      <div className="pointer-events-none absolute inset-0 z-0 bg-paper-sunken">
        <LightRays
          key={theme}
          raysOrigin="top-center"
          raysColor={theme === "dark" ? "#d9fbff" : "#20312b"}
          raysSpeed={0.5}
          lightSpread={0.7}
          rayLength={1.3}
          followMouse
          mouseInfluence={0.08}
          noiseAmount={0.18}
          distortion={0.04}
          fadeDistance={1.1}
          saturation={theme === "dark" ? 1.1 : 0.75}
          pulsating
          className="opacity-80"
        />
      </div>

      {/* Gradient fade overlay */}
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            theme === "dark"
              ? "linear-gradient(180deg, rgb(var(--paper) / 0.04) 0%, rgb(var(--paper) / 0.32) 50%, rgb(var(--paper) / 0.72) 100%)"
              : "linear-gradient(180deg, rgb(var(--paper) / 0.02) 0%, rgb(var(--paper) / 0.24) 50%, rgb(var(--paper) / 0.68) 100%)",
        }}
      />

      {/* Main content */}
      <div className="relative z-10 mx-auto w-full max-w-[480px] px-6">
        <div className="overflow-hidden rounded-[28px] border border-line/80 bg-paper-raised/92 backdrop-blur-xl shadow-[0_24px_90px_rgba(17,17,17,0.12)]">
          {/* Header with logo */}
          <div className="border-b border-line/70 px-8 py-6 text-center">
            <div className="flex items-center justify-center gap-3">
              <Logo size={32} />
              <span className="text-[20px] font-semibold tracking-tight text-ink">
                zWork
              </span>
            </div>
          </div>

          {/* Main card content */}
          <div className="px-8 py-8">
            {/* Animated headline */}
            <div className="text-center">
              <h1 className="text-[32px] font-light leading-tight tracking-tight text-ink">
                Your AI companion to
              </h1>
              <div className="relative mt-2 flex h-[1.1em] min-w-[10ch] items-center justify-center overflow-hidden">
                <span className="pointer-events-none invisible select-serif italic">
                  {ROTATING_WORDS[0]}
                </span>
                <span className="absolute inset-0 flex items-center justify-center text-[32px] font-light italic text-ink transition-all duration-500">
                  {ROTATING_WORDS[rotatingIndex]}
                </span>
              </div>
            </div>

            <p className="mt-4 text-center text-[15px] leading-6 text-ink-muted">
              Sign in to get started with your personal AI assistant
            </p>

            {/* Sign in button */}
            <button
              type="button"
              disabled={isLoadingAuth}
              onClick={handleSignIn}
              className={cn(
                "mt-8 flex w-full items-center justify-center gap-3 rounded-full bg-ink px-5 py-3.5 text-[14px] font-medium text-paper transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60",
                isLoadingAuth && "animate-pulse",
              )}
            >
              <Sparkles className="h-4 w-4" />
              {isLoadingAuth ? "Signing in..." : "Continue with Google"}
              <ArrowRight className="h-4 w-4" />
            </button>

            {/* Error message */}
            {error && (
              <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                {error}
              </div>
            )}

            {/* Divider */}
            <div className="my-6 flex items-center gap-3">
              <div className="flex-1 h-px bg-line" />
              <span className="text-[11.5px] text-ink-faint uppercase tracking-wider">What you get</span>
              <div className="flex-1 h-px bg-line" />
            </div>

            {/* Feature list */}
            <div className="space-y-3">
              {[
                {
                  icon: <Zap className="h-4 w-4" />,
                  title: "Smart assistance",
                  description: "Get help with writing, thinking, and problem-solving",
                },
                {
                  icon: <Check className="h-4 w-4" />,
                  title: "Personalized to you",
                  description: "Learns your preferences and working style",
                },
                {
                  icon: <Shield className="h-4 w-4" />,
                  title: "Your data stays yours",
                  description: "Local-first with optional cloud sync",
                },
              ].map((feature, index) => (
                <div
                  key={index}
                  className="flex items-start gap-3 rounded-xl border border-line bg-paper px-4 py-3"
                >
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-paper-sunken text-ink">
                    {feature.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">{feature.title}</div>
                    <div className="mt-0.5 text-[12px] text-ink-muted">{feature.description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-line/70 px-8 py-4 text-center">
            <p className="text-[11.5px] text-ink-faint">
              Free to start • No credit card required
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
