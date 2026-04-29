import { Suspense, lazy, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, X } from "lucide-react";
import appPackage from "../package.json";
import { Sidebar } from "./components/Sidebar";
import { Landing } from "./components/Landing";
import { useApp } from "./lib/store";
import { consumeInstalledUpdateNotice, detectUpdate, installUpdate, openReleaseUrl, type UpdateCardState, type UpdateProgress } from "./lib/update";
import { cn } from "./lib/cn";
import { recordTelemetry, setTelemetryEnabled, startTelemetrySession, stopTelemetrySession } from "./lib/telemetry";
import { LoginScreen } from "./components/LoginScreen";

const Onboarding = lazy(() => import("./components/Onboarding").then((m) => ({ default: m.Onboarding })));
const loadChatView = () => import("./components/ChatView").then((m) => ({ default: m.ChatView }));
const ChatView = lazy(loadChatView);
const SettingsPage = lazy(() => import("./components/Settings").then((m) => ({ default: m.SettingsPage })));
const SearchModal = lazy(() => import("./components/SearchModal").then((m) => ({ default: m.SearchModal })));
const ProjectView = lazy(() => import("./components/ProjectView").then((m) => ({ default: m.ProjectView })));
const ArtifactPanel = lazy(() => import("./components/ArtifactPanel").then((m) => ({ default: m.ArtifactPanel })));

export default function App() {
  const appVersion = appPackage.version;
  const bootstrap = useApp((s) => s.bootstrap);
  const view = useApp((s) => s.view);
  const settings = useApp((s) => s.settings);
  const user = useApp((s) => s.user);
  const active = useApp((s) => s.activeChatId);
  const chat = useApp((s) => (active ? s.chats[active] : undefined));
  const artifactPanelOpen = !!(view === "chat" && active && chat?.artifactPanelOpen);
  const openLanding = useApp((s) => s.openLanding);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const setView = useApp((s) => s.setView);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const onboardingDone = useApp((s) => s.onboardingDone);
  const [updateCard, setUpdateCard] = useState<UpdateCardState | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>({ phase: "idle" });
  const [recentUpdateNotice, setRecentUpdateNotice] = useState<{
    version: string;
    releaseUrl: string;
    notes?: string;
  } | null>(null);
  const showLanding = view === "chat" && active === null;

  // Show login screen if user is not authenticated
  if (!user) {
    return <LoginScreen />;
  }

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const enabled = !!settings?.telemetry_enabled;
    setTelemetryEnabled(enabled);
    if (!enabled) {
      stopTelemetrySession("telemetry_disabled");
      return;
    }
    startTelemetrySession({
      appVersion,
      os: navigator.platform,
      screen: showLanding ? "landing" : view,
    });
    return () => {
      stopTelemetrySession("app_unmounted");
    };
  }, [appVersion, settings?.telemetry_enabled]);

  useEffect(() => {
    void loadChatView();
  }, []);

  useEffect(() => {
    setRecentUpdateNotice(consumeInstalledUpdateNotice(appVersion));
  }, [appVersion]);

  useEffect(() => {
    recordTelemetry("screen_view", {
      screen: showLanding ? "landing" : view,
      has_chat: !!active,
    });
  }, [showLanding, view, active]);

  useEffect(() => {
    let cancelled = false;

    async function checkForUpdates() {
      const detected = await detectUpdate(appVersion);
      if (cancelled || !detected) return;
      recordTelemetry("update_available", {
        current_version: detected.currentVersion,
        latest_version: detected.latestVersion,
        source: detected.source,
      });

      const dismissed = window.localStorage.getItem("zwork:dismissed-update");
      if (dismissed === detected.latestVersion) return;
      setUpdateCard(detected);
    }

    void checkForUpdates();
    const interval = window.setInterval(() => {
      void checkForUpdates();
    }, 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [appVersion]);

  const runUpdate = async () => {
    if (!updateCard) return;
    if (updateProgress.phase !== "idle" && updateProgress.phase !== "error") return;
    recordTelemetry("update_started", {
      current_version: updateCard.currentVersion,
      latest_version: updateCard.latestVersion,
      source: updateCard.source,
    });
    setUpdateProgress({ phase: "checking" });
    try {
      // Always try the Tauri updater first for seamless in-app updates
      const result = await installUpdate(updateCard, setUpdateProgress);
      if (!result.ok) {
        // If updater fails, fall back to release page
        recordTelemetry("update_failed", {
          current_version: updateCard.currentVersion,
          latest_version: updateCard.latestVersion,
          source: updateCard.source,
          reason: "updater_error",
        });
        setUpdateProgress({ phase: "opening" });
        await openReleaseUrl(updateCard.releaseUrl);
        setUpdateProgress({ phase: "idle" });
      } else if (result.ok) {
        recordTelemetry("update_finished", {
          current_version: updateCard.currentVersion,
          latest_version: updateCard.latestVersion,
          source: updateCard.source,
        });
      }
    } catch (error) {
      recordTelemetry("update_failed", {
        current_version: updateCard.currentVersion,
        latest_version: updateCard.latestVersion,
        source: updateCard.source,
        reason: "exception",
      });
      setUpdateProgress({
        phase: "error",
        message: error instanceof Error ? error.message : "Update failed.",
      });
    }
  };

  const dismissUpdate = () => {
    if (updateCard) {
      try {
        window.localStorage.setItem("zwork:dismissed-update", updateCard.latestVersion);
      } catch {
        /* ignore */
      }
    }
    setUpdateCard(null);
    setUpdateProgress({ phase: "idle" });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openLanding();
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setView("settings");
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openLanding, toggleSidebar, setView, setSearchOpen]);

  const [showLandingOverlay, setShowLandingOverlay] = useState(showLanding);
  const [particlesExiting, setParticlesExiting] = useState(false);
  const panelFallback = (
    <div className="flex h-full w-full items-center justify-center bg-paper">
      <div className="rounded-2xl border border-line bg-paper-raised px-4 py-2 text-[12.5px] text-ink-muted">
        Loading…
      </div>
    </div>
  );

  useEffect(() => {
    if (showLanding) {
      setShowLandingOverlay(true);
      setParticlesExiting(false);
      return;
    }
    if (showLandingOverlay) {
      setParticlesExiting(true);
      const t = window.setTimeout(() => {
        setShowLandingOverlay(false);
        setParticlesExiting(false);
      }, 340);
      return () => window.clearTimeout(t);
    }
  }, [showLanding, showLandingOverlay]);
  // Show onboarding when we know it's NOT done. `null` = still loading; render
  // nothing then to avoid flash.
  if (onboardingDone === false) {
    return (
      <Suspense fallback={<div className="h-screen w-screen bg-paper" />}>
        <Onboarding />
      </Suspense>
    );
  }
  if (onboardingDone === null) {
    return <div className="h-screen w-screen bg-paper" />;
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-paper">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 overflow-hidden">
        {view === "settings" ? (
          <Suspense fallback={panelFallback}>
            <SettingsPage />
          </Suspense>
        ) : view === "projects" ? (
          <Suspense fallback={panelFallback}>
            <ProjectView />
          </Suspense>
        ) : (
          <>
            {!showLanding && (
              <Suspense fallback={null}>
                <ChatView />
              </Suspense>
            )}
            {showLandingOverlay && (
              <div
                className={cn(
                  "absolute inset-0 z-10 transition-opacity duration-300 ease-out",
                  particlesExiting ? "opacity-0" : "opacity-100",
                )}
              >
                <Landing
                  particlesExiting={particlesExiting}
                  updateCard={updateCard}
                  updateProgress={updateProgress}
                  onUpdate={updateCard ? runUpdate : undefined}
                  onDismissUpdate={updateCard ? dismissUpdate : undefined}
                />
              </div>
            )}
          </>
        )}
        {recentUpdateNotice && (
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-6">
            <div className="pointer-events-auto flex w-full max-w-[640px] items-center gap-3 rounded-2xl border border-line bg-paper-raised px-4 py-3 shadow-pop">
              <CheckCircle2 className="h-4.5 w-4.5 shrink-0 text-emerald-600" />
              <div className="min-w-0 flex-1 text-[12.5px] text-ink">
                zWork {recentUpdateNotice.version} installed.{" "}
                <button
                  type="button"
                  onClick={() => {
                    void openReleaseUrl(recentUpdateNotice.releaseUrl);
                  }}
                  className="inline-flex items-center gap-1 font-medium text-ink underline underline-offset-2"
                >
                  View changelog <ExternalLink className="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => setRecentUpdateNotice(null)}
                className="press rounded-full p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
                aria-label="Dismiss update notice"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
        </main>
        {artifactPanelOpen && (
          <Suspense fallback={null}>
            <ArtifactPanel />
          </Suspense>
        )}
        <Suspense fallback={null}>
          <SearchModal />
        </Suspense>
      </div>
    </div>
  );
}
