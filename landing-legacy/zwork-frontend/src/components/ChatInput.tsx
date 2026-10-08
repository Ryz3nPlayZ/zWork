import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowUp,
  Eye,
  EyeOff,
  Globe,
  Layers3,
  Paperclip,
  Shield,
  ShieldAlert,
  Square,
  X,
  FileText,
  Image as ImageIcon,
  Upload,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { api, type UploadedFile } from "../lib/api";
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
}

interface Props {
  placeholder?: string;
  autoFocus?: boolean;
  onSend?: (text: string) => void;
}

export function ChatInput({ placeholder = "Send a message", autoFocus, onSend }: Props) {
  const [value, setValue] = useState("");
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
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const webSearch = useApp((s) => s.webSearch);
  const toggleWeb = useApp((s) => s.toggleWeb);
  const focusChatInput = useApp((s) => s.focusChatInput);
  const openSettings = useApp((s) => s.openSettings);
  const planMode = useApp((s) => s.planMode);
  const setPlanMode = useApp((s) => s.setPlanMode);
  const autoApproveDestructive = useApp((s) => s.autoApproveDestructive);
  const setAutoApproveDestructive = useApp((s) => s.setAutoApproveDestructive);
  const working = useApp((s) => {
    const id = s.activeChatId;
    return id ? (s.chats[id]?.working ?? false) : false;
  });

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
  }, [value]);

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

  const canSend = value.trim().length > 0 && !working && !uploading;

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

    return {
      payload: { ...base, data_url: await readAsDataUrl(file) },
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
      setAttachments((prev) => [
        ...prev,
        ...prepared.map((item) => ({
          id: item.id,
          name: item.file.name || `upload-${item.id}`,
          mime: item.file.type || "application/octet-stream",
          kind: item.kind as "file" | "image",
          size: item.size,
          previewUrl: item.previewUrl,
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
    setValue("");
    for (const a of attachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    setAttachments([]);
    setSlashState(null);
    onSend?.(text);
    void send(text, {
      artifactMode,
      planMode,
      autoApproveDestructive,
      attachments: attachments
        .filter((a): a is ComposerAttachment & { uploadedPath: string } => !!a.uploadedPath)
        .map((a) => ({
          client_id: a.id,
          name: a.name,
          path: a.uploadedPath,
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

  return (
    <>
      {/* Full-viewport drop overlay when dragging files */}
      {dragOver && (
        <div
          className="fixed inset-0 z-[500] flex items-center justify-center bg-ink/10 backdrop-blur-sm animate-fade-in"
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
      className={cn(
        "group relative w-full rounded-2xl border border-line bg-paper-raised transition-[border-color,box-shadow]",
        focused ? "border-line-strong shadow-pop" : "shadow-chat",
        dragOver && "border-ink/30 border-dashed",
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
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 rounded-full border border-line bg-paper px-2.5 py-1 text-[11.5px] text-ink-muted"
            >
              {a.kind === "image" ? (
                <ImageIcon className="h-3.5 w-3.5" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
              <span className="max-w-[180px] truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => {
                  if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
                  setAttachments((prev) => prev.filter((x) => x.id !== a.id));
                }}
                className="rounded-full p-0.5 text-ink-faint hover:bg-line/60 hover:text-ink"
                aria-label={`Remove ${a.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {slashOpen && slashState && (
        <SlashMenu
          templates={templates}
          query={slashState.query}
          activeIndex={slashIndex}
          onActiveIndexChange={setSlashIndex}
          onSelect={insertTemplate}
          onManage={() => {
            setSlashState(null);
            openSettings("personalization");
          }}
        />
      )}
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
        className={cn(
          "block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[14.5px] leading-6 text-ink placeholder:text-ink-faint",
          "focus:outline-none",
        )}
      />
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
            icon={<Layers3 />}
            label={artifactMode ? "Artifacts: on" : "Artifacts: off"}
            tooltipSide="top"
            variant="ghost"
            size="md"
            active={artifactMode}
            onClick={() => setArtifactMode((v) => !v)}
          />
          <IconButton
            icon={<Globe />}
            label={webSearch ? "Web search: on" : "Web search"}
            tooltipSide="top"
            variant="ghost"
            size="md"
            active={webSearch}
            onClick={toggleWeb}
          />
          <IconButton
            icon={planMode ? <Eye /> : <EyeOff />}
            label={planMode ? "Plan mode: on (read-only)" : "Plan mode: off"}
            tooltipSide="top"
            variant="ghost"
            size="md"
            active={planMode}
            onClick={() => setPlanMode(!planMode)}
          />
          <IconButton
            icon={autoApproveDestructive ? <ShieldAlert /> : <Shield />}
            label={autoApproveDestructive ? "Auto-approve destructive: on" : "Auto-approve destructive: off"}
            tooltipSide="top"
            variant="ghost"
            size="md"
            active={autoApproveDestructive}
            onClick={() => setAutoApproveDestructive(!autoApproveDestructive)}
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
        accept="image/*,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.py,.js,.jsx,.ts,.tsx,.html,.css,.xml,.svg,.pdf"
      />
    </div>
    </>
  );
}
