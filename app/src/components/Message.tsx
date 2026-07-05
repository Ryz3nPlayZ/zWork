/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */

import { useState, useCallback, useEffect, useMemo } from "react";
import { THINKING_WORDS, shuffled } from "../lib/thinkingWords";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useResolvedTheme } from "../lib/theme";
import {
  Copy,
  Check as CheckIcon,
  RefreshCcw,
  ThumbsDown,
  ChevronDown,
  Code2,
  FileText,
  Table2,
  BarChart3,
  Globe,
  GitCompare,
  Image as ImageIcon,
  Edit2,
  Send,
  X as XIcon,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import { cn } from "../lib/cn";
import { getIcon } from "./ActivityBlocks";
import type { Activity, Artifact, MessagePart } from "../lib/store";
import { useApp } from "../lib/store";
import { Logo } from "./Logo";
import { IconButton } from "./IconButton";
import { AskCard, splitAroundAsk, parseAskPayload } from "./AskCard";
import type { Message as Msg } from "../lib/store";
import { api } from "../lib/api";

function formatTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---- Code block with copy, preview tabs, and running capabilities ----
function CodeBlock({
  language,
  code,
  onOpenPanel,
}: {
  language: string;
  code: string;
  onOpenPanel?: (code: string, lang: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<"code" | "preview">("code");
  const [runOutput, setRunOutput] = useState<{ stdout: string; stderr: string } | null>(null);
  const [running, setRunning] = useState(false);
  // Pick the syntax theme for the live (resolved) color scheme so code blocks
  // flip with dark mode instead of staying pinned to oneLight.
  const resolvedTheme = useResolvedTheme();
  const syntaxStyle = resolvedTheme === "dark" ? oneDark : oneLight;

  const copy = useCallback(() => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [code]);

  const langLower = (language || "").toLowerCase();
  const isPreviewable = ["html", "svg"].includes(langLower);
  const isExecutable = ["javascript", "js", "python", "py"].includes(langLower);
  const hasPreviewTab = isPreviewable || isExecutable;

  const runCode = async () => {
    setRunning(true);
    setRunOutput(null);
    if (langLower === "python" || langLower === "py") {
      try {
        const res = await api.runPythonCode(code);
        setRunOutput(res);
      } catch (e: any) {
        setRunOutput({ stdout: "", stderr: e.message || "Failed to execute Python code" });
      }
    } else if (langLower === "javascript" || langLower === "js") {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.map(x => typeof x === "object" ? JSON.stringify(x) : String(x)).join(" "));
      };
      try {
        const result = new Function(code)();
        if (result !== undefined) {
          logs.push(`Returned: ${typeof result === "object" ? JSON.stringify(result) : String(result)}`);
        }
        setRunOutput({ stdout: logs.join("\n"), stderr: "" });
      } catch (e: any) {
        setRunOutput({ stdout: logs.join("\n"), stderr: e.message || "Runtime Error" });
      } finally {
        console.log = originalLog;
      }
    }
    setRunning(false);
  };

  return (
    <div className="group/code relative my-2 rounded-xl border border-line overflow-hidden">
      <div className="flex items-center justify-between bg-paper-sunken px-3 py-1 border-b border-line">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-ink-faint uppercase">{language || "code"}</span>
          {hasPreviewTab && (
            <div className="flex border-l border-line pl-2 gap-1">
              <button
                type="button"
                onClick={() => setActiveTab("code")}
                className={cn(
                  "px-2 py-0.5 rounded text-[10.5px] font-medium transition-colors cursor-pointer",
                  activeTab === "code"
                    ? "bg-accent/10 text-accent"
                    : "text-ink-muted hover:bg-paper hover:text-ink"
                )}
              >
                Code
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab("preview");
                  if (isExecutable && !runOutput) {
                    void runCode();
                  }
                }}
                className={cn(
                  "px-2 py-0.5 rounded text-[10.5px] font-medium transition-colors cursor-pointer",
                  activeTab === "preview"
                    ? "bg-accent/10 text-accent"
                    : "text-ink-muted hover:bg-paper hover:text-ink"
                )}
              >
                {isPreviewable ? "Preview" : "Run Output"}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenPanel && (
            <button
              type="button"
              onClick={() => onOpenPanel(code, language)}
              aria-label="Open code in panel"
              className="press rounded border border-line bg-paper px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-paper-sunken hover:text-ink cursor-pointer"
            >
              Open
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            aria-label="Copy code"
            className="press rounded p-1 text-ink-muted hover:bg-paper hover:text-ink cursor-pointer"
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {activeTab === "code" ? (
        <SyntaxHighlighter
          language={language || "text"}
          style={syntaxStyle as Record<string, React.CSSProperties>}
          customStyle={{
            margin: 0,
            borderRadius: 0,
            fontSize: "12.5px",
            background: "transparent",
            padding: "12px 16px",
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono, monospace)" } }}
        >
          {code}
        </SyntaxHighlighter>
      ) : (
        <div className="bg-paper p-4 overflow-auto min-h-[150px] max-h-[400px]">
          {isPreviewable ? (
            <iframe
              srcDoc={
                langLower === "svg"
                  ? `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;">${code}</body></html>`
                  : code
              }
              title="HTML Sandbox"
              sandbox="allow-scripts"
              className="w-full h-[250px] border-0 bg-paper rounded-lg"
            />
          ) : (
            <div className="font-mono text-[12px] whitespace-pre-wrap leading-relaxed">
              {running ? (
                <div className="flex items-center gap-2 text-ink-muted animate-pulse">
                  <span className="h-2 w-2 rounded-full bg-accent animate-ping" />
                  Running script...
                </div>
              ) : (
                <div className="space-y-2">
                  {isExecutable && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={runCode}
                        className="rounded bg-accent/10 hover:bg-accent/20 text-accent px-2 py-1 text-[11px] font-medium cursor-pointer"
                      >
                        Re-run
                      </button>
                    </div>
                  )}
                  {runOutput?.stdout && (
                    <div className="text-ink-muted">
                      <div className="text-[10px] text-ink-faint font-semibold uppercase tracking-wider mb-1">STDOUT</div>
                      <div className="bg-paper-sunken p-2.5 rounded border border-line font-mono">{runOutput.stdout}</div>
                    </div>
                  )}
                  {runOutput?.stderr && (
                    <div className="text-error">
                      <div className="text-[10px] text-error font-semibold uppercase tracking-wider mb-1">STDERR</div>
                      <div className="bg-error/5 p-2.5 rounded border border-error/20 font-mono">{runOutput.stderr}</div>
                    </div>
                  )}
                  {!runOutput?.stdout && !runOutput?.stderr && (
                    <div className="text-ink-faint italic">Execution finished with no output.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Markdown renderer with KaTeX and code blocks ----
function AssistantMarkdown({
  content,
  onOpenPanel,
}: {
  content: string;
  onOpenPanel?: (code: string, lang: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const language = match ? match[1] : "";
          const codeStr = String(children).replace(/\n$/, "");
          // Detect block code (children will be multi-line or language is set)
          if (language || codeStr.includes("\n")) {
            return (
              <CodeBlock
                language={language}
                code={codeStr}
                onOpenPanel={onOpenPanel}
              />
            );
          }
          // Inline code
          return (
            <code className="rounded bg-paper-sunken px-1.5 py-0.5 text-[12px] font-mono text-ink" {...props}>
              {children}
            </code>
          );
        },
        pre({ children }) {
          return <>{children}</>;
        },
        p({ children }) {
          return <p className="mb-3 last:mb-0 leading-6">{children}</p>;
        },
        h1({ children }) {
          return <h1 className="mb-2 mt-4 text-[18px] font-bold text-ink">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="mb-2 mt-3 text-[15px] font-semibold text-ink">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="mb-1 mt-2 text-[13.5px] font-semibold text-ink">{children}</h3>;
        },
        ul({ children }) {
          return <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="mb-3 list-decimal space-y-1 pl-5">{children}</ol>;
        },
        li({ children }) {
          return <li className="leading-6">{children}</li>;
        },
        blockquote({ children }) {
          return (
            <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-muted italic">
              {children}
            </blockquote>
          );
        },
        table({ children }) {
          return (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          );
        },
        th({ children }) {
          return (
            <th className="border border-line bg-paper-sunken px-3 py-1.5 text-left font-semibold">
              {children}
            </th>
          );
        },
        td({ children }) {
          return <td className="border border-line px-3 py-1.5">{children}</td>;
        },
        a({ href, children }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-ink underline underline-offset-2 hover:opacity-70"
            >
              {children}
            </a>
          );
        },
        strong({ children }) {
          return <strong className="font-semibold text-ink">{children}</strong>;
        },
        hr() {
          return <hr className="my-4 border-line" />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ---- User message bubble with inline edit ----
function UserBubble({
  message,
  attachments,
  streaming,
}: {
  message: Msg;
  attachments: NonNullable<Msg["attachments"]>;
  streaming: boolean;
}) {
  const editAndResend = useApp((s) => s.editAndResend);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(message.content);
    setEditing(false);
  };

  const submit = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === message.content) { cancel(); return; }
    setEditing(false);
    void editAndResend(message.id, trimmed);
  };

  return (
    <div className="group flex w-full justify-end">
      <div className="max-w-[85%] min-w-0">
        {attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {attachments.map((a, i) => (
              <div
                key={`${message.id}-att-${i}`}
                className="flex items-center gap-2 rounded-full border border-line bg-paper px-2.5 py-1 text-[11.5px] text-ink-muted"
                title={a.name}
              >
                {a.kind === "image" && a.previewUrl ? (
                  <img src={a.previewUrl} alt="" className="h-4 w-4 rounded object-cover" />
                ) : a.kind === "image" ? (
                  <ImageIcon className="h-3.5 w-3.5" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                <span className="max-w-[180px] truncate">{a.name}</span>
              </div>
            ))}
          </div>
        )}

        {editing ? (
          <div className="flex flex-col gap-1.5">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
                if (e.key === "Escape") cancel();
              }}
              rows={Math.min(10, draft.split("\n").length + 1)}
              className="w-full resize-none rounded-2xl rounded-br-md border border-accent/50 bg-paper-raised px-3.5 py-2.5 text-[14px] leading-6 text-ink outline-none ring-2 ring-accent/20 focus:ring-accent/30"
            />
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={cancel}
                className="press flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-ink-muted hover:bg-paper-sunken"
              >
                <XIcon className="h-3 w-3" /> Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                className="press flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1 text-[11.5px] font-medium text-paper hover:bg-ink/80"
              >
                <Send className="h-3 w-3" /> Send
              </button>
            </div>
          </div>
        ) : (
          <div className="relative">
            <div className="rounded-2xl rounded-br-md bg-paper-raised border border-line px-3.5 py-2.5 text-[14px] leading-6 text-ink break-words whitespace-pre-wrap">
              {message.content}
            </div>
            {!streaming && (
              <button
                type="button"
                onClick={startEdit}
                title="Edit message"
                className="press absolute -left-8 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-ink-faint opacity-0 transition-opacity hover:bg-paper-sunken hover:text-ink group-hover:opacity-100"
              >
                <Edit2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        <p className="mt-1 text-right text-[10.5px] text-ink-faint">{formatTime(message.createdAt)}</p>
      </div>
    </div>
  );
}

type ProcessEntry =
  | { kind: "thinking"; part: Extract<MessagePart, { kind: "thinking" }>; i: number }
  | { kind: "tool"; part: Extract<MessagePart, { kind: "tool" }>; i: number };

/**
 * A compact, expandable panel that groups the model's internal process
 * (thinking blocks and tool calls) and sits above the actual assistant
 * message. This separates "what the model did" from "the message for the
 * user" instead of interleaving them inline.
 */
function ProcessPanel({
  parts,
  streaming,
  lastPartIdx,
  chatId,
  messageId,
}: {
  parts: MessagePart[];
  streaming?: boolean;
  lastPartIdx: number;
  chatId?: string;
  messageId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const processEntries = useMemo<ProcessEntry[]>(() => {
    const entries: ProcessEntry[] = [];
    parts.forEach((part, i) => {
      if (part.kind === "thinking") entries.push({ kind: "thinking", part, i });
      else if (part.kind === "tool") entries.push({ kind: "tool", part, i });
    });
    return entries;
  }, [parts]);

  useEffect(() => {
    if (!streaming || processEntries.length === 0) return;
    const latest = parts[lastPartIdx];
    if (latest && (latest.kind === "thinking" || (latest.kind === "tool" && !latest.done))) {
      setExpanded(true);
    }
  }, [streaming, processEntries.length, lastPartIdx, parts]);

  if (processEntries.length === 0) return null;

  const latest = processEntries[processEntries.length - 1];
  const isActive =
    streaming &&
    (latest.kind === "thinking" || (latest.kind === "tool" && !latest.part.done));

  const thoughtCount = processEntries.filter((e) => e.kind === "thinking").length;
  const toolCount = processEntries.filter((e) => e.kind === "tool").length;

  let summary: string;
  if (isActive) {
    summary = latest.kind === "thinking" ? "Thinking…" : `Running ${latest.part.label}…`;
  } else if (thoughtCount > 0 && toolCount > 0) {
    summary = `Thought · ${toolCount} tools`;
  } else if (thoughtCount > 0) {
    summary = "Thought";
  } else {
    summary = `${toolCount} tools`;
  }

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="press flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-ink-faint hover:text-ink-muted hover:bg-paper-sunken"
      >
        {isActive ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        )}
        <span>{summary}</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-1">
          {processEntries.map((entry) => {
            if (entry.kind === "thinking") {
              return <ThinkingBlock key={`thinking-${entry.i}`} text={entry.part.text} />;
            }
            return (
              <ToolCallAccordion
                key={`tool-${entry.part.id || entry.i}`}
                part={entry.part}
                chatId={chatId}
                messageId={messageId}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return (
    <div className="rounded-lg border border-line bg-paper-sunken/60 px-3 py-2 text-[12.5px] italic leading-5 text-ink-muted whitespace-pre-wrap">
      {trimmed}
    </div>
  );
}

/**
 * Plain-text renderer for the streaming tail. ReactMarkdown + KaTeX re-parse
 * the whole block on every token, which makes fast streams feel chunky.
 * Rendering the active text part as plain text while it is still growing keeps
 * the stream smooth and letter-by-letter.
 */
function StreamingText({ text }: { text: string }) {
  return <span className="whitespace-pre-wrap">{text}</span>;
}

// ---- Main Message component ----
export function Message({
  message,
  onAskSubmit,
  onOpenArtifact,
  onRetry,
  onBadResponse,
  artifacts,
  streaming,
  activities,
  status,
}: {
  message: Msg;
  onAskSubmit?: (msgId: string, choice: string) => void;
  onOpenArtifact?: (artifact: Artifact) => void;
  onRetry?: (messageId: string) => void;
  onBadResponse?: (messageId: string) => void;
  artifacts?: Artifact[];
  streaming?: boolean;
  activities?: Activity[];
  status?: string;
}) {
  const isUser = message.role === "user";
  const [askAnswers, setAskAnswers] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  // Active chat id is needed so destructive-tool permission gates can resolve
  // against the right chat's gate endpoint.
  const chatId = useApp((s) => s.activeChatId) ?? undefined;
  const showWorkingPlaceholder = !isUser && !!streaming && message.parts.length === 0;

  if (!isUser && !showWorkingPlaceholder && message.parts.length === 0 && (!activities || activities.length === 0)) {
    return null;
  }

  if (isUser) {
    const attachments = message.attachments ?? [];
    return <UserBubble message={message} attachments={attachments} streaming={!!streaming} />;
  }

  // Assistant message: separate the model's internal process (thinking +
  // tool calls) from the response text shown to the user. The process panel
  // renders above the message body; the message body contains only text parts.
  const parts = message.parts;
  const lastPartIdx = parts.length - 1;
  const trailingIsText = parts.length > 0 && parts[lastPartIdx].kind === "text";
  const textEntries = useMemo(() => {
    const entries: { part: Extract<MessagePart, { kind: "text" }>; i: number }[] = [];
    parts.forEach((part, i) => {
      if (part.kind === "text") entries.push({ part, i });
    });
    return entries;
  }, [parts]);
  const hasProcess = textEntries.length < parts.length;

  const openArtifactFromCode = onOpenArtifact
    ? (code: string, lang: string) => {
        onOpenArtifact({
          id: `code-${Date.now()}`,
          kind: "code",
          title: lang || "Untitled code",
          language: lang,
          content: code,
          createdAt: Date.now(),
          sourceMessageId: message.id,
        });
      }
    : undefined;

  return (
    <div className="group flex w-full gap-3 justify-start">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-paper">
        <Logo size={14} />
      </div>
      <div className="min-w-0 flex-1 max-w-[92%]">
        <div className="text-[14px] leading-6 text-ink">
          {!showWorkingPlaceholder && hasProcess && (
            <ProcessPanel
              parts={parts}
              streaming={streaming}
              lastPartIdx={lastPartIdx}
              chatId={chatId}
              messageId={message.id}
            />
          )}
          {showWorkingPlaceholder ? (
            <WorkingLabel status={status} />
          ) : (
            textEntries.map(({ part, i }, idx) => {
              const isStreamingPart = streaming && i === lastPartIdx;
              const subParts = splitAroundAsk(part.text);
              return subParts.map((sp, j) => {
                if (sp.type === "text") {
                  const trimmed = sp.value.trim();
                  if (!trimmed) return null;
                  // During streaming, skip the expensive markdown parser so the
                  // text tail updates smoothly token-by-token.
                  if (isStreamingPart && subParts.length === 1) {
                    return (
                      <div key={`text-${i}-${j}`} className={cn(idx > 0 && j === 0 && "mt-2")}>
                        <StreamingText text={trimmed} />
                      </div>
                    );
                  }
                  return (
                    <div key={`text-${i}-${j}`} className={cn(idx > 0 && j === 0 && "mt-2")}>
                      <AssistantMarkdown content={trimmed} onOpenPanel={openArtifactFromCode} />
                    </div>
                  );
                }
                const payload = parseAskPayload(sp.value);
                if (!payload) return null;
                const askKey = `${message.id}-ask-${i}-${j}`;
                const chosen = askAnswers[askKey];
                return (
                  <AskCard
                    key={askKey}
                    payload={payload}
                    submitted={!!chosen}
                    chosenLabel={chosen}
                    onSubmit={(choice) => {
                      setAskAnswers((prev) => ({ ...prev, [askKey]: choice }));
                      onAskSubmit?.(message.id, choice);
                    }}
                  />
                );
              });
            })
          )}
          {streaming && !showWorkingPlaceholder && trailingIsText && (
            <span className="inline-block h-[1em] w-[2px] align-middle bg-ink animate-typing-cursor ml-0.5" />
          )}
        </div>

        {artifacts && artifacts.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {artifacts
              .filter((artifact) => artifact.sourceMessageId === message.id)
              .map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => onOpenArtifact?.(artifact)}
                  className={cn(
                    "press flex w-full items-center gap-3 rounded-2xl border border-line bg-paper-raised px-3.5 py-3 text-left",
                    "hover:border-line-strong hover:bg-paper-sunken",
                  )}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-paper-sunken text-ink-muted">
                    {artifact.kind === "doc" && <FileText className="h-4 w-4" />}
                    {artifact.kind === "sheet" && <Table2 className="h-4 w-4" />}
                    {artifact.kind === "graph" && <BarChart3 className="h-4 w-4" />}
                    {artifact.kind === "code" && <Code2 className="h-4 w-4" />}
                    {artifact.kind === "preview" && <Globe className="h-4 w-4" />}
                    {artifact.kind === "diff" && <GitCompare className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">
                      {artifact.title}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-ink-muted">
                      Click to open in the sidebar
                    </div>
                  </div>
                </button>
              ))}
          </div>
        )}

        <div className={cn(
          "mt-1 flex items-center gap-0.5 transition-opacity",
          message.resolvedModel ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}>
          {message.resolvedModel && (
            <span className="inline-flex items-center rounded-full border border-line bg-paper-sunken px-2 py-0.5 text-[10.5px] text-ink-muted">
              {message.providerLabel || "Model"}: {message.resolvedModel}
            </span>
          )}
          <IconButton
            icon={copied ? <CheckIcon className="h-3.5 w-3.5 text-success" /> : <Copy />}
            label={copied ? "Copied" : "Copy"}
            size="sm"
            onClick={() => {
              navigator.clipboard.writeText(message.content).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
          />
          <IconButton icon={<RefreshCcw />} label="Regenerate" size="sm" onClick={() => onRetry?.(message.id)} />
          <IconButton
            icon={<ThumbsDown className={cn(message.feedback === "bad" && "text-error fill-error/20")} />}
            label={message.feedback === "bad" ? "Feedback logged" : "Bad response"}
            size="sm"
            active={message.feedback === "bad"}
            onClick={() => onBadResponse?.(message.id)}
          />
          <span className="ml-auto text-[10.5px] text-ink-faint">{formatTime(message.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline tool-call segment — the model's request and its execution result,
 * shown as a small accordion in the process panel. Collapsed: label + status
 * (running shimmer / ok check / error x). Expanded: input + output.
 */
function ToolCallAccordion({
  part,
  chatId,
  messageId,
}: {
  part: Extract<MessagePart, { kind: "tool" }>;
  chatId?: string;
  messageId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [resolving, setResolving] = useState(false);
  const resolveGate = useApp((s) => s.resolveGate);
  const Icon = getIcon(part.tool || part.label);
  const running = !part.done;
  const errored = part.done && part.ok === false;
  const hasGate = !!part.pendingGate && !!chatId;

  let inputPreview: string | null = null;
  if (part.input && typeof part.input === "object") {
    try {
      inputPreview = JSON.stringify(part.input, null, 2);
    } catch {
      inputPreview = String(part.input);
    }
  }

  async function handleResolve(allow: boolean) {
    if (!part.pendingGate || !chatId) return;
    const gateId = part.pendingGate.gateId;
    setResolving(true);
    try {
      await resolveGate(chatId, messageId, gateId, allow);
    } finally {
      setResolving(false);
    }
  }

  const canExpand = part.done && (part.result || inputPreview);

  return (
    <div className="my-1">
      <button
        type="button"
        disabled={!canExpand && !hasGate}
        onClick={() => {
          if (hasGate) {
            setExpanded((v) => !v);
          } else if (canExpand) {
            setExpanded((v) => !v);
          }
        }}
        className={cn(
          "press flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
          hasGate
            ? "border-warning/20 bg-warning/5 text-warning-fg hover:bg-warning/10"
            : errored
              ? "border-error/20 bg-error/5 text-error hover:bg-error/10"
              : "border-line bg-paper-sunken text-ink-muted hover:bg-paper hover:text-ink",
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">
          {running ? `Running ${part.label}…` : `tool call (${part.label})`}
        </span>
        {running && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
        {part.done && part.ok !== false && (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        )}
        {errored && <XCircle className="h-3.5 w-3.5 shrink-0 text-error" />}
        {(canExpand || hasGate) && (
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        )}
      </button>

      <div
        className={cn(
          "overflow-hidden transition-[max-height,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          expanded ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="mt-1 flex flex-col gap-2">
          {hasGate && (
            <div className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
              {part.pendingGate!.reason && (
                <p className="mb-1.5 text-[11.5px] leading-relaxed text-warning-fg">
                  {part.pendingGate!.reason}
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={resolving}
                  onClick={() => void handleResolve(true)}
                  className="press ring-focus inline-flex items-center gap-1 rounded-md bg-success px-2.5 py-1 text-[11.5px] font-semibold text-success-fg hover:bg-success/90 disabled:opacity-60"
                >
                  {resolving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                  Allow
                </button>
                <button
                  type="button"
                  disabled={resolving}
                  onClick={() => void handleResolve(false)}
                  className="press ring-focus inline-flex items-center gap-1 rounded-md border border-error/30 bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-error hover:bg-error/5 disabled:opacity-60"
                >
                  <XCircle className="h-3 w-3" />
                  Deny
                </button>
              </div>
            </div>
          )}

          {inputPreview && (
            <div>
              <div className="mb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-faint">Input</div>
              <pre className="overflow-x-auto rounded-md border border-line bg-paper-sunken px-2.5 py-1.5 text-[11.5px] leading-5 text-ink-muted">
                {inputPreview}
              </pre>
            </div>
          )}
          {part.result && (
            <div>
              <div className="mb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-faint">Output</div>
              <pre className="max-h-72 overflow-auto rounded-md border border-line bg-paper-sunken px-2.5 py-1.5 text-[11.5px] leading-5 text-ink-muted whitespace-pre-wrap break-words">
                {part.result.slice(0, 4000)}
                {part.result.length > 4000 ? `\n… (${part.result.length - 4000} more chars)` : ""}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkingLabel({ status }: { status?: string }) {
  // Cycle through a shuffled pool of whimsical "-ing" words at a slower pace.
  // The backend's `status` string wins if it isn't the generic "Thinking".
  const pool = useMemo(() => shuffled(THINKING_WORDS), []);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % pool.length), 5000);
    return () => clearInterval(id);
  }, [pool.length]);

  const generic = !status || status.toLowerCase() === "thinking";
  const label = generic ? pool[idx] : status;

  return (
    <span
      key={label}
      className="shimmer-text inline-flex items-center gap-2 text-[13.5px] font-medium text-ink-faint"
    >
      <span className="inline-flex h-1.5 w-1.5 rounded-full bg-ink-faint/70 animate-pulse" />
      <span
        key={label /* re-fade on word change */}
        className="shimmer-text"
      >
        {label}
      </span>
    </span>
  );
}
