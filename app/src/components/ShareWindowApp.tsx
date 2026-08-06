/**
 * ShareWindowApp — the standalone "Share Window" picker window.
 *
 * This runs in its OWN OS window (label "share"), NOT inside the overlay. The
 * overlay is a 76px-tall floating sliver; cramming a picker into it produced
 * dark-rectangle/cut-off artifacts. A dedicated window gets a proper-sized
 * surface with its own focus, independent of the overlay's geometry.
 *
 * Flow:
 *  1. On mount: preflight Screen Recording permission. If denied, show a
 *     permission panel with an "Open Settings" button + auto-polling re-check
 *     (every 1.2s for up to 60s) so we detect the grant WITHOUT a restart.
 *  2. If granted: list on-screen windows and show the picker grid.
 *  3. On pick: capture the window in-process (zWork's own grant), emit the
 *     result to the overlay via a Tauri event, then hide this window.
 *
 * The overlay listens for the event (OverlayChatView) and injects the image
 * as an attachment + switches to the vision model.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor, X } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";

type WindowEntry = { window_id: number; pid: number; app_name: string; title: string };

export function ShareWindowApp() {
  const [permission, setPermission] = useState<boolean | null>(null); // null = checking
  const [windows, setWindows] = useState<WindowEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capturingId, setCapturingId] = useState<number | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // Hide this window (keeps the webview alive for reuse).
  const close = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch {
      /* not in Tauri */
    }
  }, []);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Load the window list once permission is granted.
  const loadWindows = useCallback(async () => {
    setLoadError(null);
    const res = await api.listWindows();
    if (res.error) {
      setLoadError(res.error);
      setWindows([]);
    } else {
      setWindows(res.windows);
    }
  }, []);

  // On mount: preflight permission with a NON-PROMPTING check, then poll so we
  // detect a grant from System Settings without forcing a restart. The poll is
  // read-only (CGPreflightScreenCaptureAccess), so it never re-raises the macOS
  // TCC dialog. We deliberately do NOT call requestScreenCapture() /
  // openScreenRecordingSettings() automatically on open — those were firing the
  // system prompt every time the picker opened, and on some macOS builds
  // CGPreflight returns stale `false` until relaunch, which made it loop:
  // "keeps requesting the permission even after granting." The permission panel
  // surfaces a user-triggered "Open System Settings" button instead.
  useEffect(() => {
    let cancelled = false;
    const POLL_MS = 1200;
    const POLL_MAX_MS = 60_000;

    const enter = async () => {
      const granted = await api.screenCapturePreflight();
      if (cancelled) return;
      if (granted) {
        setPermission(true);
        void loadWindows();
      } else {
        setPermission(false);
      }
    };

    void enter();

    // Non-prompting poll: a user granting in System Settings should flip the
    // picker into the list view without a restart and without re-prompting.
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > POLL_MAX_MS) {
        if (pollRef.current) clearInterval(pollRef.current);
        return;
      }
      const granted = await api.screenCapturePreflight();
      if (cancelled) return;
      setPermission((prev) => {
        if (prev === true) return prev; // already granted; stop flipping
        if (granted) {
          void loadWindows();
          return true;
        }
        return prev;
      });
    }, POLL_MS);

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadWindows]);

  const onPick = useCallback(
    async (windowId: number) => {
      setCaptureError(null);
      setCapturingId(windowId);
      try {
        const result = await api.captureWindow(windowId);
        if (result.error || !result.data_url) {
          setCaptureError(result.error || "Capture failed");
          return;
        }
        // Emit to the overlay, which injects the image + switches to vision.
        try {
          const { emit } = await import("@tauri-apps/api/event");
          await emit("share-window-captured", {
            dataUrl: result.data_url,
            mime: result.mime || "image/png",
          });
        } catch {
          /* emit unavailable — still close */
        }
        await close();
      } catch (e) {
        setCaptureError(e instanceof Error ? e.message : "Capture failed");
      } finally {
        setCapturingId(null);
      }
    },
    [close],
  );

  const handleOpenSettings = useCallback(() => {
    void api.openScreenRecordingSettings();
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-2xl border border-line bg-paper">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-ink-muted" />
          <h1 className="text-[13px] font-semibold text-ink">Share a window</h1>
        </div>
        <button
          type="button"
          onClick={close}
          className="press rounded-full p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <p className="mb-3 text-[11.5px] leading-snug text-ink-muted">
          Pick a window to share. zWork captures a screenshot and sends it to the vision model.
        </p>

        {captureError && (
          <div className="mb-3 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-[11.5px] leading-snug text-error">
            {captureError}
          </div>
        )}
        {loadError && (
          <div className="mb-3 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-[11.5px] leading-snug text-error">
            Couldn’t load windows: {loadError}
          </div>
        )}

        {/* Permission-gated body */}
        {permission === false ? (
          <PermissionPanel onOpenSettings={handleOpenSettings} />
        ) : permission === null ? (
          <div className="flex items-center justify-center py-10 text-[12px] text-ink-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Checking permission…
          </div>
        ) : windows.length === 0 && !loadError ? (
          <div className="flex items-center justify-center py-10 text-[12px] text-ink-muted">
            No windows found.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {windows.map((w) => (
              <li key={`${w.window_id}-${w.pid}`}>
                <button
                  type="button"
                  disabled={capturingId !== null}
                  onClick={() => void onPick(w.window_id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border border-line bg-paper px-3 py-2 text-left transition-colors",
                    "hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-60",
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-paper-sunken text-ink-muted">
                    {capturingId === w.window_id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Monitor className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">
                      {w.app_name}
                    </span>
                    {w.title && (
                      <span className="block truncate text-[11px] text-ink-muted">
                        {w.title}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PermissionPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="rounded-xl border border-warning/20 bg-warning/5 px-4 py-4">
      <p className="text-[12.5px] font-semibold text-warning">Screen Recording permission required</p>
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink-muted">
        zWork needs Screen Recording access to capture other windows. Tap below to open System
        Settings, then enable zWork under <span className="font-medium">Screen Recording</span> and
        come back — this picker detects the grant automatically, so there’s no need to restart zWork.
      </p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="press mt-3 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-paper-sunken"
      >
        Open System Settings
      </button>
    </div>
  );
}
