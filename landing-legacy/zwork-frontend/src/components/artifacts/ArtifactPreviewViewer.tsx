import { useState, useCallback, useRef, useEffect } from "react";
import { RefreshCcw, ExternalLink, Smartphone, Monitor } from "lucide-react";
import type { Artifact } from "../../lib/store";

type Viewport = "desktop" | "mobile";

export function ArtifactPreviewViewer({ artifact }: { artifact: Artifact }) {
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [loading, setLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const src = artifact.src || "";

  useEffect(() => {
    setLoading(true);
  }, [src]);

  const handleLoad = useCallback(() => {
    setLoading(false);
  }, []);

  const handleReload = useCallback(() => {
    setLoading(true);
    if (iframeRef.current) {
      // Force reload by re-setting src
      const current = iframeRef.current.src;
      iframeRef.current.src = "";
      requestAnimationFrame(() => {
        if (iframeRef.current) iframeRef.current.src = current;
      });
    }
  }, []);

  const openExternal = useCallback(() => {
    if (src) window.open(src, "_blank");
  }, [src]);

  if (!src) {
    return (
      <div className="flex h-full items-center justify-center bg-paper-sunken">
        <div className="flex flex-col items-center gap-2 text-ink-faint">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-dashed border-line-strong">
            <ExternalLink className="h-8 w-8 text-ink-faint" />
          </div>
          <span className="text-[12px]">Web preview</span>
          <span className="text-[10.5px] text-ink-faint">
            Deploy a local app to see it here
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
        <button
          type="button"
          onClick={() => setViewport(viewport === "desktop" ? "mobile" : "desktop")}
          className="press rounded p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title={viewport === "desktop" ? "Mobile view" : "Desktop view"}
        >
          {viewport === "desktop" ? (
            <Smartphone className="h-3.5 w-3.5" />
          ) : (
            <Monitor className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={handleReload}
          className="press rounded p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title="Reload"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        <span className="text-[10.5px] font-mono text-ink-faint max-w-[200px] truncate">
          {src}
        </span>
        <button
          type="button"
          onClick={openExternal}
          className="press rounded p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title="Open in browser"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Preview area */}
      <div className="flex-1 overflow-auto flex justify-center bg-paper-sunken">
        <div
          className="relative h-full transition-[width] duration-300 ease-out"
          style={{ width: viewport === "mobile" ? 375 : "100%" }}
        >
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-paper-sunken/80 z-10">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-ink" />
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={src}
            onLoad={handleLoad}
            title={artifact.title}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-forms"
          />
        </div>
      </div>
    </div>
  );
}
