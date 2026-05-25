import { KanbanBoard } from "./KanbanBoard";
import { DailyAgenda } from "./DailyAgenda";
import { LayoutDashboard } from "lucide-react";

export function CockpitPage() {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[1200px] px-6 py-10">
        {/* Header */}
        <div className="mb-8 flex items-start gap-4">
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
    </div>
  );
}
