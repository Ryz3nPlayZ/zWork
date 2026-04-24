import { useMemo, useState } from "react";
import { Download, Clock3 } from "lucide-react";
import { ChatInput } from "./ChatInput";
import { LogoParticles } from "./LogoParticles";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

interface GreetingOption {
  text: string;
  /** true = greet with name ("Good morning, Zemu."), false = standalone */
  withName: boolean;
}

export interface UpdateCardState {
  latestVersion: string;
  releaseUrl: string;
}

/** Rotating, time-aware friendly greetings. */
function pickGreeting(): GreetingOption {
  const hour = new Date().getHours();

  const timeBased: GreetingOption[] =
    hour < 5
      ? [
          { text: "Still up", withName: true },
          { text: "Burning the midnight oil", withName: false },
          { text: "Night owl mode", withName: false },
        ]
      : hour < 12
        ? [
            { text: "Good morning", withName: true },
            { text: "Rise and shine", withName: true },
            { text: "Look who's awake", withName: true },
            { text: "Top of the morning", withName: true },
          ]
        : hour < 17
          ? [
              { text: "Good afternoon", withName: true },
              { text: "Hey", withName: true },
              { text: "What's the move", withName: false },
              { text: "Hope the day's treating you well", withName: true },
            ]
          : hour < 22
            ? [
                { text: "Good evening", withName: true },
                { text: "Hey", withName: true },
                { text: "Glad you're here", withName: true },
              ]
            : [
                { text: "Burning the late night oil", withName: false },
                { text: "One more thing before bed?", withName: false },
                { text: "Welcome back", withName: true },
              ];

  const casual: GreetingOption[] = [
    { text: "Welcome back", withName: true },
    { text: "What's cooking", withName: false },
    { text: "Hey there", withName: true },
    { text: "Let's get into it", withName: false },
    { text: "Ready when you are", withName: false },
    { text: "What's on your mind", withName: false },
  ];

  const pool = [...timeBased, ...casual];
  return pool[Math.floor(Math.random() * pool.length)];
}

export function Landing({
  particlesExiting = false,
  updateCard = null,
  onDismissUpdate,
}: {
  particlesExiting?: boolean;
  updateCard?: UpdateCardState | null;
  onDismissUpdate?: () => void;
}) {
  const me = useApp((s) => s.me);
  const firstName = (me?.name?.split(/\s+/)[0] || "friend").trim();
  const [sending, setSending] = useState(false);

  const greeting = useMemo(() => pickGreeting(), []);

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-paper">
      {/* Drag-only titlebar */}
      <div className="titlebar-drag absolute inset-x-0 top-0 h-10" />

      {/* Galaxy backdrop behind the welcome block. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 opacity-[0.15] blur-[0.3px]",
          "transition-[opacity,filter] duration-300 ease-out",
          particlesExiting && "opacity-0 blur-[12px]",
        )}
        aria-hidden="true"
      >
        <LogoParticles
          size={1800}
          particleCount={12000}
          pointScale={2.8}
          spinSpeed={0.00052}
          fill
        />
      </div>

      {/* Main content — centered slightly above vertical middle so the chatbox
          lands right below the visual midline. */}
      <div className="relative z-[1] flex flex-1 items-center justify-center px-6">
        <div
          className={cn(
            "flex w-full max-w-[720px] -translate-y-[4vh] flex-col items-center transition-all duration-400 ease-[cubic-bezier(0.22,1,0.36,1)]",
            sending && "translate-y-[-18vh] scale-[0.92] opacity-0",
          )}
        >
          <h1 className="text-center text-[42px] font-light leading-tight tracking-tight text-ink font-serif">
            {greeting.withName ? (
              <>
                {greeting.text},  <span className="italic text-ink-soft">{firstName}</span>.
              </>
            ) : (
              greeting.text
            )}
          </h1>

          <div
            className={cn(
              "mt-8 w-full [&>div]:!shadow-none transition-all duration-400 ease-[cubic-bezier(0.22,1,0.36,1)]",
              sending && "mt-4 max-w-[520px] rounded-2xl scale-95",
            )}
          >
            <ChatInput
              autoFocus
              placeholder="What can I help with?"
              onSend={() => setSending(true)}
            />
          </div>

          {updateCard && (
            <div className="mt-4 w-full max-w-[640px] rounded-[22px] border border-line bg-paper-raised px-4 py-3 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
                    Update ready
                  </div>
                  <div className="mt-1 text-[13px] font-medium text-ink">
                    zWork {updateCard.latestVersion}
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-ink-muted">
                    A newer release is available for Linux and macOS.
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => window.open(updateCard.releaseUrl, "_blank", "noreferrer")}
                    className="press inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-ink-soft"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Update
                  </button>
                  {onDismissUpdate && (
                    <button
                      type="button"
                      onClick={onDismissUpdate}
                      className="press inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink-muted hover:bg-paper-sunken hover:text-ink"
                    >
                      <Clock3 className="h-3.5 w-3.5" />
                      Remind me later
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
