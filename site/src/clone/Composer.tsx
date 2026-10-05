import type { ReactNode } from "react";
import {
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  FileText,
  Hand,
  MessageSquarePlus,
  NotebookPen,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Square,
  XCircle,
} from "lucide-react";
import { cn } from "../lib/cn";
import type { CloneState, Permission, Preset } from "./types";

export const PRESET_META: Record<Preset, { icon: ReactNode; label: string; description: string }> = {
  ask: { icon: <Hand className="h-4 w-4" />, label: "Ask before changes", description: "Checks with you before changing anything." },
  edit: { icon: <ShieldCheck className="h-4 w-4" />, label: "Edit automatically", description: "Changes files without asking first." },
  plan: { icon: <NotebookPen className="h-4 w-4" />, label: "Plan first", description: "Suggests a plan and changes nothing." },
  full: { icon: <ShieldAlert className="h-4 w-4" />, label: "Full access", description: "Fewest check-ins. Use with care." },
};

export const MODELS: { id: string; name: string; subtitle: string }[] = [
  { id: "zwork-flash", name: "zWork Flash", subtitle: "Hosted by zWork · fast" },
  { id: "zwork-pro", name: "zWork Pro", subtitle: "Hosted by zWork · strongest" },
  { id: "claude", name: "Claude Opus 5.5", subtitle: "Anthropic · your key" },
  { id: "gpt", name: "GPT-5.5", subtitle: "OpenAI · your key" },
  { id: "gemini", name: "Gemini 3 Pro", subtitle: "Google · your key" },
  { id: "deepseek", name: "DeepSeek V4 Pro", subtitle: "DeepSeek · your key" },
  { id: "local", name: "gpt-oss:120b", subtitle: "Ollama · on this computer" },
];

function IconButton({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted [&_svg]:h-4 [&_svg]:w-4"
    >
      {children}
    </span>
  );
}

function ModelMenu({ current }: { current: string }) {
  return (
    <div className="absolute bottom-[calc(100%+8px)] right-0 z-40 w-[320px] rounded-xl border border-line bg-paper p-1 shadow-pop animate-[fade-in_180ms_ease-out]">
      <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">Model</div>
      {MODELS.map((m) => {
        const selected = m.name === current;
        return (
          <div
            key={m.id}
            data-target={`model-${m.id}`}
            className={cn("press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left", selected && "bg-paper-sunken")}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-ink">{m.name}</span>
              <span className="block truncate text-[11px] text-ink-muted">{m.subtitle}</span>
            </span>
            {selected && <Check className="h-3.5 w-3.5 shrink-0 text-ink" />}
          </div>
        );
      })}
      <div className="mt-1 border-t border-line pt-1">
        <div className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-ink-muted">
          <Plus className="h-3.5 w-3.5" />
          Add custom model
        </div>
      </div>
    </div>
  );
}

export function PermissionCard({ p, pressed }: { p: Permission; pressed: string | null }) {
  return (
    <div className="relative w-full rounded-2xl border border-line bg-paper-raised p-4 shadow-lift">
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">zWork needs your OK</div>
          <div className="mt-0.5 text-[12px] text-ink-muted">{p.reason}</div>
          {p.detail && (
            <pre className="mt-2 max-h-[96px] overflow-hidden whitespace-pre-wrap rounded-md border border-line bg-paper-sunken px-2.5 py-1.5 font-mono text-[12px] leading-[18px] text-ink-soft">
              {p.detail}
            </pre>
          )}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div
          data-target="allow"
          data-pressed={pressed === "allow"}
          className={cn(
            "press flex items-center justify-center gap-1.5 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-[13px] font-medium text-ink",
            (pressed === "allow" || p.chosen === "allow") && "bg-success/20",
          )}
        >
          <CheckCircle2 className="h-4 w-4 text-success" />
          Allow
        </div>
        <div className="press flex items-center justify-center gap-1.5 rounded-xl border border-error/30 bg-error/5 px-3 py-2 text-[13px] font-medium text-ink">
          <XCircle className="h-4 w-4 text-error" />
          Don't allow
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 rounded-xl border border-line bg-paper px-3 py-2 text-[12.5px] text-ink-faint">
        <MessageSquarePlus className="h-3.5 w-3.5" />
        Tell zWork what to do instead…
      </div>
    </div>
  );
}

export function Composer({ s, placeholder }: { s: CloneState; placeholder: string }) {
  if (s.permission && !s.permission.chosen) return <PermissionCard p={s.permission} pressed={s.pressed} />;
  const preset = PRESET_META[s.preset];
  const hasText = s.composer.length > 0;
  return (
    <div className={cn("group relative w-full rounded-2xl bg-paper transition-[box-shadow]", s.composerFocus ? "focus-ring" : "hairline-ring")}>
      <div className="block min-h-[66px] w-full whitespace-pre-wrap px-5 pb-2 pt-4 text-[15px] leading-[25px] text-ink">
        {hasText ? s.composer : <span className="text-ink-faint">{placeholder}</span>}
        {s.composerFocus && (
          <span className="ml-px inline-block h-[1.05em] w-[1.5px] translate-y-[3px] bg-ink animate-typing-cursor" />
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
        <div className="flex items-center gap-1">
          <IconButton label="Attach file">
            <Plus />
          </IconButton>
          <IconButton label="Make a document">
            <FileText />
          </IconButton>
          <span className="press inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[12px] font-medium text-ink">
            <span className="text-ink-muted">{preset.icon}</span>
            {preset.label}
            <ChevronDown className="h-3.5 w-3.5 text-ink-muted" />
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <span
              data-target="model"
              data-pressed={s.pressed === "model"}
              className="press inline-flex items-center gap-1.5 rounded-full border border-line bg-paper py-1 pl-2.5 pr-2 text-[12px] font-medium text-ink"
            >
              <span className="max-w-[200px] truncate">{s.model}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 text-ink-muted transition-transform", s.modelMenu && "rotate-180")} />
            </span>
            {s.modelMenu && <ModelMenu current={s.model} />}
          </div>
          {s.working ? (
            <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-paper-sunken">
              <span className="absolute -inset-px animate-spin rounded-full border border-transparent border-t-ink/50 [animation-duration:1.6s]" />
              <Square className="h-3 w-3 fill-ink text-ink" />
            </span>
          ) : (
            <span
              data-target="send"
              data-pressed={s.pressed === "send"}
              className={cn(
                "press inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-paper-sunken text-ink",
                !hasText && "opacity-50",
              )}
            >
              <ArrowUp className="h-4 w-4" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
