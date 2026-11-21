import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown } from "lucide-react";
import { useApp } from "../../lib/store";
import { cn } from "../../lib/cn";
import { MENU_PANEL, MENU_TRIGGER, menuPlacement, type MenuPlacement } from "../../lib/menu";
import { CrewAvatar } from "./CrewAvatar";

export function CrewPicker({ disabled = false }: { disabled?: boolean }) {
  const crew = useApp((s) => s.crew);
  const activeChatId = useApp((s) => s.activeChatId);
  const chatCrewId = useApp((s) => (s.activeChatId ? s.chats[s.activeChatId]?.crewId : undefined));
  const newChatCrewId = useApp((s) => s.newChatCrewId);
  const setChatCrew = useApp((s) => s.setChatCrew);
  const setView = useApp((s) => s.setView);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<MenuPlacement>({ dropDown: false, maxHeight: 400 });
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const crewId = activeChatId ? chatCrewId || "" : newChatCrewId;
  const selected = crew.find((member) => member.id === crewId);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = async (id: string) => {
    setError(null);
    try {
      await setChatCrew(id);
      setOpen(false);
    } catch {
      setError("Couldn't change the crew member. Try again.");
    }
  };

  return (
    <div ref={ref} className="relative flex">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          setError(null);
          setPlace(menuPlacement(ref.current));
          setOpen((value) => !value);
        }}
        aria-label={selected ? `Crew member: ${selected.name}` : "Choose a crew member"}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(MENU_TRIGGER, "max-w-40", open && "bg-ink/5 text-ink")}
      >
        {selected ? <CrewAvatar member={selected} size={20} /> : <Bot className="h-4 w-4 text-ink-muted" aria-hidden />}
        <span className="truncate">{selected ? selected.name : "Crew"}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Crew members"
          style={{ maxHeight: place.maxHeight }}
          className={cn(MENU_PANEL, "left-0 w-64", place.dropDown ? "top-full mt-2 origin-top-left" : "bottom-full mb-2 origin-bottom-left")}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!selected}
            onClick={() => void choose("")}
            className="press ring-focus flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink hover:bg-state-hover"
          >
            <Bot className="h-4 w-4 text-ink-muted" aria-hidden />
            <span className="flex-1">No crew member</span>
            {!selected && <Check className="h-4 w-4" aria-hidden />}
          </button>
          {crew.map((member) => (
            <button
              key={member.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected?.id === member.id}
              onClick={() => void choose(member.id)}
              className="press ring-focus flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink hover:bg-state-hover"
            >
              <CrewAvatar member={member} size={26} />
              <span className="min-w-0 flex-1 truncate">{member.name}</span>
              {selected?.id === member.id && <Check className="h-4 w-4" aria-hidden />}
            </button>
          ))}
          {crew.length === 0 && <p className="px-2 py-2 text-[12px] text-ink-muted">Add a member to give this chat a reusable job and app limits.</p>}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setView("crew");
            }}
            className="press ring-focus flex min-h-10 w-full items-center rounded-lg px-2 py-1.5 text-left text-[12.5px] font-medium text-ink hover:bg-state-hover"
          >
            Manage crew
          </button>
          {error && <p role="alert" className="px-2 pb-1 pt-2 text-[11.5px] text-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
