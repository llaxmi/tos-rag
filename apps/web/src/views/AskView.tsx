import { useState, type FormEvent } from "react";
import { ask, type AskResponse, type DocFilter } from "../lib/api";
import { parseCitations } from "../lib/citations";
import { formatMs } from "../lib/format";
import { EvidenceCard } from "../components/EvidenceCard";

const SUGGESTIONS = [
  "How much notice does GitHub give before changing fees?",
  "Can I share my Netflix account outside my household?",
  "Who owns the content I post in a public repository?",
];

const DOC_OPTIONS: Array<{ label: string; value: DocFilter }> = [
  { label: "Both documents", value: undefined },
  { label: "GitHub ToS", value: "github-tos" },
  { label: "Netflix ToU", value: "netflix-tou" },
];

export function AskView() {
  const [question, setQuestion] = useState("");
  const [docId, setDocId] = useState<DocFilter>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [askedQuestion, setAskedQuestion] = useState("");
  const [flashed, setFlashed] = useState<number | null>(null);

  async function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    setAskedQuestion(trimmed);
    try {
      setResult(await ask(trimmed, docId));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(question);
  }

  function flash(id: number) {
    setFlashed(id);
    document
      .getElementById(`evidence-${id}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    window.setTimeout(() => setFlashed(null), 1200);
  }

  const parsed = result ? parseCitations(result.answer) : null;

  return (
    <>
      <section className="ask-hero">
        <h1>Ask the Terms of Service.</h1>
        <p>
          Answers come only from the frozen corpus, and every retrieved clause
          carries its exact character offsets.{" "}
          <span className="offset-note">
            chunk.text === canonical.slice(start, end)
          </span>
        </p>
      </section>

      <div className="doc-chips" role="group" aria-label="Limit to a document">
        {DOC_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            type="button"
            className="doc-chip"
            aria-pressed={docId === opt.value}
            onClick={() => setDocId(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <form className="ask-form" onSubmit={onSubmit}>
        <input
          className="ask-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. How much notice before a fee change?"
          aria-label="Your question"
        />
        <button className="ask-button" type="submit" disabled={pending}>
          Ask
        </button>
      </form>

      <div className="ask-layout">
        <section aria-label="Answer">
          {pending && (
            <div className="loading-row" role="status">
              <span className="dot" aria-hidden="true" />
              Retrieving clauses and generating…
            </div>
          )}

          {error && <p className="error-note">{error}</p>}

          {!pending && !error && result && parsed && (
            <div className="exchange">
              <p className="exchange-q">{askedQuestion}</p>
              {result.abstained ? (
                <div className="answer-abstained">
                  The corpus doesn't answer this, so the model declined rather
                  than guess. Its reply, verbatim:{" "}
                  <span className="verbatim">{result.answer}</span>
                </div>
              ) : (
                <p className="answer">
                  <span className="marked">
                    {parsed.segments.map((seg, i) =>
                      seg.kind === "text" ? (
                        <span key={i}>{seg.value}</span>
                      ) : (
                        <button
                          key={i}
                          type="button"
                          className="cite-chip"
                          onClick={() => flash(seg.value)}
                          aria-label={`Show evidence ${seg.value}`}
                        >
                          {seg.value}
                        </button>
                      ),
                    )}
                  </span>
                </p>
              )}
              <div className="answer-meta">
                <span>
                  config {result.config.strategy} × {result.config.chunkSize}
                </span>
                <span>retrieval {formatMs(result.timings.retrievalMs)}</span>
                <span>generation {formatMs(result.timings.generationMs)}</span>
                <span>
                  {result.tokens.input} in · {result.tokens.output} out tokens
                </span>
              </div>
            </div>
          )}

          {!pending && !result && !error && (
            <div className="suggestions">
              <p>
                Ask anything the two agreements actually answer — or try one of
                these:
              </p>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="suggestion"
                  onClick={() => {
                    setQuestion(s);
                    void submit(s);
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="evidence-panel" aria-label="Evidence">
          <h2>Evidence</h2>
          {result && result.evidence.length > 0 ? (
            result.evidence.map((ev, i) => (
              <EvidenceCard
                key={`${ev.docId}-${ev.charStart}`}
                index={i + 1}
                evidence={ev}
                cited={parsed?.citedIds.includes(i + 1) ?? false}
                flashed={flashed === i + 1}
              />
            ))
          ) : (
            <p className="evidence-empty">
              Retrieved clauses appear here with their §character offsets and
              similarity scores.
            </p>
          )}
        </aside>
      </div>
    </>
  );
}
