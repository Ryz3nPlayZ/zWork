import { useRef, useCallback } from "react";
import { ChatShell, UserMsg, AssistantMsg, ActivityPill, CodeBlock, TerminalOutput, useDemoTimeline, typeText } from "./ChatShell";

export function TaskDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const msg1Ref = useRef<HTMLDivElement>(null);
  const act1Ref = useRef<HTMLDivElement>(null);
  const act2Ref = useRef<HTMLDivElement>(null);
  const act3Ref = useRef<HTMLDivElement>(null);
  const act4Ref = useRef<HTMLDivElement>(null);
  const msg2Ref = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);

  const buildTimeline = useCallback((tl: gsap.core.Timeline) => {
    tl.call(() => typeText(composerRef.current, "The CI build is failing on auth module tests", 30));
    tl.to({}, { duration: 2.0 });

    tl.to(composerRef.current, { opacity: 0, duration: 0.15 });
    tl.set(composerRef.current, { textContent: "" });
    tl.fromTo(msg1Ref.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35 });
    tl.to(composerRef.current, { opacity: 1, duration: 0.1 });

    // Activities stagger in with realistic timing
    tl.fromTo(act1Ref.current, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.3 });
    tl.to({}, { duration: 1.0 });
    tl.fromTo(act2Ref.current, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.3 });
    tl.to({}, { duration: 1.0 });
    tl.fromTo(act3Ref.current, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.3 });
    tl.to({}, { duration: 0.8 });
    tl.fromTo(act4Ref.current, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.3 });
    tl.to({}, { duration: 0.8 });

    // Fade activities, show analysis + code fix + terminal
    tl.to([act1Ref.current, act2Ref.current, act3Ref.current, act4Ref.current], { opacity: 0, duration: 0.25, stagger: 0.05 });
    tl.fromTo(msg2Ref.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 });
    tl.fromTo(codeRef.current, { opacity: 0, y: 8, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.45 }, "-=0.2");
    tl.fromTo(termRef.current, { opacity: 0, y: 8, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.45 }, "-=0.25");

    tl.to({}, { duration: 5.5 });

    tl.to([msg1Ref.current, msg2Ref.current, codeRef.current, termRef.current], { opacity: 0, duration: 0.5, stagger: 0.04 });
  }, []);

  useDemoTimeline(containerRef, buildTimeline, []);

  return (
    <div ref={containerRef} className="w-full max-w-[580px] mx-auto">
      <ChatShell composerTextRef={composerRef} className="h-[520px] md:h-[560px]">
        <div ref={msg1Ref} className="opacity-0">
          <UserMsg>The CI build is failing on auth module tests</UserMsg>
        </div>

        <div ref={act1Ref} className="opacity-0 pl-7 mb-1.5">
          <ActivityPill text="Reading CI error logs..." />
        </div>
        <div ref={act2Ref} className="opacity-0 pl-7 mb-1.5">
          <ActivityPill text="Searching auth/ for test failures..." />
        </div>
        <div ref={act3Ref} className="opacity-0 pl-7 mb-1.5">
          <ActivityPill text="Found 3 files with breaking changes..." />
        </div>
        <div ref={act4Ref} className="opacity-0 pl-7 mb-2">
          <ActivityPill text="Applying fixes and running tests..." />
        </div>

        <div ref={msg2Ref} className="opacity-0">
          <AssistantMsg>
            <p className="text-[12.5px] leading-5 mb-1">
              Found it. <code className="font-mono text-[11px] bg-[#efede8] px-1 rounded">validateToken</code> was comparing strings with <code className="font-mono text-[11px] bg-[#efede8] px-1 rounded">==</code> instead of timing-safe comparison. Fixed + added test coverage.
            </p>
          </AssistantMsg>
        </div>

        <div ref={codeRef} className="opacity-0 pl-7 mb-2">
          <CodeBlock
            language="auth/token.ts"
            code={`// Before (vulnerable + failing)
if (token == storedToken) { ... }

// After (timing-safe)
if (crypto.timingSafeEqual(
  Buffer.from(token),
  Buffer.from(storedToken)
)) { ... }`}
          />
        </div>

        <div ref={termRef} className="opacity-0 pl-7">
          <TerminalOutput
            lines={[
              { text: "cd src/auth && npm test", type: "in" },
              { text: "Running 42 tests..." },
              { text: "✓ validateToken returns user on valid JWT", type: "ok" },
              { text: "✓ validateToken rejects expired tokens", type: "ok" },
              { text: "✓ validateToken prevents timing attacks", type: "ok" },
              { text: "42 passing (1.2s) · Coverage: 94%", type: "ok" },
            ]}
          />
        </div>
      </ChatShell>
    </div>
  );
}
