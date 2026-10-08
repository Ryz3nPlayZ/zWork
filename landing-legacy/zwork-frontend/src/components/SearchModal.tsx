import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, MessageCircle, CornerDownLeft } from "lucide-react";
import { useApp, bucketFor, type ChatBucket } from "../lib/store";
import { cn } from "../lib/cn";

export function SearchModal() {
  const open = useApp((s) => s.searchOpen);
  const setOpen = useApp((s) => s.setSearchOpen);
  const summaries = useApp((s) => s.chatSummaries);
  const openChat = useApp((s) => s.openChat);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? summaries.filter((c) => c.title.toLowerCase().includes(q))
      : summaries;
    // Sort by recency (already pre-sorted by the backend typically).
    return filtered.slice(0, 80);
  }, [summaries, query]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Keep activeIdx in range
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1));
  }, [results.length, activeIdx]);

  if (!open) return null;

  const selectAt = (idx: number) => {
    const r = results[idx];
    if (!r) return;
    void openChat(r.id);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      selectAt(activeIdx);
    }
  };

  // Group for the time labels column
  const bucketLabel = (ts: number) => {
    const b: ChatBucket = bucketFor(ts);
    if (b === "Today") return "Today";
    if (b === "This week") return "This week";
    return "Earlier";
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[10vh] animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-[720px] overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Search className="h-5 w-5 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKey}
            placeholder="Search chats and projects"
            className="flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="press rounded-md p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-6 py-8 text-center text-[13px] text-ink-faint">
              No chats match "{query}".
            </div>
          )}
          {results.map((r, i) => {
            const active = i === activeIdx;
            return (
              <button
                key={r.id}
                type="button"
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => selectAt(i)}
                className={cn(
                  "press flex w-full items-center gap-3 px-4 py-2.5 text-left",
                  active ? "bg-paper-sunken" : "hover:bg-paper-sunken/60",
                )}
              >
                <MessageCircle className="h-4 w-4 shrink-0 text-ink-muted" />
                <span className="flex-1 truncate text-[13.5px] text-ink">
                  {r.title || "Untitled conversation"}
                </span>
                <span className="shrink-0 text-[12px] text-ink-faint">
                  {bucketLabel(r.updated_at)}
                </span>
                {active && (
                  <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
