// The picture from a generate_image call, shown in the reply. While it is
// being made, a pixel shader churns in a card of the coming image's shape;
// when it lands, the image dissolves in over it. Reduced motion gets a still
// card and the plain image.
import { useEffect, useRef, useState } from "react";
import { Copy, Check, ExternalLink, FolderOpen, RotateCcw } from "lucide-react";
import { ImageGeneration, type ImageGenerationHandle } from "img-fx";
import { api } from "../lib/api";
import { useApp, type MessagePart } from "../lib/store";
import { useResolvedTheme } from "../lib/theme";
import { IconButton } from "./IconButton";
import { Lightbox } from "./Lightbox";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function parseResult(result?: string): { path?: string } {
  try {
    return JSON.parse(result || "{}");
  } catch {
    return {};
  }
}

export function ImageCard({ part }: { part: Extract<MessagePart, { kind: "tool" }> }) {
  const input = (part.input ?? {}) as { prompt?: string; aspect?: string };
  const [w, h] = (input.aspect || "1:1").split(":").map(Number);
  const ratio = w > 0 && h > 0 ? `${w} / ${h}` : "1 / 1";
  const path = part.ok ? parseResult(part.result).path : undefined;
  const failed = part.done && (part.ok === false || !path);

  const theme = useResolvedTheme();
  const send = useApp((s) => s.send);
  const fxRef = useRef<ImageGenerationHandle>(null);
  // Only a card that was churning in this view animates in; history shows the image.
  const sawRunning = useRef(!part.done);
  const still = useRef(reducedMotion()).current;
  const [src, setSrc] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!path) return;
    let url: string | null = null;
    api
      .outputImage(path)
      .then((b) => {
        url = URL.createObjectURL(b);
        setBlob(b);
        setSrc(url);
      })
      .catch((e) => setNote(e instanceof Error ? e.message : String(e)));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  const animate = sawRunning.current && !still;
  useEffect(() => {
    // Let the new image prop reach the effect before revealing it.
    if (src && animate) requestAnimationFrame(() => fxRef.current?.triggerReveal({ hold: "manual" }));
  }, [src, animate]);

  const run = async (fn: () => Promise<unknown>) => {
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = () =>
    run(async () => {
      if (!blob) return;
      // The clipboard takes PNG everywhere; other formats are redrawn as PNG.
      const png =
        blob.type === "image/png"
          ? blob
          : await new Promise<Blob>(async (resolve, reject) => {
              const bmp = await createImageBitmap(blob);
              const c = document.createElement("canvas");
              c.width = bmp.width;
              c.height = bmp.height;
              c.getContext("2d")!.drawImage(bmp, 0, 0);
              c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't copy the image."))), "image/png");
            });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  // shortcut: Try again asks the agent in a new message rather than re-running the call in place; add a direct endpoint if people use it a lot.
  const tryAgain = () => void send(input.prompt ? `Make that image again: ${input.prompt}` : "Make that image again.");

  const frame = "w-full rounded-xl bg-paper-sunken";

  if (failed) {
    return (
      <div role="alert" className="my-3 flex max-w-[440px] items-center gap-3 rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[13px] text-ink-muted">
        <span className="flex-1">{part.result?.trim() || "The image couldn't be made. Nothing was charged."}</span>
        <button type="button" onClick={tryAgain} className="press shrink-0 rounded-md px-2 py-1 font-medium text-ink hover:bg-ink/5">
          Try again
        </button>
      </div>
    );
  }

  const alt = input.prompt || "Generated image";
  let picture;
  if (path && !src && note) {
    picture = (
      <div className={`${frame} flex items-center justify-center px-6 text-center text-[12.5px] text-ink-faint`} style={{ aspectRatio: ratio }}>
        {note}
      </div>
    );
  } else if (src && !animate) {
    picture = (
      <button type="button" aria-label="View full size" onClick={() => setExpanded(true)} className="ring-focus block w-full cursor-zoom-in rounded-xl">
        <img src={src} alt={alt} className={`${frame} block object-cover`} style={{ aspectRatio: ratio }} />
      </button>
    );
  } else if (still) {
    picture = (
      <div className={`${frame} flex items-center justify-center text-[12.5px] text-ink-faint`} style={{ aspectRatio: ratio }}>
        Making the image…
      </div>
    );
  } else {
    picture = (
      <ImageGeneration ref={fxRef} preset="pixels-organic" theme={theme} images={src ? [src] : []} className="block w-full">
        <div role="img" aria-label={src ? alt : "Making the image…"} className={frame} style={{ aspectRatio: ratio }} />
      </ImageGeneration>
    );
  }

  return (
    <figure className="my-3 w-full max-w-[440px] rounded-2xl border border-line bg-paper-raised p-1.5">
      {picture}
      {path && (
        <figcaption className="flex items-center gap-0.5 pl-1.5 pt-1">
          <span className="mr-auto min-w-0 truncate text-[12px] text-ink-muted" title={input.prompt}>
            {note && src ? note : input.prompt}
          </span>
          <IconButton size="sm" icon={<ExternalLink />} label="Open" onClick={() => run(() => api.openFile(path))} />
          <IconButton size="sm" icon={copied ? <Check /> : <Copy />} label={copied ? "Copied" : "Copy"} disabled={!blob} onClick={copy} />
          <IconButton size="sm" icon={<FolderOpen />} label="Show in folder" onClick={() => run(() => api.openFile(path, true))} />
          <IconButton size="sm" icon={<RotateCcw />} label="Try again" onClick={tryAgain} />
        </figcaption>
      )}
      {expanded && src && <Lightbox src={src} alt={alt} caption={input.prompt} onClose={() => setExpanded(false)} />}
    </figure>
  );
}
