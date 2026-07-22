-- pgvector. Must exist before the chunks.embedding vector(768) column below.
-- (Retired supabase/migrations/0001_extensions.sql, preserved here.)
create extension if not exists vector;

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "char_length" INTEGER NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configs" (
    "id" SERIAL NOT NULL,
    "strategy" TEXT NOT NULL,
    "chunk_size" INTEGER NOT NULL,

    CONSTRAINT "configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" BIGSERIAL NOT NULL,
    "config_id" INTEGER NOT NULL,
    "doc_id" TEXT NOT NULL,
    "char_start" INTEGER NOT NULL,
    "char_end" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "embedding" vector(768) NOT NULL,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "qtype" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "expected_answer" TEXT NOT NULL,
    "gold_spans" JSONB NOT NULL,
    "phase1" BOOLEAN NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" BIGSERIAL NOT NULL,
    "phase" INTEGER NOT NULL,
    "config_id" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "retrieved" JSONB NOT NULL,
    "answer" TEXT NOT NULL,
    "retrieval_ms" INTEGER,
    "generation_ms" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evals" (
    "run_id" BIGINT NOT NULL,
    "char_precision" DOUBLE PRECISION,
    "char_recall" DOUBLE PRECISION,
    "hit_at_8" DOUBLE PRECISION,
    "faithfulness" DOUBLE PRECISION,
    "crag_score" INTEGER,
    "judge_explanation" TEXT,
    "squad_f1" DOUBLE PRECISION,
    "squad_em" DOUBLE PRECISION,
    "cosine_sim" DOUBLE PRECISION,
    "cost_usd" DECIMAL(10,6),

    CONSTRAINT "evals_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "analysis_results" (
    "id" BIGSERIAL NOT NULL,
    "analysis" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "configs_strategy_chunk_size_key" ON "configs"("strategy", "chunk_size");

-- CreateIndex
CREATE INDEX "chunks_config_id_idx" ON "chunks"("config_id");

-- CreateIndex
CREATE UNIQUE INDEX "runs_phase_config_id_model_question_id_key" ON "runs"("phase", "config_id", "model", "question_id");

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evals" ADD CONSTRAINT "evals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints (Prisma migrate does not emit these).
alter table "configs"   add constraint configs_strategy_check   check (strategy in ('fixed','recursive','sentence','semantic','section'));
alter table "configs"   add constraint configs_chunk_size_check check (chunk_size in (128, 256, 512));
alter table "questions" add constraint questions_qtype_check    check (qtype in ('factual','multi_clause','comparison','unanswerable'));
alter table "runs"      add constraint runs_phase_check         check (phase in (1,2));
alter table "evals"     add constraint evals_crag_score_check   check (crag_score in (-1, 0, 1));

-- Exact-scan retrieval RPC. NO HNSW/IVFFlat INDEX — exact scan gives perfect
-- recall and deterministic ordering; an approximate index would make retrieval
-- non-deterministic and invalidate collected runs. Experimental control, not a
-- missing optimization. p_doc_id filters inside the scan so a doc-scoped
-- question still gets k rows. (Retired supabase/migrations/0002_schema.sql.)
create or replace function match_chunks(
  p_config_id int,
  p_query vector(768),
  p_k int,
  p_doc_id text default null
)
returns table (chunk_id bigint, doc_id text, char_start int, char_end int, text text, score real)
language sql stable as $$
  select id, doc_id, char_start, char_end, text,
         1 - (embedding <=> p_query) as score
  from chunks
  where config_id = p_config_id
    and (p_doc_id is null or doc_id = p_doc_id)
  order by embedding <=> p_query, id
  limit p_k;
$$;

-- RLS enabled with NO policies: anon/authenticated denied outright; the
-- service-role / direct connection bypasses RLS. Stops the advisor flagging
-- publicly-exposed tables. (Retired supabase/migrations/0002_schema.sql.)
alter table documents        enable row level security;
alter table configs          enable row level security;
alter table chunks           enable row level security;
alter table questions        enable row level security;
alter table runs             enable row level security;
alter table evals            enable row level security;
alter table analysis_results enable row level security;
