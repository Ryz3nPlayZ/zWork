import { useState, useCallback, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  Eye,
  Edit3,
  Download,
  Copy,
  Check,
  FileText,
  Trash2,
  ChevronDown,
  Plus,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Square,
  CheckSquare,
  FileCode
} from "lucide-react";
import type { Artifact } from "../../lib/store";
import { useApp } from "../../lib/store";
import { cn } from "../../lib/cn";

const AUTOSAVE_MS = 600;

interface Block {
  id: string;
  type: "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "todo" | "code";
  text: string;
  checked?: boolean;
  language?: string;
}

function parseMarkdownToBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let inCode = false;
  let codeText = "";
  let codeLang = "";
  let codeBlockId = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      if (inCode) {
        blocks.push({
          id: codeBlockId,
          type: "code",
          text: codeText.trim(),
          language: codeLang,
        });
        inCode = false;
        codeText = "";
        codeLang = "";
      } else {
        inCode = true;
        codeLang = line.slice(3).trim();
        codeBlockId = "block_" + Math.random().toString(36).substr(2, 9);
      }
      continue;
    }

    if (inCode) {
      codeText += line + "\n";
      continue;
    }

    const id = "block_" + Math.random().toString(36).substr(2, 9);
    if (line.startsWith("# ")) {
      blocks.push({ id, type: "h1", text: line.slice(2) });
    } else if (line.startsWith("## ")) {
      blocks.push({ id, type: "h2", text: line.slice(3) });
    } else if (line.startsWith("### ")) {
      blocks.push({ id, type: "h3", text: line.slice(4) });
    } else if (line.startsWith("- [ ] ")) {
      blocks.push({ id, type: "todo", text: line.slice(6), checked: false });
    } else if (line.startsWith("- [x] ")) {
      blocks.push({ id, type: "todo", text: line.slice(6), checked: true });
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push({ id, type: "ul", text: line.slice(2) });
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)/);
      blocks.push({ id, type: "ol", text: match ? match[2] : line });
    } else {
      // Treat simple lines as paragraphs. If empty, it's an empty paragraph.
      blocks.push({ id, type: "p", text: line });
    }
  }

  if (inCode) {
    blocks.push({
      id: codeBlockId,
      type: "code",
      text: codeText.trim(),
      language: codeLang,
    });
  }

  // Ensure there is at least one paragraph block if empty
  if (blocks.length === 0) {
    blocks.push({
      id: "block_initial",
      type: "p",
      text: "",
    });
  }

  return blocks;
}

function serializeBlocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "h1":
          return `# ${b.text}`;
        case "h2":
          return `## ${b.text}`;
        case "h3":
          return `### ${b.text}`;
        case "ul":
          return `- ${b.text}`;
        case "ol":
          return `1. ${b.text}`;
        case "todo":
          return `- [${b.checked ? "x" : " "}] ${b.text}`;
        case "code":
          return `\`\`\`${b.language || ""}\n${b.text}\n\`\`\``;
        case "p":
        default:
          return b.text;
      }
    })
    .join("\n");
}

export function ArtifactDocViewer({ artifact }: { artifact: Artifact }) {
  const updateArtifact = useApp((s) => s.updateArtifact);
  const [editorMode, setEditorMode] = useState<"read" | "blocks" | "source">("read");
  const [blocks, setBlocks] = useState<Block[]>(() => parseMarkdownToBlocks(artifact.content));
  const [sourceDraft, setSourceDraft] = useState(artifact.content);
  const [copied, setCopied] = useState(false);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [blockMenuId, setBlockMenuId] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Synchronize when the artifact content updates externally (from AI stream)
  useEffect(() => {
    if (editorMode === "read") {
      setBlocks(parseMarkdownToBlocks(artifact.content));
      setSourceDraft(artifact.content);
    }
  }, [artifact.content, editorMode]);

  const triggerAutosave = useCallback(
    (nextBlocks: Block[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const md = serializeBlocksToMarkdown(nextBlocks);
        void updateArtifact(artifact.id, { content: md });
      }, AUTOSAVE_MS);
    },
    [artifact.id, updateArtifact]
  );

  const handleBlockChange = (blockId: string, text: string) => {
    const next = blocks.map((b) => (b.id === blockId ? { ...b, text } : b));
    setBlocks(next);
    triggerAutosave(next);
  };

  const handleTodoToggle = (blockId: string) => {
    const next = blocks.map((b) =>
      b.id === blockId ? { ...b, checked: !b.checked } : b
    );
    setBlocks(next);
    triggerAutosave(next);
  };

  const handleBlockTypeChange = (blockId: string, type: Block["type"]) => {
    const next = blocks.map((b) =>
      b.id === blockId ? { ...b, type, checked: type === "todo" ? false : undefined } : b
    );
    setBlocks(next);
    triggerAutosave(next);
    setBlockMenuId(null);
  };

  const handleDeleteBlock = (blockId: string) => {
    if (blocks.length <= 1) {
      // Don't delete the last block, just make it an empty paragraph
      const next = [{ id: blockId, type: "p" as const, text: "" }];
      setBlocks(next);
      triggerAutosave(next);
      return;
    }
    const idx = blocks.findIndex((b) => b.id === blockId);
    const next = blocks.filter((b) => b.id !== blockId);
    setBlocks(next);
    triggerAutosave(next);
    // Focus neighbor
    const neighborIdx = Math.max(0, idx - 1);
    setActiveBlockId(next[neighborIdx]?.id || null);
  };

  const handleCreateBlockBelow = (blockId: string) => {
    const idx = blocks.findIndex((b) => b.id === blockId);
    const newId = "block_" + Math.random().toString(36).substr(2, 9);
    const newBlock: Block = { id: newId, type: "p", text: "" };
    const next = [...blocks];
    next.splice(idx + 1, 0, newBlock);
    setBlocks(next);
    triggerAutosave(next);
    setActiveBlockId(newId);
  };

  const handleKeyDown = (e: React.KeyboardEvent, block: Block) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleCreateBlockBelow(block.id);
    } else if (e.key === "Backspace" && block.text === "") {
      e.preventDefault();
      handleDeleteBlock(block.id);
    }
  };

  const handleSourceChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setSourceDraft(text);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void updateArtifact(artifact.id, { content: text });
      setBlocks(parseMarkdownToBlocks(text));
    }, AUTOSAVE_MS);
  };

  const copyContent = () => {
    const text = serializeBlocksToMarkdown(blocks);
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const downloadMd = () => {
    const text = serializeBlocksToMarkdown(blocks);
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.title.replace(/\s+/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1 bg-paper-soft">
        <div className="flex rounded-lg border border-line bg-paper p-0.5">
          <button
            onClick={() => {
              setEditorMode("read");
              setBlocks(parseMarkdownToBlocks(artifact.content));
            }}
            className={cn(
              "px-2 py-1 text-[11px] font-medium rounded-md transition-all",
              editorMode === "read"
                ? "bg-paper-raised text-ink shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                : "text-ink-muted hover:text-ink"
            )}
          >
            <Eye className="inline h-3 w-3 mr-1" />
            Read
          </button>
          <button
            onClick={() => {
              setEditorMode("blocks");
              setBlocks(parseMarkdownToBlocks(artifact.content));
            }}
            className={cn(
              "px-2 py-1 text-[11px] font-medium rounded-md transition-all",
              editorMode === "blocks"
                ? "bg-paper-raised text-ink shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                : "text-ink-muted hover:text-ink"
            )}
          >
            <Edit3 className="inline h-3 w-3 mr-1" />
            Notion Blocks
          </button>
          <button
            onClick={() => {
              setEditorMode("source");
              setSourceDraft(serializeBlocksToMarkdown(blocks));
            }}
            className={cn(
              "px-2 py-1 text-[11px] font-medium rounded-md transition-all",
              editorMode === "source"
                ? "bg-paper-raised text-ink shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                : "text-ink-muted hover:text-ink"
            )}
          >
            <FileText className="inline h-3 w-3 mr-1" />
            Source
          </button>
        </div>

        <div className="flex-1" />

        <button
          onClick={copyContent}
          className="press flex items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink transition-colors"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>

        <button
          onClick={downloadMd}
          className="press flex items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink transition-colors"
        >
          <Download className="h-3 w-3" />
          <span>Export</span>
        </button>
      </div>

      {/* Editor Body */}
      <div className="flex-1 overflow-y-auto bg-paper">
        {editorMode === "read" && (
          <div className="h-full px-8 py-8">
            <article className="max-w-none text-[13.5px] leading-6 text-ink">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  h1: ({ children }) => <h2 className="mb-2 mt-6 text-[18px] font-bold text-ink border-b border-line pb-1.5">{children}</h2>,
                  h2: ({ children }) => <h3 className="mb-2 mt-5 text-[15.5px] font-semibold text-ink">{children}</h3>,
                  h3: ({ children }) => <h4 className="mb-1 mt-4 text-[13.5px] font-semibold text-ink">{children}</h4>,
                  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>,
                  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5">{children}</ol>,
                  code: ({ className, children }) => {
                    const match = /language-(\w+)/.exec(className || "");
                    if (match || String(children).includes("\n")) {
                      return (
                        <pre className="my-2 overflow-x-auto rounded-xl border border-line bg-paper-sunken p-3 text-[12px] font-mono">
                          <code>{children}</code>
                        </pre>
                      );
                    }
                    return (
                      <code className="rounded bg-paper-sunken px-1.5 py-0.5 text-[12px] font-mono text-ink">
                        {children}
                      </code>
                    );
                  },
                }}
              >
                {serializeBlocksToMarkdown(blocks)}
              </ReactMarkdown>
            </article>
          </div>
        )}

        {editorMode === "blocks" && (
          <div className="px-10 py-8 flex flex-col gap-1 min-h-full">
            {blocks.map((block, idx) => {
              const isHovered = hoveredBlockId === block.id;
              const isActive = activeBlockId === block.id;
              const isMenuOpen = blockMenuId === block.id;

              return (
                <div
                  key={block.id}
                  onMouseEnter={() => setHoveredBlockId(block.id)}
                  onMouseLeave={() => {
                    setHoveredBlockId(null);
                    if (!isMenuOpen) setBlockMenuId(null);
                  }}
                  className={cn(
                    "group/block relative flex items-start gap-2 py-0.5 rounded-lg border-l-2 transition-all",
                    isActive ? "border-accent pl-1 bg-paper-soft" : "border-transparent"
                  )}
                >
                  {/* Hover Actions / Drag handle */}
                  <div
                    className={cn(
                      "absolute -left-7 top-1 flex items-center gap-0.5 transition-opacity duration-150",
                      isHovered ? "opacity-100" : "opacity-0 pointer-events-none"
                    )}
                  >
                    {/* Add block button */}
                    <button
                      onClick={() => handleCreateBlockBelow(block.id)}
                      className="p-0.5 rounded text-ink-faint hover:text-ink hover:bg-paper-sunken"
                      title="Add block below"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                    {/* Block menu trigger */}
                    <div className="relative">
                      <button
                        onClick={() => setBlockMenuId(isMenuOpen ? null : block.id)}
                        className="p-0.5 rounded text-ink-faint hover:text-ink hover:bg-paper-sunken"
                        title="Change block type"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>

                      {isMenuOpen && (
                        <div className="absolute left-0 top-full z-45 w-[160px] rounded-xl border border-line bg-paper-raised p-1 shadow-pop">
                          <button
                            onClick={() => handleBlockTypeChange(block.id, "p")}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-paper-sunken text-ink"
                          >
                            <FileText className="h-3.5 w-3.5 text-ink-muted" /> Paragraph
                          </button>
                          <button
                            onClick={() => handleBlockTypeChange(block.id, "h1")}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-paper-sunken text-ink"
                          >
                            <Heading1 className="h-3.5 w-3.5 text-ink-muted" /> Heading 1
                          </button>
                          <button
                            onClick={() => handleBlockTypeChange(block.id, "h2")}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-paper-sunken text-ink"
                          >
                            <Heading2 className="h-3.5 w-3.5 text-ink-muted" /> Heading 2
                          </button>
                          <button
                            onClick={() => handleBlockTypeChange(block.id, "h3")}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-paper-sunken text-ink"
                          >
                            <Heading3 className="h-3.5 w-3.5 text-ink-muted" /> Heading 3
                          </button>
                          <button
                            onClick={() => handleBlockTypeChange(block.id, "ul")}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-paper-sunken text-ink"
                          >
                            <List className="h-3.5 w-3.5 text-ink-muted" /> Bullet List
                          </button>
                          <button
                            onClick={() => handleBlockTypeChange(block.id, "ol")}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-paper-sunken text-ink"
                          >
                            <ListOrdered className="h-3.5 w-3.5 text-ink-muted" /> Numbered List
                          </button>
                          <button
                            onClick={() => handleBlockTypeChange(block.id, "todo")}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-paper-sunken text-ink"
                          >
                            <Square className="h-3.5 w-3.5 text-ink-muted" /> Todo list
                          </button>
                          <button
                            onClick={() => handleBlockTypeChange(block.id, "code")}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-paper-sunken text-ink"
                          >
                            <FileCode className="h-3.5 w-3.5 text-ink-muted" /> Code Block
                          </button>
                          <div className="border-t border-line my-1" />
                          <button
                            onClick={() => handleDeleteBlock(block.id)}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] text-red-500 hover:bg-red-500/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Render based on Block type */}
                  <div className="flex-1 flex items-start gap-2 w-full">
                    {block.type === "ul" && (
                      <span className="text-ink-muted select-none mt-[3px] text-[13px] shrink-0">•</span>
                    )}
                    {block.type === "ol" && (
                      <span className="text-ink-muted select-none mt-[3px] text-[12px] shrink-0">{idx + 1}.</span>
                    )}
                    {block.type === "todo" && (
                      <button
                        onClick={() => handleTodoToggle(block.id)}
                        className="press text-ink-muted hover:text-ink select-none mt-1 shrink-0"
                      >
                        {block.checked ? (
                          <CheckSquare className="h-4 w-4 text-emerald-600" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                    )}

                    <textarea
                      value={block.text}
                      onChange={(e) => handleBlockChange(block.id, e.target.value)}
                      onFocus={() => setActiveBlockId(block.id)}
                      onBlur={() => {
                        // Keep delay so clicks inside menu can register
                        setTimeout(() => setActiveBlockId(null), 150);
                      }}
                      onKeyDown={(e) => handleKeyDown(e, block)}
                      rows={1}
                      placeholder={
                        block.type === "h1" ? "Heading 1" :
                        block.type === "h2" ? "Heading 2" :
                        block.type === "h3" ? "Heading 3" :
                        block.type === "code" ? "Paste code block here..." :
                        "Type '/' for commands..."
                      }
                      style={{ height: "auto" }}
                      className={cn(
                        "flex-1 bg-transparent resize-none border border-transparent rounded-lg focus:outline-none focus:border-line-soft transition-colors w-full py-0.5",
                        block.type === "h1" && "text-[18px] font-bold text-ink leading-tight",
                        block.type === "h2" && "text-[15.5px] font-semibold text-ink leading-snug",
                        block.type === "h3" && "text-[13.5px] font-semibold text-ink leading-normal",
                        block.type === "code" && "font-mono text-[12px] bg-paper-sunken border border-line p-2 text-ink-soft rounded-lg leading-relaxed",
                        block.type === "p" && "text-[13px] text-ink-muted leading-relaxed",
                        block.type === "ul" && "text-[13px] text-ink-muted leading-relaxed",
                        block.type === "ol" && "text-[13px] text-ink-muted leading-relaxed",
                        block.type === "todo" && "text-[13px] text-ink-muted leading-relaxed",
                        block.checked && "line-through opacity-50"
                      )}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {editorMode === "source" && (
          <textarea
            className="w-full h-full resize-none bg-paper p-6 font-mono text-[12.5px] leading-6 text-ink outline-none placeholder:text-ink-faint"
            value={sourceDraft}
            onChange={handleSourceChange}
            placeholder="Write markdown here…"
            spellCheck
            autoFocus
          />
        )}
      </div>

      {/* Footer Info */}
      <div className="shrink-0 border-t border-line px-3 py-1.5 text-[10.5px] text-ink-faint bg-paper-soft flex items-center justify-between">
        <span>Notion Blocks Mode: Press Enter for new line · Backspace to merge blocks</span>
        <span>Auto-saved</span>
      </div>
    </div>
  );
}
