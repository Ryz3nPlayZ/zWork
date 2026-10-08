import { useState, useCallback } from "react";
import { Download, ZoomIn, ZoomOut } from "lucide-react";
import type { Artifact } from "../../lib/store";

export function ArtifactGraphViewer({ artifact }: { artifact: Artifact }) {
  const [zoom, setZoom] = useState(1);

  const exportImage = useCallback(() => {
    if (!artifact.src) return;
    const a = document.createElement("a");
    a.href = artifact.src;
    a.download = `${artifact.title.replace(/\s+/g, "_")}.png`;
    a.click();
  }, [artifact.src, artifact.title]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
          className="press rounded p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <span className="text-[10.5px] font-mono text-ink-faint w-10 text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
          className="press rounded p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        {artifact.src && (
          <button
            type="button"
            onClick={exportImage}
            className="press flex items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
          >
            <Download className="h-3 w-3" /> Export
          </button>
        )}
      </div>

      {/* Image / placeholder */}
      <div className="flex-1 overflow-auto flex items-center justify-center bg-paper-sunken">
        {artifact.src ? (
          <img
            src={artifact.src}
            alt={artifact.title}
            style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
            className="max-w-none transition-transform"
          />
        ) : artifact.content ? (
          <div className="w-full h-full overflow-auto p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-muted">Graph recipe</span>
            </div>
            <pre className="whitespace-pre-wrap rounded-xl border border-line bg-paper px-4 py-3 text-[12px] leading-6 text-ink">
              {artifact.content}
            </pre>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-ink-faint">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-dashed border-line-strong">
              <svg className="h-8 w-8 text-ink-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3v18h18" />
                <path d="M7 16l4-8 4 5 5-9" />
              </svg>
            </div>
            <span className="text-[12px]">Graph will render here</span>
            <span className="text-[10.5px] text-ink-faint">
              Ask zWork to generate a chart
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
