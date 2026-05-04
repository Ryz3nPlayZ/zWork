import { useState } from "react";
import { TrendingUp, Info } from "lucide-react";
import { cn } from "../lib/cn";

function StatBar({
  label,
  percent,
}: {
  label: string;
  percent: number;
}) {
  const clampedPercent = Math.max(0, Math.min(100, percent));

  const barOpacity =
    clampedPercent > 50 ? "bg-ink/70" : clampedPercent > 25 ? "bg-ink/50" : "bg-ink/30";

  return (
    <div className="space-y-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-ink-muted">{label}</span>
        <span className="text-[22px] font-light tracking-tight text-ink">
          {clampedPercent}% remaining
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-paper-sunken">
        <div
          className={cn("h-full rounded-full transition-all duration-500", barOpacity)}
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
    </div>
  );
}

function generateActivityData(days: number) {
  const data = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const value = Math.random() > 0.1 ? Math.floor(Math.random() * 40) + 5 : 0;

    data.push({
      date: dateStr,
      value,
    });
  }
  return data;
}

export function AnalyticsPage() {
  const [timeRange, setTimeRange] = useState<"7d" | "30d">("7d");
  const [activityData] = useState({
    "7d": generateActivityData(7),
    "30d": generateActivityData(30),
  });
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);

  const currentData = activityData[timeRange];
  const maxValue = Math.max(20, ...currentData.map((d) => d.value));

  const handleChartMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const chartWidth = rect.width - 40;
    const x = e.clientX - rect.left - 40;
    const barCount = currentData.length;
    const index = Math.floor((x / chartWidth) * barCount);

    if (index >= 0 && index < barCount) {
      setHoveredIndex(index);
      setTooltipPosition({ x: e.clientX, y: e.clientY });
    } else {
      setHoveredIndex(null);
      setTooltipPosition(null);
    }
  };

  const handleChartMouseLeave = () => {
    setHoveredIndex(null);
    setTooltipPosition(null);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[700px] px-6 py-8">

        {/* Header */}
        <header className="mb-8 border-b border-line/50 pb-6">
          <h1 className="text-[36px] font-light tracking-tight text-ink">
            Analytics
          </h1>
          <p className="mt-2 text-[14px] text-ink-muted">
            Your usage and activity overview
          </p>
        </header>

        {/* Usage Section */}
        <section className="mb-6 rounded-2xl border border-line bg-paper p-6">
          <div className="mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-ink-muted" />
            <h2 className="text-[16px] font-semibold text-ink">Usage Limits</h2>
          </div>
          <div className="space-y-5">
            <StatBar
              label="5-hour usage limit"
              percent={64}
            />
            <StatBar
              label="Weekly usage limit"
              percent={30}
            />
          </div>
        </section>

        {/* Activity Chart */}
        <section className="rounded-2xl border border-line bg-paper p-6">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-[16px] font-semibold text-ink">Activity</h2>
              <p className="mt-0.5 text-[13px] text-ink-muted">Daily requests over time</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 rounded-full border border-line/60 bg-paper-raised p-0.5">
                <button
                  type="button"
                  onClick={() => setTimeRange("7d")}
                  className={cn(
                    "ring-focus rounded-full px-3 py-1 text-[12px] font-medium transition-all",
                    timeRange === "7d"
                      ? "bg-ink/90 text-paper shadow-sm"
                      : "text-ink-muted hover:text-ink hover:bg-paper-sunken/50"
                  )}
                >
                  7 days
                </button>
                <button
                  type="button"
                  onClick={() => setTimeRange("30d")}
                  className={cn(
                    "ring-focus rounded-full px-3 py-1 text-[12px] font-medium transition-all",
                    timeRange === "30d"
                      ? "bg-ink/90 text-paper shadow-sm"
                      : "text-ink-muted hover:text-ink hover:bg-paper-sunken/50"
                  )}
                >
                  30 days
                </button>
              </div>
              <button
                type="button"
                className="press ring-focus flex h-8 w-8 items-center justify-center rounded-lg border border-line/50 bg-paper text-ink-faint hover:bg-paper-sunken hover:text-ink"
                aria-label="Activity chart info"
                title="Daily request count over the selected period"
              >
                <Info className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Chart Container */}
          <div
            className="relative"
            onMouseMove={handleChartMouseMove}
            onMouseLeave={handleChartMouseLeave}
          >
            {/* Y-axis labels */}
            <div className="absolute inset-y-0 left-0 flex w-10 flex-col justify-between text-[11px] text-ink-faint">
              <span>{maxValue}</span>
              <span>{Math.round(maxValue * 0.75)}</span>
              <span>{Math.round(maxValue * 0.5)}</span>
              <span>{Math.round(maxValue * 0.25)}</span>
              <span>0</span>
            </div>

            {/* Chart area */}
            <div className="ml-10 relative" style={{ height: "160px" }}>
              {/* Grid lines */}
              <div className="absolute inset-0 pointer-events-none">
                {[0, 0.25, 0.5, 0.75].map((pos, i) => (
                  <div
                    key={i}
                    className="absolute left-0 right-0 border-t border-line/40"
                    style={{ top: `${pos * 100}%` }}
                  />
                ))}
              </div>

              {/* Bars */}
              <div className="relative flex items-end gap-1 h-full">
                {currentData.map((day, index) => {
                  const isHovered = hoveredIndex === index;
                  const barHeight = day.value > 0 ? Math.max(4, (day.value / maxValue) * 160) : 0;

                  return (
                    <div
                      key={index}
                      className={cn(
                        "flex-1 rounded-t transition-all duration-200",
                        isHovered ? "bg-ink/80 scale-y-[1.02]" : "bg-ink/60",
                        day.value === 0 && "bg-transparent"
                      )}
                      style={{
                        height: `${barHeight}px`,
                        minWidth: 2,
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {/* X-axis labels */}
            <div className="ml-10 mt-2 flex text-[11px] text-ink-faint">
              <span>{currentData[0]?.date}</span>
              <span className="flex-1 text-center">{currentData[Math.floor(currentData.length / 2)]?.date}</span>
              <span>{currentData[currentData.length - 1]?.date}</span>
            </div>
          </div>

          {/* Tooltip */}
          {hoveredIndex !== null && tooltipPosition && (
            <div
              className="fixed z-50 rounded-xl border border-line/80 bg-paper-raised px-3 py-2 shadow-pop"
              style={{
                left: `${tooltipPosition.x + 12}px`,
                top: `${tooltipPosition.y - 8}px`,
              }}
            >
              <div className="text-[12px] text-ink-muted">{currentData[hoveredIndex]?.date}</div>
              <div className="text-[14px] font-semibold text-ink">{currentData[hoveredIndex]?.value} requests</div>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
