import { useRef, useCallback } from "react";
import { ChatShell, UserMsg, AssistantMsg, ActivityPill, TerminalOutput, useDemoTimeline, typeText } from "./ChatShell";

export function HeroDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const msg1Ref = useRef<HTMLDivElement>(null);
  const act1Ref = useRef<HTMLDivElement>(null);
  const act2Ref = useRef<HTMLDivElement>(null);
  const act3Ref = useRef<HTMLDivElement>(null);
  const msg2Ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const msg3Ref = useRef<HTMLDivElement>(null);

  const buildTimeline = useCallback((tl: gsap.core.Timeline) => {
    tl.call(() => typeText(composerRef.current, "Organize last month's receipts and create the expense report", 28));
    tl.to({}, { duration: 2.4 });

    tl.to(composerRef.current, { opacity: 0, duration: 0.15 });
    tl.set(composerRef.current, { textContent: "" });
    tl.fromTo(msg1Ref.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35 });
    tl.to(composerRef.current, { opacity: 1, duration: 0.1 });

    // Activities — faster pace for hero
    tl.fromTo(act1Ref.current, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.25 });
    tl.to({}, { duration: 0.7 });
    tl.fromTo(act2Ref.current, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.25 });
    tl.to({}, { duration: 0.7 });
    tl.fromTo(act3Ref.current, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.25 });
    tl.to({}, { duration: 0.7 });

    // Results
    tl.to([act1Ref.current, act2Ref.current, act3Ref.current], { opacity: 0, duration: 0.2, stagger: 0.04 });
    tl.fromTo(msg2Ref.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 });
    tl.fromTo(termRef.current, { opacity: 0, y: 8, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.4 }, "-=0.2");
    tl.fromTo(msg3Ref.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 }, "-=0.15");

    tl.to({}, { duration: 5.0 });

    tl.to([msg1Ref.current, msg2Ref.current, msg3Ref.current, termRef.current], {
      opacity: 0, duration: 0.5, stagger: 0.04,
    });
  }, []);

  useDemoTimeline(containerRef, buildTimeline, []);

  return (
    <div ref={containerRef} className="w-full max-w-[680px] mx-auto">
      <ChatShell composerTextRef={composerRef} className="h-[420px] md:h-[460px]">
        <div ref={msg1Ref} className="opacity-0">
          <UserMsg>Organize last month's receipts and create the expense report</UserMsg>
        </div>

        <div ref={act1Ref} className="opacity-0 pl-7 mb-1.5">
          <ActivityPill text="Scanning ~/Downloads and ~/Documents for receipts..." />
        </div>
        <div ref={act2Ref} className="opacity-0 pl-7 mb-1.5">
          <ActivityPill text="Reading 23 PDFs and 4 images — extracting amounts, dates, vendors..." />
        </div>
        <div ref={act3Ref} className="opacity-0 pl-7 mb-2">
          <ActivityPill text="Categorizing by project code and generating report..." />
        </div>

        <div ref={msg2Ref} className="opacity-0">
          <AssistantMsg>
            <p className="text-[12.5px] leading-5 mb-1">
              Found <strong className="text-[#171716]">27 receipts</strong> totaling <strong className="text-[#171716]">$4,231.50</strong>. Categorized by project and flagged 3 that need manager approval (over $500). Here's your report:
            </p>
          </AssistantMsg>
        </div>

        <div ref={termRef} className="opacity-0 pl-7 mb-2">
          <TerminalOutput
            lines={[
              { text: "Expense Report — October 2024", type: "out" },
              { text: "─────────────────────────────", type: "out" },
              { text: "Travel & Meals      $1,840.00", type: "out" },
              { text: "Software & Tools      $624.50", type: "out" },
              { text: "Office Supplies       $412.00", type: "out" },
              { text: "Cloud Infrastructure  $1,355.00", type: "out" },
              { text: "─────────────────────────────", type: "out" },
              { text: "TOTAL              $4,231.50", type: "ok" },
              { text: "", type: "out" },
              { text: "✓ Saved to ~/Reports/Expenses_Oct2024.pdf", type: "ok" },
            ]}
          />
        </div>

        <div ref={msg3Ref} className="opacity-0 pl-7">
          <AssistantMsg>
            <p className="text-[12.5px] leading-5">
              The 3 flagged receipts are in <code className="font-mono text-[11px] bg-[#efede8] px-1 rounded">~/Reports/needs_approval/</code>. Want me to draft the approval email to your manager?
            </p>
          </AssistantMsg>
        </div>
      </ChatShell>
    </div>
  );
}
