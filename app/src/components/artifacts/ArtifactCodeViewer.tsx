import { useState, useCallback, useRef, useEffect } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check, Edit3, Eye, Download } from "lucide-react";
import type { Artifact } from "../../lib/store";
import { useApp } from "../../lib/store";

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
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
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

      {editing && (
        <div className="shrink-0 border-t border-line px-3 py-1 text-[10.5px] text-ink-faint">
          ⌘+Enter to preview · auto-saves
        </div>
      )}
    </div>
  );
}
