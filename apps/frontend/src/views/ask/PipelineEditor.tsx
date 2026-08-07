import { RotateCcw } from "lucide-react";
import {
  MODEL_LABELS,
  PHASE1_WINNER,
  SIZES,
  STRATEGIES,
  type DocFilter,
  type GeneratorModel,
} from "@tos-rag/shared";
import { Button, Card, ToggleGroup, ToggleGroupItem, cn } from "@tos-rag/ui";

/** ToggleGroup needs string values, so "both" stands in for no filter. */
export const DOC_OPTIONS: Array<{ label: string; value: string; doc: DocFilter }> = [
  { label: "Both documents", value: "both", doc: undefined },
  { label: "GitHub ToS", value: "github-tos", doc: "github-tos" },
  { label: "Netflix ToU", value: "netflix-tou", doc: "netflix-tou" },
];

const MODELS = (Object.keys(MODEL_LABELS) as GeneratorModel[]).map((value) => ({
  value,
  label: MODEL_LABELS[value],
}));

/** Selected chips read as navy fills, not shadcn's subtle hover surface. */
const CHIP_ON =
  "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";

export interface PipelineState {
  docValue: string;
  strategy: string;
  chunkSize: number;
  model: GeneratorModel;
}

interface Props {
  value: PipelineState;
  onChange: (next: PipelineState) => void;
}

export function PipelineEditor({ value, onChange }: Props) {
  const isWinner =
    value.strategy === PHASE1_WINNER.strategy &&
    value.chunkSize === PHASE1_WINNER.chunkSize &&
    value.model === "llama";

  return (
    <Card aria-label="Pipeline configuration" className="bg-card mt-3 gap-0 p-5 sm:px-6">
      <div className="border-border mb-5 flex items-center justify-between gap-3 border-b pb-4">
        <span className="text-muted-foreground text-[11px] font-bold uppercase tracking-[0.14em]">
          Pipeline
        </span>
        {isWinner ? (
          <span className="text-ink-soft flex items-center gap-2 font-mono text-[11px]">
            <span className="bg-primary size-1.5 rotate-45 rounded-[1px]" aria-hidden="true" />
            winning config
          </span>
        ) : (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-ink-soft hover:text-foreground h-auto p-0 font-mono text-[11.5px]"
            onClick={() =>
              onChange({
                ...value,
                strategy: PHASE1_WINNER.strategy,
                chunkSize: PHASE1_WINNER.chunkSize,
                model: "llama",
              })
            }
          >
            <RotateCcw className="size-3" aria-hidden="true" />
            reset to winner
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-5">
        <PipelineStage label="Search in">
          <ToggleGroup
            type="single"
            value={value.docValue}
            onValueChange={(v) => v && onChange({ ...value, docValue: v })}
            aria-label="Limit to a document"
            className="flex flex-wrap gap-1.5"
          >
            {DOC_OPTIONS.map((opt) => (
              <BenchChip key={opt.value} value={opt.value}>
                {opt.label}
              </BenchChip>
            ))}
          </ToggleGroup>
        </PipelineStage>

        <PipelineStage label="Chunk by" node="cut">
          <ToggleGroup
            type="single"
            value={value.strategy}
            onValueChange={(v) => v && onChange({ ...value, strategy: v })}
            aria-label="Chunking strategy"
            className="flex flex-wrap gap-1.5"
          >
            {STRATEGIES.map((s) => (
              <BenchChip key={s} value={s}>
                {s}
              </BenchChip>
            ))}
          </ToggleGroup>
        </PipelineStage>

        <PipelineStage label="At size">
          <ToggleGroup
            type="single"
            value={String(value.chunkSize)}
            onValueChange={(v) => v && onChange({ ...value, chunkSize: Number(v) })}
            aria-label="Chunk size in tokens"
            className="flex flex-wrap gap-1.5"
          >
            {SIZES.map((s) => (
              <BenchChip key={s} value={String(s)}>
                {s} tok
              </BenchChip>
            ))}
          </ToggleGroup>
        </PipelineStage>

        <PipelineStage label="Answer with">
          <ToggleGroup
            type="single"
            value={value.model}
            onValueChange={(v) => v && onChange({ ...value, model: v as GeneratorModel })}
            aria-label="Generator model"
            className="flex flex-wrap gap-1.5"
          >
            {MODELS.map((m) => (
              <BenchChip key={m.value} value={m.value}>
                {m.label}
              </BenchChip>
            ))}
          </ToggleGroup>
        </PipelineStage>
      </div>
    </Card>
  );
}

/**
 * One stage of the pipeline as a row: a marker and verb-phrase label on the
 * left, the stage's chips on the right. The "cut" marker places the app's
 * cut-mark signature on the chunking stage — where the pipeline actually cuts
 * the document.
 */
function PipelineStage({
  label,
  node = "station",
  children,
}: {
  label: string;
  node?: "station" | "cut";
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex items-center gap-2.5 sm:w-36 sm:shrink-0">
        <span
          className="flex w-3.5 shrink-0 justify-center"
          aria-hidden="true"
        >
          {node === "cut" ? (
            <span className="cut-mark-rule block w-3.5" />
          ) : (
            <span className="bg-primary size-2 rotate-45 rounded-[1px]" />
          )}
        </span>
        <span className="text-ink-soft text-[11px] font-bold uppercase tracking-[0.14em]">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function BenchChip({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  return (
    <ToggleGroupItem
      value={value}
      className={cn(
        "border-border bg-background text-ink-soft hover:bg-accent hover:text-foreground h-auto rounded-md border px-3 py-1.5 font-mono text-[13px] transition-colors",
        CHIP_ON,
      )}
    >
      {children}
    </ToggleGroupItem>
  );
}
