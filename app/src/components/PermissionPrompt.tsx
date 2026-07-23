import { useEffect, useState } from "react";
import { Check, ChevronRight, Keyboard, Camera, RotateCw } from "lucide-react";
import { api } from "../lib/api";

const IS_TAURI = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
const DISMISS_KEY = "zwork:permission-prompt-dismissed";

type Status = "checking" | "missing" | "granted";

export function PermissionPrompt() {
  const [a11y, setA11y] = useState<Status>("checking");
  const [screen, setScreen] = useState<Status>("checking");
  // null = unchecked, true = driver reachable, false = CuaDriver not installed.
  const [driverOk, setDriverOk] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    if (!IS_TAURI) return true;
    return localStorage.getItem(DISMISS_KEY) === "true";
  });
  const [busy, setBusy] = useState<"a11y" | "screen" | null>(null);

  const refresh = async () => {
    if (!IS_TAURI) return;
    try {
      // Source of truth = cua-driver daemon identity (com.trycua.driver),
      // the process that actually performs Accessibility + CGEvent work.
      const st = await api.desktopStatus();
      setDriverOk(st.driver_ok);
      setA11y(st.accessibility ? "granted" : "missing");
      setScreen(st.screen_recording ? "granted" : "missing");
      if (st.driver_ok && st.accessibility && st.screen_recording) {
        localStorage.setItem(DISMISS_KEY, "true");
        setDismissed(true);
      }
    } catch {
      setDriverOk(false);
      setA11y("missing");
      setScreen("missing");
    }
  };

  useEffect(() => {
    if (!IS_TAURI) return;
    void refresh();
  }, []);

  // Periodically re-check while the prompt is open and something is missing —
  // macOS may grant the permission in System Settings while the app runs.
  useEffect(() => {
    if (!IS_TAURI || dismissed) return;
    if (a11y !== "missing" && screen !== "missing") return;
    const id = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(id);
  }, [IS_TAURI, dismissed, a11y, screen]);

  if (!IS_TAURI || dismissed) return null;
  if (a11y === "checking" && screen === "checking") return null;
  if (a11y !== "missing" && screen !== "missing") return null;

  const grant = async (which: "a11y" | "screen") => {
    setBusy(which);
    try {
      // One endpoint raises prompts for ALL missing grants, attributed to the
      // driver identity (com.trycua.driver) — the process that needs them.
      // Both buttons hit it; polling picks up the granted state.
      await api.desktopGrant();
      setTimeout(() => {
        void refresh();
        setBusy(null);
      }, 1200);
    } catch {
      setBusy(null);
    }
  };

  const skip = () => {
    localStorage.setItem(DISMISS_KEY, "true");
    setDismissed(true);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-[3px] p-4">
      <div className="w-full max-w-[380px] rounded-2xl border border-line bg-paper-raised shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1">
            System Access
          </div>
          <h2 className="text-[16px] font-semibold text-ink leading-tight">
            {driverOk === false ? "Install CuaDriver" : "Grant permissions"}
          </h2>
          <p className="text-[12px] text-ink-muted mt-1 leading-relaxed">
            {driverOk === false
              ? "Desktop control runs through CuaDriver.app. Install it, then relaunch zWork to grant permissions."
              : "zWork drives your desktop through CuaDriver, which needs these macOS permissions."}
          </p>
        </div>

        {driverOk === false ? (
          /* Driver unreachable — Enable buttons would do nothing, so show the
             install guidance instead of the permission rows. */
          <div className="px-5 pb-2">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-3">
              <p className="text-[12px] text-ink leading-relaxed">
                Download CuaDriver from{" "}
                <span className="font-mono text-[11px] text-ink-muted">
                  github.com/trycua/cua
                </span>
                , run the installer, then relaunch zWork.
              </p>
            </div>
          </div>
        ) : (
          /* Permission rows */
          <div className="px-3">
            <PermissionRow
              icon={<Keyboard className="h-4 w-4" />}
              name="Accessibility"
              hint="Read & control app windows"
              status={a11y}
              busy={busy === "a11y"}
              onGrant={() => grant("a11y")}
            />
            <PermissionRow
              icon={<Camera className="h-4 w-4" />}
              name="Screen Recording"
              hint="See on-screen content"
              status={screen}
              busy={busy === "screen"}
              onGrant={() => grant("screen")}
            />
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 mt-1">
          <button
            onClick={skip}
            className="text-[12px] font-medium text-ink-faint hover:text-ink-muted transition-colors"
          >
            Skip
          </button>
          <button
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink hover:bg-paper-sunken transition-colors"
          >
            <RotateCw className="h-3 w-3" />
            Recheck
          </button>
        </div>
      </div>
    </div>
  );
}

function PermissionRow({
  icon,
  name,
  hint,
  status,
  busy,
  onGrant,
}: {
  icon: React.ReactNode;
  name: string;
  hint: string;
  status: Status;
  busy: boolean;
  onGrant: () => void;
}) {
  const granted = status === "granted";
  return (
    <div className="flex items-center gap-3 rounded-xl px-2.5 py-2.5">
      <div
        className={
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg " +
          (granted ? "bg-emerald-500/10 text-emerald-600" : "bg-paper-sunken text-ink-muted")
        }
      >
        {granted ? <Check className="h-4 w-4" /> : icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink leading-tight">{name}</div>
        <div className="text-[11px] text-ink-faint leading-tight mt-0.5">{hint}</div>
      </div>
      {granted ? (
        <span className="text-[11px] font-medium text-emerald-600 pr-1">On</span>
      ) : (
        <button
          onClick={onGrant}
          disabled={busy}
          className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[11.5px] font-medium text-ink hover:bg-paper-sunken transition-colors disabled:opacity-60"
        >
          {busy ? "…" : "Enable"}
          {!busy && <ChevronRight className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}
