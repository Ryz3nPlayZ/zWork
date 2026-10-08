import { useRef, useCallback } from "react";
import { ChatShell, UserMsg, AssistantMsg, ArtifactCard, DataTable, ThinkingDots, useDemoTimeline, typeText } from "./ChatShell";

export function OutputDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const msg1Ref = useRef<HTMLDivElement>(null);
  const thinkRef = useRef<HTMLDivElement>(null);
  const msg2Ref = useRef<HTMLDivElement>(null);
  const artifactRef = useRef<HTMLDivElement>(null);

  const buildTimeline = useCallback((tl: gsap.core.Timeline) => {
    tl.call(() => typeText(composerRef.current, "Draft the Q4 hiring plan with budget breakdown", 28));
    tl.to({}, { duration: 2.2 });

    tl.to(composerRef.current, { opacity: 0, duration: 0.15 });
    tl.set(composerRef.current, { textContent: "" });
    tl.fromTo(msg1Ref.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35 });
    tl.to(composerRef.current, { opacity: 1, duration: 0.1 });

    tl.fromTo(thinkRef.current, { opacity: 0 }, { opacity: 1, duration: 0.25 });
    tl.to({}, { duration: 1.6 });
    tl.to(thinkRef.current, { opacity: 0, duration: 0.2 });

    tl.fromTo(msg2Ref.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 });
    tl.fromTo(artifactRef.current, { opacity: 0, y: 8, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.5 }, "-=0.2");
    tl.to({}, { duration: 6.0 });

    tl.to([msg1Ref.current, msg2Ref.current, artifactRef.current], { opacity: 0, duration: 0.5, stagger: 0.05 });
  }, []);

  useDemoTimeline(containerRef, buildTimeline, []);

  return (
    <div ref={containerRef} className="w-full max-w-[580px] mx-auto">
      <ChatShell composerTextRef={composerRef} className="h-[540px] md:h-[580px]">
        <div ref={msg1Ref} className="opacity-0">
          <UserMsg>Draft the Q4 hiring plan with budget breakdown</UserMsg>
        </div>

        <div ref={thinkRef} className="opacity-0 pl-7 mb-3">
          <ThinkingDots />
        </div>

        <div ref={msg2Ref} className="opacity-0">
          <AssistantMsg>
            <p className="text-[12.5px] leading-5 mb-1">
              Done. I've built a full Q4 hiring plan based on the team's Q3 growth and current backlog. Here's the summary:
            </p>
          </AssistantMsg>
        </div>

        <div ref={artifactRef} className="opacity-0 pl-7">
          <ArtifactCard title="Q4-Hiring-Plan.md">
            <div className="px-3 py-2.5 space-y-3">
              <div>
                <p className="text-[11px] font-medium text-[#171716] mb-1">Roles needed</p>
                <DataTable
                  headers={["Role", "Count", "Salary", "Total" ]}
                  rows={[
                    ["Senior Engineer", "2", "$165K", "$330K"],
                    ["Product Designer", "1", "$140K", "$140K"],
                    ["DevOps Engineer", "1", "$150K", "$150K"],
                    ["Growth Marketer", "1", "$110K", "$110K"],
                  ]}
                />
              </div>
              <div className="flex items-center justify-between text-[10.5px] text-[#6b6a65] border-t border-[#e6e3dc] pt-2">
                <span>Total new hires: <strong className="text-[#171716]">5</strong></span>
                <span>Total budget: <strong className="text-[#171716]">$730K</strong></span>
                <span>Timeline: <strong className="text-[#171716]">8 weeks</strong></span>
              </div>
              <div className="text-[10.5px] text-[#6b6a65] leading-4">
                <strong className="text-[#171716]">Priority order:</strong> DevOps (blocks infra roadmap) → Senior Engineers (feature velocity) → Designer (Q1 redesign) → Marketer (launch prep)
              </div>
            </div>
          </ArtifactCard>
        </div>
      </ChatShell>
    </div>
  );
}
