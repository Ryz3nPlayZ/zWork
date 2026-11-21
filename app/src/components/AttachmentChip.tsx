// One attached file, in the composer or on a sent message. A picture shows as
// a thumbnail that opens full size; any other file shows its name, type and size.
import { useState } from "react";
import { FileSpreadsheet, FileText, Loader2, X } from "lucide-react";
import { cn } from "../lib/cn";
import { Lightbox } from "./Lightbox";

const SHEETS = ["csv", "tsv", "xlsx", "xls", "ods", "numbers"];

function sizeLabel(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentChip({
  name,
  kind,
  size,
  src,
  busy,
  large,
  onRemove,
}: {
  name: string;
  kind: string;
  size?: number;
  /** Picture to show for an image: a blob or data URL. */
  src?: string;
  /** Still uploading. */
  busy?: boolean;
  /** Sent messages show pictures bigger than the composer does. */
  large?: boolean;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const Icon = SHEETS.includes(ext) ? FileSpreadsheet : FileText;
  const detail = busy ? "Uploading…" : [ext.toUpperCase(), sizeLabel(size)].filter(Boolean).join(", ");

  return (
    <div className="group/chip relative" title={name}>
      {kind === "image" && src ? (
        <button
          type="button"
          aria-label={`View ${name}`}
          onClick={() => setOpen(true)}
          className="ring-focus block cursor-zoom-in overflow-hidden rounded-xl border border-line bg-paper-sunken"
        >
          <img
            src={src}
            alt={name}
            className={cn("block object-cover", large ? "h-28 w-auto max-w-[220px]" : "h-14 w-14", busy && "opacity-60")}
          />
        </button>
      ) : (
        <div className="flex h-14 items-center gap-2.5 rounded-xl border border-line bg-paper-raised pl-2 pr-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-paper-sunken text-ink-muted">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
          </span>
          <span className="min-w-0 text-left">
            <span className="block max-w-[180px] truncate text-[12.5px] font-medium text-ink">{name}</span>
            {detail && <span className="block text-[11px] text-ink-faint">{detail}</span>}
          </span>
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="press ring-focus absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-paper bg-ink text-paper opacity-0 shadow-sm transition-opacity focus-visible:opacity-100 group-hover/chip:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
      {open && src && <Lightbox src={src} alt={name} caption={name} onClose={() => setOpen(false)} />}
    </div>
  );
}
