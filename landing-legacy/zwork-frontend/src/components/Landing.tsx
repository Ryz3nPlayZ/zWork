import { useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { ChatInput } from "./ChatInput";
import { useApp } from "../lib/store";
import { useResolvedTheme } from "../lib/theme";
import { isMacOS } from "../lib/platform";
import { cn } from "../lib/cn";
import type { UpdateCardState, UpdateProgress } from "../lib/update";
import LightRays from "./LightRays";

interface GreetingOption {
  text: string;
  /** true = greet with name ("Good morning, Zemu."), false = standalone */
  withName: boolean;
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
  updateProgress = { phase: "idle" },
  onUpdate,
  onDismissUpdate,
}: {
  particlesExiting?: boolean;
  updateCard?: UpdateCardState | null;
  updateProgress?: UpdateProgress;
  onUpdate?: () => void | Promise<void>;
  onDismissUpdate?: () => void;
}) {
  const me = useApp((s) => s.me);
  const firstName = (me?.name?.split(/\s+/)[0] || "friend").trim();
  const [sending, setSending] = useState(false);
  const theme = useResolvedTheme();

  const greeting = useMemo(() => pickGreeting(), []);
  const updateBusy = updateProgress.phase !== "idle" && updateProgress.phase !== "error";
  const macOS = isMacOS();

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-paper">
      {/* Drag-only titlebar */}
      {macOS && <div className="titlebar-drag absolute inset-x-0 top-0 h-12" />}

      <div
        className={cn(
          "pointer-events-none fixed inset-0 transition-opacity duration-300 ease-out",
          particlesExiting && "opacity-0",
        )}
        aria-hidden="true"
      >
        <LightRays
          raysOrigin="top-center"
          raysColor={theme === "dark" ? "#ffffff" : "#e9e3d2"}
          raysSpeed={0.42}
          lightSpread={0.72}
          rayLength={1.25}
          pulsating
          fadeDistance={1.35}
          saturation={theme === "dark" ? 1.08 : 0.88}
          followMouse={false}
          mouseInfluence={0}
          noiseAmount={0.18}
          distortion={0.03}
          className="opacity-85"
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
              onSend={() => {
                void import("./ChatView");
                setSending(true);
              }}
            />
          </div>

          {updateCard && (
            <div className="mt-3 w-full max-w-[480px] rounded-lg border border-line/50 bg-paper/50 px-3 py-2 shadow-xs backdrop-blur-sm">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 text-[11.5px] text-ink-muted">
                  <span className="text-ink">Update available</span>
                  <span className="text-ink-dim ml-1">
                    {updateCard.currentVersion} → {updateCard.latestVersion}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5" data-no-drag>
                  <button
                    type="button"
                    onClick={() => {
                      if (onUpdate) {
                        void onUpdate();
                        return;
                      }
                      void import("../lib/update").then((m) => m.openReleaseUrl(updateCard.releaseUrl));
                    }}
                    disabled={updateBusy}
                    className="press inline-flex items-center gap-1 rounded-full bg-ink/90 px-2.5 py-1 text-[11px] font-medium text-paper transition-colors hover:bg-ink disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {updateBusy ? (
                      <>
                        <RefreshCw className="h-3 w-3 animate-spin" />
                      </>
                    ) : (
                      <>
                        <Download className="h-3 w-3" />
                        Update
                      </>
                    )}
                  </button>
                  {onDismissUpdate && (
                    <button
                      type="button"
                      onClick={onDismissUpdate}
                      className="press text-[11px] text-ink-dim hover:text-ink transition-colors px-1"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
              {(updateProgress.phase === "error" || updateBusy) && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-ink-dim">
                  <RefreshCw className={cn("h-3 w-3", updateBusy && "animate-spin")} />
                  <span>
                    {updateProgress.phase === "error"
                      ? updateProgress.message
                      : updateProgress.phase === "opening"
                        ? "Opening release page…"
                      : updateProgress.phase === "relaunching"
                        ? "Relaunching…"
                        : "Updating…"}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
