import { cn } from "./lib/utils";

/**
 * A small legend chip: a coloured square followed by its label. The colour comes
 * from either a Tailwind background utility (`className="bg-primary"`) or a raw
 * CSS colour/`var(--…)` (`color="var(--compare)"`) for values that aren't
 * expressible as a utility.
 */
export function Swatch({
  className,
  color,
  children,
}: {
  className?: string;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <span>
      <span
        className={cn(
          "mr-1.5 inline-block size-2.5 rounded-[2px] align-[-1px]",
          className,
        )}
        style={color ? { background: color } : undefined}
      />
      {children}
    </span>
  );
}
