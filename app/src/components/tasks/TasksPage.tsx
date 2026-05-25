import { useState, useMemo, useEffect } from "react";
import {
  LayoutDashboard,
  List,
  Calendar as CalendarIcon,
  Plus,
  MoreHorizontal,
  Trash2,
  ArrowUp,
  ArrowDown,
  Minus,
  User,
  Bot,
  Clock,
} from "lucide-react";
import { useApp, type Task } from "../../lib/store";
import { cn } from "../../lib/cn";
import { NewTaskModal } from "./NewTaskModal";
import { CalendarView } from "./CalendarView";

const COLUMNS: { id: Task["column"]; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "todo", label: "To Do" },
  { id: "doing", label: "Doing" },
  { id: "done", label: "Done" },
];

const PRIORITY_ICONS = {
  high: <ArrowUp className="h-3 w-3 text-red-500" />,
  medium: <Minus className="h-3 w-3 text-ink-muted" />,
  low: <ArrowDown className="h-3 w-3 text-ink-faint" />,
};

const PRIORITY_LABELS = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

function formatDate(dateStr: string | null) {
  if (!dateStr) return "—";
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isOverdue(dateStr: string | null) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  return d < today;
}

export function TasksPage() {
  const tasks = useApp((s) => s.tasks);
  const events = useApp((s) => s.events);
  const updateTaskColumn = useApp((s) => s.updateTaskColumn);
  const deleteTask = useApp((s) => s.deleteTask);
  const fetchTasks = useApp((s) => s.fetchTasks);
  const fetchEvents = useApp((s) => s.fetchEvents);
  const [viewMode, setViewMode] = useState<"board" | "list" | "calendar">("board");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);

  useEffect(() => {
    void fetchTasks();
    void fetchEvents();
  }, [fetchTasks, fetchEvents]);

  const byColumn = useMemo(() => {
    const map: Record<string, Task[]> = {
      inbox: [],
      todo: [],
      doing: [],
      done: [],
    };
    for (const t of tasks) {
      map[t.column]?.push(t);
    }
    // Sort by priority then due date
    for (const col of Object.keys(map)) {
      map[col].sort((a, b) => {
        const pa = a.priority === "high" ? 3 : a.priority === "medium" ? 2 : 1;
        const pb = b.priority === "high" ? 3 : b.priority === "medium" ? 2 : 1;
        if (pa !== pb) return pb - pa;
        if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
        if (a.due_date) return -1;
        if (b.due_date) return 1;
        return b.updated_at - a.updated_at;
      });
    }
    return map;
  }, [tasks]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      {/* Header */}
      <div className="shrink-0 border-b border-line bg-paper-soft px-6 py-4">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between">
          <div>
            <h1 className="font-serif text-[28px] font-bold tracking-tight text-ink">Tasks</h1>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              Manage your work across projects.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-line bg-paper p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("board")}
                className={cn(
                  "press rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                  viewMode === "board" ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
                )}
              >
                <LayoutDashboard className="inline h-3.5 w-3.5 mr-1" />
                Board
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={cn(
                  "press rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                  viewMode === "list" ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
                )}
              >
                <List className="inline h-3.5 w-3.5 mr-1" />
                List
              </button>
              <button
                type="button"
                onClick={() => setViewMode("calendar")}
                className={cn(
                  "press rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                  viewMode === "calendar" ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
                )}
              >
                <CalendarIcon className="inline h-3.5 w-3.5 mr-1" />
                Calendar
              </button>
            </div>
            <button
              type="button"
              onClick={() => { setEditingTask(null); setModalOpen(true); }}
              className="press inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:bg-ink-soft transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              New task
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1200px] px-6 py-6">
          {viewMode === "board" ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              {COLUMNS.map((col) => (
                <div key={col.id} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[12px] font-semibold text-ink-muted uppercase tracking-wider">
                      {col.label}
                    </span>
                    <span className="text-[11px] text-ink-faint">
                      {byColumn[col.id].length}
                    </span>
                  </div>
                  <div className="flex min-h-[120px] flex-col gap-2 rounded-xl border border-line bg-paper-soft p-2">
                    {byColumn[col.id].map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onEdit={() => { setEditingTask(task); setModalOpen(true); }}
                        onDelete={() => void deleteTask(task.id)}
                        menuOpen={menuTaskId === task.id}
                        onMenuToggle={() => setMenuTaskId(menuTaskId === task.id ? null : task.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : viewMode === "list" ? (
            <div className="rounded-xl border border-line bg-paper-raised overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-paper-soft text-left text-[11px] font-semibold text-ink-muted uppercase tracking-wider">
                    <th className="px-4 py-2.5">Task</th>
                    <th className="px-4 py-2.5 w-[120px]">Status</th>
                    <th className="px-4 py-2.5 w-[110px]">Due</th>
                    <th className="px-4 py-2.5 w-[90px]">Priority</th>
                    <th className="px-4 py-2.5 w-[100px]">Assignee</th>
                    <th className="px-4 py-2.5 w-[40px]" />
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.id} className="border-b border-line last:border-0 hover:bg-paper-soft/50 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-ink">{task.title}</div>
                        {task.description && (
                          <div className="mt-0.5 text-[11px] text-ink-muted line-clamp-1">{task.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <select
                          value={task.column}
                          onChange={(e) => void updateTaskColumn(task.id, e.target.value as Task["column"])}
                          className="bg-paper border border-line rounded-lg px-2 py-1 text-[11px] text-ink focus:outline-none appearance-none cursor-pointer"
                        >
                          {COLUMNS.map((c) => (
                            <option key={c.id} value={c.id} className="bg-paper text-ink">{c.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={cn("text-[12px]", isOverdue(task.due_date) ? "text-red-500 font-medium" : "text-ink-muted")}>
                          {formatDate(task.due_date)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          {PRIORITY_ICONS[task.priority || "medium"]}
                          <span className="text-[11px] text-ink-muted">{PRIORITY_LABELS[task.priority || "medium"]}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1 text-[11px] text-ink-muted">
                          {task.assignee === "zwork" ? (
                            <><Bot className="h-3 w-3" /> zWork</>
                          ) : (
                            <><User className="h-3 w-3" /> Me</>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => void deleteTask(task.id)}
                          className="rounded p-1 text-ink-faint hover:text-red-500 hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : viewMode === "calendar" ? (
            <CalendarView
              tasks={tasks}
              events={events}
              onTaskClick={(task) => { setEditingTask(task); setModalOpen(true); }}
            />
          ) : null}
        </div>
      </div>

      {modalOpen && (
        <NewTaskModal
          task={editingTask}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function TaskCard({
  task,
  onEdit,
  onDelete,
  menuOpen,
  onMenuToggle,
}: {
  task: Task;
  onEdit: () => void;
  onDelete: () => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
}) {
  const updateTaskColumn = useApp((s) => s.updateTaskColumn);

  return (
    <div className="group relative rounded-lg border border-line bg-paper p-2.5 shadow-xs hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left"
        >
          <div className="text-[12.5px] font-medium text-ink leading-snug">{task.title}</div>
          {task.description && (
            <div className="mt-0.5 text-[11px] text-ink-muted line-clamp-2">{task.description}</div>
          )}
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onMenuToggle(); }}
            className="rounded p-0.5 text-ink-faint hover:text-ink hover:bg-paper-sunken opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={onMenuToggle} />
              <div className="absolute right-0 top-full z-50 mt-1 w-[140px] rounded-xl border border-line bg-paper-raised p-1 shadow-pop">
                <button
                  type="button"
                  onClick={() => { onMenuToggle(); onEdit(); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink hover:bg-paper-sunken"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => { onMenuToggle(); onDelete(); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-red-500 hover:bg-red-500/10"
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {task.priority && (
          <span className="inline-flex items-center gap-0.5 rounded-full border border-line bg-paper px-1.5 py-px text-[10px] text-ink-muted">
            {PRIORITY_ICONS[task.priority]}
            {PRIORITY_LABELS[task.priority]}
          </span>
        )}
        {task.due_date && (
          <span className={cn(
            "inline-flex items-center gap-1 text-[10px]",
            isOverdue(task.due_date) ? "text-red-500 font-medium" : "text-ink-faint"
          )}>
            <Clock className="h-3 w-3" />
            {formatDate(task.due_date)}
          </span>
        )}
        {task.assignee && (
          <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-ink-faint">
            {task.assignee === "zwork" ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
          </span>
        )}
      </div>
      {/* Column change quick actions */}
      <div className="mt-2 flex flex-wrap gap-1">
        {COLUMNS.filter((c) => c.id !== task.column).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => void updateTaskColumn(task.id, c.id)}
            className="rounded border border-line bg-paper px-1.5 py-px text-[9px] text-ink-muted hover:text-ink hover:border-line-strong transition-colors"
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
