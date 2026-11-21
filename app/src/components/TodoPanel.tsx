import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Circle, Loader2 } from "lucide-react";
import { useApp, type AgentTodo } from "../lib/store";
import { cn } from "../lib/cn";

/**
 * The agent's live todo list (from `update_todos` → `todo_update` events),
 * as a plain box sitting right above the composer. It's in the composer's
 * flow, and ChatView pads the messages by the composer's height, so it
 * pushes the chat up instead of covering it. Header = current step + count;
 * the list opens below it. Read-only.
 */
export function TodoPanel() {
  const todos = useApp((s) => {
    const id = s.activeChatId;
    return id ? s.chats[id]?.todos ?? [] : [];
  });
  // null = follow the list: open while work is underway, folded once every
  // item is done so the finished checklist doesn't sit over the answer.
  const [collapsedPref, setCollapsed] = useState<boolean | null>(null);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");
  const collapsed = collapsedPref ?? completed === todos.length;
  const allDone = completed === todos.length;

  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-line bg-paper-raised">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        className="press flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-state-hover"
      >
        {allDone ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
          {allDone ? "All steps done" : active?.content ?? "Working through the steps"}
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-ink-muted">
          {completed} of {todos.length}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-200",
            collapsed && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <ol className="flex max-h-[176px] flex-col gap-0.5 overflow-y-auto border-t border-line px-2 py-2">
              {todos.map((todo, i) => (
                <TodoRow key={`${todo.id}-${i}`} todo={todo} />
              ))}
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A single read-only todo row with a status glyph. */
function TodoRow({ todo }: { todo: AgentTodo }) {
  const done = todo.status === "completed";
  const inProgress = todo.status === "in_progress";

  return (
    <li
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-2 py-1.5",
        inProgress && "bg-ink/5",
      )}
    >
      <span className="mt-0.5 shrink-0">
        {done ? (
          <Check className="h-3.5 w-3.5 text-accent" />
        ) : inProgress ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        ) : (
          <Circle className="h-3.5 w-3.5 text-ink-faint" />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 text-[13px] leading-snug",
          done ? "text-ink-faint line-through" : "text-ink",
        )}
      >
        {todo.content}
      </span>
    </li>
  );
}
