-- What the engine knew about the client when it wrote this programme.
--
-- ai_workout_generations already froze the safety screen and the rule audit
-- alongside each proposal. It could not say what the model was TOLD about the
-- person — and until now the honest answer for a thin client record was
-- "height 175, weight 75, male, beginner, four days a week", none of which
-- came from the database. The browser supplied them and the prompt printed
-- them under the heading CLIENT AUTHORITATIVE DATA.
--
-- Those defaults are gone (see modules/pt-os/client-facts.js). These two
-- columns are what replaces them in the record:
--
--   inputs        every fact as resolved, each with the COLUMN it came from,
--                 or marked as the trainer's own statement, or as missing
--   data_quality  the summary: what was recorded, what the trainer stated,
--                 what nobody holds, and how complete that leaves the picture
--
-- Frozen rather than recomputed, for the same reason the screen is: these
-- rules keep changing, and re-resolving a six-month-old proposal against
-- today's columns would make the history unreadable.
--
-- Nullable with no backfill. Every row written before this migration genuinely
-- has no answer, and inventing one for them would repeat the exact mistake
-- this column exists to record.
ALTER TABLE ai_workout_generations
  ADD COLUMN IF NOT EXISTS inputs       JSONB,
  ADD COLUMN IF NOT EXISTS data_quality JSONB;

-- "Which programmes did we write without knowing the client's goal?" — the
-- question a studio should be able to ask when a plan turns out wrong. Partial,
-- because rows with nothing blocking are the uninteresting majority.
CREATE INDEX IF NOT EXISTS ai_workout_generations_incomplete_idx
  ON ai_workout_generations (organization_id, created_at DESC)
  WHERE data_quality IS NOT NULL
    AND jsonb_array_length(COALESCE(data_quality->'missing', '[]'::jsonb)) > 0;
