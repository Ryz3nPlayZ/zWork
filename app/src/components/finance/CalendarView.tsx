/** The week ahead: who reports earnings each day (biggest first) and the economic releases. */
import { useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useFinance } from "./financeStore";
import { shortDate } from "./MarketsView";
import { big, Card, Empty, pct, Spinner, tone, useLoad } from "./ui";

export function CalendarView() {
  const open = useFinance((s) => s.open);
  const [cal, error] = useLoad("calendar5", () => api.financeCalendar(5));
  const days = [...new Set([...(cal?.earnings ?? []).map((e) => e.date), ...(cal?.economy ?? []).map((e) => e.date)])].sort();
  const [picked, setPicked] = useState("");
  const day = days.includes(picked) ? picked : days[0] ?? "";
  const earnings = (cal?.earnings ?? []).filter((e) => e.date === day).sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  const economy = (cal?.economy ?? []).filter((e) => e.date === day);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight text-ink">Calendar</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">Earnings reports and economic releases for the next five trading days.</p>
      </div>
      {error ? (
        <Card><Empty>The calendar isn't available right now. Try again in a minute.</Empty></Card>
      ) : !cal ? (
        <Spinner className="h-64" />
      ) : days.length === 0 ? (
        <Card><Empty>Nothing is scheduled for the next five days.</Empty></Card>
      ) : (
        <>
          <div role="tablist" aria-label="Day" className="flex gap-1.5 overflow-x-auto">
            {days.map((d) => {
              const n = cal.earnings.filter((e) => e.date === d).length;
              return (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={d === day}
                  onClick={() => setPicked(d)}
                  className={cn("press ring-focus flex shrink-0 flex-col items-start rounded-xl border px-3 py-1.5 text-left", d === day ? "border-line-strong bg-state-selected" : "border-line hover:bg-state-hover")}
                >
                  <span className="text-[12.5px] font-medium text-ink">{shortDate(d)}</span>
                  <span className="text-[11px] text-ink-faint">{n} report{n === 1 ? "" : "s"}</span>
                </button>
              );
            })}
          </div>
          <div className="grid gap-4 [@container(min-width:900px)]:grid-cols-[1.6fr_1fr]">
            <Card panel="calendar" title="Earnings" action={<span className="text-[11.5px] text-ink-faint">Biggest companies first</span>}>
              {earnings.length === 0 ? (
                <Empty>No earnings reports this day.</Empty>
              ) : (
                <div className="-mx-4 overflow-x-auto px-4">
                  <table className="fin-table w-full min-w-[480px] text-[12.5px] tabular-nums">
                    <thead>
                      <tr className="text-ink-faint">
                        <th className="py-1 text-left font-normal">Company</th>
                        <th className="py-1 text-left font-normal">When</th>
                        <th className="py-1 text-right font-normal" title="Analysts' average estimate of earnings per share">EPS estimate</th>
                        <th className="py-1 text-right font-normal">Reported</th>
                        <th className="py-1 text-right font-normal">Market value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {earnings.slice(0, 150).map((e) => (
                        <tr key={e.symbol} onClick={() => open(e.symbol, "earnings")} className="cursor-pointer border-t border-line-soft hover:bg-state-hover">
                          <td className="max-w-[220px] py-1.5 pr-2">
                            <button type="button" onClick={(ev) => { ev.stopPropagation(); open(e.symbol, "earnings"); }} className="ring-focus flex min-w-0 items-baseline gap-2 rounded text-left">
                              <span className="w-12 shrink-0 font-semibold text-ink">{e.symbol}</span>
                              <span className="truncate text-ink-muted">{e.name}</span>
                            </button>
                          </td>
                          <td className="py-1.5 text-ink-muted">{e.time || "–"}</td>
                          <td className="py-1.5 text-right text-ink">{e.estimate == null ? "–" : e.estimate.toFixed(2)}</td>
                          <td className="py-1.5 text-right text-ink">
                            {e.eps == null ? "–" : e.eps.toFixed(2)}
                            {e.surprisePct != null && <span className="ml-1 text-[11px]" style={{ color: tone(e.surprisePct) }}>{pct(e.surprisePct, true, 0)}</span>}
                          </td>
                          <td className="py-1.5 text-right text-ink-muted">{big(e.marketCap, "$")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card panel="economy" title="Economy" action={<span className="text-[11.5px] text-ink-faint">Times in GMT</span>}>
              {economy.length === 0 ? (
                <Empty>No economic releases this day.</Empty>
              ) : (
                <ul className="flex flex-col">
                  {economy.map((e, i) => (
                    <li key={i} className="fin-row flex flex-col gap-0.5 border-t border-line-soft py-2 first:border-t-0 first:pt-0">
                      <div className="flex items-baseline gap-2 text-[12.5px]">
                        <span className="w-11 shrink-0 tabular-nums text-ink-faint">{e.time}</span>
                        <span className="min-w-0 flex-1 text-ink">{e.event}</span>
                      </div>
                      {(e.actual || e.consensus || e.previous) && (
                        <div className="ml-[52px] flex flex-wrap gap-x-3 text-[11.5px] tabular-nums text-ink-faint">
                          {e.actual && <span>Actual <span className="text-ink">{e.actual}</span></span>}
                          {e.consensus && <span>Expected {e.consensus}</span>}
                          {e.previous && <span>Before {e.previous}</span>}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
