import { Suspense, lazy, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, X, AlertTriangle } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { Landing } from "./components/Landing";
import { useApp } from "./lib/store";
import { consumeInstalledUpdateNotice, detectUpdate, installUpdate, openReleaseUrl, type UpdateCardState, type UpdateProgress } from "./lib/update";
import { cn } from "./lib/cn";
import { isMacOS } from "./lib/platform";
import { useTranslucencyPref, nativeVibrancySupported } from "./lib/translucency";
import { recordTelemetry, setTelemetryEnabled, startTelemetrySession, stopTelemetrySession } from "./lib/telemetry";
import { fallbackAppVersion, resolveAppVersion } from "./lib/appVersion";
import { fetchCloudSession, onCloudAuthChanged, handleOAuthTokenCallback, type CloudUser } from "./lib/cloud";
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
const ConnectorsPage = lazy(() => import("./components/ConnectorsPage").then((m) => ({ default: m.ConnectorsPage })));
const AdminPage = lazy(() => import("./components/AdminPage").then((m) => ({ default: m.AdminPage })));
const TasksPage = lazy(() => import("./components/tasks/TasksPage").then((m) => ({ default: m.TasksPage })));
const InboxPage = lazy(() => import("./components/InboxPage").then((m) => ({ default: m.InboxPage })));
const ScheduledTasksPage = lazy(() => import("./components/scheduled/ScheduledTasksPage").then((m) => ({ default: m.ScheduledTasksPage })));
const OverlayChatView = lazy(() => import("./components/OverlayChatView").then((m) => ({ default: m.OverlayChatView })));
import { KeybindingsModal } from "./components/KeybindingsModal";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { BootProgress } from "./components/BootProgress";


function OfflineBanner() {
  const offline = useApp((s) => s.backendOffline);
  const bootstrap = useApp((s) => s.bootstrap);
  const [reconnecting, setReconnecting] = useState(false);

  if (!offline) return null;

  const handleRetry = async () => {
    setReconnecting(true);
    try {
      await bootstrap();
    } catch {}
    setReconnecting(false);
  };

  return (
    <div className="shrink-0 border-b border-warning/20 bg-warning/5 px-4 py-2 flex items-center justify-between text-[11px] text-warning animate-in fade-in duration-200">
      <div className="flex items-center gap-2">
        <span className="font-semibold flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          Running Offline:
        </span>
        <span className="text-warning/90">
          The local backend is unreachable. Showing cached chats and local canvas editors.
        </span>
      </div>
      <button
        onClick={handleRetry}
        disabled={reconnecting}
        className="px-2.5 py-1 text-[10.5px] font-semibold bg-warning/10 hover:bg-warning/20 text-warning rounded-lg transition-colors border border-warning/30 disabled:opacity-50 cursor-pointer"
      >
        {reconnecting ? "Connecting..." : "Reconnect"}
      </button>
    </div>
  );
}

/**
 * Detect whether this webview is the overlay window, synchronously.
 * Tauri injects the window label into `__TAURI_INTERNALS__.metadata` before
 * any app JS runs, so this is safe to call at the top of the component.
 */
function isOverlayWindow(): boolean {
  if (typeof window === "undefined") return false;
  const internals = (window as any).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label === "overlay";
}

export default function App() {
  // Detect the overlay window SYNCHRONOUSLY — this must happen before any
  // hooks are called. The window label is constant for the process lifetime,
  // so returning early here keeps the hook count stable across renders
  // (violating this causes React error #300). Previously this was an async
  // state that flipped false→true mid-lifecycle, skipping later hooks.
  if (isOverlayWindow()) {
    return (
      <Suspense fallback={<div className="h-screen w-screen bg-paper/10 backdrop-blur-xl" />}>
        <OverlayChatView />
      </Suspense>
    );
  }

  const previewMode = getPreviewMode();
  // Handle OAuth token callback from web sign-in (must run before any auth logic)
  handleOAuthTokenCallback();
  const [appVersion, setAppVersion] = useState(fallbackAppVersion());
  const bootstrap = useApp((s) => s.bootstrap);
  // Check for /admin path in web mode
  const [initialView] = useState(() => {
    if (typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__) {
      if (window.location.pathname === "/admin") return "admin" as const;
    }
    return null;
  });
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
  const backendReady = useApp((s) => s.backendReady);
  const keybindingsOpen = useApp((s) => s.keybindingsOpen);
  const setKeybindingsOpen = useApp((s) => s.setKeybindingsOpen);

  const macOS = isMacOS();
  const tauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
  const translucency = useTranslucencyPref();
  const useNativeGlass = translucency === "on" && nativeVibrancySupported();

  // Skip onboarding in browser preview mode (non-Tauri environment)
  const skipOnboarding = typeof window !== "undefined" && !((window as any).__TAURI_INTERNALS__);
  const [updateCard, setUpdateCard] = useState<UpdateCardState | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>({ phase: "idle" });
  const [recentUpdateNotice, setRecentUpdateNotice] = useState<{
    version: string;
    releaseUrl: string;
    notes?: string;
  } | null>(null);
  // In browser (non-Tauri) dev mode, skip cloud auth entirely and use a local stub.
  const isBrowserDevMode = typeof window !== "undefined" && !((window as any).__TAURI_INTERNALS__) && !previewMode;
  const localStubUser: CloudUser = {
    user_id: "local-dev",
    email: "dev@zwork.local",
    name: "Local Dev",
    tier: "free",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(
    previewMode === "app" ? {
      user_id: "preview-user",
      email: "preview@zwork.local",
      name: "Preview",
      tier: "free",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } : isBrowserDevMode ? localStubUser : null
  );
  const [cloudLoading, setCloudLoading] = useState(previewMode || isBrowserDevMode ? false : true);
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

  // Seed Zustand store with stub user in browser dev mode so components
  // that read `useApp(s => s.me)` work without a real cloud session.
  useEffect(() => {
    if (isBrowserDevMode) {
      syncStoreUser(localStubUser);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBrowserDevMode]);

  useEffect(() => {
    if (initialView === "admin") {
      useApp.getState().setView("admin");
    }
  }, [initialView]);

  useEffect(() => {
    let cancelled = false;
    void resolveAppVersion().then((version) => {
      if (!cancelled) setAppVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore saved zoom level
  useEffect(() => {
    const saved = localStorage.getItem("zwork.zoom");
    if (saved) {
      const zoom = parseFloat(saved);
      if (zoom >= 0.8 && zoom <= 1.5) {
        document.documentElement.style.setProperty("--zoom-level", String(zoom));
      }
    }
  }, []);

  useEffect(() => {
    // Browser dev mode: stub already set, skip cloud fetch entirely
    if (previewMode || isBrowserDevMode) return;
    let cancelled = false;
    void fetchCloudSession()
      .then((user) => {
        if (!cancelled) {
          setCloudUser(user);
          syncStoreUser(user);
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => {
        if (!cancelled) setCloudLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewMode, isBrowserDevMode]);

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
      } else if (mod && e.key.toLowerCase() === "s") {
        // Cmd/Ctrl+S toggles the sidebar. preventDefault stops the browser's
        // "Save Page" dialog. Kept alongside Cmd+\ so both bindings work.
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
      } else if (mod && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        const cur = parseFloat(localStorage.getItem("zwork.zoom") || "1");
        const next = Math.min(1.5, Math.round((cur + 0.1) * 10) / 10);
        localStorage.setItem("zwork.zoom", String(next));
        document.documentElement.style.setProperty("--zoom-level", String(next));
      } else if (mod && e.key === "-") {
        e.preventDefault();
        const cur = parseFloat(localStorage.getItem("zwork.zoom") || "1");
        const next = Math.max(0.5, Math.round((cur - 0.1) * 10) / 10);
        localStorage.setItem("zwork.zoom", String(next));
        document.documentElement.style.setProperty("--zoom-level", String(next));
      } else if (mod && e.key === "0") {
        e.preventDefault();
        localStorage.setItem("zwork.zoom", "1");
        document.documentElement.style.setProperty("--zoom-level", "1");
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        // setView("tasks"); // Disabled for now (deferred to backlog)
      } else if (mod && e.key === "/") {
        e.preventDefault();
        setKeybindingsOpen(!keybindingsOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openLanding, toggleSidebar, setView, setSearchOpen, triggerFocusChatInput, keybindingsOpen, setKeybindingsOpen]);

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
  if (!cloudUser && !isBrowserDevMode) {
    return (
      <Suspense fallback={<div className="h-screen w-screen bg-paper" />}>
        <LoginScreen />
      </Suspense>
    );
  }

  // Show onboarding when we know it's NOT done. `null` = still loading; render
  // nothing then to avoid flash. Skip in browser (non-Tauri) preview.
  if (!skipOnboarding && onboardingDone === false) {
    return (
      <Suspense fallback={<div className="h-screen w-screen bg-paper" />}>
        <Onboarding />
      </Suspense>
    );
  }
  if (!skipOnboarding && onboardingDone === null) {
    return <div className="h-screen w-screen bg-paper" />;
  }

  // Gate: don't render the main UI until the local backend is healthy.
  // Without this, providers/settings/connectors all load as empty.
  const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
  if (isTauri && !backendReady) {
    return <BootProgress />;
  }

  return (
    <div className={cn("flex h-screen w-screen flex-col overflow-hidden", useNativeGlass ? "bg-transparent" : "bg-paper")}>
      {/* macOS traffic-light area: ~38px tall. data-tauri-drag-region makes
          the strip draggable; Tauri auto-excludes the traffic-light buttons. */}
      {tauri && macOS && <div data-tauri-drag-region className="h-[38px] shrink-0 bg-transparent" />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        {/* Main content stays opaque — translucency is sidebar-only so the
            reading pane stays readable. The native Effect.Sidebar material is
            applied to the whole window but only shows through transparent regions. */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
          {/* Hide DailyGoalBar progress bar (deferred to backlog)
          <DailyGoalBar />
          */}
          <OfflineBanner />
          <div className="relative flex-grow flex min-h-0 overflow-hidden">
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
              <PlanPage cloudUser={cloudUser!} onUserChanged={setCloudUser} />
            </Suspense>
          ) : view === "projects" ? (
            <Suspense fallback={panelFallback}>
              <ProjectView />
            </Suspense>
          ) : view === "connectors" ? (
            <Suspense fallback={panelFallback}>
              <ConnectorsPage />
            </Suspense>
          ) : view === "tasks" ? (
            <Suspense fallback={panelFallback}>
              <TasksPage />
            </Suspense>
          ) : view === "inbox" ? (
            <Suspense fallback={panelFallback}>
              <InboxPage />
            </Suspense>
          ) : view === "scheduled" ? (
            <Suspense fallback={panelFallback}>
              <ScheduledTasksPage />
            </Suspense>
          ) : view === "admin" ? (
            <Suspense fallback={panelFallback}>
              <AdminPage />
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
              <div className="pointer-events-auto flex w-full max-w-[640px] items-center gap-3 rounded-2xl hairline bg-paper-raised px-4 py-3 shadow-lift">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
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
          </div>
        </main>
        {artifactPanelOpen && (
          <Suspense fallback={null}>
            <ArtifactPanel />
          </Suspense>
        )}
        <Suspense fallback={null}>
          <SearchModal />
        </Suspense>
        <KeybindingsModal />
        <PermissionPrompt />
      </div>
    </div>
  );
}
