import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ArrowLeft, Check } from "lucide-react";
import { Logo } from "./Logo";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { recordTelemetry } from "../lib/telemetry";
import { useResolvedTheme } from "../lib/theme";
import { needsLightweightRendering } from "../lib/platform";
import { api, type OnboardingAnswer, type OnboardingCredential } from "../lib/api";
import { CHORES } from "../lib/chores";
import LightRays from "./LightRays";
import { CardWindowControls, EarlyScreenChrome } from "./TitleBar";
import { dragRegionAttrs, onDragMouseDown } from "../lib/drag";

/* ------------------------------------------------------------------ *
 *  Question model
 * ------------------------------------------------------------------ */

type CommonQ = {
  key: string;
  /** Small uppercase label shown above the question (e.g. "About you"). */
  eyebrow?: string;
  /** Short tagline shown beneath the question for context. */
  subtitle?: string;
};

type TextQuestion = CommonQ & {
  kind: "text";
  question: string;
  placeholder?: string;
};

type ChoiceQuestion = CommonQ & {
  kind: "choice";
  question: string;
  options: string[];
  hint?: string;
};

type Question = TextQuestion | ChoiceQuestion;

const SOMETHING_ELSE = "Something else";

const QUESTIONS: Question[] = [
  {
    kind: "text",
    key: "name",
    eyebrow: "Say hi",
    question: "First, what should we call you?",
    placeholder: "Your first name",
  },
  {
    kind: "choice",
    key: "first_job",
    eyebrow: "Your first job",
    question: "What paperwork keeps coming back?",
    subtitle: "Pick one to start with. zWork sets it up with you, and you check the result.",
    options: [...CHORES.map((c) => c.label), SOMETHING_ELSE],
  },
];

/* ------------------------------------------------------------------ *
 *  Root component
 * ------------------------------------------------------------------ */

export function Onboarding() {
  const setOnboardingDone = useApp((s) => s.setOnboardingDone);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const refreshMe = useApp((s) => s.refreshMe);
  const me = useApp((s) => s.me);

  const [step, setStep] = useState(0); // index into QUESTIONS
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({
    name: me?.name?.split(/\s+/)[0] || "",
  }));
  const [error, setError] = useState("");

  // Final "Personalizing..." phase
  const [finalizing, setFinalizing] = useState(false);
  const [done, setDone] = useState(false);

  const total = QUESTIONS.length;
  const q = QUESTIONS[step];

  const setAnswer = (key: string, answer: string) =>
    setAnswers((a) => ({ ...a, [key]: answer }));

  const next = () => {
    if (step < total - 1) setStep(step + 1);
    else complete();
  };
  const back = () => {
    if (step > 0) setStep(step - 1);
  };

  const complete = async () => {
    if (finalizing) return;
    setError("");
    setFinalizing(true);
    const payload: OnboardingAnswer[] = QUESTIONS.map((qq) => ({
      key: qq.key,
      question: qq.question,
      answer: answers[qq.key] || "",
    }));
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
    const chore = CHORES.find((c) => c.label === answers.first_job);
    try {
      await api.waitForBackend();
      await api.onboardComplete({
        answers: payload,
        credential,
        telemetry_enabled: true,
      });
      await Promise.all([refreshProviders(), refreshSettings(), refreshMe()]);
      recordTelemetry("onboarding_completed", {
        credential: credential?.credential || "",
        model_id: credential?.model_id || "",
        first_job: chore?.id || "",
      });
      useApp.setState({ starterDraft: chore?.prompt || "" });
      setDone(true);
      // Small delay so the "Setting things up…" message has breathing room.
      setTimeout(() => setOnboardingDone(true), 900);
    } catch (err) {
      console.error(err);
      setFinalizing(false);
      const detail = err instanceof Error ? err.message : String(err);
      setError(`Setup did not save. ${friendlySetupError(detail)}`);
    }
  };

  const friendlySetupError = (detail: string) => {
    if (/failed to fetch|load failed|networkerror|did not become ready/i.test(detail)) {
      return "zWork didn't finish starting. Quit and reopen it.";
    }
    if (/address already in use|eaddrinuse/i.test(detail)) {
      return "Another copy of zWork is already running. Quit it and reopen zWork.";
    }
    return detail || "Please try again.";
  };

  // Keyboard: Enter advances.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finalizing) return;
      if (e.defaultPrevented) return;
      if (e.key === "Enter" && !e.shiftKey) {
        const active = document.activeElement as HTMLElement | null;
        if (active?.tagName === "TEXTAREA") return;
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const theme = useResolvedTheme();

  // Personalizing / setting up screen
  if (finalizing) {
    return <FinalizingScreen done={done} />;
  }

  return (
    <div
      ref={rootRef}
      className="onboarding-shell relative flex h-full min-h-screen min-w-0 flex-1 flex-col overflow-hidden bg-paper"
    >
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

      {/* Subtle gradient that fades the dither toward the card side so text
          on the card always has breathing room. */}
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            theme === "dark"
              ? "linear-gradient(90deg, rgb(var(--paper) / 0.06) 0%, rgb(var(--paper) / 0.18) 38%, rgb(var(--paper) / 0.74) 100%)"
              : "linear-gradient(90deg, rgb(var(--paper) / 0.04) 0%, rgb(var(--paper) / 0.14) 38%, rgb(var(--paper) / 0.68) 100%)",
        }}
      />

      {/* Window chrome — these full-screen gates render without the main
          layout's base layer, so they need their own top strip (drag region
          on macOS, drag region + caption buttons on Windows). */}
      <EarlyScreenChrome controlsInCard />

      {/* Content area — card spans full viewport height, pinned right. */}
      <div className="relative z-20 flex h-full flex-1 items-center p-5 md:p-6">
        
        {/* Left side visual */}
        <div className="absolute inset-y-0 left-0 right-[548px] hidden select-none lg:block xl:right-[596px]">
          <div className="flex h-full w-full items-center justify-center px-10">
            <OnboardingVisual />
          </div>
        </div>

        <motion.div
          layout
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
          {/* Card header: logo left, progress dots right. */}
          <div
            {...dragRegionAttrs()}
            onMouseDown={onDragMouseDown}
            className="flex flex-shrink-0 items-center justify-between border-b border-line/70 px-7 py-4 md:px-9"
          >
          <div className="flex items-center gap-2">
              <Logo size={20} />
              <span className="text-[13.5px] font-semibold tracking-tight text-ink">
                <span className="lowercase">z</span>Work
              </span>
            </div>
            <div className="flex items-center gap-4 self-stretch">
              <ProgressDots step={step} total={total} />
              <CardWindowControls />
            </div>
          </div>

          {/* Scrollable body — centers the current question vertically. */}
          <div className="relative flex min-h-0 flex-1 items-center overflow-y-auto px-7 py-6 md:px-9 md:py-8">
            <div className="w-full">
              <MorphContainer>
                <AnimatePresence mode="wait">
                  <motion.div
                    key={q.key}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
                    className="flex flex-col text-left"
                  >
                    {q.eyebrow && (
                      <span className="mb-3 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                        <span className="h-[1px] w-4 bg-line-strong" />
                        {q.eyebrow}
                      </span>
                    )}
                    <h2 className="text-[25px] font-medium leading-[1.18] tracking-tight text-ink md:text-[28px]">
                      {q.question}
                    </h2>
                    {q.subtitle && (
                      <p className="mt-2.5 text-[14px] leading-6 text-ink-muted">
                        {q.subtitle}
                      </p>
                    )}

                    <div className="mt-6 w-full">
                      {q.kind === "text" && (
                        <TextInput
                          value={answers[q.key] || ""}
                          onChange={(v) => setAnswer(q.key, v)}
                          placeholder={q.placeholder || ""}
                          onSubmit={next}
                        />
                      )}
                      {q.kind === "choice" && (
                        <ChoiceList
                          options={q.options}
                          selected={answers[q.key] || ""}
                          onSelect={(v) => setAnswer(q.key, v)}
                        />
                      )}
                    </div>
                    {error && (
                      <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-200">
                        {error}
                      </p>
                    )}
                  </motion.div>
                </AnimatePresence>
              </MorphContainer>
            </div>
          </div>

          {/* Card footer: back / continue / hint. */}
          <div className="flex-shrink-0 border-t border-line/70 px-7 py-4 md:px-9">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={back}
                disabled={step === 0}
                className={cn(
                  "press inline-flex items-center gap-1 text-[13px] text-ink-muted hover:text-ink",
                  step === 0 && "invisible",
                )}
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </button>

              <div className="flex items-center gap-3">
                <span className="hidden text-[11.5px] text-ink-faint sm:inline">
                  {step + 1} of {total}
                </span>
                <button
                  type="button"
                  onClick={next}
                  className="press inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper shadow-sm hover:bg-ink-soft"
                >
                  {step === total - 1 ? "Finish" : "Continue"}
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <p className="mt-3 text-center text-[10.5px] text-ink-faint">
              Press <kbd className="rounded border border-line bg-paper px-1 font-mono text-[10px]">Enter</kbd> to continue
              {q.kind === "choice" && (
                <> · <kbd className="rounded border border-line bg-paper px-1 font-mono text-[10px]">↑</kbd>
                <kbd className="rounded border border-line bg-paper px-1 font-mono text-[10px]">↓</kbd> to navigate</>
              )}
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Subcomponents
 * ------------------------------------------------------------------ */

function ProgressDots({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 w-1.5 rounded-full transition-all duration-200",
            i < step
              ? "bg-ink"
              : i === step
                ? "w-4 bg-ink"
                : "bg-line-strong",
          )}
        />
      ))}
    </div>
  );
}

/** A container that smoothly resizes its height when children change. */
function MorphContainer({ children }: { children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!outer.current || !inner.current) return;
    const obs = new ResizeObserver(() => {
      if (outer.current && inner.current) {
        outer.current.style.height = `${inner.current.offsetHeight}px`;
      }
    });
    obs.observe(inner.current);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={outer}
      className="relative w-full transition-[height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
    >
      <div ref={inner} className="absolute left-0 top-0 w-full">
        {children}
      </div>
    </div>
  );
}

import { ROTATING_WORDS } from "../lib/constants";

function OnboardingVisual() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % ROTATING_WORDS.length);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col items-center justify-center gap-8 text-center">
      <div className="logo-hover-trigger rounded-3xl p-4">
        <span className="logo-spin-target inline-flex will-change-transform">
          <Logo size={90} className="text-ink" />
        </span>
      </div>
      <div className="flex flex-col items-center justify-center gap-2 text-center text-4xl leading-[1.02] tracking-tight text-ink md:text-5xl lg:text-6xl">
        <span className="block">Your agent for</span>
        <div className="relative flex h-[1.18em] min-w-[8.2em] items-center justify-center overflow-hidden leading-none">
          <span className="pointer-events-none invisible select-none italic">
            weekly paperwork
          </span>
          <AnimatePresence mode="popLayout">
            <motion.span
              key={index}
              initial={{ y: "100%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "-100%", opacity: 0 }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
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

function TextInput({
  value,
  onChange,
  placeholder,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onSubmit: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onSubmit();
        }
      }}
      className="w-full rounded-xl border border-line bg-paper-raised px-4 py-3 text-center text-[16px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
    />
  );
}

function ChoiceList({
  options,
  selected,
  onSelect,
}: {
  options: string[];
  selected: string;
  onSelect: (v: string) => void;
}) {
  const [highlighted, setHighlighted] = useState<number>(() =>
    Math.max(0, options.indexOf(selected)),
  );

  // Reset highlight when the question (options) changes.
  useEffect(() => {
    setHighlighted(Math.max(0, options.indexOf(selected)));
  }, [options, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((i) => (i + 1) % options.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((i) => (i - 1 + options.length) % options.length);
      } else if (e.key === "Enter") {
        const opt = options[highlighted];
        if (opt && opt !== selected) {
          // Apply selection; Enter also advances via the root listener.
          onSelect(opt);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [options, highlighted, selected, onSelect]);

  return (
    <div className="flex flex-col gap-2" role="listbox">
      {options.map((opt, i) => {
        const active = opt === selected;
        const isHi = i === highlighted;
        return (
          <button
            key={opt}
            type="button"
            role="option"
            aria-selected={active}
            onMouseEnter={() => setHighlighted(i)}
            onClick={() => onSelect(opt)}
            className={cn(
              "press group flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-[14px] transition-colors",
              // Use inset rings so the selected/highlighted outline never
              // spills past the card's horizontal padding.
              active
                ? "border-line-strong bg-paper-sunken text-ink ring-1 ring-inset ring-line-strong"
                : "border-line bg-paper-raised text-ink hover:border-line-strong",
              !active && isHi && "ring-1 ring-inset ring-line-strong border-line-strong",
            )}
          >
            <span>{opt}</span>
            {active && <Check className="h-4 w-4" />}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Finalizing screen — shimmer text cycling through phases
 * ------------------------------------------------------------------ */

const FINALIZING_PHASES = ["Setting things up…", "Almost ready…"];

function FinalizingScreen({ done }: { done: boolean }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (done) return;
    // Slower cycle so the user gets to read each phase.
    const id = setInterval(
      () => setIdx((i) => (i + 1) % FINALIZING_PHASES.length),
      3200,
    );
    return () => clearInterval(id);
  }, [done]);

  const label = done ? "Done." : FINALIZING_PHASES[idx];

  return (
    <div className="onboarding-shell flex h-full min-h-screen w-full items-center justify-center bg-paper">
      <motion.span
        key={label}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className={cn(
          "text-[22px] font-medium tracking-tight",
          done ? "text-ink" : "shimmer-text-slow",
        )}
      >
        {label}
      </motion.span>
    </div>
  );
}
