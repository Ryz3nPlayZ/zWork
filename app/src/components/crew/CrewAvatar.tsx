import { BotAvatar, botAvatarTypes, type BotAvatarShading, type BotAvatarState, type BotAvatarType } from "bot-avatars";
import type { CrewMember } from "../../lib/api";
import { useApp } from "../../lib/store";
import { useResolvedTheme } from "../../lib/theme";
import { cn } from "../../lib/cn";

/** Working while one of their chats is running; sleeping while they wait on a schedule. */
function useCrewState(id: string): BotAvatarState {
  // shortcut: a scheduled run in progress isn't in the chat store, so it reads as sleeping; add a running flag to schedules if that matters.
  const working = useApp((s) => Object.values(s.chats).some((c) => c.crewId === id && c.working));
  const scheduled = useApp((s) => s.scheduledTasks.some((t) => t.crew_id === id && t.enabled));
  return working ? "working" : scheduled ? "sleeping" : "default";
}

export function CrewAvatar({
  member,
  size = 32,
  shading = "smooth",
  className,
}: {
  member: CrewMember;
  size?: number | string;
  /** "smooth" in lists, "fabric" on the member's own page. */
  shading?: BotAvatarShading;
  className?: string;
}) {
  const state = useCrewState(member.id);
  const theme = useResolvedTheme();
  const type = botAvatarTypes.includes(member.avatar as BotAvatarType)
    ? (member.avatar as BotAvatarType)
    : "clover";
  const label = state === "working" ? "working" : state === "sleeping" ? "waiting on a schedule" : "";

  return (
    <BotAvatar
      type={type}
      state={state}
      color={member.color || "#d97757"}
      size={size}
      interactive={false}
      shading={shading}
      theme={theme}
      role="img"
      aria-label={label ? `${member.name}, ${label}` : member.name}
      className={cn("shrink-0", className)}
    />
  );
}
