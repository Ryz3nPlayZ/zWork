import { useState } from "react";
import {
  Loader2,
  RefreshCw,
  Plug,
} from "lucide-react";
import { useApp } from "../lib/store";

const APP_ICONS: Record<string, React.ReactNode> = {
  mail: <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>,
  calendar: <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  hash: <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M4 9h16M4 15h16M10 3 8 21M16 3 14 21"/></svg>,
  "book-open": <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>,
  folder: <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></svg>,
  "git-branch": <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>,
  layers: <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 12-8.97 4.08a2 2 0 0 1-1.66 0L2 12"/><path d="m22 17-8.97 4.08a2 2 0 0 1-1.66 0L2 17"/></svg>,
  zap: <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>,
  "check-square": <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>,
  "layout-grid": <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  target: <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
  "circle-dot": <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/></svg>,
};

export function ComposioPanel() {
  const composioStatus = useApp((s) => s.composioStatus);
  const composioAccounts = useApp((s) => s.composioAccounts);
  const composioApps = useApp((s) => s.composioApps);
  const refreshComposio = useApp((s) => s.refreshComposio);
  const connectComposioApp = useApp((s) => s.connectComposioApp);
  const disconnectComposioApp = useApp((s) => s.disconnectComposioApp);

  const [connecting, setConnecting] = useState<string | null>(null);

  const available = composioStatus?.available ?? false;
  const connectedApps = new Set(
    composioAccounts
      .filter((a) => a.status === "ACTIVE")
      .map((a) => a.app),
  );

  async function handleConnect(appId: string) {
    setConnecting(appId);
    try {
      await connectComposioApp(appId);
    } finally {
      setConnecting(null);
    }
  }

  // Not available (user not logged in or server not configured) — show nothing
  if (!available) return null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Connected Apps</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-muted">
            Connect your apps and zWork can use them for you — send emails, manage your calendar, and more.
          </p>
        </div>
        <button
          onClick={() => void refreshComposio()}
          className="press shrink-0 rounded-lg border border-line p-1.5 text-ink-muted hover:text-ink"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {composioStatus && composioStatus.tool_count > 0 && (
        <p className="text-[12px] text-ink-faint">
          {composioStatus.tool_count} tools active across {composioStatus.connected_apps.length} app{composioStatus.connected_apps.length !== 1 ? "s" : ""}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        {composioApps.map((app) => {
          const isConnected = connectedApps.has(app.id);
          const isConnecting = connecting === app.id;
          const icon = APP_ICONS[app.icon] ?? <Plug className="h-5 w-5" />;

          return (
            <div
              key={app.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper-raised p-3.5"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="shrink-0" style={{ color: app.color }}>
                  {icon}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-medium text-ink truncate">{app.name}</span>
                    {isConnected && (
                      <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
                        Connected
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {isConnecting ? (
                <Loader2 className="h-4 w-4 animate-spin text-ink-muted shrink-0" />
              ) : isConnected ? (
                <button
                  onClick={() => disconnectComposioApp(app.id)}
                  className="press shrink-0 rounded-md border border-line px-2.5 py-1 text-[11.5px] font-medium text-ink-muted hover:text-red-500 hover:border-red-300"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={() => handleConnect(app.id)}
                  className="press shrink-0 rounded-md bg-ink px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-ink/90"
                >
                  Connect
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
