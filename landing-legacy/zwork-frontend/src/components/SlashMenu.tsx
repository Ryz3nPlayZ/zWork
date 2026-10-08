import { useEffect, useMemo, useRef } from "react";
import { CornerDownLeft, Settings as SettingsIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { filterTemplates, type PromptTemplate } from "../lib/templates";

interface Props {
  templates: PromptTemplate[];
  query: string;
  activeIndex: number;
  onActiveIndexChange: (idx: number) => void;
  onSelect: (template: PromptTemplate) => void;
  onManage: () => void;
}

export function SlashMenu({
  templates,
  query,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onManage,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => filterTemplates(templates, query), [templates, query]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-tpl-index="${activeIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      className="absolute bottom-full left-3 z-30 mb-2 w-[320px] overflow-hidden rounded-xl border border-line bg-paper-raised shadow-pop"
      role="listbox"
      aria-label="Prompt templates"
      onMouseDown={(e) => {
        // Prevent the textarea from losing focus when clicking the menu.
        e.preventDefault();
      }}
    >
      <div ref={listRef} className="max-h-[260px] overflow-y-auto py-1">
        {matches.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12.5px] text-ink-faint">
            No templates match "/{query}".
          </div>
        ) : (
          matches.map((tpl, i) => {
            const active = i === activeIndex;
            return (
              <button
                key={tpl.id}
                type="button"
                role="option"
                aria-selected={active}
                data-tpl-index={i}
                onMouseEnter={() => onActiveIndexChange(i)}
                onClick={() => onSelect(tpl)}
                className={cn(
                  "press flex w-full items-center gap-3 px-3 py-2 text-left",
                  active ? "bg-paper-sunken" : "hover:bg-paper-sunken/60",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium text-ink">
                      {tpl.title}
                    </span>
                    <span className="rounded-full border border-line bg-paper px-1.5 py-px font-mono text-[10.5px] text-ink-muted">
                      /{tpl.trigger}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                    {tpl.body.replace(/\s+/g, " ").trim().slice(0, 80)}
                  </div>
                </div>
                {active && (
                  <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                )}
              </button>
            );
          })
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line bg-paper px-3 py-1.5">
        <span className="text-[10.5px] text-ink-faint">
          Enter to insert, Esc to dismiss
        </span>
        <button
          type="button"
          onClick={onManage}
          className="press inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-paper-sunken hover:text-ink"
        >
          <SettingsIcon className="h-3 w-3" />
          Manage templates
        </button>
      </div>
    </div>
  );
}
