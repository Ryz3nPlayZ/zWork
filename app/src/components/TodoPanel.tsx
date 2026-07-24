import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Circle, ListTodo, Loader2 } from "lucide-react";
import { useApp, type AgentTodo } from "../lib/store";
import { cn } from "../lib/cn";

/**
 * TodoCard — a compact, collapsible status card that floats over the chat's
 * top-right corner. Shows the agent's live todo list (driven by `update_todos`
 * tool calls → `todo_update` SSE events). Stickied: scrolling the chat doesn't
 * move it. Consistent corner radius (`rounded-2xl`) with the rest of the UI.
 *
 * Collapses to a minimal "Status" pill on click; expands to show the full list.
 * Read-only display — the user can only collapse/expand, not edit.
 */
export function TodoPanel() {
  const todos = useApp((s) => {
    const id = s.activeChatId;
    return id ? s.chats[id]?.todos ?? [] : [];
  });
  const [collapsed, setCollapsed] = useState(false);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");

  return (
    <div className="pointer-events-none absolute right-4 top-[52px] z-30 w-[260px]">
      <motion.div
        layout
        className={cn(
          "pointer-events-auto overflow-hidden rounded-2xl border border-line bg-paper-raised/95 backdrop-blur-xl shadow-lift",
        )}
      >
        {/* Header — always visible, click to collapse/expand */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="press flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-paper-sunken/50"
        >
          <ListTodo className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
          <span className="flex-1 text-[12px] font-medium text-ink">
            {active ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin text-accent" />
                <span className="truncate">{active.content}</span>
              </span>
            ) : (
              "Status"
            )}
          </span>
          <span className="rounded-full bg-line/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-muted">
            {completed}/{todos.length}
          </span>
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200",
              collapsed && "-rotate-90",
            )}
          />
        </button>

        {/* Body — the todo list, collapsible */}
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
              <ol className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto px-2 pb-2">
                {todos.map((todo, i) => (
                  <TodoRow key={`${todo.id}-${i}`} todo={todo} />
                ))}
              </ol>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
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
        "flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors",
        inProgress && "bg-accent/10",
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
          "min-w-0 flex-1 text-[12px] leading-snug",
          done ? "text-ink-faint line-through" : "text-ink",
        )}
      >
        {todo.content}
      </span>
    </li>
  );
}
