import { useMemo, useState } from "react";
import { Download, ArrowUpRight, Loader2 } from "lucide-react";
import { ChatInput } from "./ChatInput";
import { loadTemplates } from "../lib/templates";
import { useApp } from "../lib/store";
import { useResolvedTheme } from "../lib/theme";
import { isMacOS, needsLightweightRendering } from "../lib/platform";
import { cn } from "../lib/cn";
import type { UpdateCardState, UpdateProgress } from "../lib/update";
import LightRays from "./LightRays";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

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
  const [inputValue, setInputValue] = useState("");
  const theme = useResolvedTheme();
  const triggerFocusChatInput = useApp((s) => s.triggerFocusChatInput);
  const [templates] = useState(() => loadTemplates());

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
              value={inputValue}
              onChange={setInputValue}
              onSend={() => {
                void import("./ChatView");
                setSending(true);
              }}
            />
          </div>



          {updateCard && (
            <div className={cn(
              "mt-3 w-full max-w-[480px] rounded-xl border border-line bg-paper-raised px-4 py-3 shadow-xs",
              needsLightweightRendering() ? "bg-paper" : "bg-paper/50 backdrop-blur-sm",
            )}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium text-ink">
                    Update available
                  </div>
                  <div className="text-[11.5px] text-ink-muted">
                    {updateCard.currentVersion} → {updateCard.latestVersion}
                  </div>
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
                    className="press inline-flex items-center gap-1 rounded-xl bg-ink px-3 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {updateBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : updateCard.source === "github" ? (
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {updateBusy
                      ? updateProgress.phase === "downloading"
                        ? "Downloading"
                        : updateProgress.phase === "installing"
                          ? "Installing"
                          : updateProgress.phase === "relaunching"
                            ? "Restarting"
                            : "Updating"
                      : updateCard.source === "github"
                        ? "Get update"
                        : "Install"}
                  </button>
                  {onDismissUpdate && !updateBusy && (
                    <button
                      type="button"
                      onClick={onDismissUpdate}
                      className="press rounded-lg p-1 text-ink-faint hover:text-ink hover:bg-line/40 transition-colors"
                    >
                      <span className="sr-only">Dismiss</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Download progress */}
              {updateProgress.phase === "downloading" && updateProgress.totalBytes != null && (
                <div className="mt-2.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-paper-sunken">
                    <div
                      className="h-full rounded-full bg-accent/60 transition-all duration-300"
                      style={{
                        width: `${Math.min(100, (updateProgress.downloadedBytes / updateProgress.totalBytes) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="mt-1 text-[10.5px] text-ink-faint">
                    {formatBytes(updateProgress.downloadedBytes)} of {formatBytes(updateProgress.totalBytes)}
                  </div>
                </div>
              )}

              {/* Error state */}
              {updateProgress.phase === "error" && (
                <div className="mt-2 text-[11.5px] text-red-600">
                  {updateProgress.message}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
