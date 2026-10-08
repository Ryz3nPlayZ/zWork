import type { ReactNode } from "react";
import { siApple } from "simple-icons";
import { BatteryFull, MessageCircle, Search, Settings, Wifi } from "lucide-react";
import { cn } from "../lib/cn";

/*
 * macOS chrome for the desktop demo, after Tahoe: a transparent menu bar over
 * the wallpaper and a Liquid Glass dock. The app icons are drawn here in the
 * system's style rather than copied from Apple's artwork; zWork's is the real
 * one from app/src-tauri/icons.
 */

export function MenuBar({ app = "zWork" }: { app?: string }) {
  return (
    <div className="desk-ink mac-font absolute inset-x-0 top-0 z-10 flex h-[26px] items-center justify-between px-3.5 text-[13px] sm:px-5">
      <div className="flex items-center gap-[18px]">
        <svg viewBox="0 0 24 24" className="h-[15px] w-[15px] -translate-y-px fill-current" aria-hidden="true">
          <path d={siApple.path} />
        </svg>
        <span className="font-bold">{app}</span>
        {["File", "Edit", "View", "Window", "Help"].map((m) => (
          <span key={m} className="hidden font-medium sm:inline">
            {m}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-[15px]">
        <span className="hidden items-center gap-1 sm:flex">
          <BatteryFull className="h-[17px] w-[17px]" strokeWidth={1.6} />
        </span>
        <Wifi className="h-[15px] w-[15px]" strokeWidth={2.2} />
        <Search className="hidden h-[14px] w-[14px] sm:block" strokeWidth={2.4} />
        <ControlCenter />
        <span className="font-medium tabular-nums">
          <span className="hidden sm:inline">Tue Oct 7&nbsp;&nbsp;</span>5:21 PM
        </span>
      </div>
    </div>
  );
}

/** Control Center's menu bar glyph: two stacked switches. */
function ControlCenter() {
  const pill = "flex h-[6px] w-[13px] items-center rounded-full border-[1.5px] border-current";
  return (
    <span className="hidden flex-col gap-[2px] sm:flex" aria-hidden="true">
      <span className={cn(pill, "justify-end")}>
        <span className="mr-[0.5px] h-[3px] w-[3px] rounded-full bg-current" />
      </span>
      <span className={cn(pill, "justify-start")}>
        <span className="ml-[0.5px] h-[3px] w-[3px] rounded-full bg-current" />
      </span>
    </span>
  );
}

export function TrafficLights({ dim }: { dim?: boolean }) {
  return (
    <div className="flex gap-2">
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <span
          key={c}
          className="h-3 w-3 rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/.12)]"
          style={{ background: dim ? "rgb(var(--line-strong))" : c }}
        />
      ))}
    </div>
  );
}

/** A squircle app icon with the system's rim light and soft shadow. */
function Icon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("mac-icon relative h-full w-full overflow-hidden rounded-[23%]", className)}>
      {children}
    </div>
  );
}

const svg = "absolute inset-0 h-full w-full";

const ICONS: Record<string, ReactNode> = {
  Finder: (
    <Icon>
      <svg viewBox="0 0 100 100" className={svg} aria-hidden="true">
        <defs>
          <linearGradient id="mf-l" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3ea8ff" />
            <stop offset="1" stopColor="#1360e2" />
          </linearGradient>
          <linearGradient id="mf-r" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f4f8fd" />
            <stop offset="1" stopColor="#d9e6f6" />
          </linearGradient>
        </defs>
        <rect width="100" height="100" fill="url(#mf-r)" />
        <path d="M0 0H57C51 18 47 34 48 50C41 52 39 58 45 61C43 74 45 88 50 100H0Z" fill="url(#mf-l)" />
        <rect x="27" y="29" width="6.5" height="17" rx="3.2" fill="#0b2347" />
        <rect x="67" y="29" width="6.5" height="17" rx="3.2" fill="#0b2347" />
        <path d="M21 69Q50 85 81 67" stroke="#0b2347" strokeWidth="4.5" strokeLinecap="round" fill="none" />
      </svg>
    </Icon>
  ),
  Safari: (
    <Icon className="bg-gradient-to-b from-white to-[#e9ebee]">
      <svg viewBox="0 0 100 100" className={svg} aria-hidden="true">
        <defs>
          <radialGradient id="ms-f" cx="0.5" cy="0.35" r="0.65">
            <stop offset="0" stopColor="#5fd0ff" />
            <stop offset="1" stopColor="#1263e0" />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="39" fill="url(#ms-f)" />
        {Array.from({ length: 24 }, (_, i) => (
          <line
            key={i}
            x1="50"
            y1="14"
            x2="50"
            y2={i % 3 ? "18" : "21"}
            stroke="white"
            strokeOpacity=".85"
            strokeWidth="1.4"
            transform={`rotate(${i * 15} 50 50)`}
          />
        ))}
        <g transform="rotate(45 50 50)">
          <polygon points="50,20 56,50 44,50" fill="#ff3b30" />
          <polygon points="50,80 56,50 44,50" fill="#f2f2f2" />
        </g>
      </svg>
    </Icon>
  ),
  Mail: (
    <Icon className="bg-gradient-to-b from-[#4cb0ff] to-[#1468e8]">
      <svg viewBox="0 0 100 100" className={svg} aria-hidden="true">
        <rect x="17" y="29" width="66" height="44" rx="7" fill="white" />
        <path d="M20 33L50 55L80 33" stroke="#1d72ea" strokeWidth="4" strokeLinejoin="round" fill="none" />
      </svg>
    </Icon>
  ),
  Messages: (
    <Icon className="bg-gradient-to-b from-[#6ee46e] to-[#1db43a]">
      <svg viewBox="0 0 100 100" className={svg} aria-hidden="true">
        <ellipse cx="51" cy="47" rx="31" ry="26" fill="white" />
        <path d="M31 63Q28 75 18 81Q36 81 44 70Z" fill="white" />
      </svg>
    </Icon>
  ),
  Calendar: (
    <Icon className="bg-white">
      <svg viewBox="0 0 100 100" className={svg} aria-hidden="true">
        <text x="50" y="30" textAnchor="middle" fontSize="15" fontWeight="600" fill="#ff3b30" fontFamily="-apple-system, system-ui, sans-serif">
          TUE
        </text>
        <text x="50" y="80" textAnchor="middle" fontSize="50" fontWeight="300" fill="#1d1d1f" fontFamily="-apple-system, system-ui, sans-serif">
          7
        </text>
      </svg>
    </Icon>
  ),
  Notes: (
    <Icon className="bg-white">
      <svg viewBox="0 0 100 100" className={svg} aria-hidden="true">
        <defs>
          <linearGradient id="mn-t" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffe066" />
            <stop offset="1" stopColor="#ffc928" />
          </linearGradient>
        </defs>
        <rect width="100" height="28" fill="url(#mn-t)" />
        {[44, 58, 72, 86].map((y) => (
          <line key={y} x1="12" y1={y} x2="88" y2={y} stroke="#dcdcdc" strokeWidth="1.6" />
        ))}
      </svg>
    </Icon>
  ),
  Numbers: (
    <Icon className="bg-gradient-to-b from-[#4fdc76] to-[#169c43]">
      <svg viewBox="0 0 100 100" className={svg} aria-hidden="true">
        <rect x="23" y="52" width="13" height="27" rx="3" fill="white" />
        <rect x="44" y="35" width="13" height="44" rx="3" fill="white" />
        <rect x="65" y="22" width="13" height="57" rx="3" fill="white" />
      </svg>
    </Icon>
  ),
  "System Settings": (
    <Icon className="flex items-center justify-center bg-gradient-to-b from-[#d4d6db] to-[#8e929a]">
      <Settings className="h-[70%] w-[70%] text-[#3b3e44]" strokeWidth={1.4} />
    </Icon>
  ),
  ChatGPT: (
    <Icon className="flex items-center justify-center bg-gradient-to-b from-[#2b2b2b] to-[#0d0d0d]">
      <MessageCircle className="h-[52%] w-[52%] text-white" strokeWidth={1.8} />
    </Icon>
  ),
  zWork: (
    <Icon>
      <img src="/zwork-icon.png" alt="" className="h-full w-full" draggable={false} />
    </Icon>
  ),
  Trash: (
    <svg viewBox="0 0 100 100" className="h-full w-full drop-shadow-[0_2px_3px_rgb(0_0_0/.25)]" aria-hidden="true">
      <path d="M26 30H74L68 86Q67 92 61 92H39Q33 92 32 86Z" fill="rgb(255 255 255/.62)" stroke="rgb(0 0 0/.14)" />
      {[40, 50, 60].map((x) => (
        <line key={x} x1={x} y1="38" x2={x} y2="84" stroke="rgb(0 0 0/.12)" strokeWidth="2" />
      ))}
      <rect x="22" y="20" width="56" height="10" rx="4" fill="rgb(255 255 255/.82)" stroke="rgb(0 0 0/.14)" />
    </svg>
  ),
};

const APPS: { name: keyof typeof ICONS; running?: boolean; wide?: boolean }[] = [
  { name: "Finder", running: true },
  { name: "Safari", wide: true },
  { name: "Messages", wide: true },
  { name: "Mail" },
  { name: "Calendar" },
  { name: "Notes", wide: true },
  { name: "Numbers", wide: true },
  { name: "System Settings", wide: true },
  { name: "ChatGPT", running: true },
  { name: "zWork", running: true },
];

export function Dock() {
  const tile = "relative h-9 w-9 sm:h-[50px] sm:w-[50px]";
  const dot = "absolute -bottom-[5px] left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full mac-dot";
  return (
    <div className="absolute inset-x-0 bottom-1.5 flex justify-center sm:bottom-2">
      <div className="mac-glass flex items-center gap-[5px] rounded-[18px] p-[5px] sm:gap-[7px] sm:rounded-[26px] sm:p-[7px]">
        {APPS.map(({ name, running, wide }) => (
          <div key={name} title={name} className={cn(tile, wide && "hidden sm:block")}>
            {ICONS[name]}
            {running && <span className={dot} />}
          </div>
        ))}
        <span className="mac-sep mx-[2px] h-8 w-px sm:h-11" />
        <div title="Trash" className={tile}>
          {ICONS.Trash}
        </div>
      </div>
    </div>
  );
}
