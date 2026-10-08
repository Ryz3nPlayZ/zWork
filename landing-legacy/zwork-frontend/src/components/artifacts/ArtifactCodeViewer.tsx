import { useState, useCallback } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check } from "lucide-react";
import type { Artifact } from "../../lib/store";

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

function cn(...inputs: (string | undefined | false)[]) {
  return inputs.filter(Boolean).join(" ");
}

// ---- Code/Diff viewer ----

export function ArtifactCodeViewer({ artifact }: { artifact: Artifact }) {
  const [copied, setCopied] = useState(false);
  const isDiff = artifact.kind === "diff" || artifact.content.startsWith("@@") || artifact.content.startsWith("diff --git");

  const copy = useCallback(() => {
    navigator.clipboard.writeText(artifact.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [artifact.content]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-end border-b border-line px-2 py-1">
        <button
          type="button"
          onClick={copy}
          className="press flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {isDiff ? (
          <DiffView lines={parseDiff(artifact.content)} />
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
            {artifact.content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}
