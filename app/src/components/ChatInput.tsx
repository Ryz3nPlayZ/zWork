import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  Plus,
  Square,
  X,
  FileText,
  Image as ImageIcon,
  Upload,
  ChevronDown,
  Hand,
  ShieldCheck,
  NotebookPen,
  ShieldAlert,
  MessageSquarePlus,
  CheckCircle2,
  XCircle,
  Monitor,
} from "lucide-react";
import { cn } from "../lib/cn";
import { needsLightweightRendering } from "../lib/platform";
import { useApp } from "../lib/store";
import type { SecurityPreset } from "../lib/store";
import { api, IS_WEB, type UploadedFile } from "../lib/api";
import {
  filterTemplates,
  findSlashTrigger,
  loadTemplates,
  newTemplateId,
  normalizeTrigger,
  saveTemplates,
  type PromptTemplate,
} from "../lib/templates";
import { IconButton } from "./IconButton";
import { classifyFile } from "../lib/files";
import { dragRegionAttrs } from "../lib/drag";
import { ModelPicker } from "./ModelPicker";
import { SlashMenu } from "./SlashMenu";

interface ComposerAttachment {
  id: string;
  name: string;
  mime: string;
  kind: "file" | "image";
  size: number;
  previewUrl?: string;
  uploadedPath?: string;
  dataUrl?: string;
}

function OverlayToolItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "press flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[12.5px] font-medium text-ink-soft",
        "hover:bg-paper-sunken hover:text-ink",
        active && "text-ink",
      )}
    >
      <span className={cn("text-ink-muted", active && "text-ink")}>{icon}</span>
      {label}
    </button>
  );
}

const PRESET_META: Record<
  SecurityPreset,
  { icon: ReactNode; label: string; description: string }
> = {
  ask: {
    icon: <Hand className="h-4 w-4" />,
    label: "Ask before changes",
    description: "Ask before file changes.",
  },
  edit: {
    icon: <ShieldCheck className="h-4 w-4" />,
    label: "Edit automatically",
    description: "Edit files automatically.",
  },
  plan: {
    icon: <NotebookPen className="h-4 w-4" />,
    label: "Plan mode",
    description: "Plan before editing.",
  },
  full: {
    icon: <ShieldAlert className="h-4 w-4" />,
    label: "Full access",
    description: "Run with fewer confirmations.",
  },
};

function SecurityPresetPicker({
  value,
  onChange,
}: {
  value: SecurityPreset;
  onChange: (preset: SecurityPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = PRESET_META[value];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Security preset"
        aria-expanded={open}
        className={cn(
          "press ring-focus inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-paper-sunken",
          open && "bg-paper-sunken border-line-strong",
        )}
      >
        <span className="text-ink-muted">{current.icon}</span>
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 text-ink-muted transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-64 animate-fade-in rounded-2xl border border-line bg-paper-raised p-1.5 shadow-lift">
          {(Object.keys(PRESET_META) as SecurityPreset[]).map((key) => {
            const meta = PRESET_META[key];
            const active = key === value;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className={cn(
                  "press flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
                  active
                    ? "bg-paper-sunken text-ink"
                    : "text-ink-soft hover:bg-paper-sunken hover:text-ink",
                )}
              >
                <span className={cn("mt-0.5 text-ink-muted", active && "text-ink")}>{meta.icon}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[12.5px] font-medium">{meta.label}</span>
                  <span className="text-[11px] text-ink-muted leading-4">{meta.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface Props {
  placeholder?: string;
  autoFocus?: boolean;
  onSend?: (text: string) => void;
  value?: string;
  onChange?: (val: string) => void;
  /** Compact, Gemini-style chatbar for the overlay window. */
  variant?: "default" | "overlay";
  className?: string;
  /** Called when the overlay should close (overlay variant only). */
  onDismiss?: () => void;
  /** Reports the overlay bar's rendered height so the window can grow with the draft. */
  onHeightChange?: (height: number) => void;
  /** When set, the composer morphs into an inline card instead of showing the
   *  textarea + controls. "question" renders a multiple-choice card for
   *  ask_question/ask_user_for_permission; "permission" renders an allow/deny
   *  card for destructive-tool gates. The card occupies the same screen space. */
  mode?: "default" | "question" | "permission";
  /** Data for the question card (mode="question"). */
  question?: { question: string; options: string[] };
  /** Data for the permission card (mode="permission"). */
  permission?: { reason: string };
  /** Callback when the user answers a question card. */
  onAnswerQuestion?: (answer: string) => void;
  /** Callback when the user resolves a permission card. */
  onResolvePermission?: (allow: boolean) => void;
}

export function ChatInput({
  placeholder = "Send a message",
  autoFocus,
  onSend,
  value: propValue,
  onChange: propOnChange,
  variant = "default",
  className,
  onDismiss,
  onHeightChange,
  mode = "default",
  question,
  permission,
  onAnswerQuestion,
  onResolvePermission,
}: Props) {
  const [localValue, setLocalValue] = useState("");
  const isControlled = propValue !== undefined;
  const value = isControlled ? propValue : localValue;
  const setValue = (val: string | ((prev: string) => string)) => {
    if (isControlled) {
      if (typeof val === "function") {
        propOnChange?.(val(propValue ?? ""));
      } else {
        propOnChange?.(val);
      }
    } else {
      setLocalValue(val);
    }
  };

  const [focused, setFocused] = useState(false);
  const [artifactMode, setArtifactMode] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const [templates, setTemplates] = useState<PromptTemplate[]>(() => loadTemplates());
  const [slashState, setSlashState] = useState<
    { start: number; end: number; query: string } | null
  >(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  const presetRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isOverlay = variant === "overlay";

  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const focusChatInput = useApp((s) => s.focusChatInput);
  const openSettings = useApp((s) => s.openSettings);
  const securityPreset = useApp((s) => s.securityPreset);
  const setSecurityPreset = useApp((s) => s.setSecurityPreset);
  const openLanding = useApp((s) => s.openLanding);
  const working = useApp((s) => {
    const id = s.activeChatId;
    return id ? (s.chats[id]?.working ?? false) : false;
  });
  const model = useApp((s) => s.model);
  const providers = useApp((s) => s.providers);
  const pendingShareImage = useApp((s) => s.pendingShareImage);
  const clearPendingShareImage = useApp((s) => s.clearPendingShareImage);
  const currentModel = providers?.models.find((m) => m.id === model);
  const modelLabel = currentModel?.name ?? (providers?.models.length ? "Model" : "No models");

  const slashMatches = useMemo(
    () => (slashState ? filterTemplates(templates, slashState.query) : []),
    [templates, slashState],
  );
  const slashOpen = !!slashState && slashMatches.length > 0;

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
    setMultiline(el.scrollHeight > 28);
    // Report the overlay bar's height so the overlay window grows with the draft.
    // When the + tools menu is open, reserve room ABOVE the bar for the upward-
    // opening menu — otherwise it's clipped by the idle window's 76px height.
    // (The Share Window picker is now its own OS window and doesn't affect the
    // overlay's geometry at all.)
    if (isOverlay && onHeightChange) {
      const bar = toolsRef.current;
      if (bar) {
        let h = bar.scrollHeight;
        if (toolsOpen) {
          // The menu opens above the bar (~256px wide, ~5 items ≈ 220px tall,
          // plus margin). Reserve enough vertical space so it isn't clipped.
          h += 260;
        }
        onHeightChange(h);
      }
    }
  }, [value, isOverlay, onHeightChange, setMultiline, toolsOpen]);

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

  // Consume an image pushed from the standalone Share Window picker (its own OS
  // window) via the store. Drain it into the local attachment list so it shows
  // up as a thumbnail the user can send. The model switch to zwork-vision is
  // done by the emitter (OverlayChatView); here we just attach the bytes.
  useEffect(() => {
    if (!pendingShareImage) return;
    const { dataUrl, mime, name } = pendingShareImage;
    clearPendingShareImage();
    let active = true;
    (async () => {
      try {
        const previewUrl = URL.createObjectURL(await (await fetch(dataUrl)).blob());
        if (!active) {
          URL.revokeObjectURL(previewUrl);
          return;
        }
        const id = `${Date.now().toString(36)}-share`;
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name: name || "Shared window",
            mime: mime || "image/png",
            kind: "image" as const,
            size: 0,
            previewUrl,
            dataUrl,
            uploadedPath: dataUrl,
          },
        ]);
      } catch {
        /* ignore — the image is dropped */
      }
    })();
    return () => {
      active = false;
    };
  }, [pendingShareImage, clearPendingShareImage]);

  useEffect(() => {
    if (focusChatInput > 0) areaRef.current?.focus();
  }, [focusChatInput]);

  // Refresh templates when the window regains focus, so edits made in the
  // Settings page show up immediately when the user comes back to chat.
  useEffect(() => {
    const onFocus = () => setTemplates(loadTemplates());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Close the overlay tools menu on outside click.
  useEffect(() => {
    if (!isOverlay || !toolsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!toolsRef.current?.contains(e.target as Node)) {
        setToolsOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [isOverlay, toolsOpen]);

  // Close the security-preset menu on outside click.
  useEffect(() => {
    if (!presetOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!presetRef.current?.contains(e.target as Node)) {
        setPresetOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [presetOpen]);

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !working && !uploading;

  const readAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });

  /**
   * Downscale a raster image so its base64 payload fits comfortably under the
   * upstream model router's request-body limit. Vision models don't benefit
   * from megapixel images (Anthropic/OpenAI both recommend ≤1568px on the long
   * edge), so we cap at 1568px and re-encode as JPEG q85. This typically shrinks
   * a phone photo / screenshot by ~90% with no perceptible quality loss for the
   * model. GIFs are returned as-is (canvas would collapse animation frames),
   * and any canvas failure falls back to the original bytes.
   */
  const downscaleImage = (file: File, maxEdge = 1568, quality = 0.85): Promise<string> =>
    new Promise((resolve) => {
      if (file.type === "image/gif" || file.type === "image/svg+xml") {
        readAsDataUrl(file).then(resolve, () => resolve(""));
        return;
      }
      const objUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        try {
          let { width, height } = img;
          const scale = Math.min(1, maxEdge / Math.max(width, height));
          width = Math.round(width * scale);
          height = Math.round(height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            readAsDataUrl(file).then(resolve, () => resolve(""));
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          // PNGs with transparency would gain a black background if flattened
          // to JPEG; keep PNG for those, otherwise JPEG is far smaller.
          const outMime = file.type === "image/png" ? "image/png" : "image/jpeg";
          resolve(canvas.toDataURL(outMime, quality));
        } catch {
          readAsDataUrl(file).then(resolve, () => resolve(""));
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        readAsDataUrl(file).then(resolve, () => resolve(""));
      };
      img.src = objUrl;
    });

  const fileToPayload = async (file: File, clientId: string) => {
    const mime = file.type || "application/octet-stream";
    const kind: "file" | "image" = mime.startsWith("image/") ? "image" : "file";
    const previewUrl = URL.createObjectURL(file);
    const base = {
      client_id: clientId,
      name: file.name || `upload-${clientId}`,
      mime,
      kind,
    };

    const textLike =
      mime.startsWith("text/") ||
      /\.(md|markdown|txt|csv|tsv|json|yaml|yml|py|js|jsx|ts|tsx|html|css|xml|svg)$/i.test(file.name);

    if (textLike) {
      return {
        payload: { ...base, text_content: await file.text() },
        previewUrl,
        size: file.size,
        kind,
      };
    }

    // Downscale raster images so the payload stays under the upstream router's
    // request-body cap; raw phone photos/screenshots exceed it (see `downscaleImage`).
    const dataUrl = mime.startsWith("image/")
      ? (await downscaleImage(file)) || (await readAsDataUrl(file))
      : await readAsDataUrl(file);
    return {
      payload: { ...base, data_url: dataUrl },
      dataUrl,
      previewUrl,
      size: file.size,
      kind,
    };
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    const pending = list.map((file) => ({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      file,
    }));
    try {
      const prepared = await Promise.all(
        pending.map(async ({ id, file }) => {
          const item = await fileToPayload(file, id);
          return { id, file, ...item };
        }),
      );

      // In web mode there is no local sidecar to stage files on disk, so we
      // keep the base64 data URL and send it inline with the chat request.
      if (IS_WEB) {
        setAttachments((prev) => [
          ...prev,
          ...prepared.map((item) => ({
            id: item.id,
            name: item.file.name || `upload-${item.id}`,
            mime: item.file.type || "application/octet-stream",
            kind: item.kind as "file" | "image",
            size: item.size,
            previewUrl: item.previewUrl,
            dataUrl: item.dataUrl,
            uploadedPath: item.dataUrl,
          })),
        ]);
        return;
      }

      setAttachments((prev) => [
        ...prev,
        ...prepared.map((item) => ({
          id: item.id,
          name: item.file.name || `upload-${item.id}`,
          mime: item.file.type || "application/octet-stream",
          kind: item.kind as "file" | "image",
          size: item.size,
          previewUrl: item.previewUrl,
          dataUrl: item.dataUrl,
        })),
      ]);

      const uploaded = await api.uploadFiles(prepared.map((item) => item.payload));
      setAttachments((prev) =>
        prev.map((att) => {
          const match = uploaded.files.find((f: UploadedFile) => f.client_id === att.id);
          return match ? { ...att, uploadedPath: match.path } : att;
        }),
      );
    } catch (e) {
      console.error(e);
      alert(`Failed to upload attachment${list.length > 1 ? "s" : ""}. Please try again.`);
    } finally {
      setUploading(false);
    }
  };

  const refreshSlashState = (next: string, caret: number) => {
    if (composing) {
      setSlashState(null);
      return;
    }
    const found = findSlashTrigger(next, caret);
    setSlashState(found);
    setSlashIndex(0);
  };

  const insertTemplate = (tpl: PromptTemplate) => {
    if (!slashState) return;
    const before = value.slice(0, slashState.start);
    const after = value.slice(slashState.end);
    const next = before + tpl.body + after;
    setValue(next);
    setSlashState(null);
    setSlashIndex(0);
    const caret = before.length + tpl.body.length;
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  /**
   * Handle the literal `/save <trigger>` shortcut. The composer body up to
   * the trailing `/save <trigger>` is persisted as a new template; the
   * normal send is short-circuited.
   */
  const tryHandleSaveCommand = (text: string): boolean => {
    const match = text.match(/(^|\s)\/save\s+(\S+)\s*$/i);
    if (!match) return false;
    const trigger = normalizeTrigger(match[2]);
    if (!trigger) return false;
    const body = text.slice(0, match.index! + match[1].length).trimEnd();
    if (!body) {
      alert("Type the template body before /save <trigger>.");
      return true;
    }
    const existing = templates.find((t) => t.trigger === trigger);
    if (existing) {
      alert(`A template with the trigger "/${trigger}" already exists.`);
      return true;
    }
    const next: PromptTemplate[] = [
      ...templates,
      {
        id: newTemplateId(),
        trigger,
        title: trigger.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        body,
      },
    ];
    setTemplates(next);
    saveTemplates(next);
    setValue("");
    setSlashState(null);
    return true;
  };

  const submit = () => {
    if (!canSend) return;
    const text = value;
    if (tryHandleSaveCommand(text)) {
      return;
    }
    const readyAttachments = attachments.filter(
      (a): a is ComposerAttachment & { uploadedPath: string } => !!a.uploadedPath,
    );
    setValue("");
    for (const a of attachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    setAttachments([]);
    setSlashState(null);
    onSend?.(text);
    void send(text, {
      artifactMode,
      attachments: readyAttachments.map((a) => ({
        client_id: a.id,
        name: a.name,
        path: a.uploadedPath,
        data_url: a.dataUrl,
        mime: a.mime,
        kind: a.kind,
        size: a.size,
        previewUrl: a.previewUrl,
      })),
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, slashMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const tpl = slashMatches[slashIndex];
        if (tpl) insertTemplate(tpl);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashState(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items || []);
    const files = [
      ...Array.from(e.clipboardData.files || []),
      ...items
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file),
    ];
    if (files.length === 0) return;
    const hasBinary = files.some((f) => f.type.startsWith("image/") || f.type);
    if (!hasBinary) return;
    e.preventDefault();
    await uploadFiles(files);
  };

  /**
   * Open the standalone Share Window picker (its own OS window, label "share").
   * The picker handles permission preflight, window listing, and capture; on a
   * successful capture it emits a "share-window-captured" event, which the
   * overlay (OverlayChatView) listens for to inject the image + switch to the
   * vision model. This keeps the overlay's geometry untouched — the picker no
   * longer lives inside the 76px-tall overlay frame.
   */
  const openShareWindow = async () => {
    setToolsOpen(false);
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      // Reuse the existing window if it was created earlier; otherwise create
      // it. The window is declared in tauri.conf.json (visible:false), so on
      // first open we just show it; if the config window isn't found (e.g. the
      // build predates it), fall back to creating it at runtime.
      let win = await WebviewWindow.getByLabel("share").catch(() => null);
      if (!win) {
        win = new WebviewWindow("share", {
          url: "index.html",
          title: "Share a Window",
          width: 520,
          height: 560,
          resizable: false,
          maximizable: false,
          minimizable: false,
          fullscreen: false,
          center: true,
          transparent: false,
          decorations: false,
          alwaysOnTop: true,
          shadow: true,
          visible: true,
          skipTaskbar: true,
        });
        // The constructor returns before the window is ready; once it's created
        // it shows itself (visible:true above).
      } else {
        await win.show();
        await win.setFocus();
      }
    } catch (e) {
      console.warn("[share-window] failed to open picker:", e);
    }
  };

  const attachmentList = attachments.length > 0 && (
    <div className={cn("flex flex-wrap gap-2", isOverlay ? "px-3 py-1.5" : "px-4 pt-3")}>
      {attachments.map((a) => {
        const classification = classifyFile(a.name, a.mime);
        return (
          <div
            key={a.id}
            className="flex items-center gap-2 rounded-xl border border-line bg-paper px-3 py-1.5 text-[12px] text-ink-muted transition-all"
          >
            {a.kind === "image" && a.previewUrl ? (
              <img
                src={a.previewUrl}
                alt={a.name}
                className="h-12 w-12 rounded-lg object-cover border border-line"
              />
            ) : a.kind === "image" ? (
              <ImageIcon className="h-3.5 w-3.5 text-blue-500" />
            ) : (
              <FileText className="h-3.5 w-3.5 text-ink-faint" />
            )}
            <span className="max-w-[180px] truncate font-medium">{a.name}</span>

            <span
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] font-bold uppercase tracking-wider select-none",
                classification.colorClass,
                classification.bgClass,
              )}
            >
              <span>{classification.category}</span>
            </span>

            <button
              type="button"
              onClick={() => {
                if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
                setAttachments((prev) => prev.filter((x) => x.id !== a.id));
              }}
              className="rounded-full p-0.5 text-ink-faint hover:bg-line/60 hover:text-ink ml-1"
              aria-label={`Remove ${a.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );

  const slashMenu = slashOpen && slashState && (
    <SlashMenu
      templates={templates}
      query={slashState.query}
      activeIndex={slashIndex}
      onActiveIndexChange={setSlashIndex}
      onSelect={insertTemplate}
      onManage={() => {
        setSlashState(null);
        openSettings("general");
      }}
    />
  );

  // When mode is "question" or "permission", the composer morphs into an
  // inline card instead of the textarea + controls. The card occupies the
  // same screen space (same wrapper className) so the transition is seamless.
  if (mode === "question" && question) {
    return (
      <ComposerCardShell variant={variant} className={className}>
        <QuestionCardBody
          question={question.question}
          options={question.options}
          onAnswer={onAnswerQuestion}
        />
      </ComposerCardShell>
    );
  }
  if (mode === "permission" && permission) {
    return (
      <ComposerCardShell variant={variant} className={className}>
        <PermissionCardBody
          reason={permission.reason}
          onResolve={onResolvePermission}
        />
      </ComposerCardShell>
    );
  }

  return (
    <>
      {/* Full-viewport drop overlay when dragging files */}
      {dragOver && (
        <div
          className={cn(
            "fixed inset-0 z-[500] flex items-center justify-center animate-fade-in",
            needsLightweightRendering()
              ? "bg-ink/20"
              : "bg-ink/10 backdrop-blur-sm",
          )}
          onDragLeave={(e) => {
            e.preventDefault();
            dragCounter.current -= 1;
            if (dragCounter.current <= 0) setDragOver(false);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            dragCounter.current = 0;
            if (e.dataTransfer.files.length > 0) void uploadFiles(e.dataTransfer.files);
          }}
          role="dialog"
          aria-label="Drop files to attach"
        >
          <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-ink/30 bg-paper p-12 shadow-pop pointer-events-none">
            <Upload className="h-10 w-10 text-ink-muted" />
            <div className="text-center">
              <p className="text-[18px] font-medium text-ink">Drop files to attach</p>
              <p className="mt-1 text-[13px] text-ink-muted">Images, documents, code, and more</p>
            </div>
          </div>
        </div>
      )}

      <div
        ref={isOverlay ? toolsRef : undefined}
        // The pill is a SINGLE drag mechanism: the declarative
        // `data-tauri-drag-region`. Tauri hooks it at the native layer BEFORE
        // the macOS first-click-focus event on the always-on-top window, so the
        // first grab both focuses AND drags — this is why we can't rely on the
        // imperative `startDragging()` fallback here (it loses that race).
        // Previously the wrapper ALSO carried the imperative `onBarMouseDown`,
        // which fired mid-drag and fought the native drag → jittery/inconsistent
        // drags on the non-interactive chrome. Tauri's declarative handler
        // natively skips interactive elements (textarea/buttons/select), so text
        // selection and clicks still work; [data-no-drag] clusters opt out too.
        {...(isOverlay ? dragRegionAttrs() : {})}
        className={cn(
          // Main-window input: OpenCode-style fill matches the page (bg-paper,
          // not raised), elevation faked via a hairline ring + soft shadow. On
          // focus the ring shifts to an accent-tinted outline. This avoids the
          // chatbox reading as a different-colored box — the "too light"
          // complaint in Catppuccin Mocha / Atom One came from bg-paper-raised
          // glaring.
          //
          // Overlay input: solid fill — on a fully-transparent Tauri overlay
          // window, `backdrop-filter` has nothing to sample (the window's own
          // backing store is transparent), so WebKit fills the element's
          // bounding box with an opaque frosted rectangle instead of blurring
          // the desktop. A solid bg-paper is the correct treatment for a
          // floating overlay; the shadow + hairline ring carry the elevation.
          "group relative w-full transition-[box-shadow] hairline-ring",
          isOverlay
            ? cn(
                "bg-paper",
                "flex items-center gap-1 px-2 py-2",
                (multiline || attachments.length > 0) ? "rounded-2xl" : "rounded-full",
                focused && "focus-ring",
              )
            : cn("bg-paper rounded-2xl", focused ? "focus-ring" : ""),
          dragOver && "ring-2 ring-ink/30 border-dashed",
          className,
        )}
        onDragEnter={(e) => {
          e.preventDefault();
          dragCounter.current += 1;
          if (dragCounter.current === 1) setDragOver(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          dragCounter.current -= 1;
          if (dragCounter.current <= 0) {
            dragCounter.current = 0;
            setDragOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          dragCounter.current = 0;
          if (e.dataTransfer.files.length > 0) void uploadFiles(e.dataTransfer.files);
        }}
      >
      {isOverlay && (
        <button
          type="button"
          onClick={() => setToolsOpen((v) => !v)}
          aria-label="More options"
          data-no-drag
          className="press ring-focus inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-paper-sunken hover:text-ink"
        >
          <Plus className="h-[18px] w-[18px]" />
        </button>
      )}

      {isOverlay ? (
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {attachmentList}
          {slashMenu}
          <textarea
            ref={areaRef}
            rows={1}
            value={value}
            placeholder={placeholder}
            disabled={working}
            onChange={(e) => {
              const next = e.target.value;
              setValue(next);
              refreshSlashState(next, e.target.selectionStart ?? next.length);
            }}
            onKeyDown={onKey}
            onKeyUp={(e) => {
              const el = e.currentTarget;
              refreshSlashState(el.value, el.selectionStart ?? el.value.length);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              refreshSlashState(el.value, el.selectionStart ?? el.value.length);
            }}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              // Defer so click handlers inside the menu still fire.
              setTimeout(() => setSlashState(null), 120);
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(e) => {
              setComposing(false);
              const el = e.currentTarget;
              refreshSlashState(el.value, el.selectionStart ?? el.value.length);
            }}
            className="block w-full min-h-0 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-0 text-[14.5px] leading-6 text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </div>
      ) : (
        <>
          {attachmentList}
          {slashMenu}
          <textarea
            ref={areaRef}
            rows={1}
            value={value}
            placeholder={placeholder}
            disabled={working}
            onChange={(e) => {
              const next = e.target.value;
              setValue(next);
              refreshSlashState(next, e.target.selectionStart ?? next.length);
            }}
            onKeyDown={onKey}
            onKeyUp={(e) => {
              const el = e.currentTarget;
              refreshSlashState(el.value, el.selectionStart ?? el.value.length);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              refreshSlashState(el.value, el.selectionStart ?? el.value.length);
            }}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              // Defer so click handlers inside the menu still fire.
              setTimeout(() => setSlashState(null), 120);
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(e) => {
              setComposing(false);
              const el = e.currentTarget;
              refreshSlashState(el.value, el.selectionStart ?? el.value.length);
            }}
            className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[14.5px] leading-6 text-ink placeholder:text-ink-faint focus:outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          />
        </>
      )}
      {isOverlay ? (
        <div data-no-drag className="flex shrink-0 items-center gap-1.5 pr-1">
          <span className="inline-flex max-w-[120px] items-center truncate text-[12px] font-medium text-ink-muted">
            {modelLabel}
          </span>
          <button
            type="button"
            aria-label={working ? "Stop" : "Send"}
            disabled={!working && !canSend}
            onClick={working ? stop : submit}
            className={cn(
              "press ring-focus inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors",
              working
                ? "bg-paper-sunken text-ink hover:bg-line/70"
                : canSend
                    ? "bg-ink text-paper hover:bg-ink/90"
                    : "bg-paper-sunken text-ink-faint cursor-not-allowed",
            )}
          >
            {working ? (
              <Square className="h-3 w-3 fill-ink" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <div className="flex items-center gap-1.5">
            <IconButton
              icon={<Plus className="h-4 w-4" />}
              label="Attach file"
              tooltipSide="top"
              variant="ghost"
              size="md"
              onClick={() => fileInputRef.current?.click()}
            />
            <IconButton
              icon={<FileText className="h-4 w-4" />}
              label={artifactMode ? "Artifact: on" : "Artifact"}
              tooltipSide="top"
              variant="ghost"
              size="md"
              active={artifactMode}
              onClick={() => setArtifactMode((v) => !v)}
            />
            <SecurityPresetPicker value={securityPreset} onChange={setSecurityPreset} />
          </div>
          <div className="flex items-center gap-2">
            <ModelPicker />
            <button
              type="button"
              aria-label={working ? "Stop" : "Send"}
              disabled={!working && !canSend}
              onClick={working ? stop : submit}
              className={cn(
                "press ring-focus inline-flex h-8 w-8 items-center justify-center rounded-full",
                "transition-colors",
                working
                  ? "bg-paper-sunken text-ink hover:bg-line/70"
                  : canSend
                      ? "bg-paper-sunken text-ink hover:bg-paper hover:border-line-strong border border-line"
                      : "bg-paper-sunken text-ink-faint cursor-not-allowed border border-line",
              )}
            >
              {working ? (
                <Square className="h-3 w-3 fill-ink" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      )}

      {isOverlay && toolsOpen && (
        <div data-no-drag className="absolute bottom-full left-0 mb-2 w-56 animate-fade-in rounded-2xl hairline bg-paper p-1.5 shadow-lift">
          <OverlayToolItem
            icon={<Plus className="h-4 w-4" />}
            label="Attach file"
            onClick={() => {
              setToolsOpen(false);
              fileInputRef.current?.click();
            }}
          />
          <OverlayToolItem
            icon={<Monitor className="h-4 w-4" />}
            label="Share window"
            onClick={() => {
              setToolsOpen(false);
              void openShareWindow();
            }}
          />
          <OverlayToolItem
            icon={<FileText className="h-4 w-4" />}
            label={artifactMode ? "Artifact: on" : "Artifact"}
            active={artifactMode}
            onClick={() => setArtifactMode((v) => !v)}
          />
          <div className="my-1 h-px bg-line" />
          <OverlayToolItem
            icon={<MessageSquarePlus className="h-4 w-4" />}
            label="New chat"
            onClick={() => {
              setToolsOpen(false);
              openLanding();
            }}
          />
          {onDismiss && (
            <OverlayToolItem
              icon={<X className="h-4 w-4" />}
              label="Close"
              onClick={() => {
                setToolsOpen(false);
                onDismiss();
              }}
            />
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          if (!files || files.length === 0) return;
          void uploadFiles(files);
          e.currentTarget.value = "";
        }}
        accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.py,.js,.jsx,.ts,.tsx,.html,.css,.xml,.pdf"
      />
    </div>
    </>
  );
}

/**
 * Shared wrapper for the question/permission cards. Matches the composer's
 * geometry (same rounded corners, solid fill for overlay, paper for main)
 * so the morph feels seamless — the card appears exactly where the chatbox was.
 */
function ComposerCardShell({
  variant,
  className,
  children,
}: {
  variant: "default" | "overlay";
  className?: string;
  children: ReactNode;
}) {
  const isOverlay = variant === "overlay";
  return (
    <div
      className={cn(
        "relative w-full rounded-2xl border border-line shadow-lift p-4",
        isOverlay ? "bg-paper" : "bg-paper-raised",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Question card — renders the model's question + vertical answer choices.
 * "Other" reveals a text input. Consistent corner radius, theme-correct text.
 */
function QuestionCardBody({
  question,
  options,
  onAnswer,
}: {
  question: string;
  options: string[];
  onAnswer?: (answer: string) => void;
}) {
  const [otherText, setOtherText] = useState("");
  const [showOther, setShowOther] = useState(false);
  // Filter out meta-options (the model sometimes includes "tell me what to do instead").
  const cleanOptions = options.filter(
    (o) => !/tell me what to do|instead/i.test(o),
  );
  const hasOther = options.length > cleanOptions.length || !options.some((o) => /other/i.test(o));
  const allOptions = hasOther ? [...cleanOptions, "Other"] : cleanOptions;

  const handleSelect = (opt: string) => {
    if (opt === "Other") {
      setShowOther(true);
      return;
    }
    onAnswer?.(opt);
  };

  const submitOther = () => {
    if (otherText.trim()) onAnswer?.(otherText.trim());
  };

  return (
    <div className="flex flex-col gap-3" data-no-drag>
      <p className="text-[14px] font-medium leading-snug text-ink">{question}</p>
      {showOther ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={otherText}
            autoFocus
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitOther();
              }
            }}
            placeholder="Type your answer…"
            className="flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-line-strong"
          />
          <button
            type="button"
            onClick={submitOther}
            disabled={!otherText.trim()}
            className="press ring-focus rounded-lg bg-ink px-3 py-2 text-[12.5px] font-semibold text-paper hover:bg-ink/90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {allOptions.map((opt, i) => (
            <button
              key={`${opt}-${i}`}
              type="button"
              onClick={() => handleSelect(opt)}
              className={cn(
                "press ring-focus flex items-center gap-2.5 rounded-xl border border-line bg-paper px-3 py-2 text-left text-[13px] text-ink transition-colors hover:bg-paper-sunken",
                opt === "Other" && "text-ink-muted",
              )}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-[10px] font-medium text-ink-muted">
                {String.fromCharCode(65 + i)}
              </span>
              <span className="flex-1">{opt}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Permission card — "zWork wants to run: {command}" with Allow / Don't allow / Other.
 * Always visible (no collapsed state) so the user sees it immediately.
 */
function PermissionCardBody({
  reason,
  onResolve,
}: {
  reason: string;
  onResolve?: (allow: boolean) => void;
}) {
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState("");

  return (
    <div className="flex flex-col gap-3" data-no-drag>
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="flex-1">
          <p className="text-[13px] font-medium text-ink">zWork wants to run a command</p>
          {reason && (
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{reason}</p>
          )}
        </div>
      </div>
      {showOther ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={otherText}
            autoFocus
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="Tell zWork what to do instead…"
            className="flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-line-strong"
          />
          <button
            type="button"
            onClick={() => {
              if (otherText.trim()) onResolve?.(false);
            }}
            disabled={!otherText.trim()}
            className="press ring-focus rounded-lg bg-ink px-3 py-2 text-[12.5px] font-semibold text-paper hover:bg-ink/90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onResolve?.(true)}
            className="press ring-focus flex items-center gap-2.5 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:bg-success/20"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            <span className="flex-1">Allow</span>
          </button>
          <button
            type="button"
            onClick={() => onResolve?.(false)}
            className="press ring-focus flex items-center gap-2.5 rounded-xl border border-error/30 bg-error/5 px-3 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:bg-error/10"
          >
            <XCircle className="h-4 w-4 shrink-0 text-error" />
            <span className="flex-1">Don't allow</span>
          </button>
          <button
            type="button"
            onClick={() => setShowOther(true)}
            className="press ring-focus flex items-center gap-2.5 rounded-xl border border-line bg-paper px-3 py-2 text-left text-[13px] text-ink-muted transition-colors hover:bg-paper-sunken"
          >
            <MessageSquarePlus className="h-4 w-4 shrink-0" />
            <span className="flex-1">Other (tell zWork what to do instead)</span>
          </button>
        </div>
      )}
    </div>
  );
}
