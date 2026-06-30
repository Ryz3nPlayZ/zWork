import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  Paperclip,
  Lock,
  Unlock,
  Square,
  X,
  FileText,
  Image as ImageIcon,
  Upload,
  Globe,
  Plus,
  MessageSquarePlus,
} from "lucide-react";
import { cn } from "../lib/cn";
import { needsLightweightRendering } from "../lib/platform";
import { useApp } from "../lib/store";
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
  const [documentMode, setDocumentMode] = useState(false);
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
  const [multiline, setMultiline] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isOverlay = variant === "overlay";

  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const focusChatInput = useApp((s) => s.focusChatInput);
  const openSettings = useApp((s) => s.openSettings);
  const autoApproveDestructive = useApp((s) => s.autoApproveDestructive);
  const setAutoApproveDestructive = useApp((s) => s.setAutoApproveDestructive);
  const webSearchEnabled = useApp((s) => s.webSearchEnabled);
  const setWebSearchEnabled = useApp((s) => s.setWebSearchEnabled);
  const openLanding = useApp((s) => s.openLanding);
  const working = useApp((s) => {
    const id = s.activeChatId;
    return id ? (s.chats[id]?.working ?? false) : false;
  });
  const model = useApp((s) => s.model);
  const providers = useApp((s) => s.providers);
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
    if (isOverlay && onHeightChange) {
      const bar = toolsRef.current;
      if (bar) onHeightChange(bar.scrollHeight);
    }
  }, [value, isOverlay, onHeightChange, setMultiline]);

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

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

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !working && !uploading;

  const readAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
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

    const dataUrl = await readAsDataUrl(file);
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
      artifactMode: documentMode,
      planMode: false,
      autoApproveDestructive,
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

  // Drag the overlay window by grabbing the chatbar (not the textarea/buttons).
  // `.titlebar-drag` / `-webkit-app-region` is an Electron-ism WKWebView ignores,
  // so we drive the drag explicitly via the Tauri window API.
  const onBarMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!isOverlay || e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("textarea, input, button, a, select, [data-no-drag]")) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().startDragging().catch(() => {});
    });
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
        openSettings("memory");
      }}
    />
  );

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
        onMouseDown={isOverlay ? onBarMouseDown : undefined}
        className={cn(
          "group relative w-full border border-line bg-paper-raised transition-[border-color,box-shadow]",
          isOverlay
            ? cn(
                "titlebar-drag flex items-center gap-1 px-2 py-2 shadow-float",
                (multiline || attachments.length > 0) ? "rounded-2xl" : "rounded-full",
                focused && "border-line-strong",
              )
            : cn("rounded-2xl", focused ? "border-line-strong shadow-pop" : "shadow-chat"),
          dragOver && "border-ink/30 border-dashed",
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
            className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[14.5px] leading-6 text-ink placeholder:text-ink-faint focus:outline-none"
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
          <div className="flex items-center gap-1">
            <IconButton
              icon={<Paperclip />}
              label="Attach file"
              tooltipSide="top"
              variant="ghost"
              size="md"
              onClick={() => fileInputRef.current?.click()}
            />
            <IconButton
              icon={<FileText className="h-4 w-4" />}
              label={documentMode ? "Document: on" : "Document"}
              tooltipSide="top"
              variant="ghost"
              size="md"
              active={documentMode}
              onClick={() => setDocumentMode((v) => !v)}
            />
            <IconButton
              icon={autoApproveDestructive ? <Unlock className="text-ink" /> : <Lock className="text-ink-muted" />}
              label={autoApproveDestructive ? "Auto-approve: on" : "Auto-approve: off"}
              tooltipSide="top"
              variant="ghost"
              size="md"
              active={autoApproveDestructive}
              onClick={() => setAutoApproveDestructive(!autoApproveDestructive)}
            />
            <IconButton
              icon={<Globe className="h-4 w-4" />}
              label={webSearchEnabled ? "Web Search: on" : "Web Search: off"}
              tooltipSide="top"
              variant="ghost"
              size="md"
              active={webSearchEnabled}
              onClick={() => setWebSearchEnabled(!webSearchEnabled)}
            />
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
        <div data-no-drag className="absolute bottom-full left-0 mb-2 w-56 animate-fade-in rounded-2xl border border-line bg-paper p-1.5 shadow-pop">
          <OverlayToolItem
            icon={<Paperclip className="h-4 w-4" />}
            label="Attach file"
            onClick={() => {
              setToolsOpen(false);
              fileInputRef.current?.click();
            }}
          />
          <OverlayToolItem
            icon={<FileText className="h-4 w-4" />}
            label={documentMode ? "Document: on" : "Document"}
            active={documentMode}
            onClick={() => setDocumentMode((v) => !v)}
          />
          <OverlayToolItem
            icon={autoApproveDestructive ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            label={autoApproveDestructive ? "Auto-approve: on" : "Auto-approve: off"}
            active={autoApproveDestructive}
            onClick={() => setAutoApproveDestructive(!autoApproveDestructive)}
          />
          <OverlayToolItem
            icon={<Globe className="h-4 w-4" />}
            label={webSearchEnabled ? "Web search: on" : "Web search: off"}
            active={webSearchEnabled}
            onClick={() => setWebSearchEnabled(!webSearchEnabled)}
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
