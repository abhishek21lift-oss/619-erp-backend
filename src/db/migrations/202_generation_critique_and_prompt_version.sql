-- The two halves of a generation the ledger could not previously reconstruct.
--
-- ai_workout_generations already freezes the safety screen, the rule audit,
-- the resolved inputs and the data-quality state. Two things a trainer saw on
-- screen were still missing from the record:
--
--   critique        the second model's reading of the plan. Advisory — the
--                   deterministic audit beside it is what decides anything —
--                   but it is part of what the trainer was shown before they
--                   approved, and a ledger that holds the rules and not the
--                   opinion cannot reconstruct the decision they actually made.
--
--   prompt_version  which wording produced this. Without it a row can say what
--                   came back and not what was asked, so a programme that reads
--                   oddly six months from now cannot be traced to the
--                   instructions that produced it.
--
-- Nullable, no backfill. Rows written before this genuinely have no answer, and
-- inventing one would be the fabrication this table exists to prevent.
ALTER TABLE ai_workout_generations
  ADD COLUMN IF NOT EXISTS critique       JSONB,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT;

-- "Which generations came from the prompt wording we have since changed?"
CREATE INDEX IF NOT EXISTS ai_workout_generations_prompt_version_idx
  ON ai_workout_generations (organization_id, prompt_version, created_at DESC)
  WHERE prompt_version IS NOT NULL;
