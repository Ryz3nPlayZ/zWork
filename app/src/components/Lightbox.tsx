// A picture shown full size over the app. Escape, the close button or a click
// outside the picture closes it.
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function Lightbox({
  src,
  alt,
  caption,
  actions,
  onClose,
}: {
  src: string;
  alt: string;
  caption?: string;
  actions?: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-[210] flex flex-col items-center justify-center gap-3 bg-black/75 p-6 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="press ring-focus absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
      <img src={src} alt={alt} className="max-h-[calc(100vh-120px)] max-w-full rounded-lg object-contain shadow-pop" />
      {(caption || actions) && (
        <div className="flex max-w-[640px] items-center gap-3 text-[12.5px] text-white/75">
          {caption && <span className="line-clamp-2 min-w-0">{caption}</span>}
          {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
        </div>
      )}
    </div>,
    document.body,
  );
}
