/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
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
  ShieldAlert,
  GitFork,
} from "lucide-react";
import { cn } from "../lib/cn";
import { protectCurrency } from "../lib/markdown";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { getIcon } from "./ActivityBlocks";
import type { Activity, Artifact, MessagePart, MessageUsage } from "../lib/store";
import { useApp } from "../lib/store";
import { Logo } from "./Logo";
import { IconButton } from "./IconButton";
import type { Message as Msg } from "../lib/store";
import { api } from "../lib/api";

function formatTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function UsageCaption({ usage }: { usage: MessageUsage }) {
  const cost = usage.costUsd != null ? ` · $${usage.costUsd.toFixed(4)}` : "";
  return (
    <span className="whitespace-nowrap font-mono" title={`${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out${cost}`}>
      ↑{formatTokens(usage.input)} ↓{formatTokens(usage.output)}{cost}
    </span>
  );
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
            fontSize: "13px",
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
            <code className="rounded bg-paper-sunken px-1.5 py-0.5 text-[13px] font-mono text-ink" {...props}>
              {children}
            </code>
          );
        },
        pre({ children }) {
          return <>{children}</>;
        },
        p({ children }) {
          return <p className="mb-3 last:mb-0 leading-[1.65]">{children}</p>;
        },
        h1({ children }) {
          return <h1 className="mb-2 mt-5 text-[19px] font-bold text-ink">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="mb-2 mt-4 text-[16px] font-semibold text-ink">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="mb-1.5 mt-3 text-[14.5px] font-semibold text-ink">{children}</h3>;
        },
        ul({ children }) {
          return <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="mb-3 list-decimal space-y-1 pl-5">{children}</ol>;
        },
        li({ children }) {
          return <li className="leading-[1.6]">{children}</li>;
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
              <table className="w-full border-collapse text-[13px]">{children}</table>
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
      {protectCurrency(content)}
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
              className="w-full resize-none rounded-2xl rounded-br-md border border-accent/50 bg-paper-raised px-3.5 py-2.5 text-[15px] leading-[25px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
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
            <div className="rounded-2xl rounded-br-md bg-paper-raised border border-line px-3.5 py-2.5 text-[15px] leading-[25px] text-ink break-words whitespace-pre-wrap">
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

        <p className="mt-1 text-right text-[11px] text-ink-faint">{formatTime(message.createdAt)}</p>
      </div>
    </div>
  );
}

type ProcessEntry =
  | { kind: "thinking"; part: Extract<MessagePart, { kind: "thinking" }>; i: number }
  | { kind: "narration"; part: Extract<MessagePart, { kind: "narration" }>; i: number }
  | { kind: "tool"; part: Extract<MessagePart, { kind: "tool" }>; i: number };

/**
 * A compact, expandable panel that groups the model's internal process
 * (thinking blocks, mid-run narration, and tool calls) and sits above the
 * actual assistant message. This separates "what the model did" from "the
 * message for the user" instead of interleaving them inline. Text the model
 * streams between tool calls is narration — it lives here, not in the answer.
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
  // Auto-open tracking: the panel opens itself while the model is visibly
  // working, and folds back down when the run finishes so the final answer
  // stands alone. Once the user clicks the toggle, auto behavior stops —
  // their choice wins for the rest of the stream.
  const [autoExpanded, setAutoExpanded] = useState(false);
  const [manual, setManual] = useState(false);
  const processEntries = useMemo<ProcessEntry[]>(() => {
    const entries: ProcessEntry[] = [];
    parts.forEach((part, i) => {
      if (part.kind === "thinking") entries.push({ kind: "thinking", part, i });
      else if (part.kind === "narration") entries.push({ kind: "narration", part, i });
      else if (part.kind === "tool") entries.push({ kind: "tool", part, i });
    });
    return entries;
  }, [parts]);

  useEffect(() => {
    if (!streaming || manual || processEntries.length === 0) return;
    const latest = parts[lastPartIdx];
    if (latest && (latest.kind === "thinking" || latest.kind === "narration" || (latest.kind === "tool" && !latest.done))) {
      setExpanded(true);
      setAutoExpanded(true);
    }
  }, [streaming, manual, processEntries.length, lastPartIdx, parts]);

  // When the stream ends, fold an auto-opened panel back down so the final
  // answer stands alone. A panel the user opened themselves stays open.
  useEffect(() => {
    if (!streaming && autoExpanded) {
      setExpanded(false);
      setAutoExpanded(false);
    }
  }, [streaming, autoExpanded]);

  if (processEntries.length === 0) return null;

  const latest = processEntries[processEntries.length - 1];
  // The process is "live" only while its newest entry is still growing. Once
  // the trailing part is answer text (or the stream ended), the panel settles
  // into its summary state.
  const trailingIsAnswer = parts[lastPartIdx]?.kind === "text";
  const isActive =
    streaming &&
    !trailingIsAnswer &&
    (latest.kind === "thinking" ||
      latest.kind === "narration" ||
      (latest.kind === "tool" && !latest.part.done));

  const thoughtCount = processEntries.filter((e) => e.kind === "thinking").length;
  const narrationCount = processEntries.filter((e) => e.kind === "narration").length;
  const toolCount = processEntries.filter((e) => e.kind === "tool").length;

  let summary: string;
  if (isActive && latest.kind === "thinking") {
    summary = "Thinking…";
  } else if (isActive && latest.kind === "narration") {
    const words = latest.part.text.trim().split(/\s+/).slice(0, 8).join(" ");
    summary = words || "Working…";
  } else if (isActive && latest.kind === "tool") {
    summary = `${latest.part.label}…`;
  } else {
    const bits: string[] = [];
    if (thoughtCount + narrationCount > 0) bits.push("Thought");
    if (toolCount > 0) bits.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
    summary = bits.join(" · ") || "Process";
  }

  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={() => {
          setManual(true);
          setAutoExpanded(false);
          setExpanded((v) => !v);
        }}
        className="press flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-faint hover:text-ink-muted hover:bg-paper-sunken"
      >
        {isActive ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        )}
        <span className="truncate">{summary}</span>
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {processEntries.map((entry) => {
            if (entry.kind === "thinking") {
              return (
                <ThinkingBlock
                  key={`thinking-${entry.i}`}
                  text={entry.part.text}
                  active={streaming && entry.i === lastPartIdx}
                />
              );
            }
            if (entry.kind === "narration") {
              return (
                <NarrationBlock
                  key={`narration-${entry.i}`}
                  text={entry.part.text}
                  active={streaming && entry.i === lastPartIdx}
                />
              );
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

function ThinkingBlock({ text, active }: { text: string; active?: boolean }) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return (
    <div className="border-l-2 border-line pl-3 text-[13px] italic leading-[1.6] text-ink-faint">
      <TypewriterText text={trimmed} active={!!active} />
    </div>
  );
}

/** Mid-run spoken text ("Let me check that…") — readable process commentary,
 *  visually distinct from both private reasoning and the final answer. */
function NarrationBlock({ text, active }: { text: string; active?: boolean }) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return (
    <div className="border-l-2 border-line pl-3 text-[13.5px] leading-[1.6] text-ink-muted">
      <TypewriterText text={trimmed} active={!!active} />
    </div>
  );
}

/**
 * Plain-text renderer with a smoothed reveal, used while a text/thinking/
 * narration segment is still growing. Two jobs:
 *
 * 1. ReactMarkdown + KaTeX re-parse the whole block on every token, which
 *    makes fast streams feel chunky — active segments render as plain text
 *    and flip to markdown once the stream ends.
 * 2. SSE deltas arrive in bursts (several frames coalesce into one network
 *    read and one batched React render), so raw appends make text jump
 *    whole sentences at a time. This component buffers arrivals and reveals
 *    characters at a steady pace, accelerating with the backlog so it never
 *    lags far behind the stream, and snapping to the full text once idle.
 */
function TypewriterText({ text, active }: { text: string; active: boolean }) {
  const [shown, setShown] = useState(active ? 0 : text.length);
  const textRef = useRef(text);
  const shownRef = useRef(shown);
  const carryRef = useRef(0);
  textRef.current = text;

  useEffect(() => {
    if (!active) {
      shownRef.current = textRef.current.length;
      setShown(textRef.current.length);
      return;
    }
    let raf = 0;
    let rafAliveAt = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.max(now - last, 0);
      last = now;
      const len = textRef.current.length;
      const backlog = len - shownRef.current;
      if (backlog > 0) {
        // ~60 chars/s at small backlogs, accelerating linearly with the
        // backlog (capped at 1200 c/s) so a burst clears in well under a
        // second instead of trailing the stream.
        const rate = Math.min(60 + backlog, 1200); // chars per second
        carryRef.current += (rate * elapsed) / 1000;
        const add = Math.floor(carryRef.current);
        if (add > 0) {
          carryRef.current -= add;
          let next = Math.min(len, shownRef.current + add);
          // Never split a UTF-16 surrogate pair at the reveal boundary.
          if (next < len && (text.charCodeAt(next) & 0xfc00) === 0xdc00) next += 1;
          shownRef.current = next;
          setShown(next);
        }
      }
    };
    const rafTick = (now: number) => {
      rafAliveAt = now;
      tick(now);
      raf = requestAnimationFrame(rafTick);
    };
    raf = requestAnimationFrame(rafTick);
    // rAF is frozen to zero in throttled/occluded webviews (an unfocused
    // overlay window, suspended in-app browsers) — timers still fire there.
    // Drive the reveal from an interval whenever frames stop coming so text
    // never freezes mid-stream.
    const interval = setInterval(() => {
      if (performance.now() - rafAliveAt < 200) return; // rAF is healthy
      tick(performance.now());
    }, 30);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(interval);
    };
  }, [active]);

  return <span className="whitespace-pre-wrap">{text.slice(0, shown)}</span>;
}

// ---- Main Message component ----
export function Message({
  message,
  onOpenArtifact,
  onRetry,
  onBadResponse,
  onFork,
  artifacts,
  streaming,
  activities,
  status,
}: {
  message: Msg;
  onOpenArtifact?: (artifact: Artifact) => void;
  onRetry?: (messageId: string) => void;
  onBadResponse?: (messageId: string) => void;
  /** Fork the chat with this message as the branch point. */
  onFork?: (messageId: string) => void;
  artifacts?: Artifact[];
  streaming?: boolean;
  activities?: Activity[];
  status?: string;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  // Active chat id is needed so destructive-tool permission gates can resolve
  // against the right chat's gate endpoint.
  const chatId = useApp((s) => s.activeChatId) ?? undefined;
  const showWorkingPlaceholder = !isUser && !!streaming && message.parts.length === 0;

  // All hooks must run before any early return, or React throws error #300
  // ("Rendered fewer hooks than expected"). The textEntries useMemo below is
  // the one that used to sit after the isUser early return — moved up here.
  const parts = message.parts;
  const textEntries = useMemo(() => {
    const entries: { part: Extract<MessagePart, { kind: "text" }>; i: number }[] = [];
    parts.forEach((part, i) => {
      if (part.kind === "text") entries.push({ part, i });
    });
    return entries;
  }, [parts]);
  // Permission-recovery cards live on the same parts list as text/tool parts.
  // Rendered inline after the text body so the user sees the action hint in
  // the flow of the conversation, right where the failure happened.
  const recoveryEntries = useMemo(
    () => parts.filter((p): p is Extract<MessagePart, { kind: "permission_recovery" }> => p.kind === "permission_recovery"),
    [parts],
  );

  if (!isUser && !showWorkingPlaceholder && message.parts.length === 0 && (!activities || activities.length === 0)) {
    return null;
  }

  if (isUser) {
    const attachments = message.attachments ?? [];
    return <UserBubble message={message} attachments={attachments} streaming={!!streaming} />;
  }

  // While the agent works (no parts yet), the orb stands in for the logo
  // avatar and the row carries only the shimmering working label.
  if (showWorkingPlaceholder) {
    return <WorkingLabel status={status} />;
  }

  // Assistant message: separate the model's internal process (thinking,
  // mid-run narration, tool calls) from the response text shown to the user.
  // The process panel renders above the message body; the body contains only
  // text parts — the final answer.
  const lastPartIdx = parts.length - 1;
  const trailingIsText = parts.length > 0 && parts[lastPartIdx].kind === "text";
  const hasProcess = parts.some((p) => p.kind === "thinking" || p.kind === "narration" || p.kind === "tool");

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
        <div className="text-[15px] leading-[25px] text-ink">
          {hasProcess && (
            <ProcessPanel
              parts={parts}
              streaming={streaming}
              lastPartIdx={lastPartIdx}
              chatId={chatId}
              messageId={message.id}
            />
          )}
          {textEntries.map(({ part, i }, idx) => {
            const isStreamingPart = streaming && i === lastPartIdx;
            const trimmed = part.text.trim();
            if (!trimmed) return null;
            if (isStreamingPart && textEntries.length === 1) {
              return (
                <div key={`text-${i}`} className={cn(idx > 0 && "mt-2")}>
                  <TypewriterText text={trimmed} active />
                </div>
              );
            }
            return (
              <div key={`text-${i}`} className={cn(idx > 0 && "mt-2")}>
                <AssistantMarkdown content={trimmed} onOpenPanel={openArtifactFromCode} />
              </div>
            );
          })}
          {streaming && trailingIsText && (
            <span className="inline-block h-[1em] w-[2px] align-middle bg-ink animate-typing-cursor ml-0.5" />
          )}
          {recoveryEntries.map((r) => (
            <PermissionRecoveryCard key={r.id} message={r.message} />
          ))}
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
                    <div className="truncate text-[13.5px] font-medium text-ink">
                      {artifact.title}
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink-muted">
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
            icon={<GitFork className="h-3.5 w-3.5" />}
            label="Fork from here"
            size="sm"
            onClick={() => onFork?.(message.id)}
          />
          <IconButton
            icon={<ThumbsDown className={cn(message.feedback === "bad" && "text-error fill-error/20")} />}
            label={message.feedback === "bad" ? "Feedback logged" : "Bad response"}
            size="sm"
            active={message.feedback === "bad"}
            onClick={() => onBadResponse?.(message.id)}
          />
          <span className="ml-auto text-[11px] text-ink-faint">{formatTime(message.createdAt)}</span>
          {message.usage && (
            <span className="text-[11px] text-ink-faint">
              <UsageCaption usage={message.usage} />
            </span>
          )}
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
  // messageId was used by the old inline gate handler (handleResolve), which
  // moved to the composer's permission card. Kept in the prop interface for
  // API stability; prefixed to silence the unused warning.
  messageId: _messageId,
}: {
  part: Extract<MessagePart, { kind: "tool" }>;
  chatId?: string;
  messageId: string;
}) {
  const [expanded, setExpanded] = useState(false);
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
          "press flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors",
          hasGate
            ? "border-warning/20 bg-warning/5 text-warning hover:bg-warning/10"
            : errored
              ? "border-error/20 bg-error/5 text-error hover:bg-error/10"
              : "border-line bg-paper-sunken text-ink-muted hover:bg-paper hover:text-ink",
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">
          {running ? `${part.label}…` : part.label}
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
              <p className="text-[11.5px] leading-relaxed text-ink-muted">
                Permission required — respond in the card below to continue.
              </p>
            </div>
          )}

          {inputPreview && (
            <div>
              <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Input</div>
              <pre className="overflow-x-auto rounded-md border border-line bg-paper-sunken px-2.5 py-1.5 text-[12px] leading-5 text-ink-muted">
                {inputPreview}
              </pre>
            </div>
          )}
          {part.result && (
            <div>
              <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Output</div>
              <pre className="max-h-72 overflow-auto rounded-md border border-line bg-paper-sunken px-2.5 py-1.5 text-[12px] leading-5 text-ink-muted whitespace-pre-wrap break-words">
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

/** Orb states that read clearly at the 32px display size — "working" (loose
 *  particle scatter) and "shaping" (thin outline) dissolve into noise, so the
 *  label matcher never selects them. */
const ORB_STATES: readonly OrbState[] = [
  "searching", "solving", "listening",
  "connecting", "weaving", "composing", "breathing",
];

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

  const words = label.toLowerCase().split(/[^a-z]+/);
  const orbState: OrbState = ORB_STATES.find((s) => words.includes(s)) ?? "weaving";

  return (
    <div className="group flex w-full gap-3 justify-start">
      {/* While the agent works, the orb takes the logo avatar's slot. The
          package's 20px preset draws sub-pixel dots that vanish at inline
          scale; the denser 64px design displayed at 32px stays legible. */}
      <ThinkingOrb
        state={orbState}
        size={64}
        style={{ width: 32, height: 32 }}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1 max-w-[92%] self-center">
        <span
          key={label /* re-fade on word change */}
          className="shimmer-text text-[14px] font-medium text-ink-faint"
        >
          {label}
        </span>
      </div>
    </div>
  );
}

/** A user-facing recovery card shown when desktop automation failed due to a
 *  macOS permission problem. Turns the silent "nothing happens" failure into
 *  an actionable hint — the #1 reported cause is "granted Accessibility to
 *  zWork, not CuaDriver". The button deep-links to the right System Settings
 *  pane so the user can fix it without leaving the chat. */
function PermissionRecoveryCard({ message }: { message: string }) {
  const openSettings = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Open Accessibility first — it's the more common missing grant. The
      // user can navigate to Screen Recording from the sidebar if needed.
      await invoke("open_macos_privacy_pane", { pane: "accessibility" });
    } catch {
      // Non-Tauri or command missing — the message already names the path.
    }
  }, []);

  return (
    <div className="mt-2 flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">Permission needed for desktop control</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{message}</p>
        <button
          onClick={openSettings}
          className="mt-2 inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-paper-raised px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-paper-sunken transition-colors"
        >
          Open System Settings
        </button>
      </div>
    </div>
  );
}
