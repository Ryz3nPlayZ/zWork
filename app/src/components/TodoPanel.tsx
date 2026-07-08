import { AnimatePresence, motion } from "framer-motion";
import { Check, Circle, ListTodo, Loader2, X } from "lucide-react";
import { useApp, type AgentTodo } from "../lib/store";
import { cn } from "../lib/cn";
import { IconButton } from "./IconButton";

/**
 * Right-side panel showing the agent's live todo list for the active chat.
 * Read-only display — the list is driven entirely by `todo_update` SSE events
 * (the agent calls `update_todos`); the user can only open/close the panel.
 *
 * Modeled on ArtifactPanel's `motion.aside` width-animation pattern, but
 * narrower since it renders a compact list, not a document.
 */
export function TodoPanel() {
  const activeChatId = useApp((s) => s.activeChatId);
  const open = useApp((s) => {
    const id = s.activeChatId;
    return id ? !!s.chats[id]?.todoPanelOpen : false;
  });
  const todos = useApp((s) => {
    const id = s.activeChatId;
    return id ? s.chats[id]?.todos ?? [] : [];
  });
  const close = useApp((s) => s.closeTodoPanel);

  return (
    <AnimatePresence>
      {open && activeChatId && (
        <motion.aside
          key="todo-panel"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: "clamp(320px, 30vw, 460px)", opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="h-full shrink-0 overflow-hidden border-l border-edge bg-paper"
        >
          <div className="flex h-full flex-col">
            {/* 48px header — mirrors ArtifactPanel's header bar */}
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-3">
              <div className="flex min-w-0 items-center gap-2">
                <ListTodo className="h-4 w-4 shrink-0 text-ink-muted" />
                <span className="truncate text-[13px] font-medium text-ink">Todo</span>
                {todos.length > 0 && (
                  <span className="rounded-full bg-line/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-muted">
                    {todos.filter((t) => t.status === "completed").length}/{todos.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2" data-no-drag>
                <IconButton icon={<X />} label="Close todo panel" size="sm" onClick={close} />
              </div>
            </div>

            {/* Body — scrollable list of agent-authored steps */}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {todos.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <ListTodo className="h-6 w-6 text-ink-faint" />
                  <p className="text-[13px] text-ink-faint">No active todo</p>
                  <p className="max-w-[220px] text-[11px] leading-relaxed text-ink-faint/70">
                    The agent will show its plan here when working on a multi-step task.
                  </p>
                </div>
              ) : (
                <ol className="flex flex-col gap-1">
                  {todos.map((todo, i) => (
                    <TodoRow key={`${todo.id}-${i}`} todo={todo} index={i} />
                  ))}
                </ol>
              )}
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** A single read-only todo row with a status glyph. */
function TodoRow({ todo }: { todo: AgentTodo; index: number }) {
  const done = todo.status === "completed";
  const active = todo.status === "in_progress";

  return (
    <li
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors",
        active && "bg-accent/10",
      )}
    >
      <span className="mt-0.5 shrink-0">
        {done ? (
          <Check className="h-4 w-4 text-accent" />
        ) : active ? (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        ) : (
          <Circle className="h-4 w-4 text-ink-faint" />
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
