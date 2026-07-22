import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2 } from "lucide-react";
import { Logo } from "./Logo";
import LightRays from "./LightRays";
import { useResolvedTheme } from "../lib/theme";
import { useApp } from "../lib/store";
import { startWebGoogleSignIn } from "../lib/cloud";
import { IS_WEB } from "../lib/api";
import { cn } from "../lib/cn";
import { isMacOS, needsLightweightRendering } from "../lib/platform";
import { dragRegionAttrs, onDragMouseDown } from "../lib/drag";
import { ROTATING_WORDS } from "../lib/constants";

function LeftVisual() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % ROTATING_WORDS.length);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col items-center justify-center gap-8 text-center">
      <div className="rounded-3xl p-4">
        <Logo size={90} className="text-ink" />
      </div>
      <div className="flex flex-col items-center justify-center gap-2 text-center text-4xl leading-[1.02] tracking-tight text-ink md:text-5xl lg:text-6xl">
        <span className="block">Your agent for</span>
        <div className="relative flex h-[1.18em] min-w-[8.2em] items-center justify-center overflow-hidden leading-none">
          <span className="pointer-events-none invisible select-none italic">
            getting unstuck
          </span>
          <AnimatePresence mode="wait">
            <motion.span
              key={index}
              initial={{ y: "100%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "-100%", opacity: 0 }}
              transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1.0] }}
              className="absolute inset-0 flex items-center justify-center italic whitespace-nowrap"
            >
              {ROTATING_WORDS[index]}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export function LoginScreen() {
  const macOS = isMacOS();
  const isLoadingAuth = useApp((s) => s.isLoadingAuth);
  const signInWithGoogle = useApp((s) => s.signInWithGoogle);
  const theme = useResolvedTheme();
  const [error, setError] = useState<string | null>(null);

  // Web vs Tauri detection. `IS_WEB` keys off `__TAURI_INTERNALS__`, which a
  // browser extension or stray global can make truthy — that would route a web
  // user into the desktop invoke() path and crash with "reading 'invoke' of
  // undefined". Treat the known web origins as definitively web (the Tauri
  // shell never serves over https to a real hostname), so a spoofed global
  // can't force the desktop code path.
  const isWeb = (() => {
    if (typeof window === "undefined") return false;
    const origin = window.location.origin;
    if (
      origin === "https://app.tryzwork.app" ||
      origin === "https://tryzwork.app" ||
      origin === "https://www.tryzwork.app"
    ) {
      return true;
    }
    return IS_WEB;
  })();

  const handleGoogleSignIn = async () => {
    setError(null);
    if (isWeb) {
      // Web: top-level navigation to Better Auth Google OAuth (sets state
      // cookie first-party, then 302s to Google).
      startWebGoogleSignIn();
      return;
    }
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed. Please try again.");
    }
  };

  return (
    <div className="onboarding-shell relative flex h-full min-h-screen min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      {/* LightRays background — same config as Onboarding */}
      <div className="pointer-events-none absolute inset-0 z-0 bg-paper-sunken">
        <LightRays
          key={theme}
          raysOrigin="left"
          raysColor={theme === "dark" ? "#d9fbff" : "#20312b"}
          raysSpeed={0.58}
          lightSpread={0.8}
          rayLength={1.45}
          followMouse
          mouseInfluence={0.12}
          noiseAmount={0.24}
          distortion={0.06}
          fadeDistance={1.18}
          saturation={theme === "dark" ? 1.2 : 0.82}
          pulsating
          className="opacity-90"
        />
      </div>

      {/* Subtle gradient overlay */}
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            theme === "dark"
              ? "linear-gradient(90deg, rgb(var(--paper) / 0.06) 0%, rgb(var(--paper) / 0.18) 38%, rgb(var(--paper) / 0.74) 100%)"
              : "linear-gradient(90deg, rgb(var(--paper) / 0.04) 0%, rgb(var(--paper) / 0.14) 38%, rgb(var(--paper) / 0.68) 100%)",
        }}
      />

      {/* Window drag region — these full-screen gates render without the main
          layout's base layer, so they need their own drag strip at the top. */}
      {macOS && (
        <div
          {...dragRegionAttrs()}
          onMouseDown={onDragMouseDown}
          className="absolute inset-x-0 top-0 z-10 h-10"
          aria-hidden="true"
        />
      )}

      {/* Content area */}
      <div className="relative z-20 flex h-full flex-1 items-center p-5 md:p-6">

        {/* Left side visual */}
        <div className="absolute inset-y-0 left-0 right-[548px] hidden select-none lg:block xl:right-[596px]">
          <div className="flex h-full w-full items-center justify-center px-10">
            <LeftVisual />
          </div>
        </div>

        {/* Right card */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "relative flex h-full w-full max-w-[520px] flex-col ml-auto",
            "rounded-2xl border border-line/80",
            needsLightweightRendering()
              ? "bg-paper-raised"
              : "bg-paper-raised/92 backdrop-blur-lg",
            "shadow-[0_20px_60px_-20px_rgb(var(--shadow)/0.35),0_2px_6px_-2px_rgb(var(--shadow)/0.15)]",
            "overflow-hidden",
          )}
        >
          {/* Card header */}
          <div className="flex flex-shrink-0 items-center border-b border-line/70 px-7 py-4 md:px-9">
            <div className="flex items-center gap-2">
              <Logo size={20} />
              <span className="text-[13.5px] font-semibold tracking-tight text-ink">
                <span className="lowercase">z</span>Work
              </span>
            </div>
          </div>

          {/* Scrollable body */}
          <div className="relative flex min-h-0 flex-1 items-center overflow-y-auto px-7 py-6 md:px-9 md:py-8">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
              className="w-full"
            >
              {/* Header copy */}
              <div className="mb-6">
                <span className="mb-3 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                  <span className="h-[1px] w-4 bg-line-strong" />
                  Welcome
                </span>

                <h2 className="text-[25px] font-medium leading-[1.18] tracking-tight text-ink md:text-[28px]">
                  Sign in to continue
                </h2>

                <p className="mt-2.5 text-[14px] leading-6 text-ink-muted">
                  Pick up where you left off
                </p>
              </div>

              {/* Google sign in */}
              <button
                type="button"
                disabled={isLoadingAuth}
                onClick={handleGoogleSignIn}
                className={cn(
                  "press inline-flex w-full items-center justify-center gap-2.5 rounded-xl border border-line bg-paper-raised px-4 py-3 text-[14px] font-medium text-ink transition-colors",
                  "hover:border-line-strong hover:bg-paper-sunken",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {isLoadingAuth ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Connecting to Google…
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    Continue with Google
                  </>
                )}
              </button>

              {/* Error message */}
              {error && (
                <p className="mt-4 rounded-lg border border-line-strong bg-paper-sunken px-3 py-2 text-[12.5px] text-ink">
                  {error}
                </p>
              )}

              {/* Notice disabled for now */}
              {/* {notice && (
                <p className="mt-4 rounded-lg border border-line bg-paper-sunken px-3 py-2 text-[12.5px] text-ink">
                  {notice}
                </p>
              )} */}

              {/* Footer note */}
              <p className="mt-6 text-center text-[11.5px] text-ink-faint">
                Free to start • No credit card required
              </p>
            </motion.div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
