import React, { useState } from "react";
import { useApp } from "../../lib/store";
import type { Task } from "../../lib/store";
import {
  Inbox,
  ListTodo,
  Flame,
  CheckCircle2,
  Plus,
  Trash2,
  Calendar,
  X,
  AlertTriangle,
} from "lucide-react";

const COLUMNS: Array<{
  id: Task["column"];
  title: string;
  icon: React.ReactNode;
  color: string;
}> = [
  {
    id: "inbox",
    title: "Inbox",
    icon: <Inbox className="h-4 w-4 text-ink-muted" />,
    color: "border-line bg-paper-soft text-ink",
  },
  {
    id: "todo",
    title: "To Do",
    icon: <ListTodo className="h-4 w-4 text-ink-muted" />,
    color: "border-line bg-paper-soft text-ink-soft",
  },
  {
    id: "doing",
    title: "Doing",
    icon: <Flame className="h-4 w-4 text-ink animate-pulse" />,
    color: "border-line-strong bg-paper-raised text-ink font-semibold",
  },
  {
    id: "done",
    title: "Done",
    icon: <CheckCircle2 className="h-4 w-4 text-ink-faint" />,
    color: "border-line-soft bg-paper-raised/40 opacity-75 text-ink-muted",
  },
];

export function KanbanBoard() {
  const tasks = useApp((s) => s.tasks);
  const addTask = useApp((s) => s.addTask);
  const updateTaskColumn = useApp((s) => s.updateTaskColumn);
  const deleteTask = useApp((s) => s.deleteTask);

  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [activeInputColumn, setActiveInputColumn] = useState<Task["column"] | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const doingCount = tasks.filter((t) => t.column === "doing").length;
  const showWipWarning = doingCount >= 1; // Strict 1-task WIP limit

  const handleAddTask = async (col: Task["column"]) => {
    if (!newTaskTitle.trim()) return;
    await addTask(newTaskTitle.trim(), col);
    setNewTaskTitle("");
    setActiveInputColumn(null);
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData("text/plain", id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent, targetCol: Task["column"]) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;
    
    // WIP limit caution/warning check if dragging into 'doing'
    if (targetCol === "doing" && doingCount >= 1) {
      // Allow it but trigger warning (non-blocking but visually clear)
    }
    
    await updateTaskColumn(taskId, targetCol);
  };

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* WIP Banner */}
      {showWipWarning && (
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] rounded-lg border border-rose-500/20 bg-rose-500/5 text-rose-400 animate-fade-in">
          <AlertTriangle className="h-3.5 w-3.5 text-rose-500 flex-shrink-0" />
          <span>
            <strong>WIP Limit Caution:</strong> Focus is key! Try to finish your current <em>Doing</em> task before starting another.
          </span>
        </div>
      )}

      {/* Grid Columns */}
      <div className="grid grid-cols-1 gap-3 overflow-y-auto flex-1 pr-1 custom-scrollbar">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.column === col.id);
          
          return (
            <div
              key={col.id}
              className={`flex flex-col rounded-xl border p-3 min-h-[150px] transition-all duration-200 ${col.color}`}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, col.id)}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {col.icon}
                  <span className="text-[13px] font-semibold text-ink">{col.title}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-line text-ink-muted">
                    {colTasks.length}
                  </span>
                </div>

                <button
                  onClick={() => {
                    setActiveInputColumn(activeInputColumn === col.id ? null : col.id);
                    setNewTaskTitle("");
                  }}
                  className="p-1 rounded-md hover:bg-paper-raised text-ink-muted hover:text-ink transition-colors duration-150"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Inline Add Task Input */}
              {activeInputColumn === col.id && (
                <div className="mb-2 p-2 rounded-lg bg-paper-raised border border-line animate-slide-down">
                  <input
                    type="text"
                    placeholder="Task name..."
                    autoFocus
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddTask(col.id);
                      if (e.key === "Escape") setActiveInputColumn(null);
                    }}
                    className="w-full bg-paper px-2 py-1.5 text-[12px] border border-line rounded focus:outline-none focus:border-amber-500/50 text-ink"
                  />
                  <div className="flex items-center justify-end gap-1.5 mt-2">
                    <button
                      onClick={() => setActiveInputColumn(null)}
                      className="px-2 py-1 text-[11px] rounded text-ink-muted hover:bg-paper duration-150"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleAddTask(col.id)}
                      className="px-2.5 py-1 text-[11px] font-medium bg-amber-500 hover:bg-amber-600 text-paper-raised rounded duration-150"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}

              {/* Task list inside column */}
              <div className="flex flex-col gap-2 flex-1">
                {colTasks.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center border border-dashed border-line rounded-lg py-6 text-[11px] text-ink-muted">
                    No tasks
                  </div>
                ) : (
                  colTasks.map((task) => (
                    <div
                      key={task.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, task.id)}
                      onClick={() => setSelectedTask(task)}
                      className={`group flex flex-col p-2.5 rounded-lg border border-line bg-paper hover:bg-paper-raised cursor-grab active:cursor-grabbing hover:border-line-hover transition-all duration-150 relative`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className={`text-[12px] text-ink leading-relaxed break-words ${task.column === "done" ? "line-through text-ink-muted" : "font-medium"}`}>
                          {task.title}
                        </span>
                        
                        {/* Actions */}
                        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity duration-150 flex-shrink-0">
                          {col.id !== "done" && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                const nextCol = col.id === "inbox" ? "todo" : col.id === "todo" ? "doing" : "done";
                                updateTaskColumn(task.id, nextCol);
                              }}
                              title="Move forward"
                              className="p-1 rounded text-ink-muted hover:text-ink hover:bg-paper transition-colors"
                            >
                              <Plus className="h-3 w-3 rotate-45" />
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteTask(task.id);
                            }}
                            title="Delete task"
                            className="p-1 rounded text-rose-500/75 hover:text-rose-500 hover:bg-paper transition-colors"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>

                      {/* Due Date tag */}
                      {task.due_date && (
                        <div className="flex items-center gap-1 mt-2 text-[10px] text-amber-500/80">
                          <Calendar className="h-2.5 w-2.5" />
                          <span>{task.due_date}</span>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Task detail Modal */}
      {selectedTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fade-in" onClick={() => setSelectedTask(null)}>
          <div
            className="w-full max-w-sm rounded-xl border border-line bg-paper p-4 shadow-xl animate-scale-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line pb-2 mb-3">
              <span className="text-[13px] font-bold text-ink">Task Details</span>
              <button
                onClick={() => setSelectedTask(null)}
                className="p-1 rounded-md hover:bg-paper-raised text-ink-muted hover:text-ink transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            
            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">Title</label>
                <div className="text-[12.5px] font-semibold text-ink mt-0.5">{selectedTask.title}</div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">Status</label>
                  <div className="mt-0.5">
                    <select
                      value={selectedTask.column}
                      onChange={async (e) => {
                        await updateTaskColumn(selectedTask.id, e.target.value as Task["column"]);
                        setSelectedTask({ ...selectedTask, column: e.target.value as Task["column"] });
                      }}
                      className="bg-paper border border-line text-[12px] px-2 py-1 rounded w-full focus:outline-none text-ink"
                    >
                      <option value="inbox">Inbox</option>
                      <option value="todo">To Do</option>
                      <option value="doing">Doing</option>
                      <option value="done">Done</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">Due Date</label>
                  <div className="text-[12px] text-ink mt-1.5 flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5 text-ink-muted" />
                    <span>{selectedTask.due_date || "No due date"}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-line mt-4 pt-3">
              <button
                onClick={async () => {
                  await deleteTask(selectedTask.id);
                  setSelectedTask(null);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-500/20 bg-rose-500/5 text-rose-400 text-[11px] font-medium hover:bg-rose-500/10 transition-all duration-150"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete Task</span>
              </button>
              
              <button
                onClick={() => setSelectedTask(null)}
                className="px-3.5 py-1.5 rounded-lg bg-amber-500 text-paper-raised text-[11px] font-semibold hover:bg-amber-600 transition-all duration-150"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
