import { CircleHelp, Copy, Download, Eye, Globe, Pencil, Send, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import type { Panel } from "./types";

export const Q3_ROWS: [string, string, string, number][] = [
  ["Advertising", "$15,320.32", "35.1%", 17],
  ["Contractors & Freelance", "$12,816.35", "29.3%", 10],
  ["Office & Workspace", "$6,450.00", "14.8%", 3],
  ["Travel & Transport", "$5,146.40", "11.8%", 14],
  ["Office Supplies & Equipment", "$1,078.74", "2.5%", 11],
  ["Software & Subscriptions", "$752.22", "1.7%", 12],
  ["Cloud Infrastructure", "$744.93", "1.7%", 5],
  ["Utilities", "$630.34", "1.4%", 3],
  ["Payroll & HR", "$447.00", "1.0%", 3],
  ["Meals & Entertainment", "$301.48", "0.7%", 8],
];

function ToolbarButton({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-paper px-2.5 py-1 text-[11px] text-ink-muted [&_svg]:h-3 [&_svg]:w-3">
      {icon}
      {children}
    </span>
  );
}

function Report({ progress }: { progress: number }) {
  const shown = Math.round(progress * (Q3_ROWS.length + 3));
  return (
    <div className="px-10 pb-10 pt-12">
      <h1 className="border-b border-line pb-3 text-[24px] font-semibold tracking-tight text-ink">Q3 2026 Spending Report</h1>
      {shown > 0 && (
        <p className="mt-4 border-b border-line pb-5 text-[14.5px] leading-[27px] text-ink">
          <strong className="font-semibold">Period:</strong> July 1 – September 30, 2026 · <strong className="font-semibold">Total spend:</strong>{" "}
          $43,687.78 (86 transactions)
        </p>
      )}
      {shown > 1 && (
        <>
          <h2 className="mt-7 text-[17px] font-semibold text-ink">1. Totals by category</h2>
          <table className="mt-4 w-full border-collapse text-[13.5px] text-ink">
            <thead>
              <tr className="border-b border-line-strong text-left font-semibold">
                <th className="py-2.5 font-semibold">Category</th>
                <th className="py-2.5 text-right font-semibold">Total</th>
                <th className="py-2.5 text-right font-semibold">% of spend</th>
                <th className="py-2.5 text-right font-semibold">Txns</th>
              </tr>
            </thead>
            <tbody>
              {Q3_ROWS.slice(0, Math.max(0, shown - 2)).map(([c, t, p, n]) => (
                <tr key={c} className="border-b border-line">
                  <td className="py-[9px]">{c}</td>
                  <td className="py-[9px] text-right tabular-nums">{t}</td>
                  <td className="py-[9px] text-right tabular-nums">{p}</td>
                  <td className="py-[9px] text-right tabular-nums">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {shown >= Q3_ROWS.length + 3 && (
        <h3 className="mt-6 text-[15px] font-semibold text-ink">Advertising + Contractors together = 64% of all spend</h3>
      )}
    </div>
  );
}

const EMAIL_BODY = `Hi Priya,

Thanks for the quick turnaround on the Q3 numbers. Two things before Thursday's review:

1. The Blue Bottle charge on Aug 14 ($51.38) was billed twice. I've removed the duplicate in our copy; can you confirm on your side?
2. Contractor spend came in at $12.8k, 29% of the quarter. I've attached the breakdown by vendor.

Happy to walk through it on the call.

Best,
Sam`;

function Email({ progress }: { progress: number }) {
  const body = EMAIL_BODY.slice(0, Math.round(progress * EMAIL_BODY.length));
  return (
    <div className="px-8 pb-8 pt-8 text-[14px] text-ink">
      <div className="divide-y divide-line rounded-xl border border-line">
        {[
          ["To", "priya@northwind-accounting.com"],
          ["Subject", "Q3 expenses: one duplicate, contractor breakdown attached"],
          ["Attachment", "q3_contractors_by_vendor.xlsx"],
        ].map(([k, v]) => (
          <div key={k} className="flex gap-3 px-3.5 py-2.5">
            <span className="w-[84px] shrink-0 text-ink-muted">{k}</span>
            <span className="truncate">{v}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 whitespace-pre-wrap leading-[24px]">{body}</div>
    </div>
  );
}

export function ArtifactPanel({ panel, width }: { panel: Panel; width: number }) {
  const email = panel.kind === "email";
  return (
    <aside style={{ width }} className="flex h-full shrink-0 flex-col border-l border-edge bg-paper">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
        <span className="truncate text-[13px] font-medium text-ink">{panel.title}</span>
        <X className="h-4 w-4 text-ink-muted" />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <div className="inline-flex rounded-lg border border-line bg-paper-raised p-0.5 text-[12px] font-medium">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-paper px-2.5 py-1 text-ink shadow-sm">
            <Eye className="h-3.5 w-3.5" />
            Preview
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-ink-muted">
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <ToolbarButton icon={<Copy />}>Copy</ToolbarButton>
          {email ? (
            <ToolbarButton icon={<Send />}>Send</ToolbarButton>
          ) : (
            <>
              <ToolbarButton icon={<Download />}>Export PDF</ToolbarButton>
              <ToolbarButton icon={<Download />}>Export Word</ToolbarButton>
              <ToolbarButton icon={<CircleHelp />}>Guide</ToolbarButton>
              <ToolbarButton icon={<Globe />}>Import URL</ToolbarButton>
            </>
          )}
        </div>
      </div>
      <div className="clone-scroll min-h-0 flex-1 overflow-hidden px-6 pt-3">
        <div className={cn("min-h-full rounded-t-2xl border border-b-0 border-line bg-paper-sunken")}>
          {email ? <Email progress={panel.progress} /> : <Report progress={panel.progress} />}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-edge px-4 py-1.5 text-[11px] text-ink-faint">
        <span>Press Enter for new block · Backspace to delete empty block</span>
        <span>Auto-saved</span>
      </div>
    </aside>
  );
}
