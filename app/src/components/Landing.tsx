import { Suspense, lazy, useMemo, useState } from "react";
import { Clock3, Download, ExternalLink, RefreshCw } from "lucide-react";
import { ChatInput } from "./ChatInput";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import type { UpdateCardState, UpdateProgress } from "../lib/update";

const LogoParticles = lazy(() => import("./LogoParticles").then((m) => ({ default: m.LogoParticles })));

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

  const greeting = useMemo(() => pickGreeting(), []);
  const updateBusy = updateProgress.phase !== "idle" && updateProgress.phase !== "error";
  const updateLabel =
    updateProgress.phase === "checking"
      ? "Checking…"
      : updateProgress.phase === "downloading"
        ? updateProgress.totalBytes && updateProgress.totalBytes > 0
          ? `Updating… ${Math.max(1, Math.min(99, Math.round((updateProgress.downloadedBytes / updateProgress.totalBytes) * 100)))}%`
          : "Downloading…"
        : updateProgress.phase === "installing"
          ? "Installing…"
          : updateProgress.phase === "relaunching"
            ? "Relaunching…"
            : "Update now";

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-paper">
      {/* Drag-only titlebar */}
      <div className="titlebar-drag absolute inset-x-0 top-0 h-12" />

      {/* Galaxy backdrop behind the welcome block. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 opacity-[0.42] blur-0",
          "transition-[opacity,filter] duration-300 ease-out",
          particlesExiting && "opacity-0 blur-[10px]",
        )}
        aria-hidden="true"
      >
        <Suspense fallback={null}>
          <LogoParticles
            particleCount={14200}
            pointScale={2.9}
            spinSpeed={0.00054}
            fill
            className="inset-auto left-1/2 top-1/2 h-[min(96vw,84vh,1100px)] w-[min(96vw,84vh,1100px)] -translate-x-1/2 -translate-y-1/2"
          />
        </Suspense>
      </div>

      <div
        className={cn(
          "pointer-events-none absolute inset-0",
          "bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.05)_0%,rgba(255,255,255,0.015)_24%,rgba(255,255,255,0)_56%)]",
          "transition-opacity duration-300 ease-out",
          particlesExiting && "opacity-0",
        )}
        aria-hidden="true"
      />

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
            <div className="mt-4 w-full max-w-[560px] rounded-2xl border border-line bg-paper-raised px-4 py-3 shadow-sm">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1 text-[12.5px] text-ink">
                  <span className="font-medium">An update is available.</span>{" "}
                  <span className="text-ink-muted">
                    {updateCard.currentVersion} {"->"} {updateCard.latestVersion}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2" data-no-drag>
                  <button
                    type="button"
                    onClick={() => {
                      if (onUpdate) {
                        void onUpdate();
                        return;
                      }
                      window.open(updateCard.releaseUrl, "_blank", "noreferrer");
                    }}
                    disabled={updateBusy}
                    className="press inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {updateCard.source === "github" ? <ExternalLink className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                    {updateCard.source === "github" && !updateBusy ? "Update now" : updateLabel}
                  </button>
                  {onDismissUpdate && (
                    <button
                      type="button"
                      onClick={onDismissUpdate}
                      className="press inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink-muted hover:bg-paper-sunken hover:text-ink"
                    >
                      <Clock3 className="h-3.5 w-3.5" />
                      Remind me later?
                    </button>
                  )}
                </div>
              </div>
              {(updateProgress.phase === "error" || updateBusy) && (
                <div className="mt-2 flex items-center gap-2 text-[11.5px] text-ink-muted">
                  <RefreshCw className={cn("h-3.5 w-3.5", updateBusy && "animate-spin")} />
                  <span>
                    {updateProgress.phase === "error"
                      ? updateProgress.message
                      : updateProgress.phase === "relaunching"
                        ? "Update installed. Relaunching zWork…"
                        : "The update is running in-app. Keep zWork open until it relaunches."}
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
