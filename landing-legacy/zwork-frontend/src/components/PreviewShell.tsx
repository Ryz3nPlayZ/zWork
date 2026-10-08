import { useEffect, useState } from "react";
import { Settings2, LogIn } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Landing } from "./Landing";
import { ChatView } from "./ChatView";
import { SettingsPage } from "./Settings";
import { ProjectView } from "./ProjectView";
import { ArtifactPanel } from "./ArtifactPanel";
import { SearchModal } from "./SearchModal";
import { AnalyticsPage } from "./AnalyticsPage";
import { PlanPage } from "./PlanPage";
import { LoginScreen } from "./LoginScreen";
import { Onboarding } from "./Onboarding";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

const PREVIEW_USER = {
  id: "preview-user",
  email: "preview@zwork.local",
  name: "Preview",
  tier: "free" as const,
  coupon_code: null,
};

const PREVIEW_CLOUD_USER = {
  user_id: "preview-user",
  email: "preview@zwork.local",
  name: "Preview",
  tier: "free" as const,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function PreviewAuthShell() {
  const [screen, setScreen] = useState<"login" | "onboarding">("login");

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-paper">
      <div className="absolute left-4 top-4 z-50 inline-flex items-center gap-1 rounded-full border border-line bg-paper-raised p-1 shadow-sm">
        <button
          type="button"
          onClick={() => setScreen("login")}
          className={cn(
            "press inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
            screen === "login" ? "bg-ink text-paper" : "text-ink-muted hover:text-ink hover:bg-paper-sunken",
          )}
        >
          <LogIn className="h-3.5 w-3.5" />
          Login
        </button>
        <button
          type="button"
          onClick={() => setScreen("onboarding")}
          className={cn(
            "press inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
            screen === "onboarding" ? "bg-ink text-paper" : "text-ink-muted hover:text-ink hover:bg-paper-sunken",
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Onboarding
        </button>
      </div>

      {screen === "login" ? <LoginScreen /> : <Onboarding />}
    </div>
  );
}

export function PreviewAppShell() {
  const bootstrap = useApp((s) => s.bootstrap);
  const view = useApp((s) => s.view);
  const active = useApp((s) => s.activeChatId);
  const chat = useApp((s) => (s.activeChatId ? s.chats[s.activeChatId] : undefined));
  const artifactPanelOpen = !!(view === "chat" && active && chat?.artifactPanelOpen);
  const openLanding = useApp((s) => s.openLanding);
  const setView = useApp((s) => s.setView);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const triggerFocusChatInput = useApp((s) => s.triggerFocusChatInput);

  useEffect(() => {
    useApp.setState({
      user: PREVIEW_USER,
      onboardingDone: true,
    });
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openLanding();
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
  }, [openLanding, setView, setSearchOpen, triggerFocusChatInput]);

  const showLanding = view === "chat" && active === null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-paper">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 overflow-hidden">
          {view === "settings" ? (
            <SettingsPage />
          ) : view === "analytics" ? (
            <AnalyticsPage />
          ) : view === "plan" ? (
            <PlanPage cloudUser={PREVIEW_CLOUD_USER} />
          ) : view === "projects" ? (
            <ProjectView />
          ) : (
            <>
              {!showLanding && <ChatView />}
              {showLanding && <Landing />}
            </>
          )}
          {artifactPanelOpen && <ArtifactPanel />}
          <SearchModal />
        </main>
      </div>
    </div>
  );
}
