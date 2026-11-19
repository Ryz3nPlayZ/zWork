import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Check } from "lucide-react";
import { Logo } from "./Logo";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { recordTelemetry } from "../lib/telemetry";
import { needsLightweightRendering } from "../lib/platform";
import { api, type OnboardingAnswer, type OnboardingCredential } from "../lib/api";
import { CHORES } from "../lib/chores";
import { EarlyScreenChrome } from "./TitleBar";
import { ThemeTiles } from "./AppearanceSettings";

const JOB_QUESTION = "What paperwork keeps coming back?";
// The rest stay in Settings > Appearance; these fit two rows.
const ONBOARDING_PRESETS = ["dune", "tide", "meadow", "blossom", "graphite", "night", "aurora"];

/** One screen: pick a first job (optional) and a look, then start. */
export function Onboarding() {
  const setOnboardingDone = useApp((s) => s.setOnboardingDone);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const refreshMe = useApp((s) => s.refreshMe);
  const me = useApp((s) => s.me);
  const firstName = me?.name?.trim().split(/\s+/)[0] || "";

  const [job, setJob] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const complete = async () => {
    if (saving) return;
    setError("");
    setSaving(true);
    const chore = CHORES.find((c) => c.id === job);
    const payload: OnboardingAnswer[] = [
      { key: "name", question: "What should we call you?", answer: firstName },
      { key: "first_job", question: JOB_QUESTION, answer: chore?.label || "" },
    ];
    // Sign-in is required on desktop and Free includes hosted models, so nobody
    // needs a key to start. Their own key is in Settings.
    const token = (window.localStorage.getItem("zwork:cloud-token") || "").trim();
    const credential: OnboardingCredential | undefined = token
      ? {
          shape: "anthropic",
          credential: "zwork_router",
          api_key: token,
          base_url: "https://api.tryzwork.app/api",
          model_id: "zwork-auto",
          model_name: "zwork-auto · zWork",
        }
      : undefined;
    try {
      await api.waitForBackend();
      await api.onboardComplete({ answers: payload, credential, telemetry_enabled: true });
      await Promise.all([refreshProviders(), refreshSettings(), refreshMe()]);
      recordTelemetry("onboarding_completed", {
        credential: credential?.credential || "",
        model_id: credential?.model_id || "",
        first_job: chore?.id || "",
      });
      useApp.setState({ starterDraft: chore?.prompt || "" });
      setOnboardingDone(true);
    } catch (err) {
      console.error(err);
      setSaving(false);
      const detail = err instanceof Error ? err.message : String(err);
      setError(`Setup did not save. ${friendlySetupError(detail)}`);
    }
  };

  // Enter starts, unless a button has focus (Enter clicks it instead).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (saving || e.defaultPrevented || e.key !== "Enter" || e.shiftKey) return;
      if ((document.activeElement as HTMLElement | null)?.tagName === "BUTTON") return;
      e.preventDefault();
      void complete();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (saving) return <FinalizingScreen />;

  return (
    // No background of its own, so a look with a wallpaper shows behind the card.
    <div className="relative flex h-full min-h-screen w-full flex-col overflow-y-auto">
      <EarlyScreenChrome />
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "w-full max-w-[600px] rounded-2xl border border-line/80 p-6 md:p-9",
            needsLightweightRendering() ? "bg-paper-raised" : "bg-paper-raised/90 backdrop-blur-lg",
            "shadow-[0_20px_60px_-20px_rgb(var(--shadow)/0.35),0_2px_6px_-2px_rgb(var(--shadow)/0.15)]",
          )}
        >
          <div className="flex items-center gap-2">
            <Logo size={20} />
            <span className="text-[13.5px] font-semibold tracking-tight text-ink">
              <span className="lowercase">z</span>Work
            </span>
          </div>

          <h1 className="mt-6 font-serif text-[34px] leading-[1.1] tracking-tight text-ink">
            {firstName ? `Welcome, ${firstName}.` : "Welcome to zWork."}
          </h1>
          <p className="mt-2 text-[14px] leading-6 text-ink-muted">Two quick choices and you're in.</p>

          <section className="mt-7">
            <h2 className="text-[14px] font-medium text-ink">{JOB_QUESTION}</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-muted">Pick one to start with, or skip it.</p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CHORES.map((c) => {
                const on = job === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setJob(on ? "" : c.id)}
                    className={cn(
                      "press ring-focus flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left text-[13.5px] text-ink transition-colors",
                      on
                        ? "border-line-strong bg-paper-sunken ring-1 ring-inset ring-line-strong"
                        : "border-line bg-paper-raised hover:border-line-strong",
                    )}
                  >
                    <span>{c.label}</span>
                    {on && <Check className="h-4 w-4 flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="mt-7">
            <h2 className="text-[14px] font-medium text-ink">Pick a look</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-muted">More colors in Settings, any time.</p>
            <ThemeTiles className="mt-3" only={ONBOARDING_PRESETS} />
          </section>

          {error && (
            <p role="alert" className="mt-5 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] text-error">
              {error}
            </p>
          )}

          <div className="mt-8 flex justify-end">
            <button
              type="button"
              onClick={() => void complete()}
              className="press ring-focus inline-flex items-center gap-1.5 rounded-full bg-ink px-5 py-2.5 text-[13.5px] font-medium text-paper shadow-sm hover:bg-ink-soft"
            >
              Start <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </motion.div>
      </main>
    </div>
  );
}

function friendlySetupError(detail: string) {
  if (/failed to fetch|load failed|networkerror|did not become ready/i.test(detail)) {
    return "zWork didn't finish starting. Quit and reopen it.";
  }
  if (/address already in use|eaddrinuse/i.test(detail)) {
    return "Another copy of zWork is already running. Quit it and reopen zWork.";
  }
  return detail || "Please try again.";
}

function FinalizingScreen() {
  return (
    <div className="flex h-full min-h-screen w-full items-center justify-center">
      <span className="shimmer-text-slow font-serif text-[24px] tracking-tight">Setting things up…</span>
    </div>
  );
}
