import type { RetrievedChunk } from "@tos-rag/core";
import { ABSTENTION_TEXT, RETRIEVAL_K } from "@tos-rag/core";
import type { AppDeps } from "../app";

/**
 * Offline demo dependencies: keyword-overlap retrieval over a tiny in-memory
 * excerpt corpus and an extractive "generator". Used when no Supabase /
 * Workers AI credentials are configured, so the demo UI works end-to-end
 * locally. Clearly NOT the experimental pipeline.
 */

interface DemoPassage {
  docId: "github-tos" | "netflix-tou";
  charStart: number;
  charEnd: number;
  text: string;
}

const PASSAGES: DemoPassage[] = [
  {
    docId: "github-tos",
    charStart: 18240,
    charEnd: 18420,
    text: "GitHub reserves the right at any time to modify or discontinue, temporarily or permanently, the Website (or any part of it) with or without notice. We will give you at least 30 days notice before any fee change takes effect.",
  },
  {
    docId: "github-tos",
    charStart: 9120,
    charEnd: 9300,
    text: "You must be at least 13 years old (or the minimum age of digital consent in your country) to use the Service. Accounts registered by bots or other automated methods are not permitted.",
  },
  {
    docId: "github-tos",
    charStart: 30410,
    charEnd: 30580,
    text: "GitHub retains the right to suspend or terminate your access to the Service at any time, with or without cause, and with or without notice, for conduct that violates these terms.",
  },
  {
    docId: "github-tos",
    charStart: 41200,
    charEnd: 41390,
    text: "You retain ownership of and responsibility for Your Content. If you post anything in a public repository, you grant each user of GitHub a nonexclusive, worldwide license to use, display, and reproduce your content through GitHub's functionality.",
  },
  {
    docId: "netflix-tou",
    charStart: 2100,
    charEnd: 2280,
    text: "The Netflix service is for your personal and non-commercial use only and may not be shared with individuals beyond your household unless otherwise permitted by your subscription plan.",
  },
  {
    docId: "netflix-tou",
    charStart: 4870,
    charEnd: 5060,
    text: "Your Netflix membership will continue until terminated. You can cancel your membership at any time, and you will continue to have access to the Netflix service through the end of your billing period.",
  },
  {
    docId: "netflix-tou",
    charStart: 6900,
    charEnd: 7090,
    text: "Payments are non-refundable and there are no refunds or credits for partially used membership periods. We may change our subscription plans and the price of our service from time to time with at least 30 days advance notice.",
  },
  {
    docId: "netflix-tou",
    charStart: 10500,
    charEnd: 10680,
    text: "You agree not to archive, reproduce, distribute, modify, display, perform, publish, license, or create derivative works from content obtained from the Netflix service without express written authorization.",
  },
];

const tokenize = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

export function createDemoDeps(): AppDeps {
  return {
    retrieve: async (question, opts) => {
      const q = tokenize(question);
      const scored = PASSAGES.filter(
        (p) => !opts?.docId || p.docId === opts.docId,
      )
        .map((p) => {
          const words = tokenize(p.text);
          let overlap = 0;
          for (const w of q) if (words.has(w)) overlap++;
          return { p, score: q.size === 0 ? 0 : overlap / q.size };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, RETRIEVAL_K);
      return scored.map(
        ({ p, score }): RetrievedChunk => ({
          docId: p.docId,
          charStart: p.charStart,
          charEnd: p.charEnd,
          text: p.text,
          score: Math.round(score * 100) / 100,
        }),
      );
    },

    generate: async (prompt) => {
      const t0 = Date.now();
      // Extractive fallback: return the first context passage's most relevant
      // sentence, or abstain when retrieval found nothing useful.
      const contextMatch = prompt.match(/\[1\] \[[^\]]+\]\n([^\n]+)/);
      const questionMatch = prompt.match(/Question: ([^\n]+)/);
      let answer = ABSTENTION_TEXT;
      if (contextMatch?.[1] && questionMatch?.[1]) {
        const q = tokenize(questionMatch[1]);
        const sentences = contextMatch[1].split(/(?<=[.!?])\s+/);
        let best = "";
        let bestScore = 0;
        for (const s of sentences) {
          const words = tokenize(s);
          let overlap = 0;
          for (const w of q) if (words.has(w)) overlap++;
          if (overlap > bestScore) {
            bestScore = overlap;
            best = s;
          }
        }
        if (bestScore >= 2) answer = best.trim();
      }
      return {
        answer,
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(answer.length / 4),
        latencyMs: Date.now() - t0,
      };
    },

    getAnalysisResults: async () => [],

    winningConfig: { strategy: "sentence", chunkSize: 256 },
  };
}
