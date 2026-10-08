import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { track } from "@vercel/analytics";

gsap.registerPlugin(ScrollTrigger);

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.21-1.96 1.07-3.11-1.05.05-2.31.71-3.06 1.66-.68.83-1.28 2.18-1.12 3.29 1.18.09 2.39-.6 3.11-1.84" />
    </svg>
  );
}

function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  );
}

function LinuxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.076 2.116c-.233.01-.48.07-.72.186a2.17 2.17 0 0 0-.873.77c-.194.304-.308.683-.32 1.064-.012.38.074.76.255 1.08.18.32.448.575.77.738.322.162.692.224 1.06.176.366-.048.71-.212.98-.468.272-.257.455-.598.522-.97a2.25 2.25 0 0 0-.093-1.13 2.13 2.13 0 0 0-.63-.88c-.27-.234-.616-.38-.97-.39zM9.876 4.546c-.23.005-.45.038-.65.106-.307.1-.585.28-.804.52-.22.242-.375.54-.45.86a2.15 2.15 0 0 0 .086 1.1c.148.35.406.65.74.86.333.21.726.32 1.126.31.4-.01.786-.14 1.108-.37.322-.23.57-.556.706-.925.137-.37.156-.776.053-1.156a2.22 2.22 0 0 0-.49-.99 2.03 2.03 0 0 0-.878-.58 1.96 1.96 0 0 0-.548-.11zm5.704 2.52c.012 0 .025.003.037.006.15.04.28.13.36.26.08.13.1.29.06.44-.04.14-.14.27-.27.35-.13.08-.29.11-.44.08-.15-.03-.28-.12-.36-.25-.08-.13-.11-.29-.07-.44.04-.15.13-.28.26-.37.12-.09.27-.14.42-.14zM10.91 7.046c.14.002.28.048.39.13.11.08.19.2.22.34.03.13.01.28-.06.4-.07.12-.18.22-.31.26-.13.05-.28.04-.41-.02-.13-.06-.23-.17-.28-.3-.05-.14-.04-.29.03-.42.07-.13.19-.23.33-.28.1-.04.2-.06.3-.05.03 0 .06-.003.09-.006zm3.33 1.96c-.26.002-.51.06-.74.18-.23.12-.42.3-.56.51-.13.21-.2.46-.2.7v.02c0 .24.06.48.2.7.13.21.33.38.56.5.23.12.48.18.74.18.25 0 .5-.06.73-.18.23-.12.43-.29.56-.5.14-.21.2-.46.2-.7v-.02c0-.24-.06-.48-.2-.7-.13-.21-.33-.38-.56-.5a1.6 1.6 0 0 0-.73-.18zM9.04 9.206c-.25.002-.5.06-.72.18-.23.12-.42.3-.55.51-.14.21-.2.46-.2.7v.02c0 .24.06.48.2.7.13.21.32.38.55.5.22.12.47.18.72.18.26 0 .51-.06.74-.18.22-.12.42-.29.55-.5.14-.21.2-.46.2-.7v-.02c0-.24-.06-.48-.2-.7-.13-.21-.33-.38-.55-.5a1.62 1.62 0 0 0-.74-.18zm8.15.42c-.01.002-.02.005-.03.006-.15.03-.28.13-.36.26-.08.13-.1.29-.06.44.04.15.13.27.26.36.13.09.29.12.44.09.15-.03.28-.12.37-.25.08-.13.11-.29.07-.44-.04-.15-.13-.28-.26-.37-.13-.09-.29-.14-.43-.14zm-11.37.01c-.15.002-.29.06-.4.17-.1.1-.16.25-.16.4 0 .15.06.29.17.4.1.1.25.17.4.17.15 0 .29-.07.4-.17.1-.11.17-.25.17-.4 0-.15-.07-.3-.17-.4-.11-.11-.25-.17-.4-.17-.01 0-.03" />
    </svg>
  );
}

const platforms = [
  {
    icon: AppleIcon,
    label: "macOS",
    cta: "Download",
    desc: "Universal",
    comingSoon: false,
    url: "https://github.com/Ryz3nPlayZ/zWork/releases/latest/download/zWork-macos-universal.dmg",
  },
  {
    icon: LinuxIcon,
    label: "Linux",
    cta: "Download",
    desc: "x86_64 AppImage",
    comingSoon: false,
    url: "https://github.com/Ryz3nPlayZ/zWork/releases/latest/download/zWork-linux-x86_64.AppImage",
  },
  {
    icon: WindowsIcon,
    label: "Windows",
    cta: "Download",
    desc: "x86_64 installer",
    comingSoon: false,
    url: "https://github.com/Ryz3nPlayZ/zWork/releases/latest/download/zWork-windows-x86_64-setup.exe",
  },
];

const serif = { fontFamily: "var(--font-serif)" };

export function DownloadSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      itemsRef.current.forEach((item, i) => {
        if (!item) return;
        gsap.fromTo(
          item,
          { y: 40, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.7,
            ease: "power2.out",
            scrollTrigger: {
              trigger: item,
              start: "top 85%",
              toggleActions: "play none none none",
            },
            delay: i * 0.15,
          }
        );
      });
    }, sectionRef);
    return () => ctx.revert();
  }, []);

  return (
    <section
      id="download"
      ref={sectionRef}
      className="relative z-50 bg-[#171716] py-12 md:py-16 px-6"
    >
      <div className="max-w-5xl mx-auto text-center">
        <h2
          className="text-5xl md:text-6xl lg:text-7xl font-semibold tracking-tight text-[#f7f6f3] mb-4"
          style={serif}
        >
          Download zWork
        </h2>
        <p className="text-lg text-[#a09e98] mb-12">
          Free and open source. No signup required.
        </p>

        <div className="relative flex flex-col md:flex-row items-stretch justify-center gap-0">
          {platforms.map((p, i) => {
            const Icon = p.icon;
            return (
              <div
                key={p.label}
                ref={(el) => { itemsRef.current[i] = el; }}
                className="flex-1 flex flex-col items-center py-8 px-6 md:px-10"
              >
                <Icon className="h-8 w-8 text-[#f7f6f3] mb-4" />
                <h3
                  className="text-3xl md:text-4xl font-semibold tracking-tight text-[#f7f6f3] mb-2"
                  style={serif}
                >
                  {p.label}
                </h3>
                <p className="text-[14px] text-[#a09e98] mb-6">{p.desc}</p>

                {p.comingSoon ? (
                  <span className="text-[13px] font-medium text-[#6b6a65]">
                    {p.cta}
                  </span>
                ) : (
                  <a
                    href={p.url}
                    download
                    onClick={() => track('download_click', { platform: p.label })}
                    className="inline-flex items-center px-6 py-3 text-[13px] font-semibold bg-[#f7f6f3] text-[#171716] hover:bg-white transition-colors"
                  >
                    {p.cta}
                  </a>
                )}
              </div>
            );
          })}

          {/* Vertical dividers */}
          <div className="hidden md:block absolute left-1/3 top-24 bottom-24 w-[1px] bg-[#2d2d31]" />
          <div className="hidden md:block absolute left-2/3 top-24 bottom-24 w-[1px] bg-[#2d2d31]" />
        </div>

        <div className="mt-12">
          <a
            href="https://github.com/Ryz3nPlayZ/zWork/releases"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track('github_releases_click')}
            className="text-[13px] text-[#a09e98] hover:text-[#f7f6f3] transition-colors"
          >
            View all releases on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
