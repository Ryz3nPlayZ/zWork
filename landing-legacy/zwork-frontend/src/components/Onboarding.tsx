import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ArrowLeft, Check, ChevronDown, Sparkles } from "lucide-react";
import { Logo } from "./Logo";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { recordTelemetry } from "../lib/telemetry";
import { useResolvedTheme } from "../lib/theme";
import { isMacOS } from "../lib/platform";
import { api, type OnboardingAnswer, type OnboardingCredential } from "../lib/api";
import LightRays from "./LightRays";

const ZWORK_ROUTER_MODEL_ID = "zwork-router";
const ZWORK_ROUTER_TARGET_MODEL_ID = "deepseek-v4-flash";

/* ------------------------------------------------------------------ *
 *  Question model
 * ------------------------------------------------------------------ */

type CommonQ = {
  key: string;
  /** Small uppercase label shown above the question (e.g. "About you"). */
  eyebrow?: string;
  /** Short tagline shown beneath the question for context. */
  subtitle?: string;
  optional?: boolean;
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

type ApiKeyQuestion = CommonQ & {
  kind: "apikey";
  question: string;
};

type Question = TextQuestion | ChoiceQuestion | ApiKeyQuestion;

const QUESTIONS: Question[] = [
  {
    kind: "text",
    key: "name",
    eyebrow: "Say hi",
    question: "First, what should we call you?",
    subtitle: "Just your first name — it's how zWork will greet you.",
    placeholder: "Your first name",
  },
  {
    kind: "choice",
    key: "profession",
    eyebrow: "About you",
    question: "What do you spend most of your day on?",
    subtitle: "This helps tune the examples and phrasing we reach for.",
    options: [
      "Student",
      "Founder",
      "Engineer",
      "Designer",
      "Product / PM",
      "Researcher",
      "Creator",
      "Something else",
    ],
  },
  {
    kind: "choice",
    key: "age_range",
    eyebrow: "About you",
    question: "Roughly, what's your age range?",
    subtitle: "Optional — helps us pick cultural references that land.",
    options: ["Under 18", "18–24", "25–34", "35–44", "45–54", "55+", "Prefer not to say"],
  },
  {
    kind: "choice",
    key: "industry",
    eyebrow: "About you",
    question: "Which industry are you closest to?",
    subtitle: "Pick whichever feels most like your day-to-day.",
    options: [
      "Software / AI",
      "Finance",
      "Healthcare",
      "Education",
      "Design / Creative",
      "Science / Research",
      "Other",
    ],
  },
  {
    kind: "choice",
    key: "ai_usage",
    eyebrow: "Habits",
    question: "How often do you already reach for AI?",
    subtitle: "No wrong answers — this sets our default depth of guidance.",
    options: [
      "Daily power user",
      "Several times a week",
      "Occasionally",
      "Just getting started",
    ],
  },
  {
    kind: "choice",
    key: "decisions",
    eyebrow: "Working style",
    question: "When zWork is doing work for you, you'd rather…",
    subtitle: "Affects how often we pause to check in mid-task.",
    options: [
      "Walk me through decisions briefly",
      "Just give me the answer — pick and go",
      "Balanced — explain when it matters",
    ],
  },
  {
    kind: "choice",
    key: "organization",
    eyebrow: "Working style",
    question: "How do you keep track of work?",
    subtitle: "We'll mirror your organizational style in follow-ups.",
    options: [
      "Chaos mode — it's all in my head",
      "Todo lists",
      "Calendar-driven",
      "All of the above",
    ],
  },
  {
    kind: "choice",
    key: "vibe",
    eyebrow: "Voice",
    question: "Pick a vibe for our conversations.",
    subtitle: "You can change this anytime in Settings → Personalization.",
    options: [
      "Casual & friendly",
      "Professional & focused",
      "Direct & minimal",
    ],
  },
  {
    kind: "choice",
    key: "verbosity",
    eyebrow: "Voice",
    question: "How long should replies usually run?",
    subtitle: "We'll lean into this unless you ask for more or less.",
    options: ["Short & punchy", "Balanced", "Thorough & detailed"],
  },
  {
    kind: "choice",
    key: "goal",
    eyebrow: "North star",
    question: "What's the long game for you right now?",
    subtitle: "We'll connect small tasks back to this whenever it helps.",
    options: [
      "Launch a startup",
      "Graduate / learn deeply",
      "Level up at my job",
      "Build a creative practice",
      "Research / discovery",
      "Still figuring it out",
    ],
  },
  {
    kind: "apikey",
    key: "credential",
    eyebrow: "Almost there",
    question: "Connect a model to start chatting.",
    subtitle: "Bring your own key for private local use, or switch to managed hosted routing after sign-in.",
  },
];

/* ------------------------------------------------------------------ *
 *  Credential presets
 * ------------------------------------------------------------------ */

interface CredentialPreset {
  id: "zwork_managed" | "claude_code" | "openai" | "anthropic";
  label: string;
  subtitle: string;
  shape: "anthropic" | "openai";
  credential: "anthropic" | "openai" | "claude_code" | "zwork_router";
  defaultBaseUrl: string;
  defaultModelId: string;
  keyless?: boolean;
  managed?: boolean;
  recommended?: boolean;
}

const PRESETS: CredentialPreset[] = [
  {
    id: "zwork_managed",
    label: "zWork Router",
    subtitle: "Use the hosted zWork router pinned to DeepSeek V4 Flash",
    shape: "anthropic",
    credential: "zwork_router",
    defaultBaseUrl: "https://api.tryzwork.app/api",
    defaultModelId: ZWORK_ROUTER_TARGET_MODEL_ID,
    keyless: true,
    managed: true,
    recommended: true,
  },
  {
    id: "claude_code",
    label: "Local credentials",
    subtitle: "Reuse your installed local credentials",
    shape: "anthropic",
    credential: "claude_code",
    defaultBaseUrl: "",
    defaultModelId: "",
    keyless: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    subtitle: "Or any OpenAI-compatible endpoint",
    shape: "openai",
    credential: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModelId: "gpt-4o-mini",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    subtitle: "Direct Anthropic API key",
    shape: "anthropic",
    credential: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModelId: "claude-3-5-sonnet-latest",
  },
];

/* ------------------------------------------------------------------ *
 *  Curated model catalog per preset — keeps the picker friendly for
 *  non-technical users. A `CUSTOM` sentinel lets power-users type any
 *  model ID they want.
 * ------------------------------------------------------------------ */

export interface ModelChoice {
  id: string;
  label: string;
  description: string;
  /** Short cost blurb. "Free tier" / "~$X / 1M in" etc. */
  cost: string;
}

export const MODEL_CATALOG: Record<CredentialPreset["id"], ModelChoice[]> = {
  zwork_managed: [
    {
      id: ZWORK_ROUTER_MODEL_ID,
      label: "zWork Router",
      description: "Hosted through the zWork router and pinned to DeepSeek V4 Flash.",
      cost: "Managed by zWork",
    },
  ],
  openai: [
    {
      id: "gpt-4o-mini",
      label: "GPT-4o mini",
      description: "Cheap and fast. Great default for everyday use.",
      cost: "~$0.15 / $0.60 per 1M tokens (in / out)",
    },
    {
      id: "gpt-4o",
      label: "GPT-4o",
      description: "Flagship quality — best for hard problems.",
      cost: "~$2.50 / $10 per 1M tokens (in / out)",
    },
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      description: "Newer generation — improved reasoning at lower cost.",
      cost: "~$2 / $8 per 1M tokens (in / out)",
    },
  ],
  anthropic: [
    {
      id: "claude-3-5-haiku-latest",
      label: "Claude 3.5 Haiku",
      description: "Fast and affordable — great for quick tasks.",
      cost: "~$0.80 / $4 per 1M tokens (in / out)",
    },
    {
      id: "claude-3-5-sonnet-latest",
      label: "Claude 3.5 Sonnet",
      description: "Best balance of quality and cost. Recommended.",
      cost: "~$3 / $15 per 1M tokens (in / out)",
    },
    {
      id: "claude-opus-4-latest",
      label: "Claude Opus 4",
      description: "Top-tier reasoning — pick this for complex work.",
      cost: "~$15 / $75 per 1M tokens (in / out)",
    },
  ],
  claude_code: [],
};

const CUSTOM_MODEL_SENTINEL = "__custom__";

/* ------------------------------------------------------------------ *
 *  Root component
 * ------------------------------------------------------------------ */

export function Onboarding() {
  const macOS = isMacOS();
  const setOnboardingDone = useApp((s) => s.setOnboardingDone);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const refreshMe = useApp((s) => s.refreshMe);
  const me = useApp((s) => s.me);

  const [step, setStep] = useState(0); // index into QUESTIONS
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({
    name: me?.name?.split(/\s+/)[0] || "",
  }));
  const [credential, setCredential] = useState<OnboardingCredential | null>(null);
  const [error, setError] = useState("");

  // Final "Personalizing..." phase
  const [finalizing, setFinalizing] = useState(false);
  const [done, setDone] = useState(false);

  const total = QUESTIONS.length;
  const q = QUESTIONS[step];

  const setAnswer = (key: string, answer: string) =>
    setAnswers((a) => ({ ...a, [key]: answer }));

  const canAdvance = () => {
    if (q.kind === "apikey") return credential !== null;
    return true; // all questions are skippable
  };

  const next = () => {
    if (!canAdvance()) return;
    if (step < total - 1) setStep(step + 1);
    else complete();
  };
  const back = () => {
    if (step > 0) setStep(step - 1);
  };

  const skip = () => {
    if (q.optional) setStep((s) => Math.min(s + 1, total - 1));
  };

  const complete = async () => {
    if (finalizing) return;
    setError("");
    setFinalizing(true);
    const payload: OnboardingAnswer[] = QUESTIONS.filter(
      (qq) => qq.kind !== "apikey",
    ).map((qq) => ({
      key: qq.key,
      question: qq.question,
      answer: answers[qq.key] || "",
    }));
    try {
      await api.waitForBackend();
      await api.onboardComplete({
        answers: payload,
        credential: credential || undefined,
        telemetry_enabled: true,
      });
      await Promise.all([refreshProviders(), refreshSettings(), refreshMe()]);
      recordTelemetry("onboarding_completed", {
        credential: credential?.credential || "",
        model_id: credential?.model_id || "",
      });
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

  const onSubmitCredential = (c: OnboardingCredential | null) => {
    setCredential(c);
  };

  const friendlySetupError = (detail: string) => {
    if (/failed to fetch|load failed|networkerror|did not become ready/i.test(detail)) {
      return "The local backend is not ready. Quit and reopen zWork; if it repeats, send the backend.log file.";
    }
    if (/address already in use|eaddrinuse/i.test(detail)) {
      return "Another zWork backend is already running on port 8787. Quit all zWork windows and reopen the app.";
    }
    return detail || "Check the model key/base URL and try again.";
  };

  // Keyboard: Enter advances, Shift+Enter (or Escape for optional) skips.
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
      } else if (e.key === "Escape" && q.optional) {
        e.preventDefault();
        skip();
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

      {/* titlebar drag */}
      {macOS && <div className="titlebar-drag absolute inset-x-0 top-0 z-10 h-10" />}

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
            "rounded-2xl border border-line/80 bg-paper-raised/92 backdrop-blur-lg",
            "shadow-[0_20px_60px_-20px_rgb(var(--shadow)/0.35),0_2px_6px_-2px_rgb(var(--shadow)/0.15)]",
            "overflow-hidden",
          )}
        >
          {/* Card header: logo left, progress dots right. */}
          <div className="flex flex-shrink-0 items-center justify-between border-b border-line/70 px-7 py-4 md:px-9">
          <div className="flex items-center gap-2">
              <Logo size={20} />
              <span className="text-[13.5px] font-semibold tracking-tight text-ink">
                <span className="lowercase">z</span>Work
              </span>
            </div>
            <ProgressDots step={step} total={total} />
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
                      {q.kind === "apikey" && (
                        <ApiKeyStep
                          initial={credential}
                          onChange={onSubmitCredential}
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
                  disabled={!canAdvance()}
                  className={cn(
                    "press inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium",
                    canAdvance()
                      ? "bg-ink text-paper hover:bg-ink-soft shadow-sm"
                      : "bg-paper-sunken text-ink-faint cursor-not-allowed",
                  )}
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
            getting unstuck
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

function ApiKeyStep({
  initial,
  onChange,
}: {
  initial: OnboardingCredential | null;
  onChange: (c: OnboardingCredential | null) => void;
}) {
  const hasCloudToken = typeof window !== "undefined" && !!window.localStorage.getItem("zwork:cloud-token");
  const cloudUnlocked = !!hasCloudToken;
  const visiblePresets = PRESETS.filter((preset) => !preset.managed || hasCloudToken);
  const recommended = visiblePresets.find((p) => p.recommended) || visiblePresets[0];
  const others = visiblePresets.filter((p) => !p.recommended);

  const [preset, setPreset] = useState<CredentialPreset | null>(() =>
    initial
      ? PRESETS.find((p) => p.credential === initial.credential) || recommended
      : null,
  );
  const [apiKey, setApiKey] = useState(initial?.api_key || "");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url || "");
  const [modelId, setModelId] = useState(initial?.model_id || "");
  const [othersOpen, setOthersOpen] = useState<boolean>(() =>
    !!initial && !PRESETS.find((p) => p.credential === initial.credential)?.recommended,
  );

  // Whether the user chose "Custom…" from the model dropdown — switches the
  // model field to a free-form text input.
  const initialIsKnown = (() => {
    if (!initial) return true;
    const pId = PRESETS.find((p) => p.credential === initial.credential)?.id;
    if (!pId) return true;
    return MODEL_CATALOG[pId].some((m) => m.id === initial.model_id);
  })();
  const [customMode, setCustomMode] = useState<boolean>(!initialIsKnown);

  const apply = (next: {
    preset: CredentialPreset | null;
    apiKey: string;
    baseUrl: string;
    modelId: string;
  }) => {
    if (!next.preset) {
      onChange(null);
      return;
    }
    const effectiveApiKey = next.preset.managed
      ? (window.localStorage.getItem("zwork:cloud-token") || "").trim()
      : next.apiKey.trim();
    const valid =
      next.preset.keyless ||
      (effectiveApiKey.length > 0 && next.modelId.trim().length > 0);
    if (!valid) {
      onChange(null);
      return;
    }
    onChange({
      shape: next.preset.shape,
      credential: next.preset.credential,
      api_key: effectiveApiKey,
      base_url: next.baseUrl.trim() || next.preset.defaultBaseUrl,
      model_id: next.modelId.trim() || next.preset.defaultModelId,
      model_name:
        (next.modelId.trim() || next.preset.defaultModelId) +
        " · " +
        next.preset.label,
    });
  };

  const pickPreset = (p: CredentialPreset) => {
    if (p.managed && !cloudUnlocked) {
      setPreset(p);
      onChange(null);
      return;
    }
    setPreset(p);
    setBaseUrl(p.defaultBaseUrl);
    // Default to the first catalog entry for this provider when available,
    // otherwise fall back to the preset's declared default model id.
    const catalog = MODEL_CATALOG[p.id] || [];
    const nextModel = catalog[0]?.id || p.defaultModelId;
    setModelId(nextModel);
    setCustomMode(false);
    if (p.keyless) {
      apply({ preset: p, apiKey: "", baseUrl: p.defaultBaseUrl, modelId: nextModel });
    } else {
      apply({ preset: p, apiKey, baseUrl: p.defaultBaseUrl, modelId: nextModel });
    }
  };

  const renderPresetCard = (p: CredentialPreset, variant: "hero" | "compact") => {
    const active = preset?.id === p.id;
    if (variant === "hero") {
      return (
        <button
          key={p.id}
          type="button"
          disabled={!!p.managed && !cloudUnlocked}
          onClick={() => pickPreset(p)}
          className={cn(
            "press relative flex w-full items-center justify-between rounded-xl border px-4 py-3.5 text-left transition-colors",
            active
              ? "border-emerald-500/70 bg-emerald-50 text-ink ring-1 ring-inset ring-emerald-500/40 dark:bg-emerald-500/10 dark:border-emerald-400/40 dark:ring-emerald-400/40"
              : "border-emerald-200 bg-emerald-50/60 text-ink hover:border-emerald-400 dark:border-emerald-500/30 dark:bg-emerald-500/5",
            p.managed && !cloudUnlocked && "cursor-not-allowed opacity-65",
          )}
        >
          <div className="flex flex-col items-start">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
              <span className="text-[14px] font-semibold">{p.label}</span>
              {p.managed ? (
                <span className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  cloudUnlocked
                    ? "border border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/20 dark:text-emerald-200"
                    : "border border-amber-200 bg-amber-100 text-amber-700",
                )}>
                  {cloudUnlocked ? "Managed" : "Sign in to use"}
                </span>
              ) : (
                <span className="rounded-full border border-emerald-200 bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/20 dark:text-emerald-200">
                  Recommended
                </span>
              )}
            </div>
            <span className="mt-0.5 text-[11.5px] text-ink-muted">{p.subtitle}</span>
          </div>
          {active && <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />}
        </button>
      );
    }
    return (
      <button
        key={p.id}
        type="button"
        onClick={() => pickPreset(p)}
        className={cn(
          "press flex flex-col items-start rounded-xl border px-3 py-2.5 text-left transition-colors",
          active
            ? "border-line-strong bg-paper-sunken text-ink ring-1 ring-inset ring-line-strong"
            : "border-line bg-paper-raised text-ink hover:border-line-strong",
        )}
      >
        <span className="text-[13px] font-medium">{p.label}</span>
        <span
          className={cn(
            "text-[11px]",
            active ? "text-ink-muted" : "text-ink-faint",
          )}
        >
          {p.subtitle}
        </span>
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Recommended provider — full-width hero card */}
      {renderPresetCard(recommended, "hero")}

      {/* Collapsible "Other providers" */}
      <div>
        <button
          type="button"
          onClick={() => setOthersOpen((v) => !v)}
          className="press flex w-full items-center justify-between rounded-md px-1 py-1 text-[12px] text-ink-muted hover:text-ink"
        >
          <span>Other providers</span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-200",
              othersOpen && "rotate-180",
            )}
          />
        </button>
        <AnimatePresence initial={false}>
          {othersOpen && (
            <motion.div
              key="others"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="mt-2 grid grid-cols-2 gap-2">
                {others.map((p) => renderPresetCard(p, "compact"))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {preset?.managed && !cloudUnlocked && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
          Your account is signed in, but managed hosting is locked until you unlock Pro. Use the Analytics tab to redeem the dev coupon, then come back here or activate it there directly.
        </p>
      )}

      {preset && !preset.keyless && !preset.managed && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="flex flex-col gap-2 rounded-xl border border-line bg-paper-raised p-3"
        >
          <Field
            label="API key"
            value={apiKey}
            onChange={(v) => {
              setApiKey(v);
              apply({ preset, apiKey: v, baseUrl, modelId });
            }}
            placeholder="sk-…"
            type="password"
          />
          <Field
            label="Base URL"
            value={baseUrl}
            onChange={(v) => {
              setBaseUrl(v);
              apply({ preset, apiKey, baseUrl: v, modelId });
            }}
            placeholder={preset.defaultBaseUrl}
          />

          {/* Curated model picker — users pick from a short, sensible list
              and fall back to a free-form text input via "Custom…". */}
          <ModelPicker
            catalog={MODEL_CATALOG[preset.id] || []}
            value={modelId}
            customMode={customMode}
            defaultModelId={preset.defaultModelId}
            onSelectKnown={(id) => {
              setCustomMode(false);
              setModelId(id);
              apply({ preset, apiKey, baseUrl, modelId: id });
            }}
            onCustom={() => {
              setCustomMode(true);
              // Clear the field so the user isn't editing a previously-picked
              // catalog entry by accident.
              setModelId("");
              apply({ preset, apiKey, baseUrl, modelId: "" });
            }}
            onCustomChange={(id) => {
              setModelId(id);
              apply({ preset, apiKey, baseUrl, modelId: id });
            }}
          />
        </motion.div>
      )}

      {preset?.keyless && (
        <p className="rounded-lg border border-line bg-paper-raised px-3 py-2 text-[12.5px] text-ink-muted">
          {preset.managed ? (
            <>✓ zWork will use your signed-in desktop session and route requests through the hosted zWork gateway.</>
          ) : (
            <>
              ✓ zWork will detect your local credentials from{" "}
              <code className="rounded bg-paper-sunken px-1 py-0.5 text-[11.5px]">
                ~/.claude/
              </code>
              .
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * ModelPicker — curated dropdown of known models for a provider, plus an
 * option to add a custom model ID. Shows a short description and cost blurb
 * for the selected model so non-technical users know what they're picking.
 */
function ModelPicker({
  catalog,
  value,
  customMode,
  defaultModelId,
  onSelectKnown,
  onCustom,
  onCustomChange,
}: {
  catalog: ModelChoice[];
  value: string;
  customMode: boolean;
  defaultModelId: string;
  onSelectKnown: (id: string) => void;
  onCustom: () => void;
  onCustomChange: (id: string) => void;
}) {
  const selected = !customMode ? catalog.find((m) => m.id === value) : undefined;

  const selectValue = customMode ? CUSTOM_MODEL_SENTINEL : value;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
        Model
      </span>
      <div className="relative">
        <select
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === CUSTOM_MODEL_SENTINEL) onCustom();
            else onSelectKnown(v);
          }}
          className="w-full appearance-none rounded-md border border-line bg-paper px-3 py-2 pr-8 text-[13.5px] text-ink focus:border-line-strong focus:outline-none"
        >
          {catalog.length === 0 && (
            <option value="" disabled>
              No preset models — pick Custom
            </option>
          )}
          {catalog.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM_MODEL_SENTINEL}>＋ Custom model ID…</option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
      </div>

      {selected && (
        <div className="mt-0.5 rounded-md border border-line/80 bg-paper-raised/70 px-2.5 py-2 text-[11.5px] leading-snug text-ink-muted">
          <p className="text-ink-soft">{selected.description}</p>
          <p className="mt-0.5 font-mono text-[10.5px] text-ink-faint">{selected.cost}</p>
        </div>
      )}

      {customMode && (
        <input
          type="text"
          autoFocus
          value={value}
          placeholder={defaultModelId || "e.g. my-finetune-v1"}
          onChange={(e) => onCustomChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      <input
        type={type || "text"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-line bg-paper px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
      />
    </label>
  );
}

/* ------------------------------------------------------------------ *
 *  Finalizing screen — shimmer text cycling through phases
 * ------------------------------------------------------------------ */

const FINALIZING_PHASES = [
  "Personalizing…",
  "Setting things up…",
  "Teaching the agent your vibe…",
  "Wiring up your model…",
  "Reading skills…",
  "Almost ready…",
];

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
