import { useState, useCallback, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Eye, Edit3, Download, Copy, Check } from "lucide-react";
import type { Artifact } from "../../lib/store";
import { useApp } from "../../lib/store";

const AUTOSAVE_MS = 800;

export function ArtifactDocViewer({ artifact }: { artifact: Artifact }) {
  const updateArtifact = useApp((s) => s.updateArtifact);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.content);
  const [copied, setCopied] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync draft when the artifact changes externally (e.g. another stream chunk)
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

  const copyContent = useCallback(() => {
    navigator.clipboard.writeText(draft).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [draft]);

  const downloadMd = useCallback(() => {
    const blob = new Blob([draft], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.title.replace(/\s+/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [draft, artifact.title]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
        <button
          type="button"
          onClick={() => (editing ? commitAndPreview() : setEditing(true))}
          className={`press flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
            editing
              ? "bg-accent/10 text-accent hover:bg-accent/15"
              : "text-ink-muted hover:bg-paper-sunken hover:text-ink"
          }`}
          title={editing ? "Preview" : "Edit"}
        >
          {editing ? (
            <><Eye className="h-3 w-3" /> Preview</>
          ) : (
            <><Edit3 className="h-3 w-3" /> Edit</>
          )}
        </button>

        <div className="flex-1" />

        <button
          type="button"
          onClick={copyContent}
          className="press flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title="Copy markdown"
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
          onClick={downloadMd}
          className="press flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title="Download as .md"
        >
          <Download className="h-3 w-3" />
          Export
        </button>
      </div>

      {/* Body */}
      {editing ? (
        <textarea
          className="flex-1 resize-none bg-paper p-5 font-mono text-[12.5px] leading-6 text-ink outline-none placeholder:text-ink-faint"
          value={draft}
          onChange={handleChange}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter → preview
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              commitAndPreview();
            }
          }}
          placeholder="Write markdown here…"
          spellCheck
          autoFocus
        />
      ) : (
        <div className="h-full overflow-auto bg-paper px-6 py-5">
          <article className="max-w-none text-[13.5px] leading-6 text-ink">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                h1: ({ children }) => (
                  <h2 className="mb-2 mt-6 text-[17px] font-bold text-ink">{children}</h2>
                ),
                h2: ({ children }) => (
                  <h3 className="mb-2 mt-5 text-[15px] font-semibold text-ink">{children}</h3>
                ),
                h3: ({ children }) => (
                  <h4 className="mb-1 mt-4 text-[13.5px] font-semibold text-ink">{children}</h4>
                ),
                p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                ul: ({ children }) => (
                  <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="mb-3 list-decimal space-y-1 pl-5">{children}</ol>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-muted italic">
                    {children}
                  </blockquote>
                ),
                code: ({ className, children, ...props }) => {
                  const match = /language-(\w+)/.exec(className || "");
                  if (match || String(children).includes("\n")) {
                    return (
                      <pre className="my-2 overflow-x-auto rounded-lg border border-line bg-paper-sunken p-3 text-[12px] font-mono">
                        <code>{children}</code>
                      </pre>
                    );
                  }
                  return (
                    <code
                      className="rounded bg-paper-sunken px-1.5 py-0.5 text-[12px] font-mono text-ink"
                      {...props}
                    >
                      {children}
                    </code>
                  );
                },
                pre: ({ children }) => <>{children}</>,
                table: ({ children }) => (
                  <div className="my-2 overflow-x-auto">
                    <table className="w-full border-collapse text-[12.5px]">{children}</table>
                  </div>
                ),
                th: ({ children }) => (
                  <th className="border border-line bg-paper-sunken px-3 py-1.5 text-left font-semibold">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="border border-line px-3 py-1.5">{children}</td>
                ),
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink underline underline-offset-2 hover:opacity-70"
                  >
                    {children}
                  </a>
                ),
                strong: ({ children }) => (
                  <strong className="font-semibold text-ink">{children}</strong>
                ),
                hr: () => <hr className="my-4 border-line" />,
              }}
            >
              {draft}
            </ReactMarkdown>
          </article>
        </div>
      )}

      {/* Edit hint */}
      {editing && (
        <div className="shrink-0 border-t border-line px-3 py-1 text-[10.5px] text-ink-faint">
          ⌘+Enter to preview · auto-saves
        </div>
      )}
    </div>
  );
}
