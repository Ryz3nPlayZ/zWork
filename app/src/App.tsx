import { useEffect, useState } from "react";
import appPackage from "../package.json";
import { Sidebar } from "./components/Sidebar";
import { Landing } from "./components/Landing";
import { ChatView } from "./components/ChatView";
import { SettingsPage } from "./components/Settings";
import { SearchModal } from "./components/SearchModal";
import { Onboarding } from "./components/Onboarding";
import { ProjectView } from "./components/ProjectView";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { useApp } from "./lib/store";
import { cn } from "./lib/cn";

export default function App() {
  const appVersion = appPackage.version;
  const bootstrap = useApp((s) => s.bootstrap);
  const view = useApp((s) => s.view);
  const active = useApp((s) => s.activeChatId);
  const chat = useApp((s) => (active ? s.chats[active] : undefined));
  const artifactPanelOpen = !!(view === "chat" && active && chat?.artifactPanelOpen);
  const openLanding = useApp((s) => s.openLanding);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const setView = useApp((s) => s.setView);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const onboardingDone = useApp((s) => s.onboardingDone);
  const [showUpdateNotice, setShowUpdateNotice] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    try {
      const seenVersion = window.localStorage.getItem("zwork:last-seen-version");
      if (seenVersion !== appVersion) {
        setShowUpdateNotice(true);
      }
    } catch {
      setShowUpdateNotice(false);
    }
  }, [appVersion]);

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

  const showLanding = view === "chat" && active === null;
  const showChatLoading = view === "chat" && !!active && !chat;
  const [showLandingOverlay, setShowLandingOverlay] = useState(showLanding);
  const [particlesExiting, setParticlesExiting] = useState(false);

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
    return <Onboarding />;
  }
  if (onboardingDone === null) {
    return <div className="h-screen w-screen bg-paper" />;
  }

  const dismissUpdateNotice = () => {
    try {
      window.localStorage.setItem("zwork:last-seen-version", appVersion);
    } catch {
      /* ignore */
    }
    setShowUpdateNotice(false);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-paper">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 overflow-hidden">
        {view === "settings" ? (
          <SettingsPage />
        ) : view === "projects" ? (
          <ProjectView />
        ) : showChatLoading ? (
          <div className="flex h-full w-full items-center justify-center bg-paper">
            <div className="rounded-2xl border border-line bg-paper-raised px-4 py-2 text-[12.5px] text-ink-muted">
              Loading chat…
            </div>
          </div>
        ) : (
          <>
            {!showLanding && <ChatView />}
            {showLandingOverlay && (
              <div
                className={cn(
                  "absolute inset-0 z-10 transition-opacity duration-300 ease-out",
                  particlesExiting ? "opacity-0" : "opacity-100",
                )}
              >
                <Landing particlesExiting={particlesExiting} />
              </div>
            )}
          </>
        )}
      </main>
      {artifactPanelOpen && <ArtifactPanel />}
      {showUpdateNotice && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-md rounded-3xl border border-line bg-paper-raised p-5 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-faint">
              Update available
            </div>
            <div className="mt-2 text-[18px] font-semibold tracking-tight text-ink">
              zWork has been updated.
            </div>
            <p className="mt-2 text-[13px] leading-6 text-ink-muted">
              You’re on version <span className="font-medium text-ink">{appVersion}</span>.
              Reload the app to pick up the latest changes.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={dismissUpdateNotice}
                className="rounded-full border border-line bg-paper px-3.5 py-2 text-[12.5px] font-medium text-ink-muted hover:bg-line/40 hover:text-ink"
              >
                Later
              </button>
              <button
                type="button"
                onClick={() => {
                  dismissUpdateNotice();
                  window.location.reload();
                }}
                className="rounded-full bg-ink px-3.5 py-2 text-[12.5px] font-medium text-paper hover:bg-ink/90"
              >
                Reload now
              </button>
            </div>
          </div>
        </div>
      )}
      <SearchModal />
    </div>
  );
}
