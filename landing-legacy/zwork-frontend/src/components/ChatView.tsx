import { useEffect, useRef, useState, useCallback } from "react";
import { Pencil, Check, X, AlertCircle, Settings as SettingsIcon, RefreshCcw } from "lucide-react";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { isMacOS } from "../lib/platform";
import { ChatInput } from "./ChatInput";
import { Message } from "./Message";
import { IconButton } from "./IconButton";
import { ConcurrentWorkBanner } from "./ConcurrentWorkBanner";

export function ChatView() {
  const macOS = isMacOS();
  const chat = useApp((s) =>
    s.activeChatId ? s.chats[s.activeChatId] : undefined,
  );
  const rename = useApp((s) => s.renameChat);
  const send = useApp((s) => s.send);
  const retry = useApp((s) => s.retry);
  const setView = useApp((s) => s.setView);
  const artifacts = useApp((s) => s.artifacts);
  const openArtifact = useApp((s) => s.openArtifact);
  const endRef = useRef<HTMLDivElement>(null);

  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat?.messages.length, chat?.working, chat?.status]);

  const handleOpenArtifact = useCallback(
    (artifact: Parameters<typeof openArtifact>[0]) => {
      openArtifact(artifact);
    },
    [openArtifact],
  );

  const handleAskSubmit = useCallback(
    (_msgId: string, choice: string) => {
      void send(choice);
    },
    [send],
  );

  if (!chat) return null;

  const commitRename = () => {
    const t = titleDraft.trim();
    setEditing(false);
    if (t && t !== chat.title && !chat.id.startsWith("tmp_")) {
      void rename(chat.id, t);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 bg-paper">
      {/* Main chat column */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className={cn(macOS && "titlebar-drag", "flex h-12 shrink-0 items-center justify-between border-b border-line px-4")}>
          <div className="min-w-0 flex items-center gap-2" data-no-drag>
            {editing ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditing(false);
                  }}
                  className="w-[280px] rounded-md border border-line-strong bg-paper px-2 py-1 text-[13px] text-ink focus:outline-none"
                />
                <IconButton icon={<Check />} label="Save" size="sm" onClick={commitRename} />
                <IconButton icon={<X />} label="Cancel" size="sm" onClick={() => setEditing(false)} />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(chat.title);
                  setEditing(true);
                }}
                className="press group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-paper-sunken"
                title="Rename chat"
              >
                <span className="truncate text-[13px] font-medium text-ink">
                  {chat.title}
                </span>
                <Pencil className="h-3 w-3 opacity-0 text-ink-faint transition-opacity group-hover:opacity-100" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1" data-no-drag>
            <span className="text-[10.5px] text-ink-faint font-mono">
              {chat.messages.length} msgs
            </span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-6 py-8">
            <ConcurrentWorkBanner />
            {chat.messages.map((m, idx) => {
              const isLast = idx === chat.messages.length - 1;
              const isStreaming = !!chat.working && isLast;
              const activities = isStreaming && m.role === "assistant"
                ? chat.activities
                : m.activities;
              return (
                <Message
                  key={m.id}
                  message={m}
                  onAskSubmit={handleAskSubmit}
                  onOpenArtifact={handleOpenArtifact}
                  artifacts={artifacts}
                  streaming={isStreaming}
                  activities={activities}
                  status={isStreaming ? chat.status : undefined}
                />
              );
            })}
            {chat.error && (
              <div className="flex animate-fade-in items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-words">{chat.error}</span>
              </div>
            )}
            {chat.needsSetup && !chat.working && (
              <div className="flex animate-fade-in items-center gap-2 rounded-lg border border-line bg-paper-sunken px-3 py-2">
                <button
                  type="button"
                  onClick={() => setView("settings")}
                  className="press inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[12.5px] font-medium text-ink hover:bg-paper-sunken"
                >
                  <SettingsIcon className="h-3.5 w-3.5" /> Open Settings
                </button>
                <button
                  type="button"
                  onClick={() => void retry()}
                  className="press inline-flex items-center gap-1.5 rounded-md border border-line bg-paper-sunken px-2.5 py-1 text-[12.5px] font-medium text-ink hover:bg-paper hover:border-line-strong"
                >
                  <RefreshCcw className="h-3.5 w-3.5" /> Retry
                </button>
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>

        {/* Composer — no top border, just padding */}
        <div className="shrink-0 bg-paper px-6 pb-5 pt-3">
          <div className="mx-auto max-w-[960px]">
            <ChatInput autoFocus placeholder="Reply to zWork" />
            <p className="mt-2 text-center text-[11px] text-ink-faint">
              zWork can take actions on your computer. Review before approving.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
