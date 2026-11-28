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
  PenLine,
  Mic,
} from "lucide-react";
import { VoiceBeam } from "voice-glow";
import { glowProps } from "../lib/glow";
import { useLook } from "../lib/wallpaper";
import { dictationSupported, useDictation } from "../lib/dictation";
import { useResolvedTheme } from "../lib/theme";
import { cn } from "../lib/cn";
import { MENU_PANEL, MENU_TRIGGER, menuPlacement, type MenuPlacement } from "../lib/menu";
import { needsLightweightRendering } from "../lib/platform";
import { useApp } from "../lib/store";
import type { SecurityPreset } from "../lib/store";
import { api, IS_WEB, type QueuedItem, type UploadedFile } from "../lib/api";
import { isDemoMode } from "../lib/preview";
import { fetchAnalyticsSummary, getCloudToken } from "../lib/cloud";
import { allowanceFrom, type Allowance } from "../lib/allowance";
import { AllowanceNote } from "./AllowanceNote";
import {
  filterTemplates,
  mergeCommands,
  findSlashTrigger,
  loadTemplates,
  newTemplateId,
  normalizeTrigger,
  saveTemplates,
  type PromptTemplate,
} from "../lib/templates";
import { IconButton } from "./IconButton";
import { AttachmentChip } from "./AttachmentChip";
import { dragRegionAttrs } from "../lib/drag";
import { ModelPicker } from "./ModelPicker";
import { SlashMenu } from "./SlashMenu";
import { GlideGroup } from "./Glide";
import { CrewPicker } from "./crew/CrewPicker";

interface ComposerAttachment {
  id: string;
  name: string;
  mime: string;
  kind: "file" | "image";
  size: number;
  previewUrl?: string;
  uploadedPath?: string;
  dataUrl?: string;
  /** Loaded from a sent message being edited: its preview URL is still in
   *  use by that message, so it must not be revoked here. */
  fromEdit?: boolean;
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
        "hover:bg-state-hover hover:text-ink",
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
    description: "Checks with you before changing anything.",
  },
  edit: {
    icon: <ShieldCheck className="h-4 w-4" />,
    label: "Edit automatically",
    description: "Changes files without asking first.",
  },
  plan: {
    icon: <NotebookPen className="h-4 w-4" />,
    label: "Plan first",
    description: "Suggests a plan and changes nothing.",
  },
  full: {
    icon: <ShieldAlert className="h-4 w-4" />,
    label: "Full access",
    description: "Fewest check-ins. Use with care.",
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
  // The composer sits at the bottom of a chat but near the top of a project
  // page: open toward whichever side has more room so the menu never clips.
  const [place, setPlace] = useState<MenuPlacement>({ dropDown: false, maxHeight: 400 });
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
        onClick={() => {
          setPlace(menuPlacement(ref.current));
          setOpen((v) => !v);
        }}
        aria-label="Security preset"
        aria-expanded={open}
        className={cn(MENU_TRIGGER, open && "bg-ink/5 text-ink")}
      >
        <span className="text-ink-muted">{current.icon}</span>
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 text-ink-muted transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <GlideGroup
          role="menu"
          highlightClassName="rounded-lg"
          style={{ maxHeight: place.maxHeight }}
          className={cn(
            MENU_PANEL,
            "left-0 w-64",
            place.dropDown ? "top-full mt-2 origin-top-left" : "bottom-full mb-2 origin-bottom-left",
          )}
        >
          {(Object.keys(PRESET_META) as SecurityPreset[]).map((key) => {
            const meta = PRESET_META[key];
            const active = key === value;
            return (
              <button
                key={key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                data-glide=""
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className={cn(
                  "press flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none",
                  active ? "bg-ink/5 text-ink" : "text-ink-soft hover:text-ink",
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
        </GlideGroup>
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
  /** Compact composer for the desktop companion's chat card. */
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
  /** Callback when the user resolves a permission card. On deny-with-text,
   *  `otherText` carries the "what to do instead" instruction. */
  onResolvePermission?: (allow: boolean, otherText?: string) => void;
  /** Start dictating whenever this number changes (the companion's Dictate button). */
  dictateNonce?: number;
  /** Narrow side-panel composer: hides the crew picker (the Finance chat is always its own crew member) and the permission picker (it still applies). */
  compact?: boolean;
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
  dictateNonce,
  compact,
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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [templates, setTemplates] = useState<PromptTemplate[]>(() => loadTemplates());
  const [commands, setCommands] = useState<Awaited<ReturnType<typeof api.commands>>["commands"]>([]);
  const slashItems = useMemo(() => mergeCommands(templates, commands), [templates, commands]);
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
  const resolvedTheme = useResolvedTheme();
  const voice = useDictation(() => areaRef.current?.value ?? "", (t) => setValue(t));
  const canDictate = dictationSupported;
  useEffect(() => {
    if (!dictateNonce || !canDictate) return;
    voice.start();
    areaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new nonce starts dictation
  }, [dictateNonce]);

  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const sendWhileBusy = useApp((s) => s.sendWhileBusy);
  const cancelQueued = useApp((s) => s.cancelQueued);
  const draftInject = useApp((s) => s.draftInject);
  const clearDraftInject = useApp((s) => s.clearDraftInject);
  const focusChatInput = useApp((s) => s.focusChatInput);
  const openSettings = useApp((s) => s.openSettings);
  const securityPreset = useApp((s) => s.securityPreset);
  const setSecurityPreset = useApp((s) => s.setSecurityPreset);
  const openLanding = useApp((s) => s.openLanding);
  const activeChatId = useApp((s) => s.activeChatId);
  const editing = useApp((s) => s.editing);
  const cancelEditMessage = useApp((s) => s.cancelEditMessage);
  const editAndResend = useApp((s) => s.editAndResend);
  const working = useApp((s) => {
    const id = s.activeChatId;
    return id ? (s.chats[id]?.working ?? false) : false;
  });
  const queuedItems = useApp((s) => {
    const id = s.activeChatId;
    return id ? (s.chats[id]?.queuedItems ?? []) : [];
  });
  const model = useApp((s) => s.model);
  const providers = useApp((s) => s.providers);
  const pendingShareImage = useApp((s) => s.pendingShareImage);
  const clearPendingShareImage = useApp((s) => s.clearPendingShareImage);
  const currentModel = providers?.models.find((m) => m.id === model);

  // zWork's own models draw on the plan allowance: say so before sending, not
  // after a failed run. Rechecked whenever a run ends, and when it refills.
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [allowanceTick, setAllowanceTick] = useState(0);
  useEffect(() => {
    if (!model.startsWith("zwork-") || IS_WEB || !getCloudToken() || working) {
      if (!model.startsWith("zwork-")) setAllowance(null);
      return;
    }
    let live = true;
    fetchAnalyticsSummary()
      .then((s) => { if (live) setAllowance(allowanceFrom(s)); })
      .catch(() => {});
    return () => { live = false; };
  }, [model, working, allowanceTick]);
  useEffect(() => {
    if (allowance?.kind !== "out" || !allowance.refillsAt) return;
    const wait = allowance.refillsAt.getTime() - Date.now() + 5_000;
    if (wait > 2 ** 31 - 1) return;
    const t = window.setTimeout(() => setAllowanceTick((n) => n + 1), Math.max(wait, 5_000));
    return () => window.clearTimeout(t);
  }, [allowance]);
  const modelLabel = currentModel?.name ?? (providers?.models.length ? "Model" : "No models");

  const slashMatches = useMemo(
    () => (slashState ? filterTemplates(slashItems, slashState.query) : []),
    [slashItems, slashState],
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
  // up as a thumbnail the user can send. Any model switch is done by the
  // emitter (CompanionView); here we just attach the bytes.
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
    const refreshCommands = () =>
      void api
        .commands()
        .then((r) => setCommands(r.commands))
        .catch(() => {});
    const onFocus = () => {
      setTemplates(loadTemplates());
      refreshCommands();
    };
    refreshCommands();
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
  // Queue-while-busy needs the sidecar's live-run endpoints — web demo and
  // hosted-web paths have no sidecar run to queue against.
  const queueSupported = !IS_WEB && !isDemoMode();
  const canQueue =
    working && queueSupported && value.trim().length > 0 && attachments.length === 0;

  // Stop hands unconsumed queued messages back to the composer — consume the
  // injected draft (non-destructively: appended under anything already typed).
  useEffect(() => {
    // chatId "" is the new-chat composer.
    if (!draftInject || draftInject.chatId !== (activeChatId ?? "")) return;
    const text = draftInject.text;
    setValue((prev) => (prev.trim() ? `${prev}\n\n${text}` : text));
    clearDraftInject();
    areaRef.current?.focus();
  }, [draftInject, activeChatId, clearDraftInject, setValue]);

  // Editing a sent message happens here in the composer: park whatever was
  // being typed, load the message, and put the draft back when the edit is
  // sent or cancelled.
  const editingHere = !isOverlay && editing && editing.chatId === activeChatId ? editing : null;
  const savedDraft = useRef<{ value: string; attachments: ComposerAttachment[] } | null>(null);
  useEffect(() => {
    if (editingHere) {
      if (!savedDraft.current) savedDraft.current = { value, attachments };
      setValue(editingHere.text);
      setAttachments(
        editingHere.attachments
          .filter((a) => !!a.path)
          .map((a, i) => ({
            id: `edit-${editingHere.messageId}-${i}`,
            name: a.name,
            mime: a.mime,
            kind: a.kind === "image" ? "image" : "file",
            size: a.size ?? 0,
            previewUrl: a.previewUrl,
            uploadedPath: a.path,
            dataUrl: a.dataUrl,
            fromEdit: true,
          })),
      );
      requestAnimationFrame(() => {
        const el = areaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    } else if (savedDraft.current) {
      const saved = savedDraft.current;
      savedDraft.current = null;
      setValue(saved.value);
      setAttachments(saved.attachments);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingHere?.messageId]);
  // Leaving the chat drops an unfinished edit.
  useEffect(() => {
    if (editing && editing.chatId !== activeChatId) cancelEditMessage();
  }, [activeChatId, editing, cancelEditMessage]);

  /** Send while a run is live: queue the text against the run instead of
   *  starting a new one. Default kind = follow-up (answered after the
   *  current run); the Steer button sends kind "steer". */
  const submitQueue = (kind: QueuedItem["kind"] = "follow_up") => {
    if (!canQueue) return;
    const text = value.trim();
    setValue("");
    setSlashState(null);
    void sendWhileBusy(text, kind);
  };

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

  // Files dragged anywhere over the window open the drop layer, not just over the box.
  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) setDragOver(true);
    };
    window.addEventListener("dragenter", enter);
    return () => window.removeEventListener("dragenter", enter);
  }, []);

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
    const text = tpl.kind ? `/${tpl.trigger} ` : tpl.body;
    const next = before + text + after;
    setValue(next);
    setSlashState(null);
    setSlashIndex(0);
    const caret = before.length + text.length;
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
    if (editingHere) {
      const ready = attachments.filter(
        (a): a is ComposerAttachment & { uploadedPath: string } => !!a.uploadedPath,
      );
      setSlashState(null);
      void editAndResend(
        editingHere.messageId,
        text,
        ready.map((a) => ({
          client_id: a.id,
          name: a.name,
          path: a.uploadedPath,
          data_url: a.dataUrl,
          mime: a.mime,
          kind: a.kind,
          size: a.size,
          previewUrl: a.previewUrl,
        })),
      );
      return;
    }
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
    if (voice.listening && (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      voice.stop();
      return;
    }
    if (e.key === "Escape" && editingHere) {
      e.preventDefault();
      cancelEditMessage();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (working && queueSupported) {
        submitQueue();
      } else {
        submit();
      }
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
   * companion (CompanionView) listens for to open its chat with the image
   * attached.
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
      {attachments.map((a) => (
        <AttachmentChip
          key={a.id}
          name={a.name}
          kind={a.kind}
          size={a.size}
          src={a.previewUrl ?? a.dataUrl}
          busy={!IS_WEB && !a.uploadedPath}
          onRemove={() => {
            if (a.previewUrl && !a.fromEdit) URL.revokeObjectURL(a.previewUrl);
            setAttachments((prev) => prev.filter((x) => x.id !== a.id));
          }}
        />
      ))}
    </div>
  );

  const slashMenu = slashOpen && slashState && (
    <SlashMenu
      templates={slashItems}
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

  const queueKindLabel: Record<QueuedItem["kind"], string> = {
    steer: "Steer",
    follow_up: "Queued",
    next_run: "Next run",
    write: "Write",
  };

  // Queued messages waiting against the live run, above the draft. A word
  // label instead of an icon per kind; the x cancels.
  const allowanceLine = allowance && (
    <AllowanceNote
      allowance={allowance}
      onSeeUsage={() => useApp.getState().setView("analytics")}
      onUpgrade={() => useApp.getState().setView("plan")}
    />
  );

  const queueChips = queuedItems.length > 0 && (
    <div className="flex flex-wrap items-center gap-1.5 px-5 pt-3">
      {queuedItems.map((item) => {
        const label = queueKindLabel[item.kind] ?? "Queued";
        return (
          <span
            key={item.entry_id}
            className="inline-flex max-w-[280px] items-center gap-1.5 rounded-full border border-line bg-ink/5 py-1 pl-2.5 pr-1 text-[12px] text-ink-muted animate-fade-in"
            title={`${label}: ${item.text}`}
          >
            <span className="shrink-0 font-medium text-ink-soft">{label}</span>
            <span className="truncate">{item.text}</span>
            <button
              type="button"
              onClick={() => void cancelQueued(item.entry_id)}
              className="press ring-focus rounded-full p-0.5 text-ink-faint hover:bg-ink/10 hover:text-ink"
              aria-label={`Cancel ${label.toLowerCase()} message`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );

  // Stop button (working state). The beam ring around it mounts ONLY in
  // Stop state (conditional mount, not active-toggled) so send-family
  // buttons can never carry a shine.
  const stopButton = (
    <button
      type="button"
      aria-label="Stop"
      onClick={stop}
      className="press ring-focus inline-flex h-8 w-8 items-center justify-center rounded-full bg-paper-sunken text-ink transition-colors hover:bg-state-hover"
    >
      <Square className="h-3 w-3 fill-ink" />
    </button>
  );

  // Queue-while-busy: two labelled choices instead of icons. Queue (Enter)
  // waits for the run to finish; Steer joins the run at its next step.
  const queueButtons = canQueue && (
    <div className="flex items-center gap-1">
      <button
        type="button"
        title="Send now; zWork reads it at its next step"
        onClick={() => submitQueue("steer")}
        className="press ring-focus inline-flex h-8 items-center rounded-full border border-line px-3 text-[12.5px] font-medium text-ink-soft hover:border-line-strong hover:bg-state-hover hover:text-ink"
      >
        Steer
      </button>
      <button
        type="button"
        title="Send when the current run finishes (Enter)"
        onClick={() => submitQueue("follow_up")}
        className="press ring-focus inline-flex h-8 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-paper hover:bg-ink/90"
      >
        Queue
      </button>
    </div>
  );

  const micButton = canDictate &&
    (voice.listening ? (
      <button
        type="button"
        title="Stop listening (Esc). The text stays here to review."
        onClick={voice.stop}
        className="press ring-focus inline-flex h-8 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-paper hover:bg-ink/90"
      >
        Done
      </button>
    ) : (
      <IconButton
        icon={<Mic className="h-4 w-4" />}
        label="Dictate"
        tooltipSide="top"
        variant="ghost"
        size="md"
        onClick={() => {
          voice.start();
          areaRef.current?.focus();
        }}
      />
    ));

  // Idle send button.
  const sendButton = (
    <button
      type="button"
      aria-label="Send"
      disabled={!canSend}
      onClick={submit}
      className={cn(
        "press ring-focus inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors",
        isOverlay
          ? canSend
            ? "bg-ink text-paper hover:bg-ink/90"
            : "bg-paper-sunken text-ink-faint cursor-not-allowed"
          : canSend
            ? "bg-ink text-paper hover:bg-ink/90"
            : "bg-ink/[0.07] text-ink-faint cursor-not-allowed",
      )}
    >
      <ArrowUp className="h-4 w-4" />
    </button>
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
          // Its card ignores the pointer, so leaving this layer means leaving the window.
          onDragLeave={(e) => e.target === e.currentTarget && setDragOver(false)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length > 0) void uploadFiles(e.dataTransfer.files);
          }}
          role="dialog"
          aria-label="Drop files to attach"
        >
          <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-ink/30 bg-paper p-12 shadow-pop pointer-events-none">
            <Upload className="h-10 w-10 text-ink-muted" />
            <div className="text-center">
              <p className="text-[18px] font-medium text-ink">Drop files to attach</p>
              <p className="mt-1 text-[13px] text-ink-muted">PDFs, spreadsheets, photos and more</p>
            </div>
          </div>
        </div>
      )}

      <ComposerGlow on={canDictate} active={voice.listening} level={voice.level} theme={resolvedTheme}>
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
            : cn("bg-paper rounded-2xl", focused ? "focus-ring" : "", voice.listening && "ring-inside"),
          className,
        )}
      >
      {isOverlay && (
        <button
          type="button"
          onClick={() => setToolsOpen((v) => !v)}
          aria-label="More options"
          data-no-drag
          className="press ring-focus inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-state-hover hover:text-ink"
        >
          <Plus className="h-[18px] w-[18px]" />
        </button>
      )}

      {isOverlay ? (
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {queueChips}
          {attachmentList}
          {slashMenu}
          <textarea
            ref={areaRef}
            rows={1}
            value={value}
            placeholder={voice.listening ? "Listening…" : working && queueSupported ? "Queue a message while zWork works…" : placeholder}
            disabled={working && !queueSupported}
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
            className="block w-full min-h-0 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-0 text-[15px] leading-[25px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </div>
      ) : (
        <>
          {editingHere && (
            <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2 text-[12px]">
              <PenLine className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
              <span className="font-medium text-ink">Editing message</span>
              <span className="truncate text-ink-faint">Sending it replaces everything after it</span>
              <button
                type="button"
                onClick={cancelEditMessage}
                className="press ring-focus ml-auto shrink-0 rounded-md px-2 py-0.5 text-ink-muted transition-colors hover:bg-state-hover hover:text-ink"
              >
                Cancel
              </button>
            </div>
          )}
          {allowanceLine}
          {queueChips}
          {attachmentList}
          {slashMenu}
          <textarea
            ref={areaRef}
            rows={1}
            value={value}
            placeholder={voice.listening ? "Listening…" : working && queueSupported ? "Queue a message while zWork works…" : placeholder}
            disabled={working && !queueSupported}
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
            className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[15px] leading-[25px] text-ink placeholder:text-ink-faint focus:outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          />
        </>
      )}
      {isOverlay ? (
        <div data-no-drag className="flex shrink-0 items-center gap-1.5 pr-1">
          <span className="inline-flex max-w-[120px] items-center truncate text-[12px] font-medium text-ink-muted">
            {modelLabel}
          </span>
          {micButton}
          {working ? (
            <>
              {queueButtons}
              {stopButton}
            </>
          ) : (
            sendButton
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <div className="flex min-w-0 items-center gap-0.5">
            <IconButton
              icon={<Plus className="h-4 w-4" />}
              label="Attach file"
              tooltipSide="top"
              variant="ghost"
              size="md"
              onClick={() => fileInputRef.current?.click()}
            />
            {/* Permissions and crew are agent features; the web app is a plain chat. */}
            {!IS_WEB && !compact && (
              <>
                <SecurityPresetPicker value={securityPreset} onChange={setSecurityPreset} />
                <CrewPicker disabled={working} />
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            <ModelPicker />
            {micButton}
            {working ? (
              <>
                {queueButtons}
                {stopButton}
              </>
            ) : (
              sendButton
            )}
          </div>
        </div>
      )}

      {isOverlay && toolsOpen && (
        <div data-no-drag className="absolute bottom-full left-0 mb-2 w-56 animate-fade-in rounded-xl border border-line bg-paper-raised p-1 shadow-pop">
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
        accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.py,.js,.jsx,.ts,.tsx,.html,.css,.xml,.pdf,.xlsx,.xls,.xlsm,.docx,.doc,.pptx,.ppt,.odt,.ods,.odp,.rtf,.key,.numbers,.pages,.zip"
      />
    </div>
    </ComposerGlow>
    {voice.blocked && (
      <div role="alert" className="mt-2 flex items-center gap-2 px-1 text-[12.5px] text-ink-muted">
        <span className="min-w-0 flex-1">
          {voice.blocked === "mic"
            ? IS_WEB
              ? "zWork can't hear you. Allow the microphone for this site in your browser."
              : "zWork can't hear you. Allow the microphone for zWork in System Settings."
            : "Speech recognition is off for zWork. Turn it on in System Settings."}
        </span>
        {!IS_WEB && (
          <button
            type="button"
            onClick={() => void openPrivacyPane(voice.blocked === "mic" ? "microphone" : "speech_recognition")}
            className="press ring-focus shrink-0 rounded-md px-2 py-0.5 font-medium text-ink hover:bg-state-hover"
          >
            Open settings
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={voice.dismissBlocked}
          className="press ring-focus shrink-0 rounded-md p-1 text-ink-faint hover:bg-state-hover hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )}
    </>
  );
}

async function openPrivacyPane(pane: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_macos_privacy_pane", { pane }).catch(() => {});
}

/** The voice glow along the composer's bottom edge. `on` never changes for a
 *  given composer, so the textarea isn't remounted. */
function ComposerGlow({
  on,
  children,
  ...beam
}: {
  on: boolean;
  children: ReactNode;
  active: boolean;
  level: () => number;
  theme: "light" | "dark";
}) {
  const { look } = useLook();
  if (!on) return <>{children}</>;
  const dark = beam.theme === "dark";
  return (
    // voice-glow clips its box, which hides the composer's outer ring and cuts off
    // its menus; only clip while listening, when the glow needs it.
    <VoiceBeam
      {...beam}
      {...glowProps(look.glow)}
      // A high floor and a low ceiling: a quiet voice still lifts it visibly,
      // a loud one doesn't blow it up.
      idle={0.45}
      attack={0.12}
      release={0.55}
      reach={dark ? 1.4 : 1.55}
      spread={1.1}
      brightness={dark ? 1.25 : 1.05}
      saturation={dark ? 1.5 : 1.7}
      glowSize={1.3}
      innerHeight={1.4}
      bloomHeight={1.6}
      strength={1}
      className={beam.active ? "w-full" : "w-full !overflow-visible"}
    >
      {children}
    </VoiceBeam>
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
 * Question card — renders the model's question + vertical answer choices,
 * with a free-text row at the bottom of the same list. The text box is
 * always present (never a separate "Other" view you can't go back from):
 * preset options stay visible and clickable while you type.
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
  // Filter out meta-options (the model sometimes includes "tell me what to do
  // instead") and bare "Other" entries — the free-text row replaces those.
  const cleanOptions = options.filter(
    (o) =>
      !/tell me what to do|instead/i.test(o) &&
      !/^other\s*(…|\.\.\.)?$/i.test(o.trim()),
  );

  const submitOther = () => {
    if (otherText.trim()) onAnswer?.(otherText.trim());
  };

  return (
    <div className="flex flex-col gap-3" data-no-drag>
      <p className="text-[14px] font-medium leading-snug text-ink">{question}</p>
      <div className="flex flex-col gap-1.5">
        {cleanOptions.map((opt, i) => (
          <button
            key={`${opt}-${i}`}
            type="button"
            onClick={() => onAnswer?.(opt)}
            className="press ring-focus flex items-center gap-2.5 rounded-xl border border-line bg-paper px-3 py-2 text-left text-[13px] text-ink transition-colors hover:bg-state-hover"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-[10px] font-medium text-ink-muted">
              {String.fromCharCode(65 + i)}
            </span>
            <span className="flex-1">{opt}</span>
          </button>
        ))}

        {/* Free-text answer — part of the list, not a separate view */}
        <div
          className="flex items-center gap-2.5 rounded-xl border border-line bg-paper px-3 py-2 transition-colors focus-within:border-line-strong"
          data-no-drag
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-ink-muted">
            <PenLine className="h-3 w-3" />
          </span>
          <input
            type="text"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitOther();
              }
            }}
            placeholder="Other — type your own answer…"
            className="flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="button"
            onClick={submitOther}
            disabled={!otherText.trim()}
            className="press ring-focus shrink-0 rounded-lg bg-ink px-2.5 py-1 text-[12px] font-semibold text-paper hover:bg-ink/90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Permission card — "zWork needs your OK" plus the reason, with Allow / Don't allow
 * and an always-present "tell zWork what to do instead" text row below them.
 * Always visible (no collapsed state) so the user sees it immediately.
 */
function PermissionCardBody({
  reason,
  onResolve,
}: {
  reason: string;
  onResolve?: (allow: boolean, otherText?: string) => void;
}) {
  const [otherText, setOtherText] = useState("");

  const submitOther = () => {
    if (otherText.trim()) onResolve?.(false, otherText.trim());
  };

  return (
    <div className="flex flex-col gap-3" data-no-drag>
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="flex-1">
          <p className="text-[13px] font-medium text-ink">zWork needs your OK</p>
          {reason && (
            <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">{reason}</p>
          )}
        </div>
      </div>
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

        {/* Free-text override — part of the same list, never a separate view */}
        <div
          className="flex items-center gap-2.5 rounded-xl border border-line bg-paper px-3 py-2 transition-colors focus-within:border-line-strong"
          data-no-drag
        >
          <MessageSquarePlus className="h-4 w-4 shrink-0 text-ink-muted" />
          <input
            type="text"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitOther();
              }
            }}
            placeholder="Tell zWork what to do instead…"
            className="flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="button"
            onClick={submitOther}
            disabled={!otherText.trim()}
            className="press ring-focus shrink-0 rounded-lg bg-ink px-2.5 py-1 text-[12px] font-semibold text-paper hover:bg-ink/90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
