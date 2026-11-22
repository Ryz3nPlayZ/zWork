/**
 * A skill's mark: a tiny drawing of the paper it produces (an invoice with its
 * total, a letter, a sheet, a slide), so a page of skills reads at a glance
 * instead of as a wall of identical icons.
 */
import { cn } from "../lib/cn";

type Kind =
  | "invoice" | "receipt" | "sheet" | "slides" | "minutes" | "letter" | "mail" | "newsletter"
  | "cv" | "lesson" | "research" | "translate" | "design" | "window" | "doc";

// Order matters: the first match wins ("meeting-notes" is minutes, not a doc).
const RULES: [RegExp, Kind][] = [
  [/receipt/, "receipt"],
  [/invoice|expense|budget|tax|payroll|bill/, "invoice"],
  [/excel|xlsx|sheet|spreadsheet|account|finance|calcul|data/, "sheet"],
  [/pptx|slide|deck|presentation|pitch/, "slides"],
  [/meeting|minutes|interview|agenda|todo|task/, "minutes"],
  [/newsletter|internal-comms|announce|team|status/, "newsletter"],
  [/cover-letter|letter/, "letter"],
  [/email|mail|outreach|reply|comms/, "mail"],
  [/cv|resume/, "cv"],
  [/lesson|teach|course|syllabus|quiz/, "lesson"],
  [/research|academic|paper|grant|study|cite|thesis/, "research"],
  [/translat|language/, "translate"],
  [/design|theme|poster|canvas|brand|visual/, "design"],
  [/computer|browser|web|chrome/, "window"],
];

export function skillKind(name: string): Kind {
  const n = name.toLowerCase();
  return RULES.find(([re]) => re.test(n))?.[1] ?? "doc";
}

const PX = { sm: 32, md: 40, lg: 56 } as const;

// Text lines on the page; `strong` is a heading, `accent` the one colored mark.
const ln = "stroke-ink-faint/70";
const strong = "stroke-ink-soft";

function L({ x1, x2, y, c = ln, w = 1.6 }: { x1: number; x2: number; y: number; c?: string; w?: number }) {
  return <line x1={x1} x2={x2} y1={y} y2={y} strokeWidth={w} strokeLinecap="round" className={c} />;
}

const sheet = "fill-paper-sunken stroke-line-strong dark:fill-ink/[0.07]";
const Portrait = () => <rect x={7.5} y={3.5} width={25} height={33} rx={3} strokeWidth={1} className={sheet} />;
const Landscape = () => <rect x={3.5} y={8.5} width={33} height={23} rx={3} strokeWidth={1} className={sheet} />;

function Body({ kind }: { kind: Kind }) {
  switch (kind) {
    case "invoice":
      return (
        <>
          <Portrait />
          <L x1={12} x2={19} y={9.5} c={strong} w={2} />
          <L x1={24} x2={28} y={9.5} />
          {[16, 20, 24].map((y) => (
            <g key={y}><L x1={12} x2={21} y={y} /><L x1={25} x2={28} y={y} /></g>
          ))}
          <L x1={12} x2={28} y={28} c="stroke-line-strong" w={0.8} />
          <L x1={20} x2={28} y={31.5} c="stroke-success" w={2.4} />
        </>
      );
    case "receipt":
      return (
        <>
          <path d="M12.5 3.5h15v31l-2.5-1.8-2.5 1.8-2.5-1.8-2.5 1.8-2.5-1.8-2.5 1.8z" strokeWidth={1} strokeLinejoin="round" className={sheet} />
          <L x1={16} x2={24} y={8.5} c={strong} w={2} />
          {[14, 17.5, 21].map((y) => <L key={y} x1={15.5} x2={24.5} y={y} />)}
          <L x1={18} x2={24.5} y={27} c="stroke-success" w={2.4} />
        </>
      );
    case "sheet":
      return (
        <>
          <Portrait />
          <rect x={11} y={8} width={18} height={4.5} rx={1} className="fill-success/25" />
          <g className="stroke-ink-faint/60" strokeWidth={0.8}>
            <rect x={11} y={8} width={18} height={24} rx={1} fill="none" />
            {[12.5, 17, 21.5, 26].map((y) => <line key={y} x1={11} x2={29} y1={y} y2={y} />)}
            <line x1={17} x2={17} y1={8} y2={32} />
            <line x1={23} x2={23} y1={8} y2={32} />
          </g>
        </>
      );
    case "slides":
      return (
        <>
          <Landscape />
          <L x1={8} x2={20} y={14} c={strong} w={2} />
          <L x1={8} x2={17} y={19} />
          <L x1={8} x2={15} y={23} />
          {[[24, 22], [27.5, 18], [31, 14]].map(([x, top]) => (
            <rect key={x} x={x - 1.3} y={top} width={2.6} height={27 - top} rx={0.6} className="fill-warning/80" />
          ))}
        </>
      );
    case "minutes":
      return (
        <>
          <Portrait />
          <L x1={12} x2={22} y={9.5} c={strong} w={2} />
          {[16, 22, 28].map((y, i) => (
            <g key={y}>
              <rect x={11.5} y={y - 2} width={4} height={4} rx={1} strokeWidth={1} className={i < 2 ? "fill-info stroke-info" : "fill-none stroke-ink-faint"} />
              <L x1={18.5} x2={i === 1 ? 25 : 28} y={y} />
            </g>
          ))}
        </>
      );
    case "letter":
      return (
        <>
          <Portrait />
          <L x1={12} x2={18} y={8.5} />
          <L x1={12} x2={16} y={11.5} />
          {[17, 20.5, 24].map((y) => <L key={y} x1={12} x2={28} y={y} />)}
          <L x1={12} x2={22} y={27.5} />
          <path d="M12.5 32c1.5-2.5 2.5-2.5 3 0s1.5 2.5 3-.5 2 1 4.5.3" fill="none" strokeWidth={1.3} strokeLinecap="round" className="stroke-info" />
        </>
      );
    case "mail":
      return (
        <>
          <Landscape />
          <path d="M4.5 10.5 20 21.5l15.5-11" fill="none" strokeWidth={1.4} strokeLinejoin="round" className="stroke-info" />
        </>
      );
    case "newsletter":
      return (
        <>
          <Portrait />
          <rect x={11} y={7.5} width={18} height={5} rx={1} className="fill-info/70" />
          {[17, 20.5, 24, 27.5].map((y) => (
            <g key={y}><L x1={11.5} x2={18.5} y={y} /><L x1={21.5} x2={28.5} y={y} /></g>
          ))}
        </>
      );
    case "cv":
      return (
        <>
          <Portrait />
          <circle cx={14.5} cy={11} r={3.5} className="fill-info/70" />
          <L x1={20.5} x2={28} y={9.5} c={strong} w={2} />
          <L x1={20.5} x2={25.5} y={13} />
          {[19.5, 23, 26.5, 30].map((y, i) => <L key={y} x1={12} x2={i % 2 ? 24 : 28} y={y} />)}
        </>
      );
    case "lesson":
      return (
        <>
          <Portrait />
          <L x1={12} x2={23} y={9.5} c={strong} w={2} />
          <L x1={12} x2={28} y={12.5} c="stroke-warning" w={1.2} />
          {[18, 23, 28].map((y) => (
            <g key={y}><L x1={12} x2={14.5} y={y} c="stroke-warning" w={2} /><L x1={17.5} x2={28} y={y} /></g>
          ))}
        </>
      );
    case "research":
      return (
        <>
          <Portrait />
          <L x1={14} x2={26} y={9} c={strong} w={2} />
          <L x1={16.5} x2={23.5} y={12.5} />
          {[17.5, 21, 24.5, 28].map((y) => (
            <g key={y}><L x1={11.5} x2={18.5} y={y} /><L x1={21.5} x2={28.5} y={y} /></g>
          ))}
          <circle cx={19.2} cy={16.2} r={1} className="fill-warning" />
          <L x1={11.5} x2={16} y={32} c="stroke-warning" w={1.2} />
        </>
      );
    case "translate":
      return (
        <>
          <Portrait />
          {[9, 12.5, 16].map((y, i) => <L key={y} x1={12} x2={i === 2 ? 22 : 28} y={y} />)}
          {[23, 26.5, 30].map((y, i) => <L key={y} x1={12} x2={i === 2 ? 20 : 28} y={y} c="stroke-info" />)}
        </>
      );
    case "design":
      return (
        <>
          <Portrait />
          <circle cx={17} cy={14} r={5} className="fill-warning/80" />
          <rect x={18} y={17} width={10} height={10} rx={1} className="fill-ink-soft/80" />
          <L x1={12} x2={22} y={31.5} />
        </>
      );
    case "window":
      return (
        <>
          <Landscape />
          <path d="M3.5 13.5h33" strokeWidth={1} className="stroke-line-strong" />
          {[7, 10, 13].map((x) => <circle key={x} cx={x} cy={11} r={0.9} className="fill-ink-faint" />)}
          <rect x={7} y={17} width={9} height={10} rx={1} className="fill-info/60" />
          {[18.5, 22, 25.5].map((y) => <L key={y} x1={19} x2={y === 25.5 ? 27 : 32} y={y} />)}
        </>
      );
    default:
      return (
        <>
          <Portrait />
          <L x1={12} x2={22} y={9.5} c={strong} w={2} />
          {[15.5, 19, 22.5, 26, 29.5].map((y, i) => <L key={y} x1={12} x2={i === 4 ? 21 : 28} y={y} />)}
          <rect x={11.5} y={20.8} width={13} height={3.4} rx={1} className="fill-warning/30" />
        </>
      );
  }
}

export function SkillDoc({ name, size = "md", className }: { name: string; size?: keyof typeof PX; className?: string }) {
  const px = PX[size];
  return (
    <svg viewBox="0 0 40 40" width={px} height={px} aria-hidden className={cn("shrink-0", className)}>
      <Body kind={skillKind(name)} />
    </svg>
  );
}
