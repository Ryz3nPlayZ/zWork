import { useRef, useCallback } from "react";
import { ChatShell, UserMsg, AssistantMsg, FileBadge, ThinkingDots, MiniBarChart, DataTable, useDemoTimeline, typeText } from "./ChatShell";

export function FileReadingDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const msg1Ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLDivElement>(null);
  const thinkRef = useRef<HTMLDivElement>(null);
  const msg2Ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const insightRef = useRef<HTMLDivElement>(null);

  const buildTimeline = useCallback((tl: gsap.core.Timeline) => {
    tl.call(() => typeText(composerRef.current, "Which product lines grew the most this quarter?", 32));
    tl.to({}, { duration: 2.0 });

    // Send message + attach files
    tl.to(composerRef.current, { opacity: 0, duration: 0.15 });
    tl.set(composerRef.current, { textContent: "" });
    tl.fromTo(msg1Ref.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35 });
    tl.fromTo(fileRef.current, { opacity: 0, scale: 0.95 }, { opacity: 1, scale: 1, duration: 0.3 }, "-=0.15");
    tl.to(composerRef.current, { opacity: 1, duration: 0.1 });

    // Thinking
    tl.fromTo(thinkRef.current, { opacity: 0 }, { opacity: 1, duration: 0.25 });
    tl.to({}, { duration: 1.8 });
    tl.to(thinkRef.current, { opacity: 0, duration: 0.2 });

    // Rich response: intro text + bar chart + table + insights — stagger in
    tl.fromTo(msg2Ref.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 });
    tl.fromTo(chartRef.current, { opacity: 0, y: 8, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.45 }, "-=0.2");
    tl.fromTo(tableRef.current, { opacity: 0, y: 8, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.45 }, "-=0.25");
    tl.fromTo(insightRef.current, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4 }, "-=0.2");

    // Hold for reading
    tl.to({}, { duration: 5.0 });

    // Fade out for loop
    tl.to([msg1Ref.current, fileRef.current, msg2Ref.current, chartRef.current, tableRef.current, insightRef.current], {
      opacity: 0, duration: 0.5, stagger: 0.04,
    });
  }, []);

  useDemoTimeline(containerRef, buildTimeline, []);

  return (
    <div ref={containerRef} className="w-full max-w-[580px] mx-auto">
      <ChatShell composerTextRef={composerRef} className="h-[480px] md:h-[520px]">
        <div ref={msg1Ref} className="opacity-0">
          <UserMsg>Which product lines grew the most this quarter?</UserMsg>
          <div ref={fileRef} className="opacity-0 flex justify-end -mt-1.5 mb-3 gap-1.5 flex-wrap">
            <FileBadge name="Q3_Sales.csv" size="1.2 MB" />
            <FileBadge name="Q2_Sales.csv" size="980 KB" />
          </div>
        </div>

        <div ref={thinkRef} className="opacity-0 pl-7 mb-3">
          <ThinkingDots />
        </div>

        <div ref={msg2Ref} className="opacity-0">
          <AssistantMsg>
            <p className="text-[12.5px] leading-5 mb-2">
              I analyzed both quarters. Here is the growth breakdown:
            </p>
          </AssistantMsg>
        </div>

        <div ref={chartRef} className="opacity-0 pl-7 mb-3">
          <MiniBarChart
            data={[
              { label: "Enterprise", value: 142, color: "#171716" },
              { label: "Pro Tier", value: 89, color: "#4a4a4e" },
              { label: "Starter", value: 34, color: "#a09e98" },
              { label: "Add-ons", value: 67, color: "#6b6a65" },
            ]}
          />
        </div>

        <div ref={tableRef} className="opacity-0 pl-7 mb-3">
          <DataTable
            headers={["Product", "Q2", "Q3", "Growth" ]}
            rows={[
              ["Enterprise", "$4.2M", "$10.2M", "+142%"],
              ["Pro Tier", "$2.8M", "$5.3M", "+89%"],
              ["Add-ons", "$1.1M", "$1.8M", "+67%"],
              ["Starter", "$3.4M", "$4.5M", "+34%"],
            ]}
          />
        </div>

        <div ref={insightRef} className="opacity-0 pl-7">
          <AssistantMsg avatar={false}>
            <div className="space-y-1.5">
              <p className="text-[12.5px] leading-5 font-medium text-[#171716]">Key findings:</p>
              <ul className="space-y-1 text-[12px] text-[#25241f]">
                <li className="flex items-start gap-1.5">
                  <span className="text-emerald-600 mt-0.5 shrink-0">▲</span>
                  <span>Enterprise is now <strong className="text-[#171716]">58% of total revenue</strong> — up from 32%</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="text-emerald-600 mt-0.5 shrink-0">▲</span>
                  <span>Churn on Starter tier dropped to <strong className="text-[#171716]">2.1%</strong> after the July pricing update</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="text-amber-500 mt-0.5 shrink-0">●</span>
                  <span>Add-ons grew slower than projected — recommend bundling with Pro</span>
                </li>
              </ul>
            </div>
          </AssistantMsg>
        </div>
      </ChatShell>
    </div>
  );
}
