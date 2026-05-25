import { useState } from "react";
import { KanbanBoard } from "./KanbanBoard";
import { DailyAgenda } from "./DailyAgenda";
import { LayoutDashboard, Sparkles, X, ArrowRightLeft } from "lucide-react";
import { useApp } from "../../lib/store";

export function CockpitPage() {
  const autoPlanTasks = useApp((s) => s.autoPlanTasks);
  const tasks = useApp((s) => s.tasks);
  const updateTask = useApp((s) => s.updateTask);

  const [showPlanner, setShowPlanner] = useState(false);
  const [projectTitle, setProjectTitle] = useState("");
  const [intervalDays, setIntervalDays] = useState(2);
  const [isPlanning, setIsPlanning] = useState(false);

  const handleAIPlan = async () => {
    if (!projectTitle.trim()) return;
    setIsPlanning(true);
    try {
      await autoPlanTasks(projectTitle.trim(), intervalDays);
      setProjectTitle("");
      setShowPlanner(false);
    } catch (e) {
      console.error(e);
    } finally {
      setIsPlanning(false);
    }
  };

  const handleDistributeTasks = async () => {
    setIsPlanning(true);
    try {
      const targets = tasks.filter((t) => t.column === "inbox" || t.column === "todo");
      if (targets.length > 0) {
        const today = new Date();
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const current = new Date(today);
          current.setDate(today.getDate() + (i + 1) * intervalDays);
          const yyyymmdd = current.toISOString().split("T")[0];
          await updateTask(t.id, t.title, t.column, yyyymmdd);
        }
      }
      setShowPlanner(false);
    } catch (e) {
      console.error(e);
    } finally {
      setIsPlanning(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[1200px] px-6 py-10">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-line bg-paper-raised text-accent">
              <LayoutDashboard className="h-6 w-6" />
            </div>
            <div>
              <h1 className="font-serif text-[32px] tracking-tight leading-none text-ink">
                Cockpit
              </h1>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-muted max-w-[500px]">
                Your command center. Organize your workspace task board and manage your daily agenda.
              </p>
            </div>
          </div>

          <button
            onClick={() => setShowPlanner(true)}
            className="press flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-2.5 text-[12.5px] font-semibold text-amber-500 hover:bg-amber-500/10 transition-all"
          >
            <Sparkles className="h-4 w-4" />
            <span>Auto-Plan Project</span>
          </button>
        </div>

        {/* Two column grid */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
          {/* LEFT: Kanban Board */}
          <div className="min-w-0">
            <div className="rounded-2xl border border-line bg-paper-raised p-6 shadow-sm">
              <h2 className="text-[15px] font-semibold text-ink mb-4 border-b border-line pb-2">
                Workspace Task Board
              </h2>
              <KanbanBoard />
            </div>
          </div>

          {/* RIGHT: Daily Agenda */}
          <div className="shrink-0">
            <div className="rounded-2xl border border-line bg-paper-raised p-6 shadow-sm">
              <h2 className="text-[15px] font-semibold text-ink mb-4 border-b border-line pb-2">
                Daily Agenda & Timeline
              </h2>
              <DailyAgenda />
            </div>
          </div>
        </div>
      </div>

      {/* Auto-Planner Modal */}
      {showPlanner && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fade-in"
          onClick={() => setShowPlanner(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-line bg-paper p-6 shadow-2xl animate-scale-up"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-line pb-3 mb-5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-amber-500" />
                <span className="text-[15px] font-bold text-ink">zWork Auto-Planner</span>
              </div>
              <button
                onClick={() => setShowPlanner(false)}
                className="p-1 rounded-md hover:bg-paper-raised text-ink-muted hover:text-ink transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="space-y-6">
              {/* Option A: AI Plan */}
              <div className="rounded-xl border border-line bg-paper-sunken/30 p-4">
                <h3 className="text-[13px] font-semibold text-ink flex items-center gap-1.5 mb-2">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  AI Plan a New Project
                </h3>
                <p className="text-[11.5px] text-ink-muted leading-relaxed mb-3">
                  Type in your project title, and our AI assistant will auto-generate a 5-step sequence of tasks.
                </p>
                <input
                  type="text"
                  placeholder="e.g. Redesign the home page..."
                  value={projectTitle}
                  onChange={(e) => setProjectTitle(e.target.value)}
                  className="w-full bg-paper px-3 py-2 text-[12.5px] border border-line rounded-lg focus:outline-none focus:border-amber-500/50 text-ink mb-3"
                />
                
                <div className="flex items-center justify-between mb-4">
                  <label className="text-[11.5px] font-medium text-ink-muted">Task spacing (days)</label>
                  <select
                    value={intervalDays}
                    onChange={(e) => setIntervalDays(Number(e.target.value))}
                    className="bg-paper border border-line text-[12px] px-2.5 py-1.5 rounded-lg focus:outline-none text-ink font-medium"
                  >
                    <option value={1}>1 day apart</option>
                    <option value={2}>2 days apart</option>
                    <option value={3}>3 days apart</option>
                    <option value={5}>5 days apart</option>
                  </select>
                </div>

                <button
                  disabled={isPlanning || !projectTitle.trim()}
                  onClick={handleAIPlan}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 text-[12px] font-bold bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-paper-raised rounded-xl transition duration-150 shadow-sm"
                >
                  {isPlanning ? "Generating..." : "Generate AI Task Plan"}
                </button>
              </div>

              {/* Divider */}
              <div className="flex items-center my-4">
                <div className="flex-1 border-t border-line" />
                <span className="px-3 text-[10px] uppercase font-bold tracking-wider text-ink-faint">Or</span>
                <div className="flex-1 border-t border-line" />
              </div>

              {/* Option B: Distribute Existing */}
              <div className="rounded-xl border border-line bg-paper-sunken/30 p-4">
                <h3 className="text-[13px] font-semibold text-ink flex items-center gap-1.5 mb-2">
                  <ArrowRightLeft className="h-4 w-4 text-accent" />
                  Reschedule Existing Tasks
                </h3>
                <p className="text-[11.5px] text-ink-muted leading-relaxed mb-4">
                  Spreads out all tasks currently in your Inbox & To Do columns sequentially to avoid overlapping deadlines.
                </p>

                <button
                  disabled={isPlanning || tasks.filter((t) => t.column === "inbox" || t.column === "todo").length === 0}
                  onClick={handleDistributeTasks}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 text-[12px] font-bold border border-line bg-paper hover:bg-paper-sunken disabled:opacity-50 text-ink rounded-xl transition duration-150"
                >
                  Distribute Tasks Sequentially
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
