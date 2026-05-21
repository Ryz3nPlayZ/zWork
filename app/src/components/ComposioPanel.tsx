import { useState } from "react";
import {
  Loader2,
  RefreshCw,
  Plug,
} from "lucide-react";
import { useApp } from "../lib/store";
import { AppBrandLogo, hasBrandLogo } from "./BrandLogos";

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
          <p className="mt-1 text-[13px] leading-5 text-ink-soft">
            Connect your apps and zWork can use them for you — send emails, manage your calendar, and more.
          </p>
        </div>
        <button
          onClick={() => void refreshComposio()}
          className="press ring-focus shrink-0 rounded-xl border border-line bg-paper-raised p-1.5 text-ink-soft hover:text-ink"
          aria-label="Refresh connected apps"
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
          const hasLogo = hasBrandLogo(app.id);

          return (
            <div
              key={app.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper-raised p-3.5"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: hasLogo ? `${app.color}14` : "rgb(var(--paper-sunken))",
                    color: hasLogo ? app.color : "rgb(var(--ink-muted))",
                  }}
                >
                  {hasLogo ? (
                    <AppBrandLogo appId={app.id} size={16} />
                  ) : (
                    <Plug size={16} />
                  )}
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
                  className="press ring-focus shrink-0 rounded-md border border-line px-2.5 py-1 text-[11.5px] font-medium text-ink-soft hover:text-red-500 hover:border-red-300"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={() => handleConnect(app.id)}
                  aria-label={`Connect ${app.name}`}
                  className="press ring-focus shrink-0 rounded-md bg-ink-soft px-2.5 py-1 text-[11.5px] font-medium text-paper hover:bg-ink"
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
