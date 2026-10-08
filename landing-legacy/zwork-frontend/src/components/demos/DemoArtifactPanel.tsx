import {
  FileText,
  Table2,
  CheckSquare,
  BarChart3,
  X,
  MoreHorizontal,
  Download,
} from "lucide-react";

const ICONS = {
  doc: FileText,
  sheet: Table2,
  tasks: CheckSquare,
  graph: BarChart3,
};

export function DemoArtifactPanel({
  type,
  title,
  visible,
  children,
}: {
  type: "doc" | "sheet" | "tasks" | "graph";
  title: string;
  visible: boolean;
  children?: React.ReactNode;
}) {
  const Icon = ICONS[type];

  if (!visible) return null;

  return (
    <div className="animate-slide-up flex h-full w-[320px] shrink-0 flex-col border-l border-line bg-paper">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-ink-muted" />
          <span className="text-[13px] font-medium text-ink">{title}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-paper-sunken hover:text-ink"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-paper-sunken hover:text-ink"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-paper-sunken hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">{children}</div>
    </div>
  );
}

export function DemoDocContent({ items }: { items: string[] }) {
  return (
    <div className="space-y-3">
      <h3 className="text-[15px] font-semibold text-ink">Key Risks</h3>
      <ul className="list-disc space-y-2 pl-5 text-[13px] leading-6 text-ink-soft">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
      <p className="mt-4 text-[12px] text-ink-faint">
        Saved to Documents/Q1_Risks.md
      </p>
    </div>
  );
}

export function DemoSheetContent() {
  const rows = [
    { client: "Acme Corp", amount: "$42,300", status: "Paid" },
    { client: "Globex", amount: "$38,100", status: "Paid" },
    { client: "Initech", amount: "$27,500", status: "Pending" },
    { client: "Umbrella", amount: "$19,200", status: "Paid" },
  ];
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-line bg-paper-sunken">
            <th className="px-3 py-1.5 text-left font-semibold text-ink">Client</th>
            <th className="px-3 py-1.5 text-left font-semibold text-ink">Amount</th>
            <th className="px-3 py-1.5 text-left font-semibold text-ink">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line">
              <td className="px-3 py-1.5 text-ink">{row.client}</td>
              <td className="px-3 py-1.5 text-ink">{row.amount}</td>
              <td className="px-3 py-1.5">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    row.status === "Paid"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {row.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DemoTasksContent() {
  const tasks = [
    { label: "Finalize pricing page copy", due: "Tomorrow" },
    { label: "Schedule user interviews", due: "May 3" },
    { label: "Review analytics dashboard", due: "May 5" },
    { label: "Draft changelog for v0.4", due: "May 6" },
    { label: "Update onboarding screenshots", due: "May 7" },
  ];
  return (
    <div className="space-y-2">
      {tasks.map((task, i) => (
        <div
          key={i}
          className="flex items-center gap-2.5 rounded-lg border border-line bg-paper-raised px-3 py-2"
        >
          <div className="h-4 w-4 rounded border border-line bg-paper" />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-ink">{task.label}</div>
            <div className="text-[11px] text-ink-faint">Due {task.due}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
