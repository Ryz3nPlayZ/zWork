import { useState } from "react";
import { useApp } from "../../lib/store";
import { KanbanBoard } from "./KanbanBoard";
import { DailyAgenda } from "./DailyAgenda";
import { X, LayoutDashboard, Calendar, ClipboardList } from "lucide-react";

export function CockpitPanel() {
  const cockpitOpen = useApp((s) => s.cockpitOpen);
  const setCockpitOpen = useApp((s) => s.setCockpitOpen);
  const [activeTab, setActiveTab] = useState<"kanban" | "agenda">("kanban");

  if (!cockpitOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-80 bg-paper/85 backdrop-blur-md border-l border-line shadow-2xl flex flex-col animate-slide-in duration-300">
      {/* Top Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="h-4 w-4 text-amber-500 animate-pulse" />
          <span className="text-[13px] font-bold tracking-tight text-ink uppercase">Workspace Cockpit</span>
        </div>

        <button
          onClick={() => setCockpitOpen(false)}
          className="p-1 rounded-md hover:bg-paper-raised text-ink-muted hover:text-ink transition-colors duration-150"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-line bg-paper-raised/40 p-1">
        <button
          onClick={() => setActiveTab("kanban")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-bold rounded-lg transition-all duration-200 ${
            activeTab === "kanban"
              ? "bg-paper border border-line text-amber-500 shadow-sm"
              : "text-ink-muted hover:text-ink hover:bg-paper/30"
          }`}
        >
          <ClipboardList className="h-3.5 w-3.5" />
          <span>Task Board</span>
        </button>

        <button
          onClick={() => setActiveTab("agenda")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-bold rounded-lg transition-all duration-200 ${
            activeTab === "agenda"
              ? "bg-paper border border-line text-amber-500 shadow-sm"
              : "text-ink-muted hover:text-ink hover:bg-paper/30"
          }`}
        >
          <Calendar className="h-3.5 w-3.5" />
          <span>Agenda</span>
        </button>
      </div>

      {/* View Content Panel */}
      <div className="flex-1 overflow-hidden p-4">
        {activeTab === "kanban" ? <KanbanBoard /> : <DailyAgenda />}
      </div>
    </div>
  );
}
