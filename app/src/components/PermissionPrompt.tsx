import { useEffect, useState } from "react";
import { Shield, ShieldCheck, ExternalLink, ArrowRight } from "lucide-react";

const IS_TAURI = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
const DISMISS_KEY = "zwork:permission-prompt-dismissed";

type PermissionState = "checking" | "not_granted" | "granted";

export function PermissionPrompt() {
  const [accessibility, setAccessibility] = useState<PermissionState>("checking");
  const [screenRecording, setScreenRecording] = useState<PermissionState>("checking");
  const [dismissed, setDismissed] = useState(() => {
    if (!IS_TAURI) return true;
    return localStorage.getItem(DISMISS_KEY) === "true";
  });
  const [showSystemSettings, setShowSystemSettings] = useState(false);

  const checkPermissions = async () => {
    if (!IS_TAURI) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [hasA11y, hasScreen] = await Promise.all([
        invoke<boolean>("check_accessibility_permission"),
        invoke<boolean>("check_screen_recording_permission"),
      ]);
      setAccessibility(hasA11y ? "granted" : "not_granted");
      setScreenRecording(hasScreen ? "granted" : "not_granted");

      // Auto-dismiss if all granted
      if (hasA11y && hasScreen) {
        localStorage.setItem(DISMISS_KEY, "true");
        setDismissed(true);
      }
    } catch {
      setAccessibility("not_granted");
      setScreenRecording("not_granted");
    }
  };

  useEffect(() => {
    if (!IS_TAURI) return;
    void checkPermissions();
  }, []);

  // Don't show if dismissed or not on Tauri
  if (!IS_TAURI || dismissed) return null;

  // Still loading
  if (accessibility === "checking" && screenRecording === "checking") return null;

  const needsA11y = accessibility === "not_granted";
  const needsScreen = screenRecording === "not_granted";

  // All granted — nothing to show
  if (!needsA11y && !needsScreen) return null;

  const handleGrant = async (permission: "accessibility" | "screen_recording") => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (permission === "accessibility") {
        await invoke("request_accessibility_permission");
      } else {
        await invoke("request_screen_recording_permission");
      }
      setShowSystemSettings(true);
    } catch {
      // ignore
    }
  };

  const handleCheckAgain = () => {
    setShowSystemSettings(false);
    void checkPermissions();
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, "true");
    setDismissed(true);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-line bg-paper-raised shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-2 duration-300">
        {/* Header */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10">
              <Shield className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-ink">Permissions Required</h2>
              <p className="text-[11.5px] text-ink-muted">
                zWork needs system permissions for full functionality
              </p>
            </div>
          </div>
        </div>

        {/* Permission items */}
        <div className="px-6 space-y-3">
          {/* Accessibility */}
          <div className="flex items-start gap-3 rounded-xl border border-line bg-paper p-4">
            <div className="mt-0.5">
              {accessibility === "granted" ? (
                <ShieldCheck className="h-5 w-5 text-emerald-500" />
              ) : (
                <Shield className="h-5 w-5 text-amber-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-ink">
                  Accessibility
                </span>
                {accessibility === "granted" && (
                  <span className="text-[10.5px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                    Granted
                  </span>
                )}
              </div>
              <p className="text-[11.5px] text-ink-muted mt-0.5 leading-relaxed">
                Required for the global keyboard shortcut{" "}
                <kbd className="inline-flex items-center gap-0.5 rounded border border-line bg-paper-sunken px-1 py-px text-[10px] font-mono">
                  ⌃⌥Space
                </kbd>{" "}
                to work when zWork isn't focused.
              </p>
              {accessibility !== "granted" && (
                <button
                  onClick={() => handleGrant("accessibility")}
                  className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink underline underline-offset-2 hover:text-ink-muted transition-colors"
                >
                  Open System Settings <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {/* Screen Recording */}
          <div className="flex items-start gap-3 rounded-xl border border-line bg-paper p-4">
            <div className="mt-0.5">
              {screenRecording === "granted" ? (
                <ShieldCheck className="h-5 w-5 text-emerald-500" />
              ) : (
                <Shield className="h-5 w-5 text-amber-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-ink">
                  Screen Recording
                </span>
                {screenRecording === "granted" && (
                  <span className="text-[10.5px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                    Granted
                  </span>
                )}
              </div>
              <p className="text-[11.5px] text-ink-muted mt-0.5 leading-relaxed">
                Required for the screenshot tool to capture your screen.
              </p>
              {screenRecording !== "granted" && (
                <button
                  onClick={() => handleGrant("screen_recording")}
                  className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink underline underline-offset-2 hover:text-ink-muted transition-colors"
                >
                  Open System Settings <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Instructions when System Settings was opened */}
        {showSystemSettings && (
          <div className="mx-6 mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <p className="text-[11.5px] text-amber-700 leading-relaxed">
              <strong>System Settings should now be open.</strong> Find <strong>zWork</strong> in the
              list and toggle it <strong>ON</strong>. You may need to authenticate with Touch ID or your password.
            </p>
          </div>
        )}

        {/* Footer buttons */}
        <div className="flex items-center justify-between gap-3 px-6 py-4">
          <button
            onClick={handleDismiss}
            className="px-3.5 py-2 text-[12px] font-medium text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-paper-sunken"
          >
            Skip for now
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCheckAgain}
              className="px-3.5 py-2 text-[12px] font-medium text-ink rounded-lg border border-line bg-paper hover:bg-paper-sunken transition-colors"
            >
              Check Again
            </button>
            <a
              href="https://support.apple.com/guide/mac-help/change-accessibility-preferences-mh43185/mac"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-3.5 py-2 text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
            >
              Help <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
