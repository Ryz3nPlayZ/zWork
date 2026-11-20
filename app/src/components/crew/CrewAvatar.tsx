import { BotAvatar, botAvatarTypes, type BotAvatarType } from "bot-avatars";
import type { CrewMember } from "../../lib/api";
import { cn } from "../../lib/cn";

export function CrewAvatar({
  member,
  size = 32,
  className,
}: {
  member: CrewMember;
  size?: number | string;
  className?: string;
}) {
  const type = botAvatarTypes.includes(member.avatar as BotAvatarType)
    ? (member.avatar as BotAvatarType)
    : "clover";

  return (
    <BotAvatar
      type={type}
      color={member.color || "#d97757"}
      size={size}
      paused
      interactive={false}
      shading="crisp"
      role="img"
      aria-label={`${member.name} avatar`}
      className={cn("shrink-0", className)}
    />
  );
}
