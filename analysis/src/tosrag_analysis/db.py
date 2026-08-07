"""The only module that touches the world: Postgres in, `analysis_results` out.

Prisma owns the schema (`packages/db/prisma`). This step reads `runs`/`evals` and writes
only `analysis_results`, which already exists, so it needs no migration and no client.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from .grid import ShapeError
from .judge import JudgedRow
from .phase1 import Row
from .phase2 import Phase2Row


# NULL is preserved, never coerced to a number: a missing retrieval metric is a
# real finding (the 4 unanswerable questions), and 0 is a real CRAG score.
def _as_float(value) -> float | None:
    return None if value is None else float(value)


def _as_int(value) -> int | None:
    return None if value is None else int(value)


# Phase 1 is Llama-only (PRD 7); Phase 2 adds Opus rows under the same config.
# Filtering explicitly keeps this analysis correct once those rows exist.
PHASE1_MODEL = "llama3.1:8b"

PHASE1_QUERY = """
select
  c.strategy,
  c.chunk_size,
  r.question_id,
  q.qtype,
  e.crag_score,
  e.char_precision,
  e.char_recall,
  e.hit_at_8,
  e.squad_f1,
  e.squad_em,
  e.faithfulness,
  r.retrieval_ms,
  r.generation_ms
from runs r
join evals e on e.run_id = r.id
join configs c on c.id = r.config_id
join questions q on q.id = r.question_id
where r.phase = 1
  and r.model = %(model)s
order by c.strategy, c.chunk_size, r.question_id
"""


# Phase 2 is the two-arm comparison: one config, two models, 30 questions. No
# `config_id` filter is needed now that the superseded recursive:256 rows are deleted
# (2026-08-04), but `load_phase2_rows` asserts a single config is present so a future
# second config cannot silently pool two experiments into one paired test.
PHASE2_QUERY = """
select
  r.config_id,
  r.model,
  r.question_id,
  q.qtype,
  q.phase1,
  r.answer,
  e.crag_score,
  e.faithfulness,
  e.cosine_sim,
  e.squad_f1,
  e.squad_em,
  e.char_precision,
  e.char_recall,
  e.hit_at_8,
  r.retrieval_ms,
  r.generation_ms,
  r.input_tokens,
  r.output_tokens,
  e.cost_usd
from runs r
join evals e on e.run_id = r.id
join questions q on q.id = r.question_id
where r.phase = 2
order by r.model, r.question_id
"""


# Rows whose CRAG score came from the judge rather than a deterministic rule. The
# rule-decided rows (abstention, exact match) are not opinions and need no human check,
# so validating them would only pad the agreement rate with free wins. The sentinel
# strings are a cross-language copy of RULE_EXPLANATIONS in
# packages/core/src/eval/evaluate.ts and must stay in sync with it.
JUDGED_QUERY = """
select
  r.id,
  r.phase,
  r.model,
  c.strategy || ':' || c.chunk_size as config,
  r.question_id,
  q.qtype,
  q.question,
  q.expected_answer,
  r.answer,
  e.crag_score,
  e.judge_explanation
from runs r
join evals e on e.run_id = r.id
join configs c on c.id = r.config_id
join questions q on q.id = r.question_id
where e.judge_explanation not in ('abstained', 'exact match')
  and e.judge_explanation not like 'abstained (re-scored%%'
  and e.judge_explanation not like 'exact match (re-scored%%'
order by r.id
"""


def resolve_dsn(explicit: str | None = None) -> str:
    """DATABASE_URL from the argument, the environment, or `apps/backend/.env`.

    The TypeScript scripts load that file via `dotenv/config` with the backend as their
    working directory. Reading the same file keeps `pnpm analyze` working out of the box
    instead of requiring the variable to be exported by hand.
    """
    if explicit:
        return explicit
    from_env = os.environ.get("DATABASE_URL")
    if from_env:
        return from_env

    env_file = Path(__file__).resolve().parents[3] / "apps" / "backend" / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "DATABASE_URL":
                return value.strip().strip('"').strip("'")

    raise RuntimeError(
        "DATABASE_URL is not set and was not found in apps/backend/.env — "
        "start the local Supabase stack and export it, or pass --database-url"
    )


def load_phase1_rows(dsn: str, model: str = PHASE1_MODEL) -> list[Row]:
    """One Row per (config, question) for Phase 1."""
    with psycopg.connect(dsn) as connection, connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(PHASE1_QUERY, {"model": model})
        records = cursor.fetchall()

    # Fields are looked up by column name, so reordering a SELECT column can
    # never silently shift every later value into the wrong slot.
    return [
        Row(
            strategy=record["strategy"],
            chunk_size=int(record["chunk_size"]),
            question_id=record["question_id"],
            qtype=record["qtype"],
            crag_score=_as_float(record["crag_score"]),
            char_precision=_as_float(record["char_precision"]),
            char_recall=_as_float(record["char_recall"]),
            hit_at_8=_as_float(record["hit_at_8"]),
            squad_f1=_as_float(record["squad_f1"]),
            squad_em=_as_float(record["squad_em"]),
            faithfulness=_as_float(record["faithfulness"]),
            retrieval_ms=_as_float(record["retrieval_ms"]),
            generation_ms=_as_float(record["generation_ms"]),
        )
        for record in records
    ]


def load_phase2_rows(dsn: str) -> list[Phase2Row]:
    """One Phase2Row per (model, question) for Phase 2."""
    with psycopg.connect(dsn) as connection, connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(PHASE2_QUERY)
        records = cursor.fetchall()

    config_ids = {int(record["config_id"]) for record in records}
    if len(config_ids) > 1:
        # Pooling two configs into one paired test would compare generators *and*
        # pipelines at once, and the payload would not say which produced the gap.
        raise ShapeError(
            f"Phase-2 rows span {len(config_ids)} configs {sorted(config_ids)} \u2014 "
            "the paired comparison assumes a single frozen configuration"
        )

    # Fields are looked up by column name, so reordering a SELECT column can never
    # silently shift every later value into the wrong slot.
    return [
        Phase2Row(
            model=record["model"],
            question_id=record["question_id"],
            qtype=record["qtype"],
            # `questions.phase1` is true for the 20 questions Phase 1 used, so the
            # held-out set is its complement.
            held_out=not record["phase1"],
            answer=record["answer"] or "",
            crag_score=_as_float(record["crag_score"]),
            faithfulness=_as_float(record["faithfulness"]),
            cosine_sim=_as_float(record["cosine_sim"]),
            squad_f1=_as_float(record["squad_f1"]),
            squad_em=_as_float(record["squad_em"]),
            char_precision=_as_float(record["char_precision"]),
            char_recall=_as_float(record["char_recall"]),
            hit_at_8=_as_float(record["hit_at_8"]),
            retrieval_ms=_as_float(record["retrieval_ms"]),
            generation_ms=_as_float(record["generation_ms"]),
            input_tokens=_as_int(record["input_tokens"]),
            output_tokens=_as_int(record["output_tokens"]),
            # cost_usd is Decimal(10,6) in Postgres; float() here keeps the payload
            # JSON-serialisable, and six decimal places is far inside float precision.
            cost_usd=_as_float(record["cost_usd"]),
        )
        for record in records
    ]


def load_judged_rows(dsn: str) -> list[JudgedRow]:
    """Every run whose score the judge decided — the population the sample is drawn from."""
    with psycopg.connect(dsn) as connection, connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(JUDGED_QUERY)
        records = cursor.fetchall()

    return [
        JudgedRow(
            run_id=int(record["id"]),
            phase=int(record["phase"]),
            model=record["model"],
            config=record["config"],
            question_id=record["question_id"],
            qtype=record["qtype"],
            question=record["question"],
            expected_answer=record["expected_answer"],
            answer=record["answer"],
            judge_score=int(record["crag_score"]),
            judge_explanation=record["judge_explanation"] or "",
        )
        for record in records
    ]


def write_analyses(dsn: str, payloads: dict[str, dict]) -> None:
    """Replace each analysis key's row, all keys in one transaction.

    Replace-per-key means the table always holds exactly one current row per analysis,
    so a dashboard reader never has to disambiguate between runs. Re-running is
    idempotent.
    """
    with psycopg.connect(dsn) as connection:
        with connection.cursor() as cursor:
            for key, payload in payloads.items():
                cursor.execute("delete from analysis_results where analysis = %s", (key,))
                cursor.execute(
                    "insert into analysis_results (analysis, payload) values (%s, %s)",
                    (key, json.dumps(payload)),
                )
        connection.commit()


def count_analyses(dsn: str) -> list[tuple[str, str]]:
    """(analysis, computed_at) for every stored row — used to confirm what landed."""
    with psycopg.connect(dsn) as connection, connection.cursor() as cursor:
        cursor.execute("select analysis, computed_at from analysis_results order by analysis")
        return [(record[0], str(record[1])) for record in cursor.fetchall()]
