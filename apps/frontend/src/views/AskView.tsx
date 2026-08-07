import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ask, getDocument, type AskResponse, type CanonicalDocument } from "../lib/api";
import {
  buildSpanSegments,
  DOC_LABELS,
  MODEL_LABELS,
  parseCitations,
  PHASE1_WINNER,
  RETRIEVAL_K,
  type CitationSpan,
} from "@tos-rag/shared";
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  ChatTurn,
  EvidenceCard,
  EvidenceRail,
  Input,
  SourceDocument,
  Spinner,
  TracePanel,
  cn,
} from "@tos-rag/ui";
import { DOC_OPTIONS, PipelineEditor, type PipelineState } from "./ask/PipelineEditor";

const SUGGESTIONS = [
  "How much notice does GitHub give before changing fees?",
  "Can I share my Netflix account outside my household?",
  "Who owns the content I post in a public repository?",
];

interface Turn {
  id: number;
  question: string;
  config: PipelineState;
  status: "pending" | "done" | "error";
  response?: AskResponse;
  error?: string;
}

type DocState = CanonicalDocument | { error: string } | "loading";

export function AskView() {
  const [question, setQuestion] = useState("");
  const [pipeline, setPipeline] = useState<PipelineState>({
    docValue: "both",
    strategy: PHASE1_WINNER.strategy,
    chunkSize: PHASE1_WINNER.chunkSize,
    model: "llama",
  });
  const [editing, setEditing] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<number | null>(null);
  const [activeCitation, setActiveCitation] = useState<number | null>(null);
  const [tab, setTab] = useState("document");
  const [railDoc, setRailDoc] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Record<string, DocState>>({});
  const nextId = useRef(1);

  const pending = turns.some((t) => t.status === "pending");
  const activeTurn = turns.find((t) => t.id === activeTurnId) ?? null;
  const evidence = activeTurn?.response?.evidence ?? [];

  /** Documents present in this turn's evidence — the only ones worth a pill. */
  const railDocIds = useMemo(
    () => [...new Set(evidence.map((e) => e.docId))],
    [evidence],
  );
  const shownDoc = railDoc && railDocIds.includes(railDoc) ? railDoc : railDocIds[0];

  async function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed || pending) return;
    const id = nextId.current++;
    const config = pipeline;
    setTurns((prev) => [...prev, { id, question: trimmed, config, status: "pending" }]);
    setQuestion("");

    const docId = DOC_OPTIONS.find((o) => o.value === config.docValue)?.doc;
    try {
      const response = await ask(trimmed, docId, {
        strategy: config.strategy,
        chunkSize: config.chunkSize,
        model: config.model,
      });
      setTurns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: "done", response } : t)),
      );
      // The rail only moves to the new turn once it actually has something to
      // show — per the spec's data flow, step 2. An errored turn leaves the
      // previous turn's evidence in place instead of blanking the rail.
      setActiveTurnId(id);
      setActiveCitation(null);
      // A new turn starts on its own first-pill default rather than inheriting
      // whichever document a citation click had pinned the rail to on the
      // previous turn. `focusCitation` sets `railDoc` deliberately alongside
      // `activeTurnId`, so this reset only fires for the natural
      // submit-completes-a-turn path, not for a citation-driven switch.
      setRailDoc(null);
    } catch (e) {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, status: "error", error: e instanceof Error ? e.message : String(e) }
            : t,
        ),
      );
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(question);
  }

  /** Clicking a citation anywhere pins the rail to that turn and that span,
   *  and — since the citation may point at either document — repoints the
   *  rail's document pill at the one the cited evidence actually belongs to.
   *  The index is 1-based against that turn's unfiltered evidence array. A
   *  malformed answer could cite an index with no matching evidence; in that
   *  case the rail still switches turn and tab, it just can't resolve a doc. */
  const focusCitation = useCallback(
    (turnId: number, index: number) => {
      setActiveTurnId(turnId);
      setActiveCitation(index);
      setTab("document");
      const turn = turns.find((t) => t.id === turnId);
      const ev = turn?.response?.evidence[index - 1];
      if (ev) setRailDoc(ev.docId);
    },
    [turns],
  );

  // Lazily fetch the document the Source tab is about to render. Kept out of
  // render so a failed fetch doesn't retry on every keystroke.
  useEffect(() => {
    if (tab !== "document" || !shownDoc || documents[shownDoc]) return;
    const docId = shownDoc;
    setDocuments((prev) => ({ ...prev, [docId]: "loading" }));
    void getDocument(docId)
      .then((doc) => setDocuments((prev) => ({ ...prev, [docId]: doc })))
      .catch((e: unknown) =>
        setDocuments((prev) => ({
          ...prev,
          [docId]: { error: e instanceof Error ? e.message : String(e) },
        })),
      );
  }, [tab, shownDoc, documents]);

  // Scroll the active span into view once its document has rendered.
  useEffect(() => {
    if (activeCitation === null || tab !== "document") return;
    document.getElementById(`doc-span-${activeCitation}`)?.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [activeCitation, tab, documents, shownDoc]);

  const docState = shownDoc ? documents[shownDoc] : undefined;
  // Citation numbers are assigned from the unfiltered evidence position
  // (`i + 1`) before the document filter runs, so a `[3]` in the answer, chunk
  // card 3, and `doc-span-3` always denote the same evidence item. Memoised
  // because `evidence` is a stable reference across renders (it only changes
  // when `turns` changes) and this otherwise re-derives on every keystroke.
  const spans: CitationSpan[] = useMemo(
    () =>
      shownDoc === undefined
        ? []
        : evidence
            .map((e, i) => ({ index: i + 1, charStart: e.charStart, charEnd: e.charEnd, docId: e.docId }))
            .filter((s) => s.docId === shownDoc)
            .map(({ index, charStart, charEnd }) => ({ index, charStart, charEnd })),
    [evidence, shownDoc],
  );
  const docSegments = useMemo(
    () =>
      docState && typeof docState === "object" && "text" in docState
        ? buildSpanSegments(docState.text, spans)
        : null,
    [docState, spans],
  );
  // Single source of truth for "did the answer cite this chunk" — the same
  // parser `ChatTurn` uses to render the inline citation buttons.
  const citedIds = activeTurn?.response
    ? parseCitations(activeTurn.response.answer).citedIds
    : [];

  const summary = [
    DOC_OPTIONS.find((o) => o.value === pipeline.docValue)?.label ?? "Both documents",
    `${pipeline.strategy} · ${pipeline.chunkSize} tok`,
    `k ${RETRIEVAL_K}`,
    MODEL_LABELS[pipeline.model],
  ];

  return (
    <>
      {turns.length === 0 && (
        <section className="max-w-[640px]">
          <h1>Ask the Terms of Service.</h1>
          <p className="text-ink-soft mt-4 text-[17px]">
            Plain answers from the GitHub and Netflix agreements — every claim
            cites the exact clause it came from.
          </p>
        </section>
      )}

      {turns.length > 0 && (
        <section aria-label="Conversation" className="flex flex-col gap-10">
          {turns.map((t) => (
            <ChatTurn
              key={t.id}
              question={t.question}
              status={t.status}
              response={t.response}
              error={t.error}
              active={t.id === activeTurnId && turns.length > 1}
              onCiteClick={(index) => focusCitation(t.id, index)}
            />
          ))}
        </section>
      )}

      <Card className="bg-background mt-8 p-2.5">
        <form onSubmit={onSubmit} className="flex gap-2.5">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={turns.length ? "Ask a follow-up…" : "e.g. How much notice before a fee change?"}
            aria-label="Your question"
            className="bg-background h-11 flex-1 text-base"
          />
          <Button type="submit" size="lg" disabled={pending} className="px-6">
            {pending && <Spinner aria-hidden="true" role={undefined} />}
            {pending ? "Asking" : "Ask"}
          </Button>
        </form>
      </Card>

      {/* The thread is a record, not a context window: /api/ask is stateless,
          so nothing here should imply the pipeline remembers earlier turns. */}
      <p className="text-muted-foreground mt-2 font-mono text-[11px]">
        each question is asked fresh — the pipeline has no memory of earlier turns
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-[12px]">
        <span className="text-muted-foreground" aria-hidden="true">◆</span>
        {summary.map((s) => (
          <span key={s} className="border-border bg-card text-ink-soft rounded-[3px] border px-2 py-1">
            {s}
          </span>
        ))}
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-expanded={editing}
          onClick={() => setEditing((v) => !v)}
          className="text-ink-soft hover:text-foreground h-auto p-0 font-mono text-[11.5px]"
        >
          {editing ? "done" : "edit config"}
        </Button>
      </div>

      {editing && <PipelineEditor value={pipeline} onChange={setPipeline} />}

      {!pending && turns.length === 0 && (
        <div className="mt-8 flex flex-wrap items-baseline gap-2">
          <span className="text-muted-foreground text-[11px] font-bold uppercase tracking-[0.12em]">
            try
          </span>
          {SUGGESTIONS.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              size="sm"
              className="text-ink-soft h-auto rounded-full px-3.5 py-1.5 text-[13.5px] font-normal shadow-none"
              onClick={() => void submit(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      {activeTurn?.response && evidence.length > 0 && (
        <section aria-label="Evidence" className="mt-6">
          <EvidenceRail
            tabs={[
              { id: "document", label: "◆ Source document" },
              { id: "chunks", label: "◇ Retrieved chunks", count: evidence.length },
              { id: "trace", label: "◇ Trace" },
            ]}
            active={tab}
            onTabChange={setTab}
            note="answers ↑ evidence ↓"
          >
            {tab === "document" && (
              <div className="flex flex-col gap-4">
                {railDocIds.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {railDocIds.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setRailDoc(id)}
                        aria-pressed={id === shownDoc}
                        className={cn(
                          "rounded-[3px] border px-2 py-1 font-mono text-[11px] transition-colors",
                          id === shownDoc
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border bg-background text-ink-soft hover:bg-accent",
                        )}
                      >
                        {DOC_LABELS[id] ?? id}
                      </button>
                    ))}
                  </div>
                )}

                {docState === "loading" && (
                  <p className="text-muted-foreground font-mono text-[12px]">
                    loading the frozen document…
                  </p>
                )}
                {docState && typeof docState === "object" && "error" in docState && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {docState.error}
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="text-destructive h-auto p-0 font-mono text-[11.5px] underline"
                        onClick={() => {
                          // Clears the cached failure so the fetch effect's
                          // guard (`!documents[shownDoc]`) sees a gap and
                          // re-runs, instead of the failure latching forever.
                          const docId = shownDoc;
                          if (!docId) return;
                          setDocuments((prev) => {
                            const next = { ...prev };
                            delete next[docId];
                            return next;
                          });
                        }}
                      >
                        try again
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                {docSegments && (
                  <SourceDocument
                    segments={docSegments}
                    activeIndex={activeCitation}
                  />
                )}
              </div>
            )}

            {tab === "chunks" && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {evidence.map((ev, i) => (
                  <EvidenceCard
                    key={`${ev.docId}-${ev.charStart}`}
                    index={i + 1}
                    evidence={ev}
                    cited={citedIds.includes(i + 1)}
                    flashed={activeCitation === i + 1}
                    onSelect={() => focusCitation(activeTurn.id, i + 1)}
                  />
                ))}
              </div>
            )}

            {tab === "trace" && (
              <TracePanel
                timings={activeTurn.response.timings}
                tokens={activeTurn.response.tokens}
                config={activeTurn.response.config}
                model={activeTurn.response.model}
                prompt={activeTurn.response.prompt}
                k={evidence.length}
              />
            )}
          </EvidenceRail>
        </section>
      )}
    </>
  );
}
