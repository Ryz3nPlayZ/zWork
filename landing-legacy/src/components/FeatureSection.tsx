import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const serif = { fontFamily: "var(--font-serif)" };

const features = [
  {
    num: "01",
    title: "Chat-first execution",
    description:
      "Describe what you need in plain language. zWork plans, executes, and reports back — no scripting required.",
  },
  {
    num: "02",
    title: "Local file & command workflows",
    description:
      "Read, write, and run on your actual machine. Your files stay local. Your commands run natively.",
  },
  {
    num: "03",
    title: "Reusable skills & playbooks",
    description:
      "Teach zWork a workflow once, then call it by name. Skills are plain Markdown files you can version and share.",
  },
  {
    num: "04",
    title: "Personalization & memory",
    description:
      "zWork remembers your preferences, project context, and working style across sessions.",
  },
  {
    num: "05",
    title: "Model & provider flexibility",
    description:
      "Bring your own keys — OpenAI, Anthropic, or local Ollama. Switch models mid-conversation.",
  },
  {
    num: "06",
    title: "Private by default",
    description:
      "No cloud proxy. No telemetry. Your chats, files, and credentials never leave your machine unless you choose.",
  },
];

export function FeatureSection() {
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      rowsRef.current.forEach((row) => {
        if (!row) return;
        gsap.fromTo(
          row,
          { y: 50, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.8,
            ease: "power2.out",
            scrollTrigger: {
              trigger: row,
              start: "top 85%",
              toggleActions: "play none none none",
            },
          }
        );
      });
    });
    return () => ctx.revert();
  }, []);

  return (
    <section className="relative z-50 bg-[#f7f6f3] py-28 md:py-36 px-6">
      <div className="max-w-6xl mx-auto">
        {/* Intro */}
        <div className="mb-24 md:mb-32">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#6b6a65] block mb-4">
            Capabilities
          </span>
          <h2
            className="text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tight text-[#171716] max-w-3xl"
            style={serif}
          >
            AI that does real work on your machine
          </h2>
          <p className="mt-6 text-lg md:text-xl text-[#6b6a65] max-w-2xl leading-relaxed">
            zWork is a desktop assistant built for people who ship. It reads
            your files, runs your commands, and keeps track of ongoing work —
            all through a native app interface.
          </p>
        </div>

        {/* Alternating rows — text only */}
        <div className="space-y-28 md:space-y-36">
          {features.map((feature, i) => {
            const isLeft = i % 2 === 0;
            return (
              <div
                key={feature.title}
                ref={(el) => { rowsRef.current[i] = el; }}
                className={`flex flex-col ${isLeft ? "md:items-start" : "md:items-end"} items-start gap-4`}
              >
                <div className="flex items-center gap-4">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a09e98]">
                    {feature.num}
                  </span>
                  <div className="h-[1px] w-8 bg-[#e6e3dc]" />
                </div>
                <h3
                  className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-[#171716] max-w-3xl"
                  style={serif}
                >
                  {feature.title}
                </h3>
                <p className="text-lg md:text-xl text-[#6b6a65] leading-relaxed max-w-xl">
                  {feature.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
