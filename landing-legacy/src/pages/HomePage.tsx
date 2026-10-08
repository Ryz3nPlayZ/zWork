import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { track } from "@vercel/analytics";
import { Logo } from "../components/Logo";
import { Footer } from "../components/Footer";
import { TopBar } from "../components/TopBar";

gsap.registerPlugin(ScrollTrigger);

const serif = { fontFamily: "var(--font-serif)" };

export default function HomePage() {
  const [showNav, setShowNav] = useState(false);

  /* ---------- HERO ---------- */
  const heroRef = useRef<HTMLDivElement>(null);
  const heroGroupRef = useRef<HTMLDivElement>(null);
  const heroLogoRef = useRef<HTMLDivElement>(null);
  const heroTextRef = useRef<HTMLHeadingElement>(null);
  const heroLightGroupRef = useRef<HTMLDivElement>(null);
  const heroLightLogoRef = useRef<HTMLDivElement>(null);
  const heroLightTextRef = useRef<HTMLDivElement>(null);
  const heroLightRef = useRef<HTMLDivElement>(null);
  const heroScanRef = useRef<HTMLDivElement>(null);
  const heroHintRef = useRef<HTMLDivElement>(null);

  /* ---------- NARRATIVE ---------- */
  const narRef = useRef<HTMLDivElement>(null);
  const narPhraseRef = useRef<HTMLDivElement>(null);
  const narChatgptRef = useRef<HTMLDivElement>(null);
  const narInsteadLightRef = useRef<HTMLDivElement>(null);
  const narInsteadDarkRef = useRef<HTMLDivElement>(null);
  const narFinalRef = useRef<HTMLDivElement>(null);
  const narStealRef = useRef<HTMLDivElement>(null);
  const narBgRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  /* ---------- CTA (inside narrative) ---------- */
  const ctaContentRef = useRef<HTMLDivElement>(null);
  const ctaTitleRef = useRef<HTMLHeadingElement>(null);
  const ctaDescRef = useRef<HTMLParagraphElement>(null);
  const ctaButtonsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      /* ---- HERO timeline ---- */
      gsap.set([heroTextRef.current, heroLightTextRef.current], { autoAlpha: 0, x: 60 });
      const heroTl = gsap.timeline({
        scrollTrigger: {
          trigger: heroRef.current,
          start: "top top",
          end: "+=400%",
          pin: true,
          scrub: 0.7,
          snap: {
            snapTo: (p) => {
              if (p < 0.18) return 0;
              if (p < 0.45) return 0.33;
              if (p < 0.72) return 0.58;
              if (p < 0.92) return 0.82;
              return 1;
            },
            duration: { min: 0.18, max: 0.4 },
            ease: "power1.inOut",
          },
        },
      });

      // Logo rolls left + shrinks, text reveals
      heroTl.to([heroLogoRef.current, heroLightLogoRef.current], {
        x: "-280px", rotation: -360, scale: 0.5,
        duration: 1, ease: "power2.inOut",
      }, 0);

      heroTl.fromTo([heroTextRef.current, heroLightTextRef.current],
        { autoAlpha: 0, x: 60 },
        { autoAlpha: 1, x: 0, duration: 1, ease: "power2.inOut" },
        0.15
      );

      // Shift group right to keep visual center balanced
      heroTl.to([heroGroupRef.current, heroLightGroupRef.current], {
        x: "140px", duration: 0.8, ease: "power2.inOut",
      }, 0.4);

      heroTl.to(heroHintRef.current, { opacity: 0, duration: 0.5 }, 0.15);

      // Both grow bigger together
      heroTl.to([heroGroupRef.current, heroLightGroupRef.current], {
        scale: 1.45, duration: 0.8, ease: "power2.inOut",
      }, 0.85);

      // Color inversion sweep
      heroTl.fromTo(heroLightRef.current,
        { clipPath: "inset(0 100% 0 0)" },
        { clipPath: "inset(0 0% 0 0)", duration: 1, ease: "power2.inOut" },
        1.4
      );
      heroTl.fromTo(heroScanRef.current,
        { left: "-5%", opacity: 0 },
        { left: "105%", opacity: 1, duration: 1, ease: "power2.inOut" },
        1.4
      );
      heroTl.to(heroScanRef.current, { opacity: 0, duration: 0.2 }, 2.15);

      /* ---- NARRATIVE timeline ---- */
      const words = narPhraseRef.current?.querySelectorAll<HTMLSpanElement>(".word");
      const chatgptEl = narChatgptRef.current;
      const insteadLight = narInsteadLightRef.current;
      const insteadDark = narInsteadDarkRef.current;
      const final = narFinalRef.current;
      const steal = narStealRef.current;
      const bg = narBgRef.current;
      const ctaContent = ctaContentRef.current;
      const ctaTitle = ctaTitleRef.current;
      const ctaDesc = ctaDescRef.current;
      const ctaButtons = ctaButtonsRef.current;

      if (!words || !chatgptEl || !insteadLight || !steal || !bg || !ctaContent) return;

      gsap.set(chatgptEl, { autoAlpha: 0, scale: 1 });
      gsap.set(insteadLight, { autoAlpha: 0 });
      gsap.set(insteadDark, { autoAlpha: 0 });
      gsap.set(final, { autoAlpha: 0, y: 30 });
      gsap.set(steal, { autoAlpha: 0, y: 20 });
      // Hide CTA initially
      gsap.set(ctaContent, { autoAlpha: 0 });
      gsap.set([ctaTitle, ctaDesc, ctaButtons], { autoAlpha: 0, y: 15 });

      const narTl = gsap.timeline({
        scrollTrigger: {
          trigger: narRef.current,
          start: "top top",
          end: "+=1600%",
          pin: true,
          scrub: 0.7,
        },
      });

      // 0.00 - 0.28: word-by-word reveal (first 7 words)
      words.forEach((w, i) => {
        gsap.set(w, { autoAlpha: 0, y: 24 });
        narTl.to(w, { autoAlpha: 1, y: 0, duration: 0.12, ease: "power2.out" }, i * 0.04);
      });

      // 0.28: centered chatgpt fades in (same size as other words)
      narTl.to(chatgptEl, { autoAlpha: 1, duration: 0.15, ease: "power2.out" }, 0.28);

      // 0.32 - 0.50: first 7 words fade left
      words.forEach((w, i) => {
        narTl.to(w, { x: -120, autoAlpha: 0, duration: 0.25, ease: "power2.in" }, 0.38 + i * 0.015);
      });

      // 0.50 - 0.75: chatgpt scales up to 1.6x and holds at center
      narTl.to(chatgptEl, { scale: 1.6, duration: 0.4, ease: "power2.inOut" }, 0.55);

      // 0.75 - 1.15: chatgpt holds at center (longer dwell)

      // 1.15 - 1.35: chatgpt fades out
      narTl.to(chatgptEl, { autoAlpha: 0, duration: 0.3, ease: "power2.inOut" }, 1.2);

      // 1.30 - 1.50: "let zWork do it instead" (light) fades in
      narTl.to(insteadLight, { autoAlpha: 1, duration: 0.3, ease: "power2.inOut" }, 1.35);

      // 1.50 - 2.00: hold "let zWork do it instead" on light bg (longer)

      // 2.00 - 2.35: fade inversion (bg darkens, text swaps)
      narTl.to(bg, { autoAlpha: 1, duration: 0.5, ease: "power2.inOut" }, 2.05);
      narTl.to(insteadLight, { autoAlpha: 0, duration: 0.4, ease: "power2.inOut" }, 2.05);
      narTl.to(insteadDark, { autoAlpha: 1, duration: 0.4, ease: "power2.inOut" }, 2.2);

      // 2.35 - 2.90: hold "let zWork do it instead" on dark bg (longer)

      // 2.90 - 3.10: "let zWork do it instead" fades out
      narTl.to(insteadDark, { autoAlpha: 0, duration: 0.3, ease: "power2.out" }, 2.95);

      // 3.05 - 3.25: "Private. Free and open source." fades in
      narTl.to(final, { autoAlpha: 1, y: 0, duration: 0.4, ease: "power2.out" }, 3.1);

      // 3.25 - 4.00: hold on final text (longer)

      // 4.00 - 4.20: punchline fades in below
      narTl.to(steal, { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out" }, 4.05);

      // 4.20 - 5.00: hold on both texts

      // 5.00 - 5.30: blur/fade out steal and final text
      narTl.to([steal, final], {
        autoAlpha: 0,
        filter: "blur(8px)",
        duration: 0.4,
        ease: "power2.inOut"
      }, 5.0);

      // 5.30 - 6.00: dark bg morphs into CTA card using scale from center
      narTl.set(bg, { transformOrigin: "center center" }, 5.3);
      narTl.to(bg, {
        scale: 0.5,
        borderRadius: "40px",
        border: "1px solid #e6e3dc",
        duration: 0.7,
        ease: "power2.inOut"
      }, 5.35);

      // 5.60 - 5.90: show CTA content container
      narTl.to(ctaContent, { autoAlpha: 1, duration: 0.3, ease: "power2.out" }, 5.65);

      // 5.75 - 6.05: title fades in
      narTl.to(ctaTitle, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power2.out" }, 5.8);

      // 5.90 - 6.20: description fades in
      narTl.to(ctaDesc, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power2.out" }, 5.95);

      // 6.05 - 6.35: buttons fade in
      narTl.to(ctaButtons, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power2.out" }, 6.1);

      // 6.35 - 7.00: hold on CTA

      /* ---- Sticky nav trigger ---- */
      ScrollTrigger.create({
        trigger: sentinelRef.current,
        start: "top top",
        onEnter: () => setShowNav(true),
        onLeaveBack: () => setShowNav(false),
      });
    });

    return () => ctx.revert();
  }, []);

  const bigText = "text-[100px] md:text-[140px] lg:text-[190px] font-semibold tracking-tighter select-none";

  return (
    <div className="relative">
      {/* HERO SECTION */}
      <section ref={heroRef} className="relative h-screen w-full overflow-hidden">
        {/* Dark layer */}
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: "#171716" }}>
          <div ref={heroGroupRef} className="relative flex items-center justify-center will-change-transform">
            <h1 ref={heroTextRef} className={`${bigText} text-[#f7f6f3]`} style={serif}>
              <span className="lowercase">z</span>Work
            </h1>
            <div ref={heroLogoRef} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 will-change-transform">
              <Logo size={280} fill="#f7f6f3" />
            </div>
          </div>
        </div>

        {/* Light layer — exact same content, inverted colors */}
        <div ref={heroLightRef} className="absolute inset-0 z-20 flex items-center justify-center" style={{ background: "#f7f6f3", clipPath: "inset(0 100% 0 0)" }}>
          <div ref={heroLightGroupRef} className="relative flex items-center justify-center will-change-transform">
            <div ref={heroLightTextRef} className={`${bigText} text-[#171716] invisible`} style={serif} aria-hidden="true">
              <span className="lowercase">z</span>Work
            </div>
            <div ref={heroLightLogoRef} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 will-change-transform">
              <Logo size={280} fill="#171716" />
            </div>
          </div>
        </div>

        {/* Scanline edge glow */}
        <div ref={heroScanRef} className="absolute top-0 bottom-0 z-30 w-[2px] md:w-[3px] pointer-events-none opacity-0" style={{ left: "-5%", background: "rgba(247,246,243,0.9)", boxShadow: "-6px 0 24px rgba(247,246,243,0.5),6px 0 24px rgba(23,23,22,0.4),0 0 60px rgba(247,246,243,0.25)", mixBlendMode: "screen" }} />

        {/* Scroll hint */}
        <aside ref={heroHintRef} aria-label="Scroll down hint" className="absolute bottom-8 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2">
          <span className="text-[11px] tracking-[0.2em] uppercase text-[#6b6a65]">Scroll</span>
          <div className="h-8 w-[1px] bg-[#6b6a65] animate-pulse" />
        </aside>
      </section>

      {/* NARRATIVE SECTION */}
      <section ref={narRef} className="relative h-screen w-full overflow-hidden">
        {/* Light bg */}
        <div className="absolute inset-0 z-0" style={{ background: "#f7f6f3" }} />
        {/* Dark bg (fades in then morphs into CTA card) */}
        <div ref={narBgRef} className="absolute inset-0 z-10 opacity-0 will-change-transform" style={{ background: "#171716" }} />

        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <div className="relative w-full h-full flex items-center justify-center">

            {/* Word phrase (first 7 words only) */}
            <div ref={narPhraseRef} className="absolute flex items-center justify-center gap-x-3 px-6" style={{ top: "38%" }}>
              {["Stop","copying","and","pasting","your","work","into"].map((w) => (
                <span key={w} className="word text-[32px] md:text-[48px] lg:text-[60px] font-semibold tracking-tight text-[#171716]" style={serif}>
                  {w}
                </span>
              ))}
            </div>

            {/* chatgpt — centered, absolute */}
            <div ref={narChatgptRef} className="absolute inset-0 flex items-center justify-center opacity-0 z-10">
              <span className="text-[32px] md:text-[48px] lg:text-[60px] font-semibold tracking-tight text-[#171716]" style={serif}>
                chatgpt
              </span>
            </div>

            {/* let zWork do it instead — light */}
            <div ref={narInsteadLightRef} className="absolute flex items-center justify-center opacity-0 text-center px-6">
              <span className="text-[56px] md:text-[80px] lg:text-[110px] font-semibold tracking-tighter text-[#171716] leading-tight" style={serif}>
                let <span className="lowercase">z</span>Work<br />do it instead
              </span>
            </div>

            {/* let zWork do it instead — dark */}
            <div ref={narInsteadDarkRef} className="absolute flex items-center justify-center opacity-0 text-center px-6">
              <span className="text-[56px] md:text-[80px] lg:text-[110px] font-semibold tracking-tighter text-[#f7f6f3] leading-tight" style={serif}>
                let <span className="lowercase">z</span>Work<br />do it instead
              </span>
            </div>

            {/* Final */}
            <div ref={narFinalRef} className="absolute flex items-center justify-center opacity-0 text-center px-6">
              <span className="text-[36px] md:text-[52px] lg:text-[68px] font-semibold tracking-tight text-[#f7f6f3] leading-tight" style={serif}>
                Private.<br />Free and open source.
              </span>
            </div>

            {/* Private by design punchline */}
            <div ref={narStealRef} className="absolute flex items-center justify-center opacity-0 text-center px-6" style={{ top: "58%" }}>
              <span className="text-[24px] md:text-[32px] lg:text-[40px] font-semibold tracking-tight text-[#a09e98] leading-tight" style={serif}>
                Your data never leaves your machine. Private by design.
              </span>
            </div>

            {/* CTA CONTENT - hidden initially, appears when bg morphs */}
            <div ref={ctaContentRef} className="absolute inset-0 flex items-center justify-center px-6 pointer-events-none">
              <div className="text-center max-w-xl w-full pointer-events-auto">
                <h2
                  ref={ctaTitleRef}
                  className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-[#f7f6f3] leading-tight"
                  style={serif}
                >
                  Ready to get to work?
                </h2>
                <p
                  ref={ctaDescRef}
                  className="mt-4 text-[15px] text-[#a09e98] max-w-lg mx-auto leading-relaxed"
                >
                  zWork runs locally on macOS, Windows, and Linux. Free to use with
                  your own API keys.
                </p>
                <div
                  ref={ctaButtonsRef}
                  className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3"
                >
                  <Link
                    to="/download"
                    onClick={() => track('home_download_click')}
                    className="inline-flex items-center gap-2 rounded-full bg-[#f7f6f3] px-6 py-3 text-[14px] font-semibold text-[#171716] hover:bg-white transition-colors"
                  >
                    Download for free
                  </Link>
                  <Link
                    to="/pricing"
                    onClick={() => track('home_pricing_click')}
                    className="inline-flex items-center gap-2 rounded-full border border-[#2d2d31] px-6 py-3 text-[14px] font-medium text-[#a09e98] hover:text-[#f7f6f3] hover:border-[#4a4a4e] transition-colors"
                  >
                    Pricing
                  </Link>
                  <a
                    href="https://github.com/Ryz3nPlayZ/zWork"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => track('home_github_click')}
                    className="inline-flex items-center gap-2 rounded-full border border-[#2d2d31] px-6 py-3 text-[14px] font-medium text-[#a09e98] hover:text-[#f7f6f3] hover:border-[#4a4a4e] transition-colors"
                  >
                    View on GitHub
                  </a>
                </div>
              </div>
            </div>

          </div>
        </div>
      </section>

      <div ref={sentinelRef} className="h-[1px]" />

      <TopBar visible={showNav} />

      {/* Subtle download CTA bar */}
      <div className="border-b border-[#e6e3dc] bg-[#f7f6f3] sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 py-2.5 flex items-center justify-between">
          <span className="text-[12px] text-[#6b6a65]">
            Ready to get to work?
          </span>
          <Link
            to="/download"
            className="text-[12px] font-semibold text-[#171716] hover:text-[#6b6a65] transition-colors"
          >
            Download zWork →
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}
