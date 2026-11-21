import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { BotAvatar, botAvatarTypes, type BotAvatarType } from "bot-avatars";
import { useResolvedTheme } from "../../lib/theme";
import { useApp } from "../../lib/store";
import type { CrewMember } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button, RowIconButton } from "../page/Page";

const COLORS = ["#d97757", "#52796f", "#6d597a", "#3a6ea5", "#b5651d", "#a44a3f", "#2a9d8f", "#c9a227"];
const STEPS = ["Look", "Job", "Apps"] as const;
const STARTERS = [
  { label: "Morning inbox", text: "Each morning, read my new email, flag anything that needs a reply today, and give me a short list with one line per message." },
  { label: "Weekly report", text: "Every Friday, pull this week's numbers from my sheets, compare them with last week, and write a one-page summary I can send to my team." },
  { label: "Research", text: "Find reliable sources on the topic I give you, compare what they say, and give me a short summary with links." },
];
const title = (type: string) => type[0].toUpperCase() + type.slice(1);
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Full-window stage for making or editing a crew member: the avatar stands in a light of its own colour while you name it, brief it and choose its apps. */
export function CrewEditor({
  member,
  onClose,
  onSaved,
}: {
  member: CrewMember | null;
  onClose: () => void;
  onSaved: (member: CrewMember) => void;
}) {
  const createCrew = useApp((s) => s.createCrew);
  const updateCrew = useApp((s) => s.updateCrew);
  const apps = useApp((s) => s.composioApps);
  const theme = useResolvedTheme();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(member?.name ?? "");
  const [instructions, setInstructions] = useState(member?.instructions ?? "");
  const [avatar, setAvatar] = useState<BotAvatarType>(
    botAvatarTypes.includes(member?.avatar as BotAvatarType) ? (member!.avatar as BotAvatarType) : "clover",
  );
  const [color, setColor] = useState(member?.color || COLORS[0]);
  const [selectedApps, setSelectedApps] = useState<string[]>(member?.apps ?? []);
  const [restrictApps, setRestrictApps] = useState((member?.apps.length ?? 0) > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [arrived, setArrived] = useState(false);
  const thinkTimer = useRef<number>();

  const appProblem = restrictApps && selectedApps.length === 0;
  const canSave = name.trim().length > 0 && instructions.trim().length > 0 && !appProblem && !busy;
  const canNext = step === 0 ? name.trim().length > 0 : instructions.trim().length > 0;
  const shown = name.trim() || "Your new member";

  const cycle = (delta: number) =>
    setAvatar((current) => botAvatarTypes[(botAvatarTypes.indexOf(current) + delta + botAvatarTypes.length) % botAvatarTypes.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
      const typing = e.target instanceof HTMLElement && e.target.matches("input, textarea");
      if (!typing && step === 0 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) cycle(e.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy, step]);
  useEffect(() => () => window.clearTimeout(thinkTimer.current), []);

  // They "think" while you brief them.
  const brief = (text: string) => {
    setInstructions(text);
    setThinking(true);
    window.clearTimeout(thinkTimer.current);
    thinkTimer.current = window.setTimeout(() => setThinking(false), 1200);
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), instructions: instructions.trim(), avatar, color, apps: restrictApps ? selectedApps : [] };
    try {
      const saved = member ? await updateCrew(member.id, body) : await createCrew(body);
      if (member || reducedMotion()) {
        onSaved(saved);
        onClose();
        return;
      }
      setArrived(true);
      window.setTimeout(() => {
        onSaved(saved);
        onClose();
      }, 1700);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save. Try again.");
      setBusy(false);
    }
  };

  // Portal: the page pane has a transform, which would trap a fixed overlay inside it.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={member ? `Edit ${member.name}` : "New crew member"}
      className="crew-stage fixed inset-0 z-[200] flex flex-col overflow-hidden bg-paper text-ink md:flex-row"
    >
      {/* The light the member stands in; its colour eases to each new pick. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className={cn(
            "absolute left-1/2 top-[30%] h-[70vmin] w-[70vmin] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-[90px] transition-[background-color,left,top] duration-700 ease-[cubic-bezier(.32,.72,0,1)] md:top-1/2",
            arrived ? "top-1/2" : "md:left-[32%]",
          )}
          style={{ backgroundColor: color }}
        />
      </div>

      <RowIconButton label="Close" onClick={onClose} className="absolute right-4 top-4 z-10">
        <X />
      </RowIconButton>

      {/* Stage */}
      <section className={cn("relative flex shrink-0 flex-col items-center justify-center px-6 pb-2 pt-10 md:min-h-0 md:flex-1 md:pb-10", arrived && "max-md:flex-1")}>
        <div className="flex items-center gap-2 md:gap-6">
          <StageArrow label="Previous look" hidden={step !== 0 || arrived} onClick={() => cycle(-1)}>
            <ChevronLeft />
          </StageArrow>
          <div className="crew-stage-rise relative">
            <div key={avatar} className="crew-stage-pop">
              <BotAvatar
                type={avatar}
                color={color}
                state={arrived || thinking ? "working" : "default"}
                whirl={arrived ? 1 : 0}
                size="clamp(120px, 26vmin, 220px)"
                shading="fabric"
                theme={theme}
                role="img"
                aria-label={`${shown}, ${title(avatar)} look`}
              />
            </div>
            <div aria-hidden className="mx-auto -mt-2 h-4 w-3/5 rounded-[50%] bg-ink/10 blur-md" />
          </div>
          <StageArrow label="Next look" hidden={step !== 0 || arrived} onClick={() => cycle(1)}>
            <ChevronRight />
          </StageArrow>
        </div>

        <div className="crew-stage-rise mt-5 w-full max-w-md text-center [animation-delay:120ms]">
          {arrived ? (
            <p role="status" className="text-[26px] font-semibold tracking-tight md:text-[30px]">
              {shown} joined your crew
            </p>
          ) : (
            <input
              autoFocus={!member}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canNext && step === 0 && setStep(1)}
              placeholder="Name them"
              aria-label="Name"
              maxLength={40}
              className="w-full border-b border-transparent bg-transparent px-2 pb-1 text-center text-[26px] font-semibold tracking-tight text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line focus:border-line-strong md:text-[30px]"
            />
          )}
          <p className="mx-auto mt-1 line-clamp-2 min-h-[20px] max-w-sm text-[13px] leading-5 text-ink-muted">
            {arrived ? "Pick them from the crew button in any chat or scheduled task." : instructions.trim() || `${title(avatar)} look`}
          </p>
        </div>
      </section>

      {/* Briefing panel */}
      <section
        className={cn(
          // On arrival the panel folds its width away so the stage re-centres on the new member;
          // children keep 420px so nothing reflows while it closes.
          "relative flex min-h-0 flex-1 flex-col overflow-hidden border-line bg-paper-raised/85 backdrop-blur-xl transition-[opacity,width,flex-grow] duration-700 ease-[cubic-bezier(.32,.72,0,1)] max-md:rounded-t-3xl max-md:border-t md:w-[420px] md:flex-none md:border-l md:[&>*]:w-[420px] md:[&>*]:shrink-0",
          arrived && "pointer-events-none opacity-0 max-md:flex-none max-md:h-0 md:w-0 md:border-l-0",
        )}
      >
        <nav aria-label="Steps" className="flex gap-1 px-6 pt-5 md:pt-14">
          {STEPS.map((label, i) => {
            const reachable = member || i <= step || (i === 1 && name.trim()) || (i === 2 && name.trim() && instructions.trim());
            return (
              <button
                key={label}
                type="button"
                disabled={!reachable}
                aria-current={i === step ? "step" : undefined}
                onClick={() => setStep(i)}
                className={cn(
                  "press ring-focus rounded-full px-3 py-1 text-[12.5px] transition-colors",
                  i === step ? "bg-state-selected font-medium text-ink" : "text-ink-muted hover:bg-state-hover disabled:opacity-40 disabled:hover:bg-transparent",
                )}
              >
                {label}
              </button>
            );
          })}
        </nav>

        <div key={step} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 pb-4 pt-5 animate-fade-in">
          {step === 0 && (
            <>
              <h2 className="text-[18px] font-semibold tracking-tight">Who are they?</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">Pick a look and a colour. You'll see them next to every chat they work on.</p>
              <div className="mt-5 grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Look">
                {botAvatarTypes.map((type) => (
                  <button
                    key={type}
                    type="button"
                    role="radio"
                    aria-checked={avatar === type}
                    aria-label={title(type)}
                    title={title(type)}
                    onClick={() => setAvatar(type)}
                    className={cn(
                      "press ring-focus flex aspect-square items-center justify-center rounded-xl transition-colors",
                      avatar === type ? "bg-state-selected ring-1 ring-ink/30" : "hover:bg-state-hover",
                    )}
                  >
                    <BotAvatar type={type} color={color} size={30} theme={theme} interactive={false} aria-hidden />
                  </button>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
                {COLORS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={color === value}
                    aria-label={`Colour ${value}`}
                    onClick={() => setColor(value)}
                    className={cn(
                      "press ring-focus h-8 w-8 rounded-full border-2 p-[3px] transition-colors",
                      color === value ? "border-ink" : "border-transparent hover:border-line-strong",
                    )}
                  >
                    <span className="block h-full w-full rounded-full" style={{ backgroundColor: value }} />
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="text-[18px] font-semibold tracking-tight">What's {name.trim() ? `${name.trim()}'s` : "their"} job?</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">Say what to do, what you want back, and anything they should never do.</p>
              <textarea
                autoFocus
                value={instructions}
                onChange={(e) => brief(e.target.value)}
                rows={7}
                aria-label="Instructions"
                placeholder="Find reliable sources on the topic I give you, compare what they say, and give me a short summary with links."
                className="ring-focus mt-4 w-full resize-none overflow-x-hidden whitespace-pre-wrap break-words rounded-xl border border-line bg-paper px-3.5 py-3 text-[14px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
              />
              <p className="mt-4 text-[12px] text-ink-muted">Or start from one of these</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {STARTERS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => brief(s.text)}
                    className="press ring-focus rounded-full border border-line px-3 py-1.5 text-[12.5px] text-ink-soft hover:bg-state-hover"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="text-[18px] font-semibold tracking-tight">What can they use?</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">Apps you've connected in Connectors. Fewer apps means fewer surprises.</p>
              <div className="mt-5 grid gap-2" role="radiogroup" aria-label="App access">
                {[
                  { value: false, label: "Every connected app", body: "Including apps you connect later." },
                  { value: true, label: "Only the apps I pick", body: "Everything else stays off for them." },
                ].map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    role="radio"
                    aria-checked={restrictApps === o.value}
                    onClick={() => setRestrictApps(o.value)}
                    className={cn(
                      "press ring-focus rounded-xl border px-4 py-3 text-left transition-colors",
                      restrictApps === o.value ? "border-ink/40 bg-state-selected" : "border-line hover:bg-state-hover",
                    )}
                  >
                    <span className="block text-[13.5px] font-medium text-ink">{o.label}</span>
                    <span className="mt-0.5 block text-[12.5px] text-ink-muted">{o.body}</span>
                  </button>
                ))}
              </div>
              {restrictApps && (
                <div className="mt-3 grid gap-1">
                  {apps.length === 0 && <p className="text-[12.5px] text-ink-muted">No apps connected yet. Connect one in Connectors, then come back.</p>}
                  {apps.map((app) => (
                    <label key={app.id} className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13px] text-ink hover:bg-state-hover">
                      <input
                        type="checkbox"
                        checked={selectedApps.includes(app.id)}
                        onChange={() =>
                          setSelectedApps((current) => (current.includes(app.id) ? current.filter((id) => id !== app.id) : [...current, app.id]))
                        }
                        className="h-4 w-4 accent-current"
                      />
                      {app.name}
                    </label>
                  ))}
                  {appProblem && apps.length > 0 && <p className="mt-1 text-[12px] text-error">Pick at least one app, or allow every connected app.</p>}
                </div>
              )}
            </>
          )}

          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-[12.5px] text-error">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-6 py-4">
          {step > 0 ? <Button onClick={() => setStep(step - 1)}>Back</Button> : <Button onClick={onClose}>Cancel</Button>}
          <div className="flex gap-2">
            {member && step < 2 && <Button disabled={!canSave} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>}
            {step < 2 ? (
              <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</Button>
            ) : (
              <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
                {busy ? "Saving…" : member ? "Save changes" : `Add ${name.trim() || "member"}`}
              </Button>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function StageArrow({ label, hidden, onClick, children }: { label: string; hidden: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={hidden ? -1 : 0}
      onClick={onClick}
      className={cn(
        "press ring-focus flex h-10 w-10 items-center justify-center rounded-full text-ink-muted transition-opacity hover:bg-state-hover hover:text-ink [&>svg]:h-5 [&>svg]:w-5",
        hidden && "pointer-events-none opacity-0",
      )}
    >
      {children}
    </button>
  );
}
