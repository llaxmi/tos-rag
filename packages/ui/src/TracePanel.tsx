import { useEffect, useRef, useState } from "react";
import {
  formatMs,
  MODEL_LABELS,
  type GeneratorModel,
} from "@tos-rag/shared";
import { Button } from "./primitives/button";

interface Props {
  timings: { retrievalMs: number; generationMs: number };
  tokens: { input: number; output: number };
  config: { strategy: string; chunkSize: number };
  model: GeneratorModel;
  prompt: string;
  k: number;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-muted-foreground text-[11px] font-bold uppercase tracking-[0.12em]">
        {label}
      </span>
      <span className="text-foreground font-mono text-[12.5px]">{value}</span>
    </div>
  );
}

/**
 * What the pipeline actually did for one answer, including the prompt handed to
 * the generator. The prompt is reported by the backend rather than rebuilt here:
 * a re-derivation could silently disagree with what was sent, which is exactly
 * the failure this panel exists to rule out.
 */
export function TracePanel({
  timings,
  tokens,
  config,
  model,
  prompt,
  k,
}: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  );
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState("copied");
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        setCopyState("idle");
      }, 1600);
    } catch {
      setCopyState("failed");
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        setCopyState("idle");
      }, 1600);
    }
  }

  const buttonText =
    copyState === "copied"
      ? "copied"
      : copyState === "failed"
        ? "copy failed"
        : "copy";

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <div className="divide-border divide-y">
        <Row label="Retrieval" value={formatMs(timings.retrievalMs)} />
        <Row label="Generation" value={formatMs(timings.generationMs)} />
        <Row
          label="Total"
          value={formatMs(timings.retrievalMs + timings.generationMs)}
        />
        <Row label="Tokens in" value={String(tokens.input)} />
        <Row label="Tokens out" value={String(tokens.output)} />
        <Row label="Chunking" value={`${config.strategy} · ${config.chunkSize} tok`} />
        <Row label="Top-k" value={String(k)} />
        <Row label="Embedder" value="EmbeddingGemma · cosine" />
        <Row label="Generator" value={MODEL_LABELS[model] ?? model} />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground text-[11px] font-bold uppercase tracking-[0.12em]">
            Prompt sent
          </span>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => void copy()}
            className="text-ink-soft hover:text-foreground h-auto p-0 font-mono text-[11.5px]"
          >
            {buttonText}
          </Button>
        </div>
        <pre className="border-border bg-background text-ink-soft max-h-80 overflow-auto rounded-md border p-3.5 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">
          {prompt}
        </pre>
      </div>
    </div>
  );
}
