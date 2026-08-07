import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "./lib/utils";

export interface RailTab {
  id: string;
  label: string;
  count?: number;
}

interface Props {
  tabs: RailTab[];
  active: string;
  onTabChange: (id: string) => void;
  /** Right-aligned hint in the tab strip, e.g. "answers ↑ evidence ↓". */
  note?: string;
  children: ReactNode;
}

/**
 * The evidence rail beneath the composer: one panel at a time, selected by a
 * tab strip. Implements the ARIA tablist keyboard contract — arrow keys move
 * between tabs and Home/End jump to the ends — because a bare set of buttons
 * leaves keyboard users tabbing through every panel to reach the next one.
 */
export function EvidenceRail({
  tabs,
  active,
  onTabChange,
  note,
  children,
}: Props) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.id === active);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    onTabChange(tabs[next]!.id);
    document.getElementById(`rail-tab-${tabs[next]!.id}`)?.focus();
  }

  return (
    <div className="border-border bg-card overflow-hidden rounded-lg border">
      <div
        role="tablist"
        aria-label="Evidence"
        onKeyDown={onKeyDown}
        className="border-border flex items-center gap-1 border-b px-3"
      >
        {tabs.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              id={`rail-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`rail-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(t.id)}
              className={cn(
                "focus-visible:ring-ring/50 -mb-px cursor-pointer border-b-2 px-3.5 py-3 font-mono text-[12px] tracking-[0.04em] transition-colors focus-visible:ring-2 focus-visible:outline-none",
                selected
                  ? "border-primary text-foreground"
                  : "text-ink-soft hover:text-foreground border-transparent",
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="text-muted-foreground ml-1.5">({t.count})</span>
              )}
            </button>
          );
        })}
        {note && (
          <span className="text-muted-foreground ml-auto font-mono text-[11px]">
            {note}
          </span>
        )}
      </div>

      <div
        id={`rail-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`rail-tab-${active}`}
        tabIndex={0}
        className="focus-visible:ring-ring/50 p-5 focus-visible:ring-2 focus-visible:outline-none sm:p-6"
      >
        {children}
      </div>
    </div>
  );
}
