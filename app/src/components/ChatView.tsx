import { useEffect, useRef, useState, useCallback } from "react";
import { Pencil, Check, X, AlertCircle, Settings as SettingsIcon, RefreshCcw, Download, ChevronDown } from "lucide-react";
import { useApp } from "../lib/store";
import { isMacOS } from "../lib/platform";
import { ChatInput } from "./ChatInput";
import { Message } from "./Message";
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
  const regenerateMessage = useApp((s) => s.regenerateMessage);
  const flagBadResponse = useApp((s) => s.flagBadResponse);
  const endRef = useRef<HTMLDivElement>(null);

  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setExportOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [exportOpen]);

  const exportToMarkdown = () => {
    if (!chat) return;
    const markdown = chat.messages
      .map((m) => `### ${m.role === "user" ? "User" : "Assistant"}\n\n${m.content}\n`)
      .join("\n---\n\n");
    
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${chat.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "chat"}.md`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportToJSON = () => {
    if (!chat) return;
    const jsonString = JSON.stringify(chat.messages, null, 2);
    const blob = new Blob([jsonString], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${chat.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "chat"}.json`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  useEffect(() => {
    const el = endRef.current;
    if (!el) return;
    const container = el.parentElement;
    if (!container) return;
    const scrollEl = container.parentElement as HTMLElement | null;
    if (!scrollEl) return;
    const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    if (distance <= 0) return;
    if (distance < 300) {
      scrollEl.scrollBy({ top: distance, behavior: "smooth" });
    } else {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "instant" });
    }
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
    if (!t) return;
    rename(chat.id, t);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setEditing(false);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-paper relative">
      {/* Drag-only titlebar */}
      {macOS && <div className="titlebar-drag absolute inset-x-0 top-0 h-10 shrink-0" />}

      <div className="flex flex-1 flex-col overflow-hidden relative">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3 bg-paper-soft select-none">
          <div className="flex min-w-0 items-center gap-2">
            {editing ? (
              <div className="flex items-center gap-1" data-no-drag>
                <input
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="rounded border border-line bg-paper px-2 py-0.5 text-[13px] text-ink focus:outline-none"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={commitRename}
                  className="rounded p-0.5 text-ink-muted hover:bg-paper-sunken hover:text-ink"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded p-0.5 text-ink-muted hover:bg-paper-sunken hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
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
          <div className="flex items-center gap-2" data-no-drag>
            <span className="text-[10.5px] text-ink-faint font-mono mr-1">
              {chat.messages.length} msgs
            </span>
            <div ref={exportRef} className="relative">
              <button
                type="button"
                onClick={() => setExportOpen((v) => !v)}
                className="press inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-[11px] font-medium text-ink hover:bg-paper-sunken"
                title="Export chat history"
              >
                <Download className="h-3 w-3" />
                <span>Export</span>
                <ChevronDown className="h-3 w-3 text-ink-muted" />
              </button>
              {exportOpen && (
                <div className="absolute top-[calc(100%+4px)] right-0 z-40 w-[170px] animate-fade-in rounded-lg border border-line bg-paper p-1 shadow-pop">
                  <button
                    type="button"
                    onClick={() => {
                      exportToMarkdown();
                      setExportOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-paper-sunken font-medium transition-colors"
                  >
                    Export as Markdown (.md)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      exportToJSON();
                      setExportOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-paper-sunken font-medium transition-colors"
                  >
                    Export as JSON (.json)
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto pb-44">
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
                  onRetry={regenerateMessage}
                  onBadResponse={flagBadResponse}
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

        {/* Composer — floating directly over the chat text */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-paper via-paper/95 to-transparent px-6 pb-5 pt-10 pointer-events-none z-10">
          <div className="mx-auto max-w-[960px] pointer-events-auto">
            {chat.pendingQuestion && (
              <div className="mb-3 rounded-xl border border-line bg-paper-raised p-4 shadow-pop flex flex-col gap-2.5 animate-scale-up">
                <div className="flex items-start gap-2">
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent mt-0.5">
                    <span className="text-[11px] font-bold">?</span>
                  </div>
                  <div>
                    <h4 className="text-[13px] font-semibold text-ink leading-tight">
                      Clarification Required
                    </h4>
                    <p className="text-[12px] text-ink-muted mt-1 leading-normal">
                      {chat.pendingQuestion.question}
                    </p>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-2 mt-1">
                  {chat.pendingQuestion.options.map((opt, oIdx) => (
                    <button
                      key={oIdx}
                      onClick={() => {
                        const optLower = opt.toLowerCase();
                        if (optLower.includes("other") || optLower.includes("instead")) {
                          document.querySelector("textarea")?.focus();
                        } else {
                          void useApp.getState().answerQuestion(chat.id, opt);
                        }
                      }}
                      className="text-left px-3 py-2 rounded-lg border border-line bg-paper hover:bg-paper-sunken hover:border-line-strong text-[12px] text-ink-muted hover:text-ink transition-colors font-medium cursor-pointer"
                    >
                      <span className="text-ink-faint mr-1.5 font-mono">{oIdx + 1}.</span>
                      {opt}
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      document.querySelector("textarea")?.focus();
                    }}
                    className="text-left px-3 py-2 rounded-lg border border-dashed border-line bg-paper hover:bg-paper-sunken hover:border-line-strong text-[12px] text-accent hover:text-accent-hover transition-colors font-medium cursor-pointer"
                  >
                    <span className="text-accent/60 mr-1.5 font-mono">*</span>
                    Other (type below...)
                  </button>
                </div>
              </div>
            )}

            <ChatInput autoFocus placeholder="Reply to zWork" />
          </div>
        </div>
      </div>
    </div>
  );
}
