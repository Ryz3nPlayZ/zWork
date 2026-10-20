/**
 * Windows window chrome.
 *
 * On Windows the main window ships without native decorations (see
 * tauri.windows.conf.json), so the app draws its own caption buttons
 * (– □ ×). The layout is otherwise the macOS one: the sidebar runs to the
 * top of the window, search + sidebar toggle float at its top-left, and the
 * chat pane carries its own header. The caption buttons sit in the pane's
 * top-right corner, so headers that reach that corner (ChatView, the
 * artifact panel) reserve CAPTION_CLEARANCE on their right.
 *
 * An earlier version drew a full-width strip above everything and lifted the
 * chat title into it; the title then sat over the sidebar and read as part
 * of it. macOS keeps its traffic lights, Linux its native title bar, and the
 * web build has no window chrome (usesIntegratedTitleBar()).
 */

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { IS_TAURI, isMacOS, usesIntegratedTitleBar } from "../lib/platform";
import { dragRegionAttrs, onDragMouseDown } from "../lib/drag";

/** Caption strip height on the early screens, which have no pane. */
const TITLEBAR_H = 40;

/** Right padding for a pane header that runs under the caption buttons
 *  (3 × 46px buttons + the pane's 5px inset + breathing room). */
export const CAPTION_CLEARANCE = "pr-[150px]";

/* ------------------------------------------------------------------ *
 *  Caption buttons (– □ ×)
 * ------------------------------------------------------------------ */

/** Windows 10/11 caption glyphs — 10×10, 1px strokes, no fill. */
function CaptionGlyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 10 10"
      className="h-[10px] w-[10px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const GlyphMin = () => <CaptionGlyph><path d="M0.5 5h9" /></CaptionGlyph>;
const GlyphMax = () => <CaptionGlyph><rect x="0.5" y="0.5" width="9" height="9" /></CaptionGlyph>;
const GlyphRestore = () => (
  <CaptionGlyph>
    <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
    <rect x="0.5" y="2.5" width="7" height="7" />
  </CaptionGlyph>
);
const GlyphClose = () => <CaptionGlyph><path d="M0.7 0.7 9.3 9.3M9.3 0.7 0.7 9.3" /></CaptionGlyph>;

function captionAction(method: "minimize" | "toggleMaximize" | "close") {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      if (method === "minimize") return win.minimize();
      if (method === "toggleMaximize") return win.toggleMaximize();
      return win.close();
    })
    .catch((err) => console.warn(`[titlebar] ${method} failed:`, err));
}

function CaptionButton({
  label,
  danger,
  inset,
  last,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  /** Sits in the main pane's corner: the hover fill is inset by the pane's
   *  5px seam while the button itself reaches the window edge, so a click
   *  in the very corner of a maximized window still lands on Close. */
  inset?: boolean;
  last?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn("group flex outline-none", inset && "pt-[5px]", inset && last && "pr-[5px]")}
    >
      <span
        className={cn(
          "inline-flex h-full w-[46px] items-center justify-center transition-colors duration-100",
          inset && last && "rounded-tr-[14px]",
          danger
            ? "group-hover:bg-[#c42b1c] group-hover:text-white"
            // ink at low alpha adapts to the theme: light overlay on dark
            // surfaces, dark overlay on light ones.
            : "group-hover:bg-ink/[0.06] group-hover:text-ink",
        )}
      >
        {children}
      </span>
    </button>
  );
}

/** Tracks maximized state so the middle button can swap □ / restore. */
function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!IS_TAURI) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (disposed) return;
      const win = getCurrentWindow();
      const sync = () => {
        win
          .isMaximized()
          .then((m) => {
            if (!disposed) setMaximized(m);
          })
          .catch(() => {});
      };
      sync();
      win
        .onResized(sync)
        .then((u) => {
          unlisten = u;
        })
        .catch(() => {});
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return maximized;
}

/** Min / max-restore / close cluster, flush to the window's top-right
 *  corner. `inset` fits it to the main pane's rounded corner; without it the
 *  parent supplies the height (h-full). */
export function WindowControls({ inset }: { inset?: boolean }) {
  const maximized = useWindowMaximized();
  return (
    <div
      data-no-drag
      className={cn("flex items-stretch text-ink-faint", inset ? "h-[43px]" : "h-full")}
    >
      <CaptionButton label="Minimize" inset={inset} onClick={() => captionAction("minimize")}>
        <GlyphMin />
      </CaptionButton>
      <CaptionButton
        label={maximized ? "Restore" : "Maximize"}
        inset={inset}
        onClick={() => captionAction("toggleMaximize")}
      >
        {maximized ? <GlyphRestore /> : <GlyphMax />}
      </CaptionButton>
      <CaptionButton label="Close" danger inset={inset} last onClick={() => captionAction("close")}>
        <GlyphClose />
      </CaptionButton>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Early screens (boot / login / onboarding) render without the main
 *  layout's base layer, so they carry their own minimal chrome: a drag
 *  strip everywhere Tauri runs, plus caption buttons on Windows, where the
 *  app draws its own.
 * ------------------------------------------------------------------ */

export function EarlyScreenChrome() {
  if (!IS_TAURI) return null;
  if (usesIntegratedTitleBar()) {
    return (
      <>
        <div
          {...dragRegionAttrs()}
          onMouseDown={onDragMouseDown}
          className="absolute inset-x-0 top-0 z-30"
          style={{ height: TITLEBAR_H }}
          aria-hidden="true"
        />
        <div className="absolute right-0 top-0 z-30 flex" style={{ height: TITLEBAR_H }}>
          <WindowControls />
        </div>
      </>
    );
  }
  if (isMacOS()) {
    return (
      <div
        {...dragRegionAttrs()}
        onMouseDown={onDragMouseDown}
        className="absolute inset-x-0 top-0 z-10 h-10"
        aria-hidden="true"
      />
    );
  }
  return null;
}
