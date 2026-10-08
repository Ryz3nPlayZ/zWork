import { cn } from "../lib/cn";
import {
  FileCode,
  FileText,
  Terminal,
  Globe,
  Database,
  FolderOpen,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface ActivityItem {
  id: string;
  label: string;
  icon?: string;
  done?: boolean;
}

const ICON_MAP: Record<string, LucideIcon> = {
  html: FileCode,
  css: FileCode,
  js: FileCode,
  ts: FileCode,
  tsx: FileCode,
  jsx: FileCode,
  json: FileCode,
  code: FileCode,
  file: FileText,
  write: FileText,
  command: Terminal,
  run: Terminal,
  deploy: Globe,
  browse: Globe,
  db: Database,
  folder: FolderOpen,
  tool: Wrench,
};

function getIcon(name?: string) {
  if (!name) return Wrench;
  const lower = name.toLowerCase();
  for (const [key, Icon] of Object.entries(ICON_MAP)) {
    if (lower.includes(key)) return Icon;
  }
  return Wrench;
}

export function ActivityBlocks({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 py-1">
      {items.map((item) => {
        const Icon = getIcon(item.icon || item.label);
        return (
          <div
            key={item.id}
            className={cn(
              "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors",
              item.done
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                : "border-line bg-paper-sunken text-ink",
            )}
          >
            <Icon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                item.done ? "text-emerald-600 dark:text-emerald-400" : "text-ink-muted",
              )}
            />
            <span className="flex-1 truncate">{item.label}</span>
            {!item.done && <ShimmerBar />}
          </div>
        );
      })}
    </div>
  );
}

function ShimmerBar() {
  return (
    <div className="h-1 w-16 overflow-hidden rounded-full bg-line">
      <div className="h-full w-full animate-shimmer rounded-full bg-gradient-to-r from-transparent via-ink/20 to-transparent bg-[length:200%_100%]" />
    </div>
  );
}
