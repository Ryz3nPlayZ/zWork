import { Suspense, lazy, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, X } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { Landing } from "./components/Landing";
import { useApp } from "./lib/store";
import { consumeInstalledUpdateNotice, detectUpdate, installUpdate, openReleaseUrl, type UpdateCardState, type UpdateProgress } from "./lib/update";
import { cn } from "./lib/cn";
import { recordTelemetry, setTelemetryEnabled, startTelemetrySession, stopTelemetrySession } from "./lib/telemetry";
import { fallbackAppVersion, resolveAppVersion } from "./lib/appVersion";
import { fetchCloudSession, onCloudAuthChanged, type CloudUser } from "./lib/cloud";
import { identifyPostHogUser, resetPostHogUser } from "./lib/posthog";
import { getPreviewMode } from "./lib/preview";
import { PreviewAppShell, PreviewAuthShell } from "./components/PreviewShell";

const Onboarding = lazy(() => import("./components/Onboarding").then((m) => ({ default: m.Onboarding })));
const LoginScreen = lazy(() => import("./components/LoginScreen").then((m) => ({ default: m.LoginScreen })));
const loadChatView = () => import("./components/ChatView").then((m) => ({ default: m.ChatView }));
const ChatView = lazy(loadChatView);
const SettingsPage = lazy(() => import("./components/Settings").then((m) => ({ default: m.SettingsPage })));
const SearchModal = lazy(() => import("./components/SearchModal").then((m) => ({ default: m.SearchModal })));
const ProjectView = lazy(() => import("./components/ProjectView").then((m) => ({ default: m.ProjectView })));
const ArtifactPanel = lazy(() => import("./components/ArtifactPanel").then((m) => ({ default: m.ArtifactPanel })));
const AnalyticsPage = lazy(() => import("./components/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const PlanPage = lazy(() => import("./components/PlanPage").then((m) => ({ default: m.PlanPage })));

export default function App() {
  const previewMode = getPreviewMode();
  const [appVersion, setAppVersion] = useState(fallbackAppVersion());
  const bootstrap = useApp((s) => s.bootstrap);
  const view = useApp((s) => s.view);
  const settings = useApp((s) => s.settings);
  const active = useApp((s) => s.activeChatId);
  const chat = useApp((s) => (active ? s.chats[active] : undefined));
  const artifactPanelOpen = !!(view === "chat" && active && chat?.artifactPanelOpen);
  const openLanding = useApp((s) => s.openLanding);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const setView = useApp((s) => s.setView);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const triggerFocusChatInput = useApp((s) => s.triggerFocusChatInput);
  const onboardingDone = useApp((s) => s.onboardingDone);
  const [updateCard, setUpdateCard] = useState<UpdateCardState | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>({ phase: "idle" });
  const [recentUpdateNotice, setRecentUpdateNotice] = useState<{
    version: string;
    releaseUrl: string;
    notes?: string;
  } | null>(null);
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(previewMode === "app" ? {
    user_id: "preview-user",
    email: "preview@zwork.local",
    name: "Preview",
    tier: "free",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } : null);
  const [cloudLoading, setCloudLoading] = useState(previewMode ? false : true);
  const showLanding = view === "chat" && active === null;

  const syncStoreUser = (user: CloudUser | null) => {
    useApp.setState({
      user: user
        ? {
            id: user.user_id,
            email: user.email,
            name: user.name,
            tier: user.tier,
            coupon_code: user.access_code ?? user.coupon_code ?? null,
          }
        : null,
    });
  };

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    let cancelled = false;
    void resolveAppVersion().then((version) => {
      if (!cancelled) setAppVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (previewMode) return;
    let cancelled = false;
    void fetchCloudSession()
      .then((user) => {
        if (!cancelled) {
          setCloudUser(user);
          syncStoreUser(user);
        }
      })
      .finally(() => {
        if (!cancelled) setCloudLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewMode]);

  useEffect(() => {
    if (previewMode) return;
    return onCloudAuthChanged(() => {
      void fetchCloudSession().then((user) => {
        setCloudUser(user);
        syncStoreUser(user);
      });
    });
  }, [previewMode]);

  useEffect(() => {
    if (previewMode) return;
    if (!cloudUser) {
      resetPostHogUser();
      return;
    }
    identifyPostHogUser(cloudUser);
  }, [cloudUser, previewMode]);

  useEffect(() => {
    if (previewMode) return;
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
  }, [appVersion, settings?.telemetry_enabled, previewMode]);

  useEffect(() => {
    if (previewMode) return;
    void loadChatView();
  }, []);

  useEffect(() => {
    if (previewMode) return;
    setRecentUpdateNotice(consumeInstalledUpdateNotice(appVersion));
  }, [appVersion, previewMode]);

  useEffect(() => {
    if (previewMode) return;
    recordTelemetry("screen_view", {
      screen: showLanding ? "landing" : view,
      has_chat: !!active,
    });
  }, [showLanding, view, active, previewMode]);

  useEffect(() => {
    if (previewMode) return;
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
  }, [appVersion, previewMode]);

  if (previewMode === "auth") {
    return <PreviewAuthShell />;
  }
  if (previewMode === "app") {
    return <PreviewAppShell />;
  }

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
      const result = await installUpdate(updateCard, setUpdateProgress);
      if (!result.ok) {
        recordTelemetry("update_failed", {
          current_version: updateCard.currentVersion,
          latest_version: updateCard.latestVersion,
          source: updateCard.source,
          reason: "updater_error",
        });
        if (updateCard.source === "github") {
          setUpdateProgress({ phase: "opening" });
          await openReleaseUrl(updateCard.releaseUrl);
          setUpdateProgress({ phase: "idle" });
        } else {
          setUpdateProgress({ phase: "error", message: result.message });
        }
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
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        triggerFocusChatInput();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openLanding, toggleSidebar, setView, setSearchOpen, triggerFocusChatInput]);

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
  if (cloudLoading) {
    return <div className="h-screen w-screen bg-paper" />;
  }
  if (!cloudUser) {
    return (
      <Suspense fallback={<div className="h-screen w-screen bg-paper" />}>
        <LoginScreen />
      </Suspense>
    );
  }

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
          ) : view === "analytics" ? (
            <Suspense fallback={panelFallback}>
              <AnalyticsPage />
            </Suspense>
          ) : view === "plan" ? (
            <Suspense fallback={panelFallback}>
              <PlanPage cloudUser={cloudUser!} />
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
