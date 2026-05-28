import { useState, useCallback, useEffect, useMemo } from "react";
import { THINKING_WORDS, shuffled } from "../lib/thinkingWords";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
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
} from "lucide-react";
import { cn } from "../lib/cn";
import { ActivityBlocks } from "./ActivityBlocks";
import type { Activity, Artifact } from "../lib/store";
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
                    ? "bg-accent/15 text-accent"
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
                    ? "bg-accent/15 text-accent"
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
              className="press rounded border border-line bg-paper px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-paper-sunken hover:text-ink cursor-pointer"
            >
              Open
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            className="press rounded p-1 text-ink-muted hover:bg-paper hover:text-ink cursor-pointer"
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {activeTab === "code" ? (
        <SyntaxHighlighter
          language={language || "text"}
          style={oneLight as Record<string, React.CSSProperties>}
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
              className="w-full h-[250px] border-0 bg-white rounded-lg shadow-sm"
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
                    <div className="text-red-500">
                      <div className="text-[10px] text-red-400 font-semibold uppercase tracking-wider mb-1">STDERR</div>
                      <div className="bg-red-50/50 p-2.5 rounded border border-red-200/50 font-mono">{runOutput.stderr}</div>
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
    <div className="group flex w-full animate-fade-in justify-end">
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
  const showWorkingPlaceholder = !isUser && !!streaming && message.content.length === 0;

  if (!isUser && !showWorkingPlaceholder && message.content.length === 0 && (!activities || activities.length === 0)) {
    return null;
  }

  if (isUser) {
    const attachments = message.attachments ?? [];
    return <UserBubble message={message} attachments={attachments} streaming={!!streaming} />;
  }

  // Assistant message — no bubble, markdown + LaTeX, AskCard injection
  const parts = splitAroundAsk(message.content);

  return (
    <div className="group flex w-full animate-fade-in gap-3 justify-start">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-paper">
        <Logo size={14} />
      </div>
      <div className="min-w-0 flex-1 max-w-[92%]">
        {/* Collapsible thinking / tool-call section */}
        {activities && activities.length > 0 && (
          <ThinkingSection
            activities={activities}
            streaming={streaming}
            hasContent={message.content.length > 0}
          />
        )}
        <div className="text-[14px] leading-6 text-ink">
          {showWorkingPlaceholder ? (
            <WorkingLabel status={status} />
          ) : (
            parts.map((part, i) => {
              if (part.type === "text") {
                const trimmed = part.value.trim();
                if (!trimmed) return null;
                return (
                  <AssistantMarkdown
                    key={i}
                    content={trimmed}
                    onOpenPanel={onOpenArtifact ? (code, lang) => {
                      onOpenArtifact({
                        id: `code-${Date.now()}`,
                        kind: "code",
                        title: lang || "Untitled code",
                        language: lang,
                        content: code,
                        createdAt: Date.now(),
                        sourceMessageId: message.id,
                      });
                    } : undefined}
                  />
                );
              }
              // AskCard segment
              const payload = parseAskPayload(part.value);
              if (!payload) return null;
              const key = `${message.id}-ask-${i}`;
              const chosen = askAnswers[key];
              return (
                <AskCard
                  key={key}
                  payload={payload}
                  submitted={!!chosen}
                  chosenLabel={chosen}
                  onSubmit={(choice) => {
                    setAskAnswers((prev) => ({ ...prev, [key]: choice }));
                    onAskSubmit?.(message.id, choice);
                  }}
                />
              );
            })
          )}
          {streaming && !showWorkingPlaceholder && (
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
            icon={copied ? <CheckIcon className="h-3.5 w-3.5 text-green-600" /> : <Copy />}
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
            icon={<ThumbsDown className={cn(message.feedback === "bad" && "text-red-500 fill-red-500/20")} />}
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
 * Collapsible section showing tool calls / steps taken during generation.
 * - During thinking (streaming, no content yet): fully expanded.
 * - When content arrives: auto-collapses to a toggle row.
 * - After completion: stays collapsed, user can expand.
 */
function ThinkingSection({
  activities,
  streaming,
  hasContent,
}: {
  activities: Activity[];
  streaming?: boolean;
  hasContent: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (activities.length === 0) return null;

  const thinking = streaming && !hasContent;

  // During thinking phase (no response text yet), show fully expanded
  if (thinking) {
    return (
      <div className="mb-2">
        <ActivityBlocks items={activities} />
      </div>
    );
  }

  // After content arrives or on completed messages: collapsible
  const label = `${activities.length} step${activities.length !== 1 ? "s" : ""}`;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "press flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium transition-colors",
          "text-ink-faint hover:text-ink-muted hover:bg-paper-sunken",
        )}
      >
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            expanded && "rotate-180",
          )}
        />
        <span>{label}</span>
      </button>
      <div
        className={cn(
          "overflow-hidden transition-[max-height,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          expanded ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="pt-1">
          <ActivityBlocks items={activities} />
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
      className="shimmer-text inline-flex animate-fade-in items-center gap-2 text-[13.5px] font-medium text-ink-faint"
    >
      <span className="inline-flex h-1.5 w-1.5 rounded-full bg-ink-faint/70 animate-pulse" />
      <span
        key={label /* re-fade on word change */}
        className="shimmer-text animate-fade-in"
      >
        {label}
      </span>
    </span>
  );
}
