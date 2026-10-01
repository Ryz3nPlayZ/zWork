import { useEffect, useRef, useState, useCallback } from "react";
import { Pencil, Check, X, AlertCircle, Settings as SettingsIcon, RefreshCcw, Download, ChevronDown, ArrowLeft, NotebookPen, History } from "lucide-react";
import { useApp } from "../lib/store";
import { api } from "../lib/api";
import { ChatInput } from "./ChatInput";
import { Message } from "./Message";
import { ConcurrentWorkBanner } from "./ConcurrentWorkBanner";
import { TodoPanel } from "./TodoPanel";
import { dragRegionAttrs, onDragMouseDown } from "../lib/drag";

/** Chat-wide token/cost totals summed from per-message usage, when any exists. */
function chatUsageSummary(messages: { usage?: { input: number; output: number; totalTokens: number; costUsd?: number } }[]) {
  let has = false;
  const sum = { input: 0, output: 0, costUsd: 0 };
  for (const m of messages) {
    if (!m.usage) continue;
    has = true;
    sum.input += m.usage.input;
    sum.output += m.usage.output;
    sum.costUsd += m.usage.costUsd ?? 0;
  }
  return has ? sum : null;
}

import { isMacOS, usesIntegratedTitleBar } from "../lib/platform";
import { downloadChatJson, downloadChatMarkdown } from "../lib/chatExport";
import { cn } from "../lib/cn";

export function ChatView() {
  const chat = useApp((s) =>
    s.activeChatId ? s.chats[s.activeChatId] : undefined,
  );
  const rename = useApp((s) => s.renameChat);
  const retry = useApp((s) => s.retry);
  const setView = useApp((s) => s.setView);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const artifacts = useApp((s) => s.artifacts);
  const openArtifact = useApp((s) => s.openArtifact);
  const regenerateMessage = useApp((s) => s.regenerateMessage);
  const forkFromMessage = useApp((s) => s.forkFromMessage);
  const flagBadResponse = useApp((s) => s.flagBadResponse);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const resolveGate = useApp((s) => s.resolveGate);
  const planMode = useApp((s) => s.planMode);
  const endRef = useRef<HTMLDivElement>(null);

  // Detect the active permission gate — scan the chat's messages for the most
  // recent tool part with a pendingGate. This drives the composer's "permission"
  // mode so the user sees the allow/deny card inline where the chatbox was.
  const activeGate = (() => {
    if (!chat) return null;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i];
      if (msg.role !== "assistant") continue;
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j];
        if (part.kind === "tool" && part.pendingGate) {
          return { messageId: msg.id, gateId: part.pendingGate.gateId, reason: part.pendingGate.reason };
        }
      }
    }
    return null;
  })();

  // The composer mode: question card takes priority over permission card,
  // both take priority over the default chatbox.
  const composerMode: "default" | "question" | "permission" = chat?.pendingQuestion
    ? "question"
    : activeGate
      ? "permission"
      : "default";

  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branches, setBranches] = useState<
    { id: string; created_at: number; message_count: number; preview: string }[]
  >([]);
  const restoreBranch = useApp((s) => s.restoreBranch);
  const deleteBranch = useApp((s) => s.deleteBranch);
  const openBranchPicker = () => {
    if (!chat) return;
    setBranchOpen((v) => !v);
    if (!branchOpen) {
      api.listBranches(chat.id).then((r) => setBranches(r.branches ?? [])).catch(() => setBranches([]));
    }
  };
  const exportRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!branchOpen) return;
    const close = (e: MouseEvent) => {
      if (!branchRef.current?.contains(e.target as Node)) setBranchOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setBranchOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [branchOpen]);

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
    downloadChatMarkdown(chat);
  };

  const exportToJSON = () => {
    if (!chat) return;
    downloadChatJson(chat);
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
      <div className="flex flex-1 flex-col overflow-hidden relative">
        {/* Sticky todo/progress card — floats over the top-right of the chat.
            Scrolling the messages doesn't move it. Collapsible. */}
        <TodoPanel />
        {/*
          Floating chat header — title + export live on their own layer at the
          true top of the chat (the pane drops its own drag band for the
          active-chat view so this can sit there instead — no empty gap above
          it). THIS LAYER IS THE DRAG REGION: empty header background
          initiates a window drag (pane-side dragging stops here for chats),
          while interactive children (title, export, back) are excluded by
          onDragMouseDown's closest() walk. A paper→transparent gradient lets
          messages scroll under the title gracefully.

          Windows replaces this header with the slim spacer below — the
          integrated title bar (TitleBar.tsx) owns the title + metadata up in
          the window chrome, so the pane doesn't repeat it.
        */}
        {usesIntegratedTitleBar() ? (
          <div
            {...dragRegionAttrs()}
            onMouseDown={onDragMouseDown}
            className="absolute inset-x-0 top-0 z-20 h-[38px] bg-gradient-to-b from-paper via-paper/95 to-transparent"
            aria-hidden="true"
          />
        ) : (
        <div
          {...dragRegionAttrs()}
          onMouseDown={onDragMouseDown}
          className={cn(
            "absolute inset-x-0 top-0 z-20 flex items-center justify-between py-2.5 pr-5 bg-gradient-to-b from-paper via-paper/95 to-transparent",
            // When the sidebar is collapsed, the main pane slides left and the
            // chat title would slide under the window-level controls (search +
            // sidebar toggle). Reserve a left gutter matching those controls
            // so the title stays clear. On macOS the controls sit at ~84px to
            // clear the traffic lights; elsewhere they hug the corner at ~10px.
            sidebarOpen
              ? "pl-5"
              : isMacOS()
                ? "pl-[96px]"
                : "pl-[52px]",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {chat.projectId && (
              <button
                type="button"
                onClick={() => {
                  setActiveProject(chat.projectId!);
                  setView("projects");
                }}
                className="press inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
                title="Back to project"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
            )}
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
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap" data-no-drag>
            {(() => {
              // Only a cost means anything to a non-developer; token counts
              // stay in the tooltip.
              const u = chatUsageSummary(chat.messages);
              if (!u || u.costUsd <= 0 || chat.artifactPanelOpen) return null;
              return (
                <span
                  className="text-[11px] text-ink-faint tabular-nums mr-1"
                  title={`${u.input.toLocaleString()} tokens in / ${u.output.toLocaleString()} out`}
                >
                  ${u.costUsd.toFixed(u.costUsd < 1 ? 3 : 2)} used
                </span>
              );
            })()}
            <div ref={branchRef} className="relative">
              <button
                type="button"
                onClick={openBranchPicker}
                className="press inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-[11px] font-medium text-ink hover:bg-paper-sunken"
                title="Earlier versions of this chat"
              >
                <History className="h-3 w-3" />
                <span>Versions</span>
              </button>
              {branchOpen && (
                <div className="absolute top-[calc(100%+4px)] right-0 z-40 w-[280px] animate-fade-in whitespace-normal rounded-lg border border-line bg-paper p-1 shadow-pop">
                  {branches.length === 0 && (
                    <div className="px-2.5 py-2 text-[12px] leading-relaxed text-ink-muted">
                      Nothing here yet. When you edit a message you already sent, the replies that came after it are kept here so you can bring them back.
                    </div>
                  )}
                  {branches.map((b) => (
                    <div key={b.id} className="flex items-center gap-1 rounded px-2.5 py-1.5 hover:bg-paper-sunken">
                      <button
                        type="button"
                        onClick={async () => {
                          setBranchOpen(false);
                          await restoreBranch(b.id);
                        }}
                        className="min-w-0 flex-1 text-left"
                        title="Bring this version back"
                      >
                        <div className="truncate text-[12px] font-medium text-ink">
                          {b.message_count} message{b.message_count === 1 ? "" : "s"} — {b.preview || "(empty)"}
                        </div>
                        <div className="text-[10px] text-ink-faint">{new Date(b.created_at).toLocaleString()}</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setBranches((prev) => prev.filter((x) => x.id !== b.id));
                          deleteBranch(b.id);
                        }}
                        className="press rounded p-1 text-ink-faint hover:text-error"
                        title="Delete this version"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto pb-44">
          <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-6 pt-14 pb-8">
            {/* Plan mode indicator — shows when plan mode is active so the user
                knows the agent is restricted to read-only tools. */}
            {planMode && (
              <div className="flex items-center gap-2 rounded-xl border border-accent/20 bg-accent/5 px-3 py-2 text-[12px] text-ink-muted">
                <NotebookPen className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span>Plan first is on — zWork will look into it and suggest a plan without changing anything. Switch it in the menu below the message box.</span>
              </div>
            )}
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
                  onOpenArtifact={handleOpenArtifact}
                  artifacts={artifacts}
                  streaming={isStreaming}
                  activities={activities}
                  status={isStreaming ? chat.status : undefined}
                  onRetry={regenerateMessage}
                  onBadResponse={flagBadResponse}
                  onFork={forkFromMessage}
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

        {/* Composer — floating directly over the chat text. When the agent asks
            a question or needs permission, the composer morphs into an inline
            card (question/permission mode) instead of showing the textarea. */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-paper via-paper/95 to-transparent px-6 pb-5 pt-10 pointer-events-none z-10">
          <div className="mx-auto max-w-[960px] pointer-events-auto">
            <ChatInput
              autoFocus
              placeholder="Reply to zWork"
              mode={composerMode}
              question={chat.pendingQuestion ? { question: chat.pendingQuestion.question, options: chat.pendingQuestion.options } : undefined}
              permission={activeGate ? { reason: activeGate.reason } : undefined}
              onAnswerQuestion={(answer) => void useApp.getState().answerQuestion(chat.id, answer)}
              onResolvePermission={(allow, otherText) => {
                if (activeGate) {
                  void resolveGate(chat.id, activeGate.messageId, activeGate.gateId, allow);
                  // Deny-with-instruction: deliver the typed text to the agent
                  // as the next user message so it isn't silently dropped.
                  if (!allow && otherText?.trim()) {
                    void useApp.getState().send(otherText.trim());
                  }
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
