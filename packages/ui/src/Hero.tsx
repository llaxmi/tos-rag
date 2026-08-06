interface HeroStat {
  label: string;
  value: string;
}

interface HeroProps {
  eyebrow: string;
  title: string;
  description: string;
  bestConfigLabel: string;
  bestConfigValue: string;
  stats: HeroStat[];
}


export function Hero({
  eyebrow,
  title,
  description,
  bestConfigLabel,
  bestConfigValue,
  stats,
}: HeroProps) {
  return (
    <header className="mb-8">
      <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div>
          <p className="text-foreground mb-2.5 text-[11.5px] font-bold uppercase tracking-[0.12em]">
            {eyebrow}
          </p>
          <h1 className="text-foreground max-w-[16ch] text-[36px] leading-[1.12] font-bold tracking-[-0.01em]">
            {title}
          </h1>
          <p className="text-ink-soft mt-4 max-w-[46ch] text-[15px]">
            {description}
          </p>
        </div>

        <div className="border-compare flex gap-8 border-l-2 pt-0.5 pl-5 md:pl-7">
          <div>
            <p className="text-muted-foreground text-[11.5px] font-bold uppercase tracking-[0.12em]">
              {bestConfigLabel}
            </p>
            <p className="text-foreground mt-1 font-mono text-[17px]">
              {bestConfigValue}
            </p>
            <div className="mt-4 flex gap-6">
              {stats.map((s) => (
                <div key={s.label}>
                  <p className="text-foreground font-mono text-[22px] leading-none font-medium">
                    {s.value}
                  </p>
                  <p className="text-muted-foreground mt-1.5 text-[11px]">
                    {s.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}