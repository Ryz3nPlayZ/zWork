import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Logo } from "../Logo";
import { PanelLeft, SquarePen, Search, Settings, Paperclip, Globe, Image, Wrench } from "lucide-react";

gsap.registerPlugin(ScrollTrigger);

/* ------------------------------------------------------------------ */
/*  Shell                                                              */
/* ------------------------------------------------------------------ */

interface ChatShellProps {
  children: React.ReactNode;
  composerTextRef?: React.RefObject<HTMLDivElement | null>;
  onReplay?: () => void;
  className?: string;
}

export function ChatShell({ children, composerTextRef, onReplay, className = "" }: ChatShellProps) {
  return (
    <div className={`relative rounded-2xl border border-[#e6e3dc] bg-[#f7f6f3] shadow-[0_1px_3px_rgba(17,17,17,0.06),0_16px_48px_rgba(17,17,17,0.12)] overflow-hidden ${className}`}>
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[#e6e3dc] bg-[#f2f0ec]">
        <div className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" />
        </div>
        <div className="flex-1 text-center">
          <span className="text-[10px] text-[#a09e98] font-medium tracking-wide">zWork</span>
        </div>
        <div className="w-12" />
      </div>

      <div className="flex h-full" style={{ height: "calc(100% - 33px)" }}>
        {/* Sidebar */}
        <div className="w-[170px] hidden sm:flex flex-col shrink-0 border-r border-[#e6e3dc] bg-[#f2f0ec] py-2.5">
          <div className="flex items-center gap-2 px-3 mb-3">
            <Logo size={18} fill="#171716" />
            <span className="text-[12px] font-semibold tracking-tight text-[#171716]"><span className="lowercase">z</span>Work</span>
          </div>
          <div className="px-2 mb-2">
            <div className="flex items-center gap-1.5 rounded-lg bg-white border border-[#e6e3dc] px-2 py-1.5 text-[11px] text-[#6b6a65]">
              <SquarePen size={12} />
              <span>New chat</span>
            </div>
          </div>
          <div className="px-2 mb-2">
            <div className="flex items-center gap-1.5 rounded-lg hover:bg-[#e6e3dc]/50 px-2 py-1.5 text-[11px] text-[#6b6a65] cursor-default transition-colors">
              <Search size={12} />
              <span>Search chats</span>
            </div>
          </div>
          <div className="px-3 mb-1.5">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-[#a09e98]">Today</span>
          </div>
          <div className="px-2 space-y-0.5">
            <div className="rounded-md px-2 py-1 text-[11px] text-[#171716] bg-[#e6e3dc]/60 truncate">Q3 Sales analysis</div>
            <div className="rounded-md px-2 py-1 text-[11px] text-[#6b6a65] hover:bg-[#e6e3dc]/30 truncate cursor-default">Fix build error</div>
            <div className="rounded-md px-2 py-1 text-[11px] text-[#6b6a65] hover:bg-[#e6e3dc]/30 truncate cursor-default">Weekly update draft</div>
          </div>
          <div className="px-3 mt-3 mb-1.5">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-[#a09e98]">This week</span>
          </div>
          <div className="px-2 space-y-0.5">
            <div className="rounded-md px-2 py-1 text-[11px] text-[#6b6a65] hover:bg-[#e6e3dc]/30 truncate cursor-default">Docker setup help</div>
            <div className="rounded-md px-2 py-1 text-[11px] text-[#6b6a65] hover:bg-[#e6e3dc]/30 truncate cursor-default">Email campaign</div>
          </div>
          <div className="mt-auto px-3 pt-2 border-t border-[#e6e3dc]">
            <div className="flex items-center gap-1.5 text-[11px] text-[#6b6a65]">
              <Settings size={12} />
              <span>Settings</span>
            </div>
          </div>
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#f7f6f3]">
          {/* Header */}
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#e6e3dc] px-3 bg-white/50">
            <div className="flex items-center gap-1.5">
              <PanelLeft size={14} className="text-[#a09e98]" />
              <span className="text-[11.5px] font-medium text-[#171716]">zWork</span>
            </div>
            <span className="text-[10px] text-[#a09e98] font-mono">Demo</span>
          </div>

          {/* Chat scroll area */}
          <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
            {children}
          </div>

          {/* Composer */}
          <div className="shrink-0 px-3 pb-3 pt-1">
            <div className="rounded-xl border border-[#e6e3dc] bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04),0_4px_12px_rgba(17,17,17,0.04)]">
              <div className="px-3 pt-2.5 pb-1">
                <div
                  ref={composerTextRef}
                  className="text-[12.5px] text-[#a09e98] leading-5 h-5"
                />
              </div>
              <div className="flex items-center justify-between px-1.5 pb-1.5">
                <div className="flex items-center gap-0.5">
                  <ComposerMiniIcon icon={<Paperclip size={12} />} />
                  <ComposerMiniIcon icon={<Globe size={12} />} />
                  <ComposerMiniIcon icon={<Image size={12} />} />
                  <ComposerMiniIcon icon={<Wrench size={12} />} />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[9.5px] text-[#a09e98]">GPT-4o</span>
                  <div className="h-5 w-5 rounded-full bg-[#efede8] flex items-center justify-center text-[#171716]">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
                  </div>
                </div>
              </div>
            </div>
            <p className="mt-1.5 text-center text-[9px] text-[#a09e98]">zWork can take actions on your computer. Review before approving.</p>
          </div>
        </div>
      </div>

      {/* Replay button */}
      {onReplay && (
        <button
          onClick={onReplay}
          className="absolute top-10 right-3 z-10 rounded-md bg-white/90 backdrop-blur-sm border border-[#e6e3dc] px-2 py-1 text-[10px] text-[#6b6a65] hover:text-[#171716] transition-colors shadow-sm"
        >
          Replay
        </button>
      )}
    </div>
  );
}

function ComposerMiniIcon({ icon }: { icon: React.ReactNode }) {
  return (
    <div className="w-6 h-6 flex items-center justify-center rounded text-[#a09e98] hover:text-[#6b6a65] transition-colors cursor-default">
      {icon}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Message helpers                                                    */
/* ------------------------------------------------------------------ */

export function UserMsg({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex w-full justify-end mb-3 ${className}`}>
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-[#f2f0ec] border border-[#e6e3dc] px-3.5 py-2.5 text-[12.5px] leading-5 text-[#171716]">
        {children}
      </div>
    </div>
  );
}

export function AssistantMsg({ children, className = "", avatar = true }: { children: React.ReactNode; className?: string; avatar?: boolean }) {
  return (
    <div className={`flex w-full gap-2.5 mb-3 ${className}`}>
      {avatar && (
        <div className="mt-0.5 flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full border border-[#e6e3dc] bg-white">
          <Logo size={11} />
        </div>
      )}
      <div className="min-w-0 flex-1 max-w-[92%] text-[12.5px] leading-[1.55] text-[#171716]">
        {children}
      </div>
    </div>
  );
}

export function ActivityPill({ text, done = false }: { text: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[#6b6a65]">
      {done ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-600 shrink-0"><path d="M20 6L9 17l-5-5"/></svg>
      ) : (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#a09e98] animate-pulse shrink-0" />
      )}
      <span>{text}</span>
    </div>
  );
}

export function FileBadge({ name, size }: { name: string; size?: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-lg border border-[#e6e3dc] bg-white px-2.5 py-1 text-[10.5px] text-[#6b6a65] shadow-sm">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span>{name}</span>
      {size && <span className="text-[#a09e98]">{size}</span>}
    </div>
  );
}

export function ArtifactCard({ title, preview, children }: { title: string; preview?: string; children?: React.ReactNode }) {
  return (
    <div className="mt-2 rounded-xl border border-[#e6e3dc] bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#e6e3dc] bg-[#f7f6f3]">
        <div className="h-5 w-5 rounded-md border border-[#e6e3dc] bg-white flex items-center justify-center text-[#6b6a65]">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <span className="text-[11.5px] font-medium text-[#171716]">{title}</span>
      </div>
      {preview && (
        <div className="px-3 py-2.5 text-[11px] text-[#6b6a65] leading-4 whitespace-pre-line">{preview}</div>
      )}
      {children}
    </div>
  );
}

export function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <div className="mt-2 rounded-lg border border-[#e6e3dc] bg-[#171716] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#2d2d31]">
        <span className="text-[10px] text-[#a09e98] font-mono">{language}</span>
        <span className="text-[9px] text-[#6b6a65]">zWork</span>
      </div>
      <pre className="px-3 py-2 text-[10.5px] font-mono text-[#f7f6f3] leading-4 overflow-x-auto"><code>{code}</code></pre>
    </div>
  );
}

export function MiniBarChart({ data }: { data: { label: string; value: number; color?: string }[] }) {
  const max = Math.max(...data.map((d) => d.value));
  return (
    <div className="mt-2 space-y-1.5">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-2">
          <span className="text-[10px] text-[#6b6a65] w-14 truncate shrink-0">{d.label}</span>
          <div className="flex-1 h-4 bg-[#efede8] rounded-sm overflow-hidden">
            <div
              className="h-full rounded-sm transition-all"
              style={{
                width: `${(d.value / max) * 100}%`,
                backgroundColor: d.color || "#171716",
              }}
            />
          </div>
          <span className="text-[10px] text-[#171716] font-mono w-8 text-right">{d.value}%</span>
        </div>
      ))}
    </div>
  );
}

export function DataTable({ rows, headers }: { rows: (string | number)[][]; headers: string[] }) {
  return (
    <div className="mt-2 rounded-lg border border-[#e6e3dc] bg-white overflow-hidden overflow-x-auto">
      <table className="w-full text-[10.5px]">
        <thead>
          <tr className="bg-[#f7f6f3] border-b border-[#e6e3dc]">
            {headers.map((h, i) => (
              <th key={i} className="px-2.5 py-1.5 text-left text-[#6b6a65] font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-[#e6e3dc]/50 last:border-0">
              {row.map((cell, ci) => (
                <td key={ci} className={`px-2.5 py-1.5 whitespace-nowrap ${ci === 0 ? "text-[#171716] font-medium" : "text-[#6b6a65]"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TerminalOutput({ lines }: { lines: { text: string; type?: "in" | "out" | "ok" | "err" }[] }) {
  return (
    <div className="mt-2 rounded-lg border border-[#e6e3dc] bg-[#171716] px-3 py-2 font-mono text-[10px] leading-4">
      {lines.map((line, i) => (
        <div key={i} className={`${line.type === "ok" ? "text-emerald-400" : line.type === "err" ? "text-red-400" : line.type === "in" ? "text-[#a09e98]" : "text-[#f7f6f3]"}`}>
          {line.type === "in" && <span className="text-[#6b6a65]">$ </span>}
          {line.text}
        </div>
      ))}
    </div>
  );
}

export function ThinkingDots() {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-[#a09e98]">
      <span className="inline-block h-1 w-1 rounded-full bg-[#a09e98] animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="inline-block h-1 w-1 rounded-full bg-[#a09e98] animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="inline-block h-1 w-1 rounded-full bg-[#a09e98] animate-bounce" style={{ animationDelay: "300ms" }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Animation helpers                                                  */
/* ------------------------------------------------------------------ */

export function useDemoTimeline(containerRef: React.RefObject<HTMLElement | null>, buildTimeline: (tl: gsap.core.Timeline) => void, deps: React.DependencyList = []) {
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: containerRef.current,
          start: "top 75%",
          toggleActions: "play pause pause reverse",
        },
        onComplete: () => {
          gsap.delayedCall(4, () => {
            if (tlRef.current) tlRef.current.restart();
          });
        },
      });
      tlRef.current = tl;
      buildTimeline(tl);
    }, containerRef);

    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return () => tlRef.current?.restart();
}

export async function typeText(el: HTMLElement | null, text: string, speed = 30): Promise<void> {
  if (!el) return;
  return new Promise((resolve) => {
    let i = 0;
    el.textContent = "";
    const tick = () => {
      if (i < text.length) {
        el.textContent = text.slice(0, i + 1);
        i++;
        setTimeout(tick, speed + Math.random() * 15);
      } else {
        resolve();
      }
    };
    tick();
  });
}
