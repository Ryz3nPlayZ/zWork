import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Globe, Layers3, Paperclip, Square, X, FileText, Image as ImageIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { api, type UploadedFile } from "../lib/api";
import { IconButton } from "./IconButton";
import { ModelPicker } from "./ModelPicker";

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
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const webSearch = useApp((s) => s.webSearch);
  const toggleWeb = useApp((s) => s.toggleWeb);
  const focusChatInput = useApp((s) => s.focusChatInput);
  const working = useApp((s) => {
    const id = s.activeChatId;
    return id ? (s.chats[id]?.working ?? false) : false;
  });

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

  const submit = () => {
    if (!canSend) return;
    const text = value;
    setValue("");
    setAttachments([]);
    onSend?.(text);
    void send(text, {
      artifactMode,
      attachments: attachments
        .filter((a): a is ComposerAttachment & { uploadedPath: string } => !!a.uploadedPath)
        .map((a) => ({
          client_id: a.id,
          name: a.name,
          path: a.uploadedPath,
          mime: a.mime,
          kind: a.kind,
        })),
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    <div
      className={cn(
        "group relative w-full rounded-2xl border border-line bg-paper-raised transition-[border-color,box-shadow]",
        focused ? "border-line-strong shadow-pop" : "shadow-chat",
      )}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-line px-4 pt-3">
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
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                className="rounded-full p-0.5 text-ink-faint hover:bg-line/60 hover:text-ink"
                aria-label={`Remove ${a.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={areaRef}
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={working}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
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
  );
}
