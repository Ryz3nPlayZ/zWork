import { useEffect, useState } from "react";
import { Logo } from "./Logo";

const PHASES = [
  { label: "Starting engine…", min: 0 },
  { label: "Loading settings…", min: 900 },
  { label: "Wiring providers…", min: 2000 },
  { label: "Connecting…", min: 3500 },
];

export function BootProgress() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      setElapsed(performance.now() - start);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  let phase = PHASES[0];
  for (const p of PHASES) {
    if (elapsed >= p.min) phase = p;
  }
  const progress = Math.min(92, (elapsed / 6000) * 100);

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-6 bg-paper px-6">
      <div className="relative">
        <div className="animate-[pulse_2.4s_ease-in-out_infinite]">
          <Logo size={56} className="text-ink" />
        </div>
        <div className="absolute -inset-4 rounded-full bg-ink/5 blur-xl animate-[pulse_3s_ease-in-out_infinite]" />
      </div>

      <div className="w-full max-w-[260px]">
        <div className="mb-2 flex items-center justify-between text-[11px] text-ink-faint">
          <span className="text-ink/80">{phase.label}</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper-raised border border-line">
          <div
            className="h-full rounded-full bg-ink transition-[width] duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <p className="text-[11px] text-ink-faint">zWork Desktop</p>
    </div>
  );
}
