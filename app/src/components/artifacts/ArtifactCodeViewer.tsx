import { useState, useCallback, useRef, useEffect } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check, Edit3, Eye, Download, Sparkles } from "lucide-react";
import type { Artifact } from "../../lib/store";
import { useApp } from "../../lib/store";
import { api } from "../../lib/api";

const AUTOSAVE_MS = 600;

// ---- Diff line parser ----

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  oldNum?: number;
  newNum?: number;
}

function parseDiff(raw: string): DiffLine[] {
  const lines = raw.split("\n");
  const result: DiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (match) {
        oldNum = parseInt(match[1], 10) - 1;
        newNum = parseInt(match[2], 10) - 1;
      }
      result.push({ type: "header", content: line });
    } else if (line.startsWith("+")) {
      newNum++;
      result.push({ type: "add", content: line.slice(1), newNum });
    } else if (line.startsWith("-")) {
      oldNum++;
      result.push({ type: "remove", content: line.slice(1), oldNum });
    } else {
      oldNum++;
      newNum++;
      result.push({ type: "context", content: line.slice(1), oldNum, newNum });
    }
  }
  return result;
}

// ---- Diff viewer ----

function cn(...inputs: (string | undefined | false)[]) {
  return inputs.filter(Boolean).join(" ");
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="font-mono text-[12px] leading-5 overflow-auto h-full">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => {
            const bg =
              line.type === "add"
                ? "bg-emerald-500/8 dark:bg-emerald-400/10"
                : line.type === "remove"
                  ? "bg-red-500/8 dark:bg-red-400/10"
                  : line.type === "header"
                    ? "bg-accent/5 dark:bg-accent/8"
                    : "";
            const fg =
              line.type === "add"
                ? "text-emerald-700 dark:text-emerald-400"
                : line.type === "remove"
                  ? "text-red-700 dark:text-red-400"
                  : line.type === "header"
                    ? "text-ink-muted"
                    : "text-ink";

            return (
              <tr key={i} className={bg}>
                <td className="w-[1%] select-none whitespace-nowrap border-r border-line px-2 text-right text-[10px] text-ink-faint">
                  {line.type !== "header" ? (line.oldNum ?? "") : ""}
                </td>
                <td className="w-[1%] select-none whitespace-nowrap border-r border-line px-2 text-right text-[10px] text-ink-faint">
                  {line.type !== "header" ? (line.newNum ?? "") : ""}
                </td>
                <td className={cn("whitespace-pre-wrap break-all px-3", fg)}>
                  {line.type === "header" ? line.content : line.content || " "}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Main code/diff viewer ----

export function ArtifactCodeViewer({ artifact }: { artifact: Artifact }) {
  const updateArtifact = useApp((s) => s.updateArtifact);
  const isDiff =
    artifact.kind === "diff" ||
    artifact.content.startsWith("@@") ||
    artifact.content.startsWith("diff --git");

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.content);
  const [copied, setCopied] = useState(false);
  const [showRefactor, setShowRefactor] = useState(false);
  const [refactorPrompt, setRefactorPrompt] = useState("");
  const [refactorMode, setRefactorMode] = useState<"clean" | "feature" | "bug" | "simplify">("clean");
  const [refactoring, setRefactoring] = useState(false);
  const [refactorResult, setRefactorResult] = useState<{
    refactored_code: string;
    explanation: string;
    steps: string[];
  } | null>(null);

  const handleRefactor = async () => {
    if (!refactorPrompt.trim()) return;
    setRefactoring(true);
    setRefactorResult(null);
    try {
      const res = await api.refactor({
        code: draft,
        instruction: refactorPrompt,
        mode: refactorMode,
      });
      setRefactorResult(res);
    } catch (err) {
      console.error(err);
      setRefactorResult({
        refactored_code: draft,
        explanation: "An error occurred during refactoring. Please try again.",
        steps: ["Error processing your request."],
      });
    } finally {
      setRefactoring(false);
    }
  };

  const handleApplyRefactor = () => {
    if (!refactorResult) return;
    setDraft(refactorResult.refactored_code);
    updateArtifact(artifact.id, { content: refactorResult.refactored_code });
    setRefactorResult(null);
    setRefactorPrompt("");
    setShowRefactor(false);
  };

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep draft in sync when externally updated (streaming)
  useEffect(() => {
    if (!editing) setDraft(artifact.content);
  }, [artifact.content, editing]);

  const scheduleSave = useCallback(
    (text: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        updateArtifact(artifact.id, { content: text });
      }, AUTOSAVE_MS);
    },
    [artifact.id, updateArtifact],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      setDraft(text);
      scheduleSave(text);
    },
    [scheduleSave],
  );

  const commitAndPreview = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    updateArtifact(artifact.id, { content: draft });
    setEditing(false);
  }, [artifact.id, draft, updateArtifact]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(draft).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [draft]);

  const ext = artifact.language
    ? `.${artifact.language}`
    : artifact.kind === "diff"
      ? ".patch"
      : ".txt";

  const downloadFile = useCallback(() => {
    const blob = new Blob([draft], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.title.replace(/\s+/g, "_")}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [draft, artifact.title, ext]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
        {!isDiff && (
          <button
            type="button"
            onClick={() => (editing ? commitAndPreview() : setEditing(true))}
            className={`press flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              editing
                ? "bg-accent/10 text-accent hover:bg-accent/15"
                : "text-ink-muted hover:bg-paper-sunken hover:text-ink"
            }`}
          >
            {editing ? (
              <><Eye className="h-3 w-3" /> Preview</>
            ) : (
              <><Edit3 className="h-3 w-3" /> Edit</>
            )}
          </button>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={copy}
          className="press flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>

        <button
          type="button"
          onClick={downloadFile}
          className="press flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
        >
          <Download className="h-3 w-3" />
          Export
        </button>

        {!isDiff && (
          <button
            type="button"
            onClick={() => setShowRefactor(!showRefactor)}
            className={`press flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              showRefactor
                ? "bg-accent/10 text-accent hover:bg-accent/15"
                : "text-ink-muted hover:bg-paper-sunken hover:text-ink"
            }`}
            title="AI Refactoring Helper"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Refactor
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="flex-1 overflow-auto border-r border-line relative">
          {editing ? (
            <textarea
              className="h-full w-full resize-none bg-paper p-4 font-mono text-[12px] leading-5 text-ink outline-none"
              value={draft}
              onChange={handleChange}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  commitAndPreview();
                }
              }}
              spellCheck={false}
              autoFocus
            />
          ) : isDiff ? (
            <DiffView lines={parseDiff(draft)} />
          ) : (
            <SyntaxHighlighter
              language={artifact.language || "text"}
              style={oneLight as Record<string, React.CSSProperties>}
              customStyle={{
                margin: 0,
                borderRadius: 0,
                fontSize: "12px",
                background: "transparent",
                height: "100%",
                padding: "12px 16px",
              }}
              codeTagProps={{ style: { fontFamily: "var(--font-mono, monospace)" } }}
            >
              {draft}
            </SyntaxHighlighter>
          )}
        </div>

        {showRefactor && (
          <div className="w-80 border-l border-line bg-paper-soft p-4 flex flex-col gap-4 overflow-y-auto shrink-0 select-none animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between border-b border-line pb-2">
              <h3 className="font-semibold text-xs text-ink flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-accent" />
                AI Refactoring Helper
              </h3>
              <button
                onClick={() => {
                  setShowRefactor(false);
                  setRefactorResult(null);
                }}
                className="text-[10px] text-ink-faint hover:text-ink p-1 rounded-md hover:bg-paper-sunken transition-colors"
              >
                Close
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[10.5px] font-medium text-ink-muted uppercase tracking-wider">Refactor Goal</label>
              <textarea
                value={refactorPrompt}
                onChange={(e) => setRefactorPrompt(e.target.value)}
                placeholder="Describe what changes you want to make in plain English..."
                rows={3}
                disabled={refactoring}
                className="w-full text-[12px] bg-paper border border-line rounded-lg p-2 focus:outline-none focus:border-accent-soft disabled:opacity-50 text-ink resize-none placeholder:text-ink-faint"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[10.5px] font-medium text-ink-muted uppercase tracking-wider">Mode Option</label>
              <div className="grid grid-cols-2 gap-1.5">
                {(["clean", "feature", "bug", "simplify"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={refactoring}
                    onClick={() => setRefactorMode(m)}
                    className={cn(
                      "py-1 text-[11px] capitalize rounded-md border text-center transition-all",
                      refactorMode === m
                        ? "bg-accent/10 border-accent text-accent font-medium shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
                        : "border-line bg-paper text-ink-muted hover:text-ink"
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleRefactor}
              disabled={refactoring || !refactorPrompt.trim()}
              className="w-full py-2 px-3 text-[11.5px] font-medium rounded-lg bg-accent text-white hover:bg-accent-soft disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.05)] cursor-pointer"
            >
              {refactoring ? (
                <>
                  <div className="h-3 w-3 animate-spin rounded-full border border-white border-t-transparent" />
                  Generating Plan...
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate Refactoring Plan
                </>
              )}
            </button>

            {refactorResult && (
              <div className="mt-2 border-t border-line pt-3 flex flex-col gap-3">
                <div className="rounded-lg bg-paper border border-line-soft p-3 flex flex-col gap-2">
                  <span className="text-[11px] font-semibold text-ink">Change Explanation:</span>
                  <p className="text-[11.5px] text-ink-muted leading-relaxed">{refactorResult.explanation}</p>
                </div>

                {refactorResult.steps && refactorResult.steps.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[10.5px] font-medium text-ink-muted uppercase tracking-wider">Step-by-step checklist:</span>
                    <ul className="list-disc pl-4 text-[11.5px] text-ink-muted space-y-1.5">
                      {refactorResult.steps.map((s, idx) => (
                        <li key={idx} className="leading-snug">{s}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button
                    onClick={() => setRefactorResult(null)}
                    className="py-1.5 px-3 text-[11px] rounded-lg border border-line bg-paper text-ink-muted hover:text-ink transition-colors cursor-pointer"
                  >
                    Discard
                  </button>
                  <button
                    onClick={handleApplyRefactor}
                    className="py-1.5 px-3 text-[11px] font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors flex items-center justify-center gap-1 cursor-pointer"
                  >
                    Apply Changes
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="shrink-0 border-t border-line px-3 py-1 text-[10.5px] text-ink-faint">
          ⌘+Enter to preview · auto-saves
        </div>
      )}
    </div>
  );
}
